/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Shows another Profile's Gecko compositor output inside this Zen window.
// Receiver side of the proven prototype layer transport
// (scripts/prototype_gecko_layer_host.m); the worker side is the env-gated
// NativeLayerCA hook. Several workers (one per Profile) may stay live; each
// is told apart by its kernel-audited pid and only the current one is shown.

#import <Cocoa/Cocoa.h>
#import <IOSurface/IOSurface.h>
#import <QuartzCore/QuartzCore.h>
#include <servers/bootstrap.h>

#include "ZenProfileOverlay.h"
#include "prototype_gecko_layer_protocol.h"
#include "WidgetUtils.h"
#include "nsThreadUtils.h"
#include <cmath>
#include "nsGlobalWindowOuter.h"
#include "nsIWidget.h"
#include "nsString.h"
#include "mozilla/Services.h"
#include "nsIObserverService.h"
#include "nsISupportsPrimitives.h"
#include "nsComponentManagerUtils.h"
#include "MOZDynamicCursor.h"

@interface ZenProfileOverlayView : NSView <NSTextInputClient>
@end

namespace {
mach_port_t sReceive = MACH_PORT_NULL;
uint64_t sToken = 0;
struct Worker {
  uint32_t pid = 0;
  mach_port_t input = MACH_PORT_NULL;  // worker's input endpoint (send right)
  CALayer* root = nil;                 // its latest frame
  uint64_t frames = 0;
};
// ponytail: fixed table; 8 live Profiles is plenty for one window.
Worker sWorkers[8];
Worker* sCurrent = nullptr;  // the worker shown and receiving input
bool sResizePending = false;  // a newly shown worker may have missed resizes
NSRect sHole = NSZeroRect;    // view-space cutout that shows chrome beneath
// Aliases for the current worker, used by the input path below.
#define sWorkerPID (sCurrent ? sCurrent->pid : 0u)
#define sInputPort (sCurrent ? sCurrent->input : MACH_PORT_NULL)
uint64_t sInputSequence = 0;
dispatch_queue_t sInputQueue = nullptr;

Worker* Find(uint32_t pid) {
  for (Worker& w : sWorkers)
    if (pid && w.pid == pid) return &w;
  return nullptr;
}

void Forget(Worker& w) {
  if (w.input) mach_port_deallocate(mach_task_self(), w.input);
  [w.root release];
  if (sCurrent == &w) sCurrent = nullptr;
  w = Worker();
}
ZenProfileOverlayView* sView = nil;
NSTimer* sTimer = nil;

// The page's cursor, reported by the shown worker (a background app cannot
// set it), applied while the pointer is over the overlay.
class CursorObserver final : public nsIObserver {
 public:
  NS_DECL_ISUPPORTS
  NS_IMETHOD Observe(nsISupports*, const char*, const char16_t* aData) override {
    nsresult rv;
    int32_t type = nsDependentString(aData).ToInteger(&rv);
    if (NS_SUCCEEDED(rv) && type >= 0 && type < eCursorCount) {
      nsIWidget::Cursor cursor;
      cursor.mDefaultCursor = nsCursor(type);
      [MOZDynamicCursor.sharedInstance setNonCustomCursor:cursor];
    }
    return NS_OK;
  }

