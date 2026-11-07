// Local-only real-Gecko layer receiver. No synthetic producer or pixel copying.
// Build with Xcode clang + its SDK; frameworks Cocoa QuartzCore IOSurface.
#import <Cocoa/Cocoa.h>
#import <Carbon/Carbon.h>
#import <QuartzCore/QuartzCore.h>
#import <IOSurface/IOSurface.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <servers/bootstrap.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <signal.h>
#include <stddef.h>
#include <unistd.h>
#include "prototype_gecko_layer_protocol.h"

static NSWindow *hostWindow;
static NSView *hostView;
static CALayer *roots[2];
static NSArray<NSDictionary *> *trees[2];
static uint32_t allowedPID[2], lastPID[2], nodeCounts[2], surfaceCounts[2];
static uint64_t expectedToken, rootIDs[2], frameCounters[2], rejected;
static double lastReport[2];
static NSUInteger selectedSlot;
static BOOL stopping, hostReady;
static mach_port_t receivePort, inputPorts[2];
static dispatch_queue_t inputQueue;
static uint64_t inputSequence;
static NSUInteger pendingInputs;

static void emit(NSDictionary *object) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
  if (!data) { fprintf(stderr, "JSON serialization failed: %s\n", error.description.UTF8String); return; }
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}
static void fail(NSString *reason) { emit(@{@"event": @"error", @"reason": reason}); }
static void stop(void) {
  if (stopping) return;
  stopping = YES;
  [NSApp stop:nil];
  [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined
    location:NSZeroPoint modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
    windowNumber:0 context:nil subtype:0 data1:0 data2:0] atStart:YES];
}
static NSDictionary *stats(NSUInteger slot) {
  return @{@"slot": @(slot), @"pid": @(lastPID[slot]), @"allowed_pid": @(allowedPID[slot]),
    @"root": @(rootIDs[slot]), @"node_count": @(nodeCounts[slot]),
    @"surface_count": @(surfaceCounts[slot]), @"frame_counter": @(frameCounters[slot]), @"native_input": @(inputPorts[slot] != MACH_PORT_NULL)};
}
static void selectRoot(void) {
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  // One entire-window tree, never two panes. Inactive trees retain their surfaces.
  hostView.layer.sublayers = roots[selectedSlot] ? @[roots[selectedSlot]] : @[];
  [CATransaction commit];
}

// Runs on the serial input queue. Caller owns the retained destination right.
static ZenProbeInputReply exchangeInput(ZenProbeInput request, NSUInteger slot, mach_port_t destination,
    uint32_t workerPID, kern_return_t *result) {
  ZenProbeInputReply answer = {0}; answer.status = UINT32_MAX;
  mach_port_t replyPort = MACH_PORT_NULL;
  *result = mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &replyPort);
  request.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_MAKE_SEND_ONCE);
  request.header.msgh_size = sizeof(request);
  request.header.msgh_remote_port = destination; request.header.msgh_local_port = replyPort;
  if (*result == KERN_SUCCESS) *result = mach_msg(&request.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
    sizeof(request), 0, MACH_PORT_NULL, 500, MACH_PORT_NULL);
  if (*result == MACH_SEND_TIMED_OUT) mach_msg_destroy(&request.header); // Dispose pseudo-received COPY_SEND/MAKE_SEND_ONCE rights.
  union { ZenProbeInputReply reply; unsigned char bytes[sizeof(ZenProbeInputReply) + MAX_TRAILER_SIZE]; } buffer = {0};
  if (*result == KERN_SUCCESS) {
    *result = mach_msg(&buffer.reply.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT |
      MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) | MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
      0, sizeof(buffer), replyPort, 2000, MACH_PORT_NULL);
    if (*result == KERN_SUCCESS) {
      ZenProbeInputReply *reply = &buffer.reply;
      if (reply->header.msgh_size == sizeof(*reply) && !(reply->header.msgh_bits & MACH_MSGH_BITS_COMPLEX) &&
          ZenProbeSenderPID(&reply->header, sizeof(buffer)) == workerPID && reply->magic == ZEN_INPUT_PROBE_MAGIC &&
          reply->pid == workerPID && reply->slot == slot && reply->kind == request.kind && reply->sequence == request.sequence)
        answer = *reply;
      if (ZenProbeMessageLayout(&reply->header, sizeof(buffer))) mach_msg_destroy(&reply->header);
    }
  }
  if (replyPort) mach_port_destroy(mach_task_self(), replyPort);
  return answer;
}

