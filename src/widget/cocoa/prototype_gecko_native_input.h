// Local opt-in native input probe, included only by nsCocoaWindow.mm (manual retain/release).
#pragma once
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#include <cmath>
#include <atomic>
#include <memory>
#include "prototype_gecko_layer_protocol.h"

static std::atomic<mach_port_t> sZenInputPort{MACH_PORT_NULL};
static dispatch_source_t sZenInputSource;
static NSMapTable* sZenInputTargets;
static uint64_t sZenInputSequence;
static std::atomic<uint32_t> sZenInputPending{0};
static char sZenInputFocused, sZenInputButtons;

extern "C" mach_port_t ZenProbeInputPort() { return sZenInputPort.load(std::memory_order_acquire); }

// A drag over the host's overlay, replayed on this window's view: the drag
// pasteboard is system-wide, so the page reads the real dragged data.
@interface ZenForwardedDrag : NSObject
@property NSPoint location;
@property NSDragOperation mask;
@property BOOL animatesToDestination;
@end
@implementation ZenForwardedDrag
- (NSPasteboard*)draggingPasteboard { return [NSPasteboard pasteboardWithName:NSPasteboardNameDrag]; }
- (NSPoint)draggingLocation { return self.location; }
- (NSDragOperation)draggingSourceOperationMask { return self.mask; }
- (id)draggingSource { return nil; }
- (NSWindow*)draggingDestinationWindow { return nil; }
- (NSInteger)draggingSequenceNumber { return 0; }
- (void)enumerateDraggingItemsWithOptions:(NSDraggingItemEnumerationOptions)options
                                  forView:(NSView*)view
                                  classes:(NSArray*)classes
                            searchOptions:(NSDictionary*)searchOptions
                               usingBlock:(void (^)(NSDraggingItem*, NSInteger, BOOL*))block {}
@end