 private:
  ~CursorObserver() = default;
};
NS_IMPL_ISUPPORTS(CursorObserver, nsIObserver)

NSWindow* Resolve(mozIDOMWindowProxy* dom) {
  if (!NS_IsMainThread() || !dom) return nil;
  auto* outer = nsGlobalWindowOuter::Cast(dom);
  if (!outer || outer->GetClosedOuter() || !outer->IsChromeWindow()) return nil;
  nsCOMPtr<nsIWidget> widget = mozilla::widget::WidgetUtils::DOMWindowToWidget(outer);
  return widget ? (NSWindow*)widget->GetNativeData(NS_NATIVE_WINDOW) : nil;
}

CATransform3D Transform(const float* f) {
  return (CATransform3D){f[0], f[1], f[2],  f[3],  f[4],  f[5],  f[6],  f[7],
                         f[8], f[9], f[10], f[11], f[12], f[13], f[14], f[15]};
}

const ZenProbeNode* Nodes(const ZenProbeFrame* f) { return (const ZenProbeNode*)f->nodes.address; }
const mach_port_t* Surfaces(const ZenProbeFrame* f) { return (const mach_port_t*)f->surfaces.address; }

// Same structural checks as the prototype host: token, pid (kernel audit),
// topology, finite geometry and IOSurface extent.
bool Valid(const ZenProbeFrame* f, uint32_t sender) {
  if (f->header.msgh_size != sizeof(*f) || !(f->header.msgh_bits & MACH_MSGH_BITS_COMPLEX) ||
      f->body.msgh_descriptor_count != 2 || f->magic != ZEN_LAYER_PROBE_MAGIC ||
      f->token != sToken || f->slot != 0 || !Find(f->pid) || sender != f->pid ||
      !f->root || !f->count || f->count > ZEN_LAYER_PROBE_NODES || f->truncated ||
      !std::isfinite(f->backingScale) || f->backingScale <= 0 || f->backingScale > 16 ||
      f->surfaces.type != MACH_MSG_OOL_PORTS_DESCRIPTOR ||
      f->surfaces.disposition != MACH_MSG_TYPE_PORT_SEND || f->surfaces.count != f->count ||
      !f->surfaces.address || f->nodes.type != MACH_MSG_OOL_DESCRIPTOR || !f->nodes.address ||
      f->nodes.size != f->count * sizeof(ZenProbeNode)) {
    return false;
  }
  for (uint32_t i = 0; i < f->count; i++) {
    if (Surfaces(f)[i] == MACH_PORT_DEAD) return false;
    const ZenProbeNode* n = &Nodes(f)[i];
    if ((i == 0 && n->parent != -1) || (i && (n->parent < 0 || (uint32_t)n->parent >= i)) ||
        (n->flags & ~31u)) return false;
    for (size_t o = offsetof(ZenProbeNode, position); o < sizeof(*n); o += sizeof(float)) {
      float v;
      memcpy(&v, (const char*)n + o, sizeof(v));
      if (!std::isfinite(v) || fabsf(v) > 1e7f) return false;
    }
    if (n->bounds[2] < 0 || n->bounds[3] < 0 || n->bounds[2] > 32768 || n->bounds[3] > 32768 ||
        n->contentsRect[2] < 0 || n->contentsRect[3] < 0 || n->opacity < 0 || n->opacity > 1 ||
        n->contentsScale <= 0 || n->contentsScale > 16 || n->cornerRadius < 0) return false;
    for (int c = 0; c < 4; c++) if (n->background[c] < 0 || n->background[c] > 1) return false;
  }
  return true;
}

void Accept(const ZenProbeFrame* f, Worker& w) {
  NSMutableArray<CALayer*>* layers = [NSMutableArray arrayWithCapacity:f->count];
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  for (uint32_t i = 0; i < f->count; i++) {
    const ZenProbeNode* n = &Nodes(f)[i];
    CALayer* layer = [CALayer layer];
    layer.position = CGPointMake(n->position[0], n->position[1]);
    layer.bounds = CGRectMake(n->bounds[0], n->bounds[1], n->bounds[2], n->bounds[3]);
    layer.anchorPoint = CGPointMake(n->anchor[0], n->anchor[1]);
    layer.contentsRect = CGRectMake(n->contentsRect[0], n->contentsRect[1], n->contentsRect[2],
                                    n->contentsRect[3]);
    layer.transform = Transform(n->transform);
    layer.sublayerTransform = Transform(n->sublayerTransform);
    layer.opacity = n->opacity;
    layer.contentsScale = n->contentsScale;
    layer.cornerRadius = n->cornerRadius;
    layer.hidden = (n->flags & 1) != 0;
    layer.masksToBounds = (n->flags & 2) != 0 && (i || (n->bounds[2] && n->bounds[3]));
    layer.geometryFlipped = (n->flags & 4) != 0;
    layer.contentsGravity = (n->flags & 8) ? kCAGravityTopLeft : kCAGravityResize;
    layer.minificationFilter = (n->flags & 16) ? kCAFilterNearest : kCAFilterLinear;
    CGColorRef color = CGColorCreateSRGB(n->background[0], n->background[1], n->background[2],
                                         n->background[3]);
    layer.backgroundColor = color;
    CGColorRelease(color);
    if (Surfaces(f)[i] != MACH_PORT_NULL) {
      IOSurfaceRef surface = IOSurfaceLookupFromMachPort(Surfaces(f)[i]);
      if (!surface || !IOSurfaceGetWidth(surface) || !IOSurfaceGetHeight(surface) ||
          IOSurfaceGetWidth(surface) > 32768 || IOSurfaceGetHeight(surface) > 32768) {
        if (surface) CFRelease(surface);
        [CATransaction commit];
        return;
      }
      layer.contents = (__bridge id)surface;
      CFRelease(surface);  // CALayer retains it; the caller destroys message rights.
    }
    [layers addObject:layer];
    if (i) [layers[(NSUInteger)n->parent] addSublayer:layer];
  }
  [w.root release];
  w.root = [layers[0] retain];
  w.frames++;
  if (sView && &w == sCurrent) sView.layer.sublayers = @[ w.root ];
  [CATransaction commit];
}

void Receive() {
  for (int batch = 0; batch < 16; batch++) {
    union {
      ZenProbeFrame frame;
      unsigned char bytes[sizeof(ZenProbeFrame) + MAX_TRAILER_SIZE];
    } buffer = {};
    mach_msg_return_t r = mach_msg(
        &buffer.frame.header,
        MACH_RCV_MSG | MACH_RCV_TIMEOUT | MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
            MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
        0, sizeof(buffer), sReceive, 0, MACH_PORT_NULL);
    if (r == MACH_RCV_TIMED_OUT) return;
    if (r != MACH_MSG_SUCCESS) continue;  // oversized messages are destroyed by the kernel
    if (!ZenProbeMessageLayout(&buffer.frame.header, sizeof(buffer))) continue;
    uint32_t sender = ZenProbeSenderPID(&buffer.frame.header, sizeof(buffer));
    if (Valid(&buffer.frame, sender)) {
      Worker& w = *Find(buffer.frame.pid);
      mach_port_t input = buffer.frame.header.msgh_remote_port;
      if (input && input != w.input &&
          mach_port_mod_refs(mach_task_self(), input, MACH_PORT_RIGHT_SEND, 1) == KERN_SUCCESS) {
        if (w.input) mach_port_deallocate(mach_task_self(), w.input);
        w.input = input;
      }
      Accept(&buffer.frame, w);
    }
    mach_msg_destroy(&buffer.frame.header);
  }
}

// Same RPC as the prototype host: COPY_SEND request + SEND_ONCE reply,
// reply authenticated by kernel audit pid. Runs on sInputQueue.
ZenProbeInputReply Exchange(ZenProbeInput request, mach_port_t destination, uint32_t worker) {
  ZenProbeInputReply answer = {};
  answer.status = UINT32_MAX;
  mach_port_t reply = MACH_PORT_NULL;
  kern_return_t kr = mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &reply);
  request.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_MAKE_SEND_ONCE);
  request.header.msgh_size = sizeof(request);
  request.header.msgh_remote_port = destination;
  request.header.msgh_local_port = reply;
  if (kr == KERN_SUCCESS)
    kr = mach_msg(&request.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(request), 0,
                  MACH_PORT_NULL, 500, MACH_PORT_NULL);
  if (kr == MACH_SEND_TIMED_OUT) mach_msg_destroy(&request.header);
  union {
    ZenProbeInputReply reply;
    unsigned char bytes[sizeof(ZenProbeInputReply) + MAX_TRAILER_SIZE];
  } buffer = {};
  if (kr == KERN_SUCCESS) {
    kr = mach_msg(&buffer.reply.header,
                  MACH_RCV_MSG | MACH_RCV_TIMEOUT | MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
                      MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
                  0, sizeof(buffer), reply, 2000, MACH_PORT_NULL);
    if (kr == KERN_SUCCESS) {
      const ZenProbeInputReply* r = &buffer.reply;
      if (r->header.msgh_size == sizeof(*r) && !(r->header.msgh_bits & MACH_MSGH_BITS_COMPLEX) &&
          ZenProbeSenderPID(&r->header, sizeof(buffer)) == worker && r->magic == ZEN_INPUT_PROBE_MAGIC &&
          r->pid == worker && r->slot == 0 && r->kind == request.kind &&
          r->sequence == request.sequence)
        answer = *r;
      if (ZenProbeMessageLayout(&buffer.reply.header, sizeof(buffer)))
        mach_msg_destroy(&buffer.reply.header);
    }
  }
  if (reply) mach_port_destroy(mach_task_self(), reply);
  return answer;
}