static void sendInput(ZenProbeInput message, NSUInteger slot) {
  if (!inputPorts[slot]) { if (allowedPID[slot]) emit(@{@"event": @"input_unavailable", @"slot": @(slot)}); return; }
  if (pendingInputs >= 64) { fail(@"input_queue_full"); stop(); return; }
  mach_port_t destination = inputPorts[slot];
  if (mach_port_mod_refs(mach_task_self(), destination, MACH_PORT_RIGHT_SEND, 1) != KERN_SUCCESS) { fail(@"input_port_dead"); return; }
  uint32_t workerPID = allowedPID[slot];
  message.magic = ZEN_INPUT_PROBE_MAGIC; message.pid = getpid(); message.slot = (uint32_t)slot;
  message.token = expectedToken; message.sequence = ++inputSequence;
  pendingInputs++;
  dispatch_async(inputQueue, ^{
    ZenProbeInput request = message;
    kern_return_t result;
    ZenProbeInputReply reply = exchangeInput(request, slot, destination, workerPID, &result);
    uint32_t status = reply.status;
    mach_port_deallocate(mach_task_self(), destination);
    dispatch_async(dispatch_get_main_queue(), ^{
      pendingInputs--;
      if (stopping) return;
      if (result != KERN_SUCCESS || status == UINT32_MAX) { emit(@{@"event": @"error", @"reason": @"native_input_rpc", @"slot": @(slot), @"sequence": @(request.sequence), @"kind": @(request.kind), @"mach_result": @(result)}); return; }
      emit(@{@"event": @"native_input", @"slot": @(slot), @"pid": @(workerPID), @"kind": @(request.kind),
        @"sequence": @(request.sequence), @"status": @(status)});
    });
  });
}
static void inputFocus(NSUInteger slot, BOOL focused) {
  ZenProbeInput input = {0};
  input.kind = focused ? ZEN_INPUT_FOCUS : ZEN_INPUT_BLUR;
  sendInput(input, slot);
}
static void inputEvent(NSEvent *event) {
  ZenProbeInput input = {0};
  input.kind = (uint32_t)event.type; input.timestamp = event.timestamp;
  input.flags = event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
  if (event.type == NSEventTypeKeyDown || event.type == NSEventTypeKeyUp || event.type == NSEventTypeFlagsChanged) {
    NSString *text = event.type == NSEventTypeFlagsChanged ? @"" : event.characters ?: @"";
    NSString *ignoring = event.type == NSEventTypeFlagsChanged ? @"" : event.charactersIgnoringModifiers ?: @"";
    if (text.length > ZEN_INPUT_PROBE_CHARS || ignoring.length > ZEN_INPUT_PROBE_CHARS) { fail(@"native_key_length"); return; }
    input.keyCode = event.keyCode; input.repeat = event.type == NSEventTypeKeyDown && event.isARepeat;
    input.length = (uint32_t)text.length; input.ignoringLength = (uint32_t)ignoring.length;
    [text getCharacters:input.characters range:NSMakeRange(0, text.length)];
    [ignoring getCharacters:input.ignoring range:NSMakeRange(0, ignoring.length)];
  } else {
    NSPoint point = [hostView convertPoint:event.locationInWindow fromView:nil];
    input.x = point.x; input.y = point.y; input.clickCount = (uint32_t)event.clickCount;
    input.buttons = (uint32_t)(NSEvent.pressedMouseButtons & 31u);
    if (event.type == NSEventTypeLeftMouseUp) input.buttons &= ~1u;
    else input.buttons |= 1u;
  }
  sendInput(input, selectedSlot);
}

static BOOL queryText(NSRange range, ZenProbeInputReply *state) {
  NSUInteger slot = selectedSlot;
  mach_port_t destination = inputPorts[slot];
  if (!destination || !hostWindow.isKeyWindow || !NSApp.isActive) return NO;
  if (range.length > ZEN_INPUT_PROBE_CHARS || (range.location != NSNotFound && range.location > UINT32_MAX)) return NO;
  if (mach_port_mod_refs(mach_task_self(), destination, MACH_PORT_RIGHT_SEND, 1) != KERN_SUCCESS) return NO;
  ZenProbeInput request = {0};
  request.kind = ZEN_INPUT_QUERY; request.magic = ZEN_INPUT_PROBE_MAGIC; request.pid = getpid();
  request.slot = (uint32_t)slot; request.token = expectedToken; request.sequence = ++inputSequence;
  request.replacementStart = range.location == NSNotFound ? UINT64_MAX : range.location; request.replacementLength = range.length;
  uint32_t workerPID = allowedPID[slot];
  __block ZenProbeInputReply answer; __block kern_return_t result;
  // ponytail: bounded synchronous text queries; renderer outbox must never wait for this host main thread.
  dispatch_sync(inputQueue, ^{ answer = exchangeInput(request, slot, destination, workerPID, &result); });
  mach_port_deallocate(mach_task_self(), destination);
  if (result != KERN_SUCCESS || answer.status != 0 || answer.selectedStart > UINT32_MAX ||
      answer.selectedLength > UINT32_MAX || answer.markedLength > ZEN_INPUT_PROBE_CHARS ||
      (answer.markedStart != UINT64_MAX && answer.markedStart > UINT32_MAX) ||
      (answer.actualStart != UINT64_MAX && answer.actualStart > UINT32_MAX) || answer.actualLength > ZEN_INPUT_PROBE_CHARS) return NO;
  for (int i = 0; i < 4; ++i) if (!isfinite(answer.caret[i]) || fabs(answer.caret[i]) > 1e7) return NO;
  if (answer.caret[2] < 0 || answer.caret[3] < 0) return NO;
  *state = answer; return YES;
}
static NSRange textRange(uint64_t start, uint64_t length) {
  return NSMakeRange(start == UINT64_MAX ? NSNotFound : (NSUInteger)start, (NSUInteger)length);
}
static BOOL forwardText(uint32_t kind, id value, NSRange selection, NSRange replacement) {
  if (!inputPorts[selectedSlot] || pendingInputs >= 64) { fail(@"text_unavailable"); return NO; }
  NSString *text = [value isKindOfClass:NSAttributedString.class] ? [value string] : value;
  if (![text isKindOfClass:NSString.class] || text.length > ZEN_INPUT_PROBE_CHARS || replacement.length > ZEN_INPUT_PROBE_CHARS ||
      (replacement.location != NSNotFound && replacement.location > UINT32_MAX) ||
      (replacement.location == NSNotFound && replacement.length) || selection.location > text.length || selection.length > text.length-selection.location) {
    fail(@"text_bounds"); return NO;
  }
  ZenProbeInput input = {0}; input.kind = kind; input.length = (uint32_t)text.length;
  input.replacementStart = replacement.location == NSNotFound ? UINT64_MAX : replacement.location;
  input.replacementLength = replacement.length; input.selectionStart = selection.location; input.selectionLength = selection.length;
  [text getCharacters:input.characters range:NSMakeRange(0, text.length)];
  sendInput(input, selectedSlot); return YES;
}

static NSString *currentInputSourceID(void);

@interface GeckoView : NSView <NSWindowDelegate, NSTextInputClient>
@property BOOL textClientEnabled;
@property BOOL locallyMarked;
@property uint64_t markedCallbacks, insertCallbacks, rectCallbacks;
@property BOOL lastRectOnHost;
@property BOOL rawCommandSent;
@property(strong) NSMutableIndexSet *rawTextKeys;
@property(strong) NSEvent *textKeyEvent;
- (void)finishComposition;