static uint32_t ZenProbeDispatchInput(const ZenProbeInput& message, ZenProbeInputReply& state) {
  NSWindow* window = [sZenInputTargets objectForKey:@"window"];
  NSView* view = [sZenInputTargets objectForKey:@"view"];
  if (!window) return 2;
  if (!view) return 9;
  if (window.attachedSheet) return 12;
  if (NSApp.modalWindow) return 13;
  if (message.kind == ZEN_INPUT_FOCUS || message.kind == ZEN_INPUT_BLUR) {
    BOOL focused = message.kind == ZEN_INPUT_FOCUS;
    objc_setAssociatedObject(window, &sZenInputFocused, @(focused), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    if (focused) {
      fprintf(stderr, "ZEN_NATIVE_FOCUS stage=responder_begin slot=%u sequence=%llu\n", message.slot, (unsigned long long)message.sequence);
      if (![window makeFirstResponder:view]) return 3;
      fprintf(stderr, "ZEN_NATIVE_FOCUS stage=activate_begin slot=%u sequence=%llu\n", message.slot, (unsigned long long)message.sequence);
      [TopLevelWindowData activateInWindow:window];
      fprintf(stderr, "ZEN_NATIVE_FOCUS stage=delegate_begin slot=%u sequence=%llu\n", message.slot, (unsigned long long)message.sequence);
      [window.delegate windowDidBecomeKey:[NSNotification notificationWithName:NSWindowDidBecomeKeyNotification object:window]];
      fprintf(stderr, "ZEN_NATIVE_FOCUS stage=done slot=%u sequence=%llu\n", message.slot, (unsigned long long)message.sequence);
    } else {
      fprintf(stderr, "ZEN_NATIVE_FOCUS stage=deactivate_begin slot=%u sequence=%llu\n", message.slot, (unsigned long long)message.sequence);
      [TopLevelWindowData deactivateInWindow:window];
      [window.delegate windowDidResignKey:[NSNotification notificationWithName:NSWindowDidResignKeyNotification object:window]];
    }
    return 0;
  }
  if (message.kind == ZEN_INPUT_RESIZE) {
    if (!std::isfinite(message.x) || !std::isfinite(message.y) || message.x < 1 || message.y < 1 ||
        message.x > 16384 || message.y > 16384) return 5;
    [window setContentSize:NSMakeSize(message.x, message.y)];
    return 0;
  }
  // Hover and drags reach the page whether or not it has focus.
  if (message.kind == NSEventTypeMouseMoved || message.kind >= ZEN_INPUT_DRAG_ENTER) {
  } else if (![objc_getAssociatedObject(window, &sZenInputFocused) boolValue]) return 4;
  if (message.kind >= ZEN_INPUT_DRAG_ENTER && message.kind <= ZEN_INPUT_DRAG_DROP) {
    NSView* content = view;
    if (!std::isfinite(message.x) || !std::isfinite(message.y)) return 5;
    NSPoint p = NSMakePoint(message.x, content.isFlipped ? message.y : content.bounds.size.height - message.y);
    ZenForwardedDrag* drag = [[[ZenForwardedDrag alloc] init] autorelease];
    drag.location = [content convertPoint:p toView:nil];
    drag.mask = (NSDragOperation)message.keyCode;
    id<NSDraggingDestination> target = (id<NSDraggingDestination>)view;
    switch (message.kind) {
      case ZEN_INPUT_DRAG_ENTER: state.selectedStart = [target draggingEntered:(id<NSDraggingInfo>)drag]; break;
      case ZEN_INPUT_DRAG_OVER: state.selectedStart = [target draggingUpdated:(id<NSDraggingInfo>)drag]; break;
      case ZEN_INPUT_DRAG_EXIT: [target draggingExited:(id<NSDraggingInfo>)drag]; break;
      case ZEN_INPUT_DRAG_DROP:
        state.selectedStart = [target performDragOperation:(id<NSDraggingInfo>)drag];
        break;
    }
    return 0;
  }
  if (message.kind >= ZEN_INPUT_MARK && message.kind <= ZEN_INPUT_QUERY) {
    if (message.length > ZEN_INPUT_PROBE_CHARS || message.replacementLength > ZEN_INPUT_PROBE_CHARS ||
        (message.replacementStart != UINT64_MAX && message.replacementStart > UINT32_MAX) ||
        (message.replacementStart == UINT64_MAX && message.replacementLength)) return 6;
    id<NSTextInputClient> client = (id<NSTextInputClient>)view;
    NSRange replacement = NSMakeRange(message.replacementStart == UINT64_MAX ? NSNotFound : message.replacementStart, message.replacementLength);
    if (message.kind == ZEN_INPUT_QUERY) {
      NSRange selected = [client selectedRange], marked = [client markedRange];
      if (selected.location == NSNotFound) return 15;
      NSRange actual = NSMakeRange(NSNotFound, 0);
      NSRect screen = [client firstRectForCharacterRange:replacement.location == NSNotFound ? selected : replacement actualRange:&actual];
      NSRect local = [view convertRect:[window convertRectFromScreen:screen] fromView:nil];
      state.selectedStart = selected.location; state.selectedLength = selected.length;
      state.markedStart = marked.location == NSNotFound ? UINT64_MAX : marked.location; state.markedLength = marked.length;
      state.actualStart = actual.location == NSNotFound ? UINT64_MAX : actual.location; state.actualLength = actual.length;
      state.caret[0] = local.origin.x; state.caret[1] = local.origin.y;
      state.caret[2] = local.size.width; state.caret[3] = local.size.height;
      return 0;
    }
    if (message.kind == ZEN_INPUT_UNMARK) { [client unmarkText]; return 0; }
    NSString* text = [[[NSString alloc] initWithCharacters:message.characters length:message.length] autorelease];
    if (message.kind == ZEN_INPUT_INSERT) { [client insertText:text replacementRange:replacement]; return 0; }
    if (message.selectionStart > message.length || message.selectionLength > message.length-message.selectionStart) return 6;
    NSAttributedString* marked = [[[NSAttributedString alloc] initWithString:text
      attributes:@{NSUnderlineStyleAttributeName: @(NSUnderlineStyleSingle)}] autorelease];
    [client setMarkedText:marked selectedRange:NSMakeRange(message.selectionStart, message.selectionLength) replacementRange:replacement];
    return 0;
  }
  NSEvent* event = nil;
  NSEventType type = static_cast<NSEventType>(message.kind);
  if (type == NSEventTypeLeftMouseDown || type == NSEventTypeLeftMouseUp || type == NSEventTypeLeftMouseDragged ||
      type == NSEventTypeMouseMoved || type == NSEventTypeRightMouseDown || type == NSEventTypeRightMouseUp ||
      type == NSEventTypeOtherMouseDown || type == NSEventTypeOtherMouseUp) {
    NSView* content = view;
    if (!std::isfinite(message.x) || !std::isfinite(message.y) || message.x < 0 || message.y < 0 ||
        message.x > content.bounds.size.width || message.y > content.bounds.size.height) return 5;
    NSPoint p = NSMakePoint(message.x, content.isFlipped ? message.y : content.bounds.size.height - message.y);
    p = [content convertPoint:p toView:nil];
    event = [NSEvent mouseEventWithType:type location:p modifierFlags:message.flags timestamp:message.timestamp
      windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:message.clickCount
      pressure:message.buttons ? 1 : 0];
  } else if (type == NSEventTypeScrollWheel) {
    NSView* content = view;
    if (!std::isfinite(message.x) || !std::isfinite(message.y) || message.x < 0 || message.y < 0 ||
        message.x > content.bounds.size.width || message.y > content.bounds.size.height ||
        !std::isfinite(message.deltaX) || !std::isfinite(message.deltaY) ||
        fabs(message.deltaX) > 1e5 || fabs(message.deltaY) > 1e5) return 5;
    NSPoint p = NSMakePoint(message.x, content.isFlipped ? message.y : content.bounds.size.height - message.y);
    NSPoint local = [content convertPoint:p toView:nil];
    CGEventRef cg = CGEventCreateScrollWheelEvent2(nullptr,
      message.precise ? kCGScrollEventUnitPixel : kCGScrollEventUnitLine, 2,
      (int32_t)lround(message.deltaY), (int32_t)lround(message.deltaX), 0);
    if (!cg) return 6;
    // As SynthesizeNativeMouseScrollEvent: with _window set below, AppKit
    // reads the CG location back as (x, mainScreenHeight - y) in the window.
    CGEventSetLocation(cg, CGPointMake(local.x, NSMaxY(NSScreen.screens.firstObject.frame) - local.y));
    CGEventSetFlags(cg, (CGEventFlags)message.flags);
    CGEventSetIntegerValueField(cg, kCGScrollWheelEventIsContinuous, message.precise ? 1 : 0);
    if (message.precise) {
      CGEventSetDoubleValueField(cg, kCGScrollWheelEventFixedPtDeltaAxis1, message.deltaY);
      CGEventSetDoubleValueField(cg, kCGScrollWheelEventFixedPtDeltaAxis2, message.deltaX);
      CGEventSetDoubleValueField(cg, kCGScrollWheelEventPointDeltaAxis1, message.deltaY);
      CGEventSetDoubleValueField(cg, kCGScrollWheelEventPointDeltaAxis2, message.deltaX);
    }
    // NSEventPhase -> CGScrollPhase / CGMomentumScrollPhase.
    auto scrollPhase = [](uint32_t p) -> int64_t {
      return (p & NSEventPhaseBegan ? kCGScrollPhaseBegan : 0) | (p & NSEventPhaseChanged ? kCGScrollPhaseChanged : 0) |
             (p & NSEventPhaseEnded ? kCGScrollPhaseEnded : 0) | (p & NSEventPhaseCancelled ? kCGScrollPhaseCancelled : 0) |
             (p & NSEventPhaseMayBegin ? kCGScrollPhaseMayBegin : 0);
    };
    auto momentumPhase = [](uint32_t p) -> int64_t {
      return p & NSEventPhaseBegan ? kCGMomentumScrollPhaseBegin
           : p & (NSEventPhaseChanged | NSEventPhaseStationary) ? kCGMomentumScrollPhaseContinue
           : p & (NSEventPhaseEnded | NSEventPhaseCancelled) ? kCGMomentumScrollPhaseEnd : kCGMomentumScrollPhaseNone;
    };
    CGEventSetIntegerValueField(cg, kCGScrollWheelEventScrollPhase, scrollPhase(message.phase));
    CGEventSetIntegerValueField(cg, kCGScrollWheelEventMomentumPhase, momentumPhase(message.momentumPhase));
    event = [NSEvent eventWithCGEvent:cg];
    CFRelease(cg);
    if (!event) return 6;
    [event setValue:window forKey:@"_window"];
  } else if (type == NSEventTypeKeyDown || type == NSEventTypeKeyUp || type == NSEventTypeFlagsChanged) {
    if (message.keyCode > 255 || message.length > ZEN_INPUT_PROBE_CHARS || message.ignoringLength > ZEN_INPUT_PROBE_CHARS) return 6;
    NSString* text = [[[NSString alloc] initWithCharacters:message.characters length:message.length] autorelease];
    NSString* ignoring = [[[NSString alloc] initWithCharacters:message.ignoring length:message.ignoringLength] autorelease];
    event = [NSEvent keyEventWithType:type location:NSZeroPoint modifierFlags:message.flags timestamp:message.timestamp
      windowNumber:window.windowNumber context:nil characters:text charactersIgnoringModifiers:ignoring
      isARepeat:message.repeat != 0 keyCode:message.keyCode];
  } else return 7;
  objc_setAssociatedObject(event, &sZenInputButtons, @(message.buttons), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  if (message.kind == NSEventTypeLeftMouseDown) {
    NSView* hit = [window.contentView hitTest:[window.contentView convertPoint:event.locationInWindow fromView:nil]];
    fprintf(stderr, "ZEN_NATIVE_ROUTE window=%s view=%s hit=%s key=%d main=%d active=%d x=%.1f y=%.1f\n",
      class_getName(window.class), class_getName(view.class), class_getName(hit.class), window.isKeyWindow,
      window.isMainWindow, NSApp.isActive, event.locationInWindow.x, event.locationInWindow.y);
  }
  if (MaybeDropEventForModalWindow(event, window.delegate)) return 2;
  // ponytail: unordered backing windows don't route NSWindow events; full key equivalents/hover need host integration.
  switch (type) {
    case NSEventTypeLeftMouseDown: [view mouseDown:event]; break;
    case NSEventTypeLeftMouseUp: [view mouseUp:event]; break;
    case NSEventTypeLeftMouseDragged: [view mouseDragged:event]; break;
    case NSEventTypeMouseMoved: [view performSelector:@selector(handleMouseMoved:) withObject:event]; break;
    case NSEventTypeRightMouseDown: [view rightMouseDown:event]; break;
    case NSEventTypeRightMouseUp: [view rightMouseUp:event]; break;
    case NSEventTypeOtherMouseDown: [view otherMouseDown:event]; break;
    case NSEventTypeOtherMouseUp: [view otherMouseUp:event]; break;
    case NSEventTypeKeyDown: [view keyDown:event]; break;
    case NSEventTypeKeyUp: [view keyUp:event]; break;
    case NSEventTypeFlagsChanged: [view flagsChanged:event]; break;
    case NSEventTypeScrollWheel: [view scrollWheel:event]; break;
    default: return 7;
  }
  return 0;
}

static void ZenProbeReplyInput(ZenProbeInput& message, uint32_t status, const ZenProbeInputReply* state = nullptr) {
  ZenProbeInputReply reply = state ? *state : ZenProbeInputReply{};
  reply.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_MOVE_SEND_ONCE, 0);
  reply.header.msgh_remote_port = message.header.msgh_remote_port;
  reply.header.msgh_size = sizeof(reply);
  reply.magic = ZEN_INPUT_PROBE_MAGIC;
  reply.pid = getpid(); reply.slot = message.slot; reply.kind = message.kind;
  reply.sequence = message.sequence; reply.status = status;
  mach_msg_return_t result = mach_msg(&reply.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
    sizeof(reply), 0, MACH_PORT_NULL, 100, MACH_PORT_NULL);
  message.header.msgh_remote_port = MACH_PORT_NULL;
  if (result != KERN_SUCCESS) mach_msg_destroy(&reply.header);
}

static void ZenProbeReceiveInput() {
  for (int batch = 0; batch < 16; ++batch) {
    union { ZenProbeInput input; unsigned char bytes[sizeof(ZenProbeInput) + MAX_TRAILER_SIZE]; } buffer = {};
    auto& message = buffer.input;
    kern_return_t result = mach_msg(&message.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT |
      MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) | MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
      0, sizeof(buffer), sZenInputPort.load(std::memory_order_acquire), 0, MACH_PORT_NULL);
    if (result == MACH_RCV_TIMED_OUT) return;
    if (result != KERN_SUCCESS) continue;
    bool layout = ZenProbeMessageLayout(&message.header, sizeof(buffer));
    uint32_t peer = ZenProbeSenderPID(&message.header, sizeof(buffer));
    const char* host = getenv("ZEN_GECKO_LAYER_HOST_PID");
    const char* token = getenv("ZEN_GECKO_LAYER_TOKEN");
    const char* slot = getenv("ZEN_GECKO_LAYER_SLOT");
    bool valid = layout && host && token && slot && message.header.msgh_size == sizeof(message) &&
      !(message.header.msgh_bits & MACH_MSGH_BITS_COMPLEX) &&
      MACH_MSGH_BITS_REMOTE(message.header.msgh_bits) == MACH_MSG_TYPE_PORT_SEND_ONCE && message.magic == ZEN_INPUT_PROBE_MAGIC &&
      peer == strtoul(host, nullptr, 10) && message.pid == peer && message.slot == strtoul(slot, nullptr, 10) &&
      message.token == strtoull(token, nullptr, 10) && message.sequence > sZenInputSequence &&
      !(message.flags & ~static_cast<uint64_t>(NSEventModifierFlagDeviceIndependentFlagsMask)) &&
      std::isfinite(message.timestamp) && message.timestamp >= 0 && message.clickCount <= 3 && message.repeat <= 1 && message.buttons <= 31;
    bool replyAllowed = layout && host && peer == strtoul(host, nullptr, 10) && message.header.msgh_remote_port &&
      MACH_MSGH_BITS_REMOTE(message.header.msgh_bits) == MACH_MSG_TYPE_PORT_SEND_ONCE;
    if (valid && sZenInputPending.fetch_add(1) < 64) {
      sZenInputSequence = message.sequence;
      auto release = [](ZenProbeInput* request) {
        mach_msg_destroy(&request->header); delete request; sZenInputPending.fetch_sub(1);
      };
      std::unique_ptr<ZenProbeInput, decltype(release)> owned(new ZenProbeInput(message), release);
      message.header.msgh_remote_port = MACH_PORT_NULL; // Reply right now belongs to the runnable, including cancellation.
      nsresult dispatched = NS_DispatchToMainThread(NS_NewRunnableFunction("ZenProbeDispatchInput", [owned = std::move(owned)] {
        uint32_t status = 8;
        ZenProbeInputReply state = {};
        @try { status = ZenProbeDispatchInput(*owned, state); }
        @catch (NSException* exception) { (void)exception; }
        ZenProbeReplyInput(*owned, status, &state);
      }));
      if (NS_FAILED(dispatched)) fprintf(stderr, "ZEN_NATIVE_INPUT main_dispatch_failed\n");
    } else {
      if (valid) sZenInputPending.fetch_sub(1);
      if (replyAllowed) ZenProbeReplyInput(message, valid ? 14 : 1);
    }
    if (layout) mach_msg_destroy(&message.header);
  }
}