ZenProbeInput Request(uint32_t kind) {
  ZenProbeInput input = {};
  input.kind = kind;
  input.magic = ZEN_INPUT_PROBE_MAGIC;
  input.pid = getpid();
  input.slot = 0;
  input.token = sToken;
  input.sequence = ++sInputSequence;
  return input;
}

// Fire-and-forget, ordered by the serial queue.
void Send(ZenProbeInput input) {
  if (getenv("ZEN_PROFILE_OVERLAY_DEBUG"))
    fprintf(stderr, "ZEN_OVERLAY send kind=%u port=%u pid=%u\n", input.kind, sInputPort, sWorkerPID);
  if (!sInputPort || !sWorkerPID) return;
  mach_port_t destination = sInputPort;
  if (mach_port_mod_refs(mach_task_self(), destination, MACH_PORT_RIGHT_SEND, 1) != KERN_SUCCESS)
    return;
  uint32_t worker = sWorkerPID;
  dispatch_async(sInputQueue, ^{
    ZenProbeInputReply reply = Exchange(input, destination, worker);
    if (getenv("ZEN_PROFILE_OVERLAY_DEBUG"))
      fprintf(stderr, "ZEN_OVERLAY input kind=%u status=%u\n", input.kind, reply.status);
    mach_port_deallocate(mach_task_self(), destination);
  });
}