@end
@implementation GeckoView
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (void)keyDown:(NSEvent *)event {
  if (!self.textClientEnabled) { inputEvent(event); return; }
  self.textKeyEvent = event; self.rawCommandSent=NO;
  BOOL consumed = [self.inputContext handleEvent:event];
  if (!consumed && !self.rawCommandSent) [self forwardRawKeyDown:event];
  self.textKeyEvent = nil;
  emit(@{@"event":@"text_key",@"key_code":@(event.keyCode),@"context_consumed":@(consumed),@"has_cg_event":@(event.CGEvent != NULL)});
}
- (void)setMarkedText:(id)value selectedRange:(NSRange)selection replacementRange:(NSRange)replacement {
  self.markedCallbacks++;
  if (forwardText(ZEN_INPUT_MARK, value, selection, replacement)) self.locallyMarked = YES;
}
- (void)insertText:(id)value replacementRange:(NSRange)replacement {
  self.insertCallbacks++;
  if (forwardText(ZEN_INPUT_INSERT, value, NSMakeRange(0,0), replacement)) self.locallyMarked = NO;
}
- (void)unmarkText {
  forwardText(ZEN_INPUT_UNMARK, @"", NSMakeRange(0,0), NSMakeRange(NSNotFound,0)); self.locallyMarked = NO;
}
- (void)finishComposition {
  if (self.locallyMarked) { [self unmarkText]; [self.inputContext discardMarkedText]; }
}
- (BOOL)hasMarkedText { return self.markedRange.location != NSNotFound; }
- (NSRange)markedRange {
  ZenProbeInputReply state; return queryText(NSMakeRange(NSNotFound,0), &state) ? textRange(state.markedStart,state.markedLength) : NSMakeRange(NSNotFound,0);
}
- (NSRange)selectedRange {
  ZenProbeInputReply state; return queryText(NSMakeRange(NSNotFound,0), &state) ? textRange(state.selectedStart,state.selectedLength) : NSMakeRange(NSNotFound,0);
}
- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText { return @[NSUnderlineStyleAttributeName]; }
- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actual {
  // ponytail: surrounding-text/reconversion unsupported in this bounded composition bridge.
  (void)range; if (actual) *actual = NSMakeRange(NSNotFound,0); return nil;
}
- (NSUInteger)characterIndexForPoint:(NSPoint)point { (void)point; return NSNotFound; }
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actual {
  self.rectCallbacks++; self.lastRectOnHost=NO;
  ZenProbeInputReply state;
  if (!queryText(range,&state)) { if (actual) *actual=NSMakeRange(NSNotFound,0); return NSZeroRect; }
  if (actual) *actual=textRange(state.actualStart,state.actualLength);
  NSRect local=NSMakeRect(state.caret[0],state.caret[1],state.caret[2],state.caret[3]);
  NSRect screen = [self.window convertRectToScreen:[self convertRect:local toView:nil]];
  self.lastRectOnHost = screen.size.height>0 && NSPointInRect(NSMakePoint(NSMidX(screen),NSMidY(screen)), self.window.frame);
  return screen;
}
- (void)doCommandBySelector:(SEL)selector {
  (void)selector;
  if (self.textKeyEvent) [self forwardRawKeyDown:self.textKeyEvent];
  else fail(@"text_command_without_event");
}
- (void)forwardRawKeyDown:(NSEvent *)event {
  if (!self.rawTextKeys) self.rawTextKeys=[NSMutableIndexSet new];
  [self.rawTextKeys addIndex:event.keyCode]; self.rawCommandSent=YES;
  inputEvent(event);
}
- (void)keyUp:(NSEvent *)event {
  if (!self.textClientEnabled) { inputEvent(event); return; }
  if ([self.rawTextKeys containsIndex:event.keyCode]) {
    [self.rawTextKeys removeIndex:event.keyCode]; inputEvent(event);
  } // IME-consumed downs have no raw Gecko key-up counterpart.
  emit(@{@"event":@"text_key_up",@"key_code":@(event.keyCode)});
}
- (void)flagsChanged:(NSEvent *)event { inputEvent(event); }
- (void)mouseUp:(NSEvent *)event { inputEvent(event); }
- (void)mouseDragged:(NSEvent *)event { inputEvent(event); }
- (void)windowDidBecomeKey:(NSNotification *)note { (void)note; if (hostReady) inputFocus(selectedSlot, YES); }
- (void)windowDidResignKey:(NSNotification *)note { (void)note; [self finishComposition]; if (hostReady) inputFocus(selectedSlot, NO); }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { (void)event; return YES; }
- (void)setFrameSize:(NSSize)size {
  [super setFrameSize:size];
  if (hostReady) emit(@{@"event": @"resize", @"width": @(self.bounds.size.width),
    @"height": @(self.bounds.size.height), @"window_number": @(hostWindow.windowNumber)});
}
- (void)mouseDown:(NSEvent *)event {
  NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
  emit(@{@"event": @"click", @"x": @(p.x), @"y": @(p.y), @"slot": @(selectedSlot),
    @"window_number": @(hostWindow.windowNumber)});
  [hostWindow makeFirstResponder:self];
  inputFocus(selectedSlot, YES);
  inputEvent(event);
}
@end