static void ZenProbeInstallInput(NSWindow* window, NSView* view) {
  if (!getenv("ZEN_GECKO_LAYER_HOST_PID")) return;
  if (!sZenInputTargets) sZenInputTargets = [[NSMapTable alloc] initWithKeyOptions:NSPointerFunctionsStrongMemory
    valueOptions:NSPointerFunctionsWeakMemory capacity:2];
  [sZenInputTargets setObject:window forKey:@"window"];
  [sZenInputTargets setObject:view forKey:@"view"];
  if (!objc_getAssociatedObject(window, &sZenInputFocused))
    objc_setAssociatedObject(window, &sZenInputFocused, @NO, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  if (sZenInputPort.load(std::memory_order_acquire)) return;
  mach_port_t port;
  if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &port) != KERN_SUCCESS ||
      mach_port_insert_right(mach_task_self(), port, port, MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS) _exit(70);
  // ponytail: process-lifetime endpoint for one top-level backing widget per disposable worker.
  sZenInputSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_MACH_RECV, port, 0,
    dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0));
  // Drain on the source handler; enqueue only authenticated packets on Gecko's own main event target.
  dispatch_source_set_event_handler(sZenInputSource, ^{ ZenProbeReceiveInput(); });
  sZenInputPort.store(port, std::memory_order_release);
  dispatch_resume(sZenInputSource);
}