// ponytail: synchronous, bounded (2.5s) text query for IME geometry.
bool Query(NSRange range, ZenProbeInputReply* state) {
  if (!sInputPort || !sWorkerPID) return false;
  if (range.length > ZEN_INPUT_PROBE_CHARS ||
      (range.location != NSNotFound && range.location > UINT32_MAX)) return false;
  mach_port_t destination = sInputPort;
  if (mach_port_mod_refs(mach_task_self(), destination, MACH_PORT_RIGHT_SEND, 1) != KERN_SUCCESS)
    return false;
  ZenProbeInput request = Request(ZEN_INPUT_QUERY);
  request.replacementStart = range.location == NSNotFound ? UINT64_MAX : range.location;
  request.replacementLength = range.length;
  uint32_t worker = sWorkerPID;
  __block ZenProbeInputReply answer;
  dispatch_sync(sInputQueue, ^{ answer = Exchange(request, destination, worker); });
  mach_port_deallocate(mach_task_self(), destination);
  if (answer.status != 0 || answer.selectedStart > UINT32_MAX || answer.selectedLength > UINT32_MAX ||
      answer.markedLength > ZEN_INPUT_PROBE_CHARS || answer.actualLength > ZEN_INPUT_PROBE_CHARS ||
      (answer.markedStart != UINT64_MAX && answer.markedStart > UINT32_MAX) ||
      (answer.actualStart != UINT64_MAX && answer.actualStart > UINT32_MAX)) return false;
  for (double v : answer.caret) if (!std::isfinite(v) || fabs(v) > 1e7) return false;
  if (answer.caret[2] < 0 || answer.caret[3] < 0) return false;
  *state = answer;
  return true;
}

// Synchronous: AppKit wants the drop target's operation back right away.
NSDragOperation Drag(uint32_t kind, id<NSDraggingInfo> info, NSView* view) {
  if (!sInputPort || !sWorkerPID) return NSDragOperationNone;
  mach_port_t destination = sInputPort;
  if (mach_port_mod_refs(mach_task_self(), destination, MACH_PORT_RIGHT_SEND, 1) != KERN_SUCCESS)
    return NSDragOperationNone;
  ZenProbeInput request = Request(kind);
  NSPoint point = [view convertPoint:info.draggingLocation fromView:nil];
  request.x = point.x;
  request.y = point.y;
  request.keyCode = (uint32_t)(info.draggingSourceOperationMask & 0xff);
  uint32_t worker = sWorkerPID;
  __block ZenProbeInputReply answer;
  dispatch_sync(sInputQueue, ^{ answer = Exchange(request, destination, worker); });
  mach_port_deallocate(mach_task_self(), destination);
  return answer.status == 0 ? (NSDragOperation)answer.selectedStart : NSDragOperationNone;
}

NSRange Range(uint64_t start, uint64_t length) {
  return NSMakeRange(start == UINT64_MAX ? NSNotFound : (NSUInteger)start, (NSUInteger)length);
}

void Focus(bool focused) { Send(Request(focused ? ZEN_INPUT_FOCUS : ZEN_INPUT_BLUR)); }