static CATransform3D transform(const float *f) {
  return (CATransform3D){f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7],
    f[8], f[9], f[10], f[11], f[12], f[13], f[14], f[15]};
}
static NSArray *numbers(const float *values, NSUInteger count) {
  NSMutableArray *result = [NSMutableArray arrayWithCapacity:count];
  for (NSUInteger i = 0; i < count; i++) [result addObject:@(values[i])];
  return result;
}
static NSString *validate(const ZenProbeFrame *f, uint32_t senderPID) {
  if (f->header.msgh_size != sizeof(*f)) return @"message_size";
  if (!(f->header.msgh_bits & MACH_MSGH_BITS_COMPLEX) ||
      f->body.msgh_descriptor_count != ZEN_LAYER_PROBE_NODES) return @"descriptors";
  if (f->magic != ZEN_LAYER_PROBE_MAGIC) return @"magic";
  if (f->token != expectedToken) return @"token";
  if (f->slot > 1 || !allowedPID[f->slot] || f->pid != allowedPID[f->slot] ||
      senderPID != f->pid) return @"pid_or_slot";
  if (!f->root || !f->count || f->count > ZEN_LAYER_PROBE_NODES || f->truncated) return @"tree_count_or_truncated";
  if (!isfinite(f->backingScale) || f->backingScale <= 0 || f->backingScale > 16) return @"backing_scale";
  for (uint32_t i = 0; i < ZEN_LAYER_PROBE_NODES; i++) {
    const mach_msg_port_descriptor_t *d = &f->surfaces[i];
    if (d->type != MACH_MSG_PORT_DESCRIPTOR || d->disposition != MACH_MSG_TYPE_PORT_SEND ||
        d->name == MACH_PORT_DEAD || (i >= f->count && d->name != MACH_PORT_NULL)) return @"surface_descriptor";
    if (i >= f->count) continue;
    const ZenProbeNode *n = &f->nodes[i];
    if ((i == 0 && n->parent != -1) || (i && (n->parent < 0 || (uint32_t)n->parent >= i)) ||
        (n->flags & ~31u)) return @"topology_or_flags";
    // All fields after flags are protocol float32s; memcpy avoids aliasing/alignment assumptions.
    for (size_t offset = offsetof(ZenProbeNode, position); offset < sizeof(*n); offset += sizeof(float)) {
      float value;
      memcpy(&value, (const char *)n + offset, sizeof(value));
      if (!isfinite(value) || fabsf(value) > 1e7f) return @"nonfinite_or_extent";
    }
    if (n->bounds[2] < 0 || n->bounds[3] < 0 || n->bounds[2] > 32768 || n->bounds[3] > 32768 ||
        n->contentsRect[2] < 0 || n->contentsRect[3] < 0 || n->opacity < 0 || n->opacity > 1 ||
        n->contentsScale <= 0 || n->contentsScale > 16 || n->cornerRadius < 0) return @"geometry";
    for (int c = 0; c < 4; c++) if (n->background[c] < 0 || n->background[c] > 1) return @"background";
  }
  return nil;
}
static void acceptFrame(ZenProbeFrame *f, uint32_t senderPID) {
  NSString *reason = validate(f, senderPID);
  if (reason) { rejected++; emit(@{@"event": @"error", @"kind": @"frame_rejected", @"reason": reason, @"rejected": @(rejected)}); return; }
  NSMutableArray<CALayer *> *layers = [NSMutableArray arrayWithCapacity:f->count];
  NSMutableArray<NSDictionary *> *metadata = [NSMutableArray arrayWithCapacity:f->count];
  uint32_t surfaces = 0;
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  for (uint32_t i = 0; i < f->count; i++) {
    const ZenProbeNode *n = &f->nodes[i];
    CALayer *layer = [CALayer layer];
    layer.actions = @{@"contents": [NSNull null], @"sublayers": [NSNull null]};
    layer.position = CGPointMake(n->position[0], n->position[1]);
    layer.bounds = CGRectMake(n->bounds[0], n->bounds[1], n->bounds[2], n->bounds[3]);
    layer.anchorPoint = CGPointMake(n->anchor[0], n->anchor[1]);
    layer.contentsRect = CGRectMake(n->contentsRect[0], n->contentsRect[1], n->contentsRect[2], n->contentsRect[3]);
    layer.transform = transform(n->transform);
    layer.sublayerTransform = transform(n->sublayerTransform);
    layer.opacity = n->opacity;
    layer.contentsScale = n->contentsScale;
    layer.cornerRadius = n->cornerRadius;
    layer.hidden = (n->flags & 1) != 0;
    layer.masksToBounds = (n->flags & 2) != 0;
    layer.geometryFlipped = (n->flags & 4) != 0;
    layer.contentsGravity = (n->flags & 8) ? kCAGravityTopLeft : kCAGravityResize;
    layer.minificationFilter = (n->flags & 16) ? kCAFilterNearest : kCAFilterLinear;
    // Gecko's container root can have zero bounds: don't cut off its genuine child coordinates.
    if (!i && (!n->bounds[2] || !n->bounds[3])) layer.masksToBounds = NO;
    CGFloat colorValues[] = {n->background[0], n->background[1], n->background[2], n->background[3]};
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGColorRef color = CGColorCreate(space, colorValues);
    layer.backgroundColor = color;
    CGColorRelease(color);
    CGColorSpaceRelease(space);
    uint32_t surfaceID = 0;
    if (f->surfaces[i].name != MACH_PORT_NULL) {
      IOSurfaceRef surface = IOSurfaceLookupFromMachPort(f->surfaces[i].name);
      if (!surface || !IOSurfaceGetWidth(surface) || !IOSurfaceGetHeight(surface) ||
          IOSurfaceGetWidth(surface) > 32768 || IOSurfaceGetHeight(surface) > 32768) {
        if (surface) CFRelease(surface);
        [CATransaction commit];
        rejected++;
        emit(@{@"event": @"error", @"kind": @"frame_rejected", @"reason": @"surface_lookup_or_extent", @"rejected": @(rejected)});
        return;
      }
      layer.contents = (__bridge id)surface;
      surfaceID = IOSurfaceGetID(surface);
      CFRelease(surface); // CALayer retains the IOSurface; message rights are destroyed by caller.
      surfaces++;
    }
    [layers addObject:layer];
    if (i) [layers[(NSUInteger)n->parent] addSublayer:layer];
    [metadata addObject:@{@"index": @(i), @"parent": @(n->parent), @"flags": @(n->flags),
      @"position": numbers(n->position, 2), @"bounds": numbers(n->bounds, 4), @"anchor": numbers(n->anchor, 2),
      @"contents_rect": numbers(n->contentsRect, 4), @"transform": numbers(n->transform, 16),
      @"sublayer_transform": numbers(n->sublayerTransform, 16), @"opacity": @(n->opacity),
      @"contents_scale": @(n->contentsScale), @"corner_radius": @(n->cornerRadius),
      @"background": numbers(n->background, 4), @"surface_id": @(surfaceID)}];
  }
  NSUInteger slot = f->slot;
  if (f->header.msgh_remote_port && f->header.msgh_remote_port != inputPorts[slot]) {
    if (mach_port_mod_refs(mach_task_self(), f->header.msgh_remote_port, MACH_PORT_RIGHT_SEND, 1) != KERN_SUCCESS) {
      [CATransaction commit]; fail(@"input_port_retain"); return;
    }
    if (inputPorts[slot]) mach_port_deallocate(mach_task_self(), inputPorts[slot]);
    inputPorts[slot] = f->header.msgh_remote_port;
    if (slot == selectedSlot && hostWindow.isKeyWindow) inputFocus(slot, YES);
  }
  roots[slot] = layers[0];
  trees[slot] = metadata;
  nodeCounts[slot] = f->count;
  surfaceCounts[slot] = surfaces;
  lastPID[slot] = f->pid;
  rootIDs[slot] = f->root;
  frameCounters[slot]++;
  if (slot == selectedSlot) selectRoot();
  [CATransaction commit];
  double now = NSProcessInfo.processInfo.systemUptime;
  if (!lastReport[slot] || now - lastReport[slot] >= 1) {
    lastReport[slot] = now;
    NSMutableDictionary *report = [stats(slot) mutableCopy];
    [report addEntriesFromDictionary:@{@"event": @"frame", @"backing_scale": @(f->backingScale),
      @"root_geometry": metadata[0], @"width": @(hostView.bounds.size.width), @"height": @(hostView.bounds.size.height),
      @"window_number": @(hostWindow.windowNumber)}];
    emit(report);
  }
}
static void receiveFrames(void) {
  for (int batch = 0; batch < 16; batch++) {
    union { ZenProbeFrame frame; unsigned char bytes[sizeof(ZenProbeFrame) + MAX_TRAILER_SIZE]; } buffer = {0};
    mach_msg_return_t result = mach_msg(&buffer.frame.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT |
      MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) | MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
      0, sizeof(buffer), receivePort, 0, MACH_PORT_NULL);
    if (result == MACH_RCV_TIMED_OUT) break;
    if (result != MACH_MSG_SUCCESS) {
      // Without MACH_RCV_LARGE, an oversized message is dequeued and destroyed by the kernel.
      rejected++;
      emit(@{@"event": @"error", @"kind": @"frame_rejected", @"reason": @"mach_receive", @"code": @(result), @"rejected": @(rejected)});
      continue;
    }
    size_t offset = (buffer.frame.header.msgh_size + 3u) & ~(size_t)3u;
    BOOL layout = ZenProbeMessageLayout(&buffer.frame.header, sizeof(buffer));
    uint32_t senderPID = 0;
    BOOL validTrailer = NO;
    if (layout && offset + sizeof(mach_msg_audit_trailer_t) <= sizeof(buffer)) {
      mach_msg_audit_trailer_t *trailer = (void *)(buffer.bytes + offset);
      validTrailer = trailer->msgh_trailer_type == MACH_MSG_TRAILER_FORMAT_0 &&
        trailer->msgh_trailer_size >= sizeof(*trailer) && trailer->msgh_trailer_size <= sizeof(buffer) - offset;
      if (validTrailer) senderPID = trailer->msgh_audit.val[5];
    }
    if (!layout || !validTrailer) {
      // Never pass unstructured bytes to mach_msg_destroy. Successful kernel receive should guarantee this layout.
      rejected++;
      emit(@{@"event": @"error", @"kind": @"frame_rejected", @"reason": @"mach_structure_or_trailer", @"rejected": @(rejected)});
      if (layout) mach_msg_destroy(&buffer.frame.header);
      continue;
    }
    acceptFrame(&buffer.frame, senderPID);
    // Both accepted and rejected structurally valid messages own received rights.
    mach_msg_destroy(&buffer.frame.header);
  }
}
static BOOL integer(id value, uint64_t maximum, uint64_t *out) {
  if (![value isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
  double d = [value doubleValue];
  if (!isfinite(d) || d < 0 || floor(d) != d || d > (double)maximum) return NO;
  *out = [value unsignedLongLongValue];
  return *out <= maximum;
}
static BOOL coordinate(id value, double maximum, double *out) {
  if (![value isKindOfClass:[NSNumber class]]) return NO;
  *out = [value doubleValue];
  return isfinite(*out) && *out >= 0 && *out <= maximum;
}
static void status(BOOL includeTree, NSString *action) {
  NSUInteger visible = 0;
  for (NSWindow *window in NSApp.windows) if (window.visible) visible++;
  NSMutableArray *sourceWindows = [NSMutableArray array];
  NSUInteger hostVisible = 0;
  CFArrayRef windowList = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
  for (NSDictionary *info in (__bridge NSArray *)windowList) {
    // Filter by owner before reading any window metadata; never read or expose window names.
    uint32_t pid = [info[(__bridge NSString *)kCGWindowOwnerPID] unsignedIntValue];
    BOOL source = (allowedPID[0] && pid == allowedPID[0]) || (allowedPID[1] && pid == allowedPID[1]);
    if (!source && pid != (uint32_t)getpid()) continue;
    NSNumber *alpha = info[(__bridge NSString *)kCGWindowAlpha];
    NSDictionary *bounds = info[(__bridge NSString *)kCGWindowBounds];
    CGRect rect;
    if (alpha.doubleValue <= 0 || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bounds, &rect) ||
        rect.size.width <= 0 || rect.size.height <= 0) continue;
    NSNumber *number = info[(__bridge NSString *)kCGWindowNumber];
    if (pid == (uint32_t)getpid()) hostVisible++;
    if (source) [sourceWindows addObject:@{@"pid": @(pid), @"window_number": number, @"alpha": alpha,
      @"bounds": @{@"x": @(rect.origin.x), @"y": @(rect.origin.y),
        @"width": @(rect.size.width), @"height": @(rect.size.height)}}];
  }
  BOOL listed = windowList != NULL;
  if (windowList) CFRelease(windowList);
  NSMutableDictionary *report = [@{@"event": @"status", @"active_slot": @(selectedSlot), @"pid": @(getpid()),
    @"window_number": @(hostWindow.windowNumber), @"visible_host_windows": @(visible),
    @"host_visible_windows": listed ? @(hostVisible) : [NSNull null],
    @"source_visible_windows": sourceWindows, @"window_list_available": @(listed),
    @"host_key_window": @(hostWindow.isKeyWindow), @"host_app_active": @(NSApp.isActive),
    @"width": @(hostView.bounds.size.width), @"height": @(hostView.bounds.size.height),
    @"rejected": @(rejected), @"slots": @[stats(0), stats(1)]} mutableCopy];
  if (includeTree) report[@"trees"] = @[trees[0] ?: @[], trees[1] ?: @[]];
  if (action) report[@"action"] = action;
  emit(report);
}
static void snapshot(NSString *path) {
  NSString *directory = NSProcessInfo.processInfo.environment[@"ZEN_GECKO_LAYER_ARTIFACTS"];
  if (![path isKindOfClass:NSString.class] || !directory ||
      ![path.stringByDeletingLastPathComponent isEqual:directory] ||
      ![path.pathExtension isEqual:@"png"] || [NSFileManager.defaultManager fileExistsAtPath:path]) {
    fail(@"snapshot_path"); return;
  }
  CGWindowID windowID = (CGWindowID)hostWindow.windowNumber;
  // QA only: enumerate/capture this process's own window, never request global TCC access.
  [SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:^(SCShareableContent *content, NSError *error) {
    SCWindow *target = nil;
    for (SCWindow *window in content.windows) {
      if (window.windowID == windowID && window.owningApplication.processID == getpid()) { target = window; break; }
    }
    if (!target) {
      dispatch_async(dispatch_get_main_queue(), ^{ fail(error.localizedDescription ?: @"own_window_not_shareable"); }); return;
    }
    SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:target];
    SCStreamConfiguration *configuration = [SCStreamConfiguration new];
    configuration.width = (size_t)ceil(target.frame.size.width);
    configuration.height = (size_t)ceil(target.frame.size.height);
    configuration.showsCursor = NO;
    configuration.ignoreShadowsSingleWindow = YES;
    [SCScreenshotManager captureImageWithFilter:filter configuration:configuration completionHandler:^(CGImageRef image, NSError *captureError) {
      NSBitmapImageRep *bitmap = image ? [[NSBitmapImageRep alloc] initWithCGImage:image] : nil;
      NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
      NSError *writeError = nil;
      BOOL saved = png && [png writeToFile:path options:NSDataWritingWithoutOverwriting error:&writeError];
      NSUInteger width = image ? CGImageGetWidth(image) : 0, height = image ? CGImageGetHeight(image) : 0;
      dispatch_async(dispatch_get_main_queue(), ^{
        if (!saved) { fail(captureError.localizedDescription ?: writeError.localizedDescription ?: @"snapshot_failed"); return; }
        emit(@{@"event": @"snapshot", @"path": path, @"width": @(width), @"height": @(height),
          @"window_number": @(windowID), @"own_process_only": @YES});
      });
    }];
  }];
}