void ForwardEvent(NSEvent* event, NSView* view) {
  ZenProbeInput input = Request((uint32_t)event.type);
  input.timestamp = event.timestamp;
  input.flags = event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
  if (event.type == NSEventTypeKeyDown || event.type == NSEventTypeKeyUp ||
      event.type == NSEventTypeFlagsChanged) {
    NSString* text = event.type == NSEventTypeFlagsChanged ? @"" : (event.characters ?: @"");
    NSString* ignoring =
        event.type == NSEventTypeFlagsChanged ? @"" : (event.charactersIgnoringModifiers ?: @"");
    if (text.length > ZEN_INPUT_PROBE_CHARS || ignoring.length > ZEN_INPUT_PROBE_CHARS) return;
    input.keyCode = event.keyCode;
    input.repeat = event.type == NSEventTypeKeyDown && event.isARepeat;
    input.length = (uint32_t)text.length;
    input.ignoringLength = (uint32_t)ignoring.length;
    [text getCharacters:input.characters range:NSMakeRange(0, text.length)];
    [ignoring getCharacters:input.ignoring range:NSMakeRange(0, ignoring.length)];
  } else {
    NSPoint point = [view convertPoint:event.locationInWindow fromView:nil];
    input.x = point.x;
    input.y = point.y;
    if (event.type == NSEventTypeScrollWheel) {
      input.deltaX = event.scrollingDeltaX;
      input.deltaY = event.scrollingDeltaY;
      input.precise = event.hasPreciseScrollingDeltas;
      input.phase = (uint32_t)event.phase;
      input.momentumPhase = (uint32_t)event.momentumPhase;
      Send(input);
      return;
    }
    input.clickCount = event.type == NSEventTypeMouseMoved ? 0 : (uint32_t)MIN(event.clickCount, 3);
    input.buttons = (uint32_t)(NSEvent.pressedMouseButtons & 31u);
    switch (event.type) {
      case NSEventTypeLeftMouseUp: input.buttons &= ~1u; break;
      case NSEventTypeRightMouseUp: input.buttons &= ~2u; break;
      case NSEventTypeOtherMouseUp: input.buttons &= ~4u; break;
      case NSEventTypeLeftMouseDown: case NSEventTypeLeftMouseDragged: input.buttons |= 1u; break;
      case NSEventTypeRightMouseDown: input.buttons |= 2u; break;
      case NSEventTypeOtherMouseDown: input.buttons |= 4u; break;
      default: break;
    }
  }
  Send(input);
}

bool ForwardText(uint32_t kind, id value, NSRange selection, NSRange replacement) {
  NSString* text = [value isKindOfClass:NSAttributedString.class] ? [value string] : value;
  if (![text isKindOfClass:NSString.class] || text.length > ZEN_INPUT_PROBE_CHARS ||
      replacement.length > ZEN_INPUT_PROBE_CHARS ||
      (replacement.location != NSNotFound && replacement.location > UINT32_MAX) ||
      (replacement.location == NSNotFound && replacement.length) ||
      selection.location > text.length || selection.length > text.length - selection.location)
    return false;
  ZenProbeInput input = Request(kind);
  input.length = (uint32_t)text.length;
  input.replacementStart = replacement.location == NSNotFound ? UINT64_MAX : replacement.location;
  input.replacementLength = replacement.length;
  input.selectionStart = selection.location;
  input.selectionLength = selection.length;
  [text getCharacters:input.characters range:NSMakeRange(0, text.length)];
  Send(input);
  return true;
}
}  // namespace

// Mouse/keyboard/IME surface for the hosted worker; mirrors the prototype
// GeckoView (scripts/prototype_gecko_layer_host.m).
@implementation ZenProfileOverlayView {
  BOOL _marked;
  BOOL _rawSent;
  NSEvent* _keyEvent;
  NSMutableIndexSet* _rawKeys;
}
- (BOOL)isFlipped { return YES; }
- (NSView*)hitTest:(NSPoint)point {
  NSView* hit = [super hitTest:point];
  return hit && NSPointInRect([self convertPoint:point fromView:self.superview], sHole) ? nil : hit;
}
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)acceptsFirstMouse:(NSEvent*)event { return YES; }
- (BOOL)becomeFirstResponder { Focus(true); return YES; }
- (BOOL)resignFirstResponder { [self finishComposition]; Focus(false); return YES; }
- (void)mouseDown:(NSEvent*)event {
  [self mouseDownNotify];
  ForwardEvent(event, self);
}
- (void)mouseUp:(NSEvent*)event { ForwardEvent(event, self); }
- (void)rightMouseDown:(NSEvent*)event { [self mouseDownNotify]; ForwardEvent(event, self); }
- (void)rightMouseUp:(NSEvent*)event { ForwardEvent(event, self); }
- (void)otherMouseDown:(NSEvent*)event { [self mouseDownNotify]; ForwardEvent(event, self); }
- (void)otherMouseUp:(NSEvent*)event { ForwardEvent(event, self); }
- (void)mouseMoved:(NSEvent*)event { ForwardEvent(event, self); }
- (void)mouseEntered:(NSEvent*)event {
  if (nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService()) {
    obs->NotifyObservers(nullptr, "zen-profile-overlay-mouseenter", nullptr);
  }
}
- (void)updateTrackingAreas {
  [super updateTrackingAreas];
  for (NSTrackingArea* area in self.trackingAreas) [self removeTrackingArea:area];
  [self addTrackingArea:[[[NSTrackingArea alloc]
                            initWithRect:NSZeroRect
                                 options:NSTrackingMouseMoved | NSTrackingMouseEnteredAndExited |
                                         NSTrackingActiveAlways | NSTrackingInVisibleRect
                                   owner:self
                                userInfo:nil] autorelease]];
}
- (void)mouseDownNotify {
  if (nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService()) {
    obs->NotifyObservers(nullptr, "zen-profile-overlay-mousedown", nullptr);
  }
  if (self.window.firstResponder != self) [self.window makeFirstResponder:self];
}
- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)info { return Drag(ZEN_INPUT_DRAG_ENTER, info, self); }
- (NSDragOperation)draggingUpdated:(id<NSDraggingInfo>)info { return Drag(ZEN_INPUT_DRAG_OVER, info, self); }
- (void)draggingExited:(id<NSDraggingInfo>)info { Drag(ZEN_INPUT_DRAG_EXIT, info, self); }
- (BOOL)performDragOperation:(id<NSDraggingInfo>)info { return Drag(ZEN_INPUT_DRAG_DROP, info, self) != 0; }
- (void)scrollWheel:(NSEvent*)event { ForwardEvent(event, self); }
- (void)mouseDragged:(NSEvent*)event { ForwardEvent(event, self); }
- (void)flagsChanged:(NSEvent*)event { ForwardEvent(event, self); }
// The manager's own shortcuts (Spaces, sidebar, tab list) win over the page.
- (BOOL)managerShortcut:(NSEvent*)event {
  NSEventModifierFlags m = event.modifierFlags;
  if (!(m & (NSEventModifierFlagCommand | NSEventModifierFlagControl))) return NO;
  static NSDictionary<NSNumber*, NSString*>* vks = @{
    @123 : @"VK_LEFT", @124 : @"VK_RIGHT", @125 : @"VK_DOWN", @126 : @"VK_UP", @48 : @"VK_TAB",
    @53 : @"VK_ESCAPE", @51 : @"VK_BACK", @117 : @"VK_DELETE", @115 : @"VK_HOME", @96 : @"VK_F5",
    @99 : @"VK_F3", @122 : @"VK_F1", @103 : @"VK_F11"
  };
  NSMutableArray* mods = [NSMutableArray array];
  if (m & NSEventModifierFlagControl) [mods addObject:@"control"];
  if (m & NSEventModifierFlagCommand) [mods addObject:@"accel"];
  if (m & NSEventModifierFlagShift) [mods addObject:@"shift"];
  if (m & NSEventModifierFlagOption) [mods addObject:@"alt"];
  NSArray* fields = @[
    [mods componentsJoinedByString:@","],
    [event charactersByApplyingModifiers:0].lowercaseString ?: @"",
    event.charactersIgnoringModifiers.lowercaseString ?: @"", vks[@(event.keyCode)] ?: @""
  ];
  NSData* json = [NSJSONSerialization dataWithJSONObject:fields options:0 error:nil];
  nsCOMPtr<nsISupportsPRBool> handled = do_CreateInstance(NS_SUPPORTS_PRBOOL_CONTRACTID);
  nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService();
  if (!json || !handled || !obs) return NO;
  NSString* s = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
  obs->NotifyObservers(handled, "zen-profile-overlay-key", NS_ConvertUTF8toUTF16(s.UTF8String).get());
  bool result = false;
  handled->GetData(&result);
  return result;
}
- (BOOL)performKeyEquivalent:(NSEvent*)event {
  if (self.window.firstResponder != self || event.type != NSEventTypeKeyDown) return NO;
  if (!(event.modifierFlags & (NSEventModifierFlagCommand | NSEventModifierFlagControl))) return NO;
  if (![self managerShortcut:event]) [self forwardRawKeyDown:event];
  return YES;
}
- (void)keyDown:(NSEvent*)event {
  if ([self managerShortcut:event]) return;
  _keyEvent = event;
  _rawSent = NO;
  BOOL consumed = [self.inputContext handleEvent:event];
  if (!consumed && !_rawSent) [self forwardRawKeyDown:event];
  _keyEvent = nil;
}
- (void)forwardRawKeyDown:(NSEvent*)event {
  if (!_rawKeys) _rawKeys = [NSMutableIndexSet new];
  [_rawKeys addIndex:event.keyCode];
  _rawSent = YES;
  ForwardEvent(event, self);
}
- (void)keyUp:(NSEvent*)event {
  // IME-consumed downs have no raw Gecko key-up counterpart.
  if ([_rawKeys containsIndex:event.keyCode]) {
    [_rawKeys removeIndex:event.keyCode];
    ForwardEvent(event, self);
  }
}
- (void)doCommandBySelector:(SEL)selector {
  if (_keyEvent) [self forwardRawKeyDown:_keyEvent];
}
- (void)setMarkedText:(id)value selectedRange:(NSRange)selection replacementRange:(NSRange)replacement {
  if (ForwardText(ZEN_INPUT_MARK, value, selection, replacement)) _marked = YES;
}
- (void)insertText:(id)value replacementRange:(NSRange)replacement {
  if (ForwardText(ZEN_INPUT_INSERT, value, NSMakeRange(0, 0), replacement)) _marked = NO;
}
- (void)unmarkText {
  ForwardText(ZEN_INPUT_UNMARK, @"", NSMakeRange(0, 0), NSMakeRange(NSNotFound, 0));
  _marked = NO;
}
- (void)finishComposition {
  if (_marked) {
    [self unmarkText];
    [self.inputContext discardMarkedText];
  }
}
- (BOOL)hasMarkedText { return self.markedRange.location != NSNotFound; }
- (NSRange)markedRange {
  ZenProbeInputReply state;
  return Query(NSMakeRange(NSNotFound, 0), &state) ? Range(state.markedStart, state.markedLength)
                                                   : NSMakeRange(NSNotFound, 0);
}
- (NSRange)selectedRange {
  ZenProbeInputReply state;
  return Query(NSMakeRange(NSNotFound, 0), &state) ? Range(state.selectedStart, state.selectedLength)
                                                   : NSMakeRange(NSNotFound, 0);
}
- (NSArray<NSAttributedStringKey>*)validAttributesForMarkedText {
  return @[ NSUnderlineStyleAttributeName ];
}
- (NSAttributedString*)attributedSubstringForProposedRange:(NSRange)range
                                               actualRange:(NSRangePointer)actual {
  // ponytail: no surrounding-text/reconversion, same as the prototype bridge.
  if (actual) *actual = NSMakeRange(NSNotFound, 0);
  return nil;
}
- (NSUInteger)characterIndexForPoint:(NSPoint)point { return NSNotFound; }
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actual {
  ZenProbeInputReply state;
  if (!Query(range, &state)) {
    if (actual) *actual = NSMakeRange(NSNotFound, 0);
    return NSZeroRect;
  }
  if (actual) *actual = Range(state.actualStart, state.actualLength);
  // Worker ChildView-local == this view's local: worker window is sized to us.
  NSRect local = NSMakeRect(state.caret[0], state.caret[1], state.caret[2], state.caret[3]);
  return [self.window convertRectToScreen:[self convertRect:local toView:nil]];
}
@end