static void command(NSDictionary *cmd) {
  if (stopping) return;
  NSString *op = cmd[@"op"];
  uint64_t slot = 0, pid = 0;
  if ([op isEqual:@"quit"]) stop();
  else if ([op isEqual:@"allow"] && integer(cmd[@"slot"], 1, &slot) && integer(cmd[@"pid"], INT32_MAX, &pid) && pid) {
    if (allowedPID[slot] != pid) {
      if (inputPorts[slot]) { mach_port_deallocate(mach_task_self(), inputPorts[slot]); inputPorts[slot] = MACH_PORT_NULL; }
      roots[slot] = nil; trees[slot] = nil;
      lastPID[slot] = nodeCounts[slot] = surfaceCounts[slot] = 0;
      rootIDs[slot] = frameCounters[slot] = 0; lastReport[slot] = 0;
    }
    allowedPID[slot] = (uint32_t)pid;
    selectRoot();
    status(NO, @"allow");
  } else if ([op isEqual:@"activate"]) {
    [hostWindow makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
    [hostWindow makeFirstResponder:hostView];
    status(NO, @"activate");
  } else if ([op isEqual:@"select"] && integer(cmd[@"slot"], 1, &slot)) {
    if (selectedSlot != (NSUInteger)slot) [(GeckoView *)hostView finishComposition];
    if (inputPorts[selectedSlot] && selectedSlot != (NSUInteger)slot) inputFocus(selectedSlot, NO);
    selectedSlot = (NSUInteger)slot;
    if (inputPorts[selectedSlot] && hostWindow.isKeyWindow) inputFocus(selectedSlot, YES);
    selectRoot();
    status(NO, @"select");
  } else if ([op isEqual:@"resize"]) {
    double w, h;
    if (!coordinate(cmd[@"width"], 16384, &w) || !coordinate(cmd[@"height"], 16384, &h) || w < 1 || h < 1) { fail(@"resize_dimensions"); return; }
    [hostWindow setContentSize:NSMakeSize(w, h)];
    emit(@{@"event": @"resize", @"width": @(hostView.bounds.size.width), @"height": @(hostView.bounds.size.height),
      @"window_number": @(hostWindow.windowNumber)});
  } else if ([op isEqual:@"text"]) {
    GeckoView *view = (GeckoView *)hostView;
    NSString *action = cmd[@"action"], *text = cmd[@"text"];
    if ([action isEqual:@"query"]) {
      ZenProbeInputReply state;
      if (!queryText(NSMakeRange(NSNotFound,0),&state)) { fail(@"text_query_unavailable"); return; }
      NSRange actual;
      NSRect screen = [view firstRectForCharacterRange:NSMakeRange(NSNotFound,0) actualRange:&actual];
      NSRect roundtrip = [view convertRect:[hostWindow convertRectFromScreen:screen] fromView:nil];
      emit(@{@"event":@"text_state", @"slot":@(selectedSlot), @"selected_start":@(state.selectedStart), @"selected_length":@(state.selectedLength),
        @"marked":@(state.markedStart != UINT64_MAX), @"marked_length":@(state.markedLength),
        @"caret":@[@(state.caret[0]),@(state.caret[1]),@(state.caret[2]),@(state.caret[3])],
        @"client_rect_roundtrip":@[@(roundtrip.origin.x),@(roundtrip.origin.y),@(roundtrip.size.width),@(roundtrip.size.height)],
        @"caret_on_host":@(NSPointInRect(NSMakePoint(NSMidX(screen),NSMidY(screen)),hostWindow.frame))});
    } else if ([action isEqual:@"enable"] && [cmd[@"enabled"] isKindOfClass:NSNumber.class]) {
      [view finishComposition]; view.textClientEnabled = [cmd[@"enabled"] boolValue];
      if (view.textClientEnabled) [view.inputContext activate];
      emit(@{@"event":@"text_client",@"enabled":@(view.textClientEnabled)});
    } else if ([action isEqual:@"source"]) {
      NSTextInputContext *context = view.inputContext;
      id target = cmd[@"source_id"];
      if (target) {
        if (!view.textClientEnabled || !hostWindow.isKeyWindow || !NSApp.isActive ||
            ![target isKindOfClass:NSString.class] ||
            !([target isEqual:@"com.apple.inputmethod.TCIM.Zhuyin"] || [target isEqual:@"com.apple.keylayout.US"]) ||
            ![context.keyboardInputSources containsObject:target]) { fail(@"input_source_not_authorized_or_available"); return; }
        context.selectedKeyboardInputSource = target;
      }
      emit(@{@"event":@"input_source",@"selected":context.selectedKeyboardInputSource ?: @"unavailable",@"system_selected":currentInputSourceID(),
        @"client_owner":@(NSTextInputContext.currentInputContext.client == view && hostWindow.isKeyWindow && NSApp.isActive),
        @"marked_callbacks":@(view.markedCallbacks),@"insert_callbacks":@(view.insertCallbacks),
        @"rect_callbacks":@(view.rectCallbacks),@"last_rect_on_host":@(view.lastRectOnHost)});
    } else if ([action isEqual:@"unmark"]) [view unmarkText];
    else if ([text isKindOfClass:NSString.class] && text.length <= ZEN_INPUT_PROBE_CHARS) {
      if ([action isEqual:@"mark"]) [view setMarkedText:text selectedRange:NSMakeRange(text.length,0) replacementRange:NSMakeRange(NSNotFound,0)];
      else if ([action isEqual:@"insert"]) [view insertText:text replacementRange:NSMakeRange(NSNotFound,0)];
      else fail(@"text_action");
    } else fail(@"text_arguments");
  } else if ([op isEqual:@"key"]) {
    uint64_t keyCode;
    NSString *text = cmd[@"text"];
    if (![text isKindOfClass:NSString.class] || text.length > ZEN_INPUT_PROBE_CHARS || !integer(cmd[@"key_code"], 255, &keyCode)) { fail(@"key_arguments"); return; }
    id quartz = cmd[@"quartz"];
    if (quartz && ![quartz isKindOfClass:NSNumber.class]) { fail(@"key_delivery_arguments"); return; }
    if ([quartz boolValue]) {
      if (![(GeckoView *)hostView textClientEnabled] || !hostWindow.isKeyWindow || !NSApp.isActive || !CGPreflightPostEventAccess()) { fail(@"own_pid_key_not_ready"); return; }
      CGEventRef events[2]={CGEventCreateKeyboardEvent(NULL,(CGKeyCode)keyCode,true),CGEventCreateKeyboardEvent(NULL,(CGKeyCode)keyCode,false)};
      if (!events[0] || !events[1]) {
        for (int i=0;i<2;i++) if (events[i]) CFRelease(events[i]);
        fail(@"own_pid_key_allocation"); return;
      }
      for (int i=0;i<2;i++) {
        CGEventSetFlags(events[i],0); CGEventPostToPid(getpid(),events[i]); CFRelease(events[i]);
      }
      return;
    }
    for (int up = 0; up < 2; up++) {
      NSEvent *event = [NSEvent keyEventWithType:up ? NSEventTypeKeyUp : NSEventTypeKeyDown location:NSZeroPoint
        modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:hostWindow.windowNumber
        context:nil characters:text charactersIgnoringModifiers:text isARepeat:NO keyCode:(unsigned short)keyCode];
      [NSApp postEvent:event atStart:NO];
    }
  } else if ([op isEqual:@"click"]) {
    double x, y;
    if (!coordinate(cmd[@"x"], hostView.bounds.size.width, &x) || !coordinate(cmd[@"y"], hostView.bounds.size.height, &y)) { fail(@"click_coordinates"); return; }
    [hostWindow makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    NSPoint location = [hostView convertPoint:NSMakePoint(x, y) toView:nil];
    for (int up = 0; up < 2; up++) {
      NSEvent *event = [NSEvent mouseEventWithType:up ? NSEventTypeLeftMouseUp : NSEventTypeLeftMouseDown
        location:location modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:hostWindow.windowNumber
        context:nil eventNumber:0 clickCount:1 pressure:up ? 0 : 1];
      [NSApp postEvent:event atStart:NO];
    }
  } else if ([op isEqual:@"snapshot"]) {
    snapshot(cmd[@"path"]);
  } else if ([op isEqual:@"status"]) {
    status([cmd[@"tree"] isEqual:@YES], nil);
  } else fail(@"invalid_command");
}

// Utility-only mode: no window or server, restore the explicitly authorized original US source.
static NSString *currentInputSourceID(void) {
  TISInputSourceRef source = TISCopyCurrentKeyboardInputSource();
  NSString *identifier = source ? [(__bridge NSString *)TISGetInputSourceProperty(source,kTISPropertyInputSourceID) copy] : @"unavailable";
  if (source) CFRelease(source);
  return identifier ?: @"unavailable";
}
static int restoreUS(void) {
  NSString *current = currentInputSourceID();
  BOOL changed = NO;
  if ([current isEqual:@"com.apple.inputmethod.TCIM.Zhuyin"]) {
    NSDictionary *filter = @{(__bridge NSString *)kTISPropertyInputSourceID:@"com.apple.keylayout.US"};
    CFArrayRef sources = TISCreateInputSourceList((__bridge CFDictionaryRef)filter,false);
    NSArray *items = (__bridge NSArray *)sources;
    if (items.count) changed = TISSelectInputSource((__bridge TISInputSourceRef)items.firstObject) == noErr;
    if (sources) CFRelease(sources);
    for (int i=0;i<50 && ![currentInputSourceID() isEqual:@"com.apple.keylayout.US"];i++) usleep(20000);
  }
  NSString *selected = currentInputSourceID();
  emit(@{@"event":@"input_source_restore",@"changed":@(changed),@"selected":selected});
  // Don't overwrite a concurrent user selection of some third source.
  return [selected isEqual:@"com.apple.keylayout.US"] ? 0 : 4;
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc==2 && !strcmp(argv[1],"--restore-us")) return restoreUS();
    signal(SIGPIPE, SIG_IGN);
    inputQueue = dispatch_queue_create("local.zen-gecko-native-input", DISPATCH_QUEUE_SERIAL);
    const char *service = NULL, *tokenString = NULL;
    for (int i = 1; i < argc; i += 2) {
      if (i + 1 >= argc) { fail(@"arguments: --service NAME --token UINT64"); return 2; }
      if (!strcmp(argv[i], "--service") && !service) service = argv[i + 1];
      else if (!strcmp(argv[i], "--token") && !tokenString) tokenString = argv[i + 1];
      else { fail(@"arguments: --service NAME --token UINT64"); return 2; }
    }
    if (!service || !*service || strlen(service) >= BOOTSTRAP_MAX_NAME_LEN || !tokenString || !*tokenString ||
        strspn(tokenString, "0123456789") != strlen(tokenString)) { fail(@"invalid_service_or_token"); return 2; }
    errno = 0;
    expectedToken = strtoull(tokenString, NULL, 10);
    if (errno == ERANGE) { fail(@"token_overflow"); return 2; }
    kern_return_t result = mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &receivePort);
    // ponytail: bounded queue for two compositor bursts; async latest-frame flow control before product use.
    mach_port_limits_t limits = {.mpl_qlimit = 64};
    if (result == KERN_SUCCESS) result = mach_port_set_attributes(mach_task_self(), receivePort,
      MACH_PORT_LIMITS_INFO, (mach_port_info_t)&limits, MACH_PORT_LIMITS_INFO_COUNT);
    if (result == KERN_SUCCESS) result = mach_port_insert_right(mach_task_self(), receivePort, receivePort, MACH_MSG_TYPE_MAKE_SEND);
    if (result == KERN_SUCCESS) result = bootstrap_register(bootstrap_port, (char *)service, receivePort);
    if (result != KERN_SUCCESS) {
      emit(@{@"event": @"error", @"reason": @"registration", @"code": @(result)});
      if (receivePort) mach_port_destroy(mach_task_self(), receivePort);
      return 2;
    }
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    hostWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 800, 600)
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
      backing:NSBackingStoreBuffered defer:NO];
    hostWindow.releasedWhenClosed = NO;
    hostWindow.title = @"Real Gecko layer transport probe — not product integration";
    hostView = [[GeckoView alloc] initWithFrame:NSMakeRect(0, 0, 800, 600)];
    hostView.wantsLayer = YES;
    hostView.layer.geometryFlipped = YES;
    hostView.layer.masksToBounds = NO;
    hostWindow.contentView = hostView;
    hostWindow.delegate = (GeckoView *)hostView;
    [hostWindow makeFirstResponder:hostView];
    [hostWindow makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    emit(@{@"event": @"ready", @"pid": @(getpid()), @"window_number": @(hostWindow.windowNumber),
      @"service": [NSString stringWithUTF8String:service], @"width": @(hostView.bounds.size.width),
      @"height": @(hostView.bounds.size.height)});
    hostReady = YES;
    NSTimer *timer = [NSTimer scheduledTimerWithTimeInterval:0.016 repeats:YES block:^(NSTimer *t) {
      (void)t;
      receiveFrames();
      if (!hostWindow.visible) stop();
    }];
    int flags = fcntl(STDIN_FILENO, F_GETFL);
    if (flags < 0 || fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) < 0) {
      fail(@"stdin_nonblocking");
      [timer invalidate]; mach_port_destroy(mach_task_self(), receivePort); return 2;
    }
    NSMutableData *pending = [NSMutableData data];
    dispatch_source_t input = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(input, ^{
      char bytes[4096];
      // ponytail: cap each dispatch turn so a busy controller cannot starve AppKit.
      for (int batch = 0; batch < 16 && !stopping; batch++) {
        ssize_t n = read(STDIN_FILENO, bytes, sizeof(bytes));
        if (!n) { stop(); break; }
        if (n < 0) {
          if (errno != EAGAIN && errno != EINTR) { fail(@"stdin_read"); stop(); }
          break;
        }
        [pending appendBytes:bytes length:(NSUInteger)n];
        for (;;) {
          const char *newline = memchr(pending.bytes, '\n', pending.length);
          if (!newline) break;
          NSUInteger length = (NSUInteger)(newline - (const char *)pending.bytes);
          NSData *line = [pending subdataWithRange:NSMakeRange(0, length)];
          [pending replaceBytesInRange:NSMakeRange(0, length + 1) withBytes:NULL length:0];
          id parsed = [NSJSONSerialization JSONObjectWithData:line options:0 error:NULL];
          if (![parsed isKindOfClass:[NSDictionary class]]) fail(@"invalid_json_object");
          else command(parsed);
        }
        if (pending.length > 65536) { fail(@"stdin_line_too_long"); stop(); }
      }
    });
    dispatch_resume(input);
    [NSApp run];
    dispatch_source_cancel(input);
    [timer invalidate];
    roots[0] = roots[1] = nil;
    hostView.layer.sublayers = @[];
    [hostWindow orderOut:nil];
    mach_port_destroy(mach_task_self(), receivePort);
    return 0;
  }
}