namespace {
}  // namespace

namespace zen::profileoverlay {

nsresult Start(mozIDOMWindowProxy* aWindow, nsACString& aDescriptor) {
  if (!Resolve(aWindow)) return NS_ERROR_INVALID_ARG;
  if (!sReceive) {
    kern_return_t kr = mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &sReceive);
    mach_port_limits_t limits = {.mpl_qlimit = 64};
    if (kr == KERN_SUCCESS)
      kr = mach_port_set_attributes(mach_task_self(), sReceive, MACH_PORT_LIMITS_INFO,
                                    (mach_port_info_t)&limits, MACH_PORT_LIMITS_INFO_COUNT);
    if (kr == KERN_SUCCESS)
      kr = mach_port_insert_right(mach_task_self(), sReceive, sReceive, MACH_MSG_TYPE_MAKE_SEND);
    nsPrintfCString name("org.zen.profile-overlay.%d", getpid());
    if (kr == KERN_SUCCESS)
      kr = bootstrap_register(bootstrap_port, const_cast<char*>(name.get()), sReceive);
    if (kr != KERN_SUCCESS) {
      if (sReceive) mach_port_destroy(mach_task_self(), sReceive);
      sReceive = MACH_PORT_NULL;
      return NS_ERROR_FAILURE;
    }
    sInputQueue = dispatch_queue_create("org.zen.profile-overlay.input", DISPATCH_QUEUE_SERIAL);
    arc4random_buf(&sToken, sizeof(sToken));
    sToken |= 1;
    // Worker popups float above every app; close them when the user leaves Ka.
    [NSWorkspace.sharedWorkspace.notificationCenter
        addObserverForName:NSWorkspaceDidActivateApplicationNotification
                    object:nil
                     queue:NSOperationQueue.mainQueue
                usingBlock:^(NSNotification* note) {
                  pid_t pid = [note.userInfo[NSWorkspaceApplicationKey] processIdentifier];
                  nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService();
                  if (pid != getpid() && !Find((uint32_t)pid) && obs)
                    obs->NotifyObservers(nullptr, "zen-profile-overlay-app-left", nullptr);
                }];
    if (nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService()) {
      obs->AddObserver(new CursorObserver(), "zen-profile-overlay-cursor", false);
    }
    sTimer = [NSTimer scheduledTimerWithTimeInterval:0.016
                                             repeats:YES
                                               block:^(NSTimer*) { Receive(); }];
  }
  aDescriptor = nsPrintfCString("org.zen.profile-overlay.%d %llu", getpid(),
                                (unsigned long long)sToken);
  return NS_OK;
}

// Make aWorkerPID the shown worker, admitting it if new. Exited workers are
// dropped here, so the table needs no separate retire call.
nsresult Admit(uint32_t aWorkerPID) {
  if (!sReceive || !aWorkerPID) return NS_ERROR_NOT_AVAILABLE;
  for (Worker& w : sWorkers)
    if (w.pid && w.pid != aWorkerPID && kill((pid_t)w.pid, 0) != 0 && errno == ESRCH) Forget(w);
  Worker* w = Find(aWorkerPID);
  if (!w)
    for (Worker& slot : sWorkers)
      if (!slot.pid) {
        w = &slot;
        w->pid = aWorkerPID;
        break;
      }
  if (!w) return NS_ERROR_OUT_OF_MEMORY;
  if (sCurrent != w && sView && sView.window.firstResponder == sView) Focus(false);
  if (sCurrent != w) sResizePending = true;
  sCurrent = w;
  if (sView) sView.layer.sublayers = w->root ? @[ w->root ] : @[];
  return NS_OK;
}

nsresult Show(mozIDOMWindowProxy* aWindow, double aX, double aY, double aW, double aH) {
  NSWindow* window = Resolve(aWindow);
  if (!window || !sReceive || !(aW > 0) || !(aH > 0)) return NS_ERROR_INVALID_ARG;
  NSView* content = window.contentView;
  // Chrome CSS px are top-left based; convert to the content view's coordinates.
  NSRect frame = NSMakeRect(aX, content.isFlipped ? aY : content.bounds.size.height - aY - aH, aW,
                            aH);
  if (!sView) {
    sView = [[ZenProfileOverlayView alloc] initWithFrame:frame];
    sView.wantsLayer = YES;
    sView.layer.masksToBounds = YES;
    sView.layer.backgroundColor = NSColor.windowBackgroundColor.CGColor;
    [sView registerForDraggedTypes:@[
      NSPasteboardTypeFileURL, NSPasteboardTypeURL, NSPasteboardTypeString, NSPasteboardTypeHTML,
      NSPasteboardTypePNG, NSPasteboardTypeTIFF
    ]];
  }
  if (sView.superview != content) [content addSubview:sView positioned:NSWindowAbove relativeTo:nil];
  if (sResizePending || !NSEqualSizes(sView.frame.size, frame.size)) {
    sResizePending = false;
    ZenProbeInput resize = Request(ZEN_INPUT_RESIZE);
    resize.x = aW;
    resize.y = aH;
    Send(resize);
  }
  sView.frame = frame;
  sView.hidden = NO;
  sView.layer.sublayers = sCurrent && sCurrent->root ? @[ sCurrent->root ] : @[];
  return NS_OK;
}

nsresult SetHole(double aX, double aY, double aW, double aH) {
  if (!sView) return NS_OK;
  NSView* content = sView.superview;
  sHole = aW > 0 && aH > 0 && content
              ? [sView convertRect:NSMakeRect(aX, content.isFlipped ? aY : content.bounds.size.height - aY - aH, aW, aH)
                          fromView:content]
              : NSZeroRect;
  if (NSIsEmptyRect(sHole)) {
    sView.layer.mask = nil;
    return NS_OK;
  }
  CAShapeLayer* mask = [CAShapeLayer layer];
  CGMutablePathRef path = CGPathCreateMutable();
  CGPathAddRect(path, nullptr, sView.bounds);
  CGPathAddRect(path, nullptr, sHole);
  mask.path = path;
  mask.fillRule = kCAFillRuleEvenOdd;
  CGPathRelease(path);
  sView.layer.mask = mask;
  return NS_OK;
}

nsresult FocusView() {
  if (sView && !sView.hidden) [sView.window makeFirstResponder:sView];
  return NS_OK;
}

nsresult Hide() {
  if (sView && sView.window.firstResponder == sView) {
    [sView.window makeFirstResponder:sView.window.contentView];
  }
  if (sView) sView.hidden = YES;
  return NS_OK;
}

uint64_t FrameCount() { return sCurrent ? sCurrent->frames : 0; }

}  // namespace zen::profileoverlay

