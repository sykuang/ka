// Throwaway native transport probe. Synthetic IOSurfaces, NOT Gecko output.
// Run: python3 scripts/prototype_profile_hosting.py --native-transport [--interactive]
// ponytail: deprecated bootstrap discovery for a local probe; use authenticated endpoints before product integration.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <IOSurface/IOSurface.h>
#import <servers/bootstrap.h>
#import <mach/mach.h>
#include <signal.h>
#include <unistd.h>

#define WIDTH 320
#define HEIGHT 240

typedef struct {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t surface;
  mach_msg_port_descriptor_t input;
  uint32_t slot, frame, clicks, pid;
} Frame;
typedef struct { mach_msg_header_t header; uint32_t action; } Input;

static mach_port_t receivePort(void) {
  mach_port_t port = MACH_PORT_NULL;
  if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &port) != KERN_SUCCESS ||
      mach_port_insert_right(mach_task_self(), port, port, MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS) abort();
  return port;
}

static int worker(const char *name, uint32_t slot) {
  mach_port_t host = MACH_PORT_NULL;
  if (bootstrap_look_up(bootstrap_port, name, &host) != KERN_SUCCESS) return 2;
  mach_port_t input = receivePort();
  IOSurfaceRef surface = IOSurfaceCreate((__bridge CFDictionaryRef)@{
    (__bridge NSString *)kIOSurfaceWidth: @(WIDTH),
    (__bridge NSString *)kIOSurfaceHeight: @(HEIGHT),
    (__bridge NSString *)kIOSurfaceBytesPerElement: @4,
    (__bridge NSString *)kIOSurfacePixelFormat: @((uint32_t)'BGRA')
  });
  if (!surface) return 3;
  mach_port_t surfacePort = IOSurfaceCreateMachPort(surface);
  uint32_t frame = 0, clicks = 0;
  for (;;) {
    union { Input message; char bytes[sizeof(Input) + 512]; } command = {0};
    kern_return_t received = mach_msg(&command.message.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT,
      0, sizeof(command), input, 40, MACH_PORT_NULL);
    if (received == KERN_SUCCESS && command.message.header.msgh_size == sizeof(Input) && command.message.action == 1) clicks++;
    if (received != KERN_SUCCESS && received != MACH_RCV_TIMED_OUT) return 4;
    frame++;
    if (IOSurfaceLock(surface, 0, NULL) != kIOReturnSuccess) return 5;
    size_t stride = IOSurfaceGetBytesPerRow(surface) / 4;
    uint32_t *pixels = IOSurfaceGetBaseAddress(surface);
    for (int y = 0; y < HEIGHT; y++) {
      for (int x = 0; x < WIDTH; x++) {
        uint32_t color = slot ? 0xff8646c4 : 0xff287d9e;
        if ((uint32_t)x / 16 == frame % 20) color = 0xffeeeeee;
        if ((uint32_t)y < 20 * clicks) color = 0xff51c777;
        pixels[y * stride + x] = color;
      }
    }
    IOSurfaceUnlock(surface, 0, NULL);
    Frame update = {0};
    update.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
    update.header.msgh_remote_port = host;
    update.header.msgh_size = sizeof(update);
    update.header.msgh_id = 1;
    update.body.msgh_descriptor_count = 2;
    update.surface.name = surfacePort;
    update.surface.disposition = MACH_MSG_TYPE_COPY_SEND;
    update.surface.type = MACH_MSG_PORT_DESCRIPTOR;
    update.input.name = input;
    update.input.disposition = MACH_MSG_TYPE_COPY_SEND;
    update.input.type = MACH_MSG_PORT_DESCRIPTOR;
    update.slot = slot;
    update.frame = frame;
    update.clicks = clicks;
    update.pid = getpid();
    if (mach_msg(&update.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(update), 0,
                 MACH_PORT_NULL, 1000, MACH_PORT_NULL) != KERN_SUCCESS) return 6;
  }
}

static CALayer *panes[2];
static mach_port_t inputs[2];
static uint32_t frames[2], clicks[2], surfaceIDs[2];
static NSTask *tasks[2];

static void stopApplication(void) {
  [NSApp stop:nil];
  [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined
    location:NSZeroPoint modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
    windowNumber:0 context:nil subtype:0 data1:0 data2:0] atStart:YES];
}

@interface ProbeView : NSView
@end
@implementation ProbeView
- (BOOL)isFlipped { return YES; }
- (void)setFrameSize:(NSSize)size {
  [super setFrameSize:size];
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  for (int i = 0; i < 2; i++) panes[i].frame = CGRectMake(i * size.width / 2, 0, size.width / 2, size.height);
  [CATransaction commit];
}
- (void)mouseDown:(NSEvent *)event {
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  int slot = point.x < self.bounds.size.width / 2 ? 0 : 1;
  if (inputs[slot] == MACH_PORT_NULL) return;
  Input message = {0};
  message.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  message.header.msgh_remote_port = inputs[slot];
  message.header.msgh_size = sizeof(message);
  message.action = 1;
  if (mach_msg(&message.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(message), 0,
               MACH_PORT_NULL, 100, MACH_PORT_NULL) != KERN_SUCCESS) abort();
}
@end

static void postClick(NSWindow *window, CGFloat x) {
  NSEvent *event = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown
    location:NSMakePoint(x, 100) modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
    windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1];
  [NSApp postEvent:event atStart:NO];
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc == 4 && strcmp(argv[1], "--worker") == 0) return worker(argv[2], (uint32_t)atoi(argv[3]));
    BOOL interactive = argc == 2 && strcmp(argv[1], "--interactive") == 0;
    NSString *name = [NSString stringWithFormat:@"local.zen-native-probe.%d", getpid()];
    name_t serviceName;
    snprintf(serviceName, sizeof(serviceName), "%s", name.UTF8String);
    mach_port_t port = receivePort();
    kern_return_t registered = bootstrap_register(bootstrap_port, serviceName, port);
    if (registered != KERN_SUCCESS) { fprintf(stderr, "bootstrap_register: %s\n", bootstrap_strerror(registered)); return 2; }
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 640, 240)
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
      backing:NSBackingStoreBuffered defer:NO];
    ProbeView *view = [[ProbeView alloc] initWithFrame:NSMakeRect(0, 0, 640, 240)];
    view.wantsLayer = YES;
    for (int i = 0; i < 2; i++) {
      panes[i] = [CALayer layer];
      panes[i].contentsGravity = kCAGravityResize;
      [view.layer addSublayer:panes[i]];
      tasks[i] = [NSTask new];
      tasks[i].executableURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[0]]];
      tasks[i].arguments = @[@"--worker", name, [NSString stringWithFormat:@"%d", i]];
      NSError *error = nil;
      if (![tasks[i] launchAndReturnError:&error]) { NSLog(@"%@", error); return 3; }
    }
    window.contentView = view;
    window.title = @"TRANSPORT ONLY — synthetic workers, NOT Gecko. Click either pane.";
    [view setFrameSize:view.frame.size];
    [window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    __block BOOL sentClicks = NO, resized = NO;
    __block int result = 1;
    double started = NSProcessInfo.processInfo.systemUptime;
    NSTimer *timer = [NSTimer scheduledTimerWithTimeInterval:0.02 repeats:YES block:^(NSTimer *unused) {
      (void)unused;
      if (interactive && !window.visible) {
        result = 0;
        [unused invalidate];
        stopApplication();
        return;
      }
      for (int batch = 0; batch < 20; batch++) {
        union { Frame frame; char bytes[sizeof(Frame) + 512]; } buffer = {0};
        kern_return_t received = mach_msg(&buffer.frame.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT,
          0, sizeof(buffer), port, 0, MACH_PORT_NULL);
        if (received == MACH_RCV_TIMED_OUT) break;
        Frame *message = &buffer.frame;
        if (received != KERN_SUCCESS) abort();
        if (message->header.msgh_size != sizeof(Frame) || !(message->header.msgh_bits & MACH_MSGH_BITS_COMPLEX) ||
            message->body.msgh_descriptor_count != 2 || message->surface.type != MACH_MSG_PORT_DESCRIPTOR ||
            message->input.type != MACH_MSG_PORT_DESCRIPTOR || message->slot > 1 ||
            message->pid != (uint32_t)tasks[message->slot].processIdentifier) { mach_msg_destroy(&message->header); continue; }
        int slot = message->slot;
        IOSurfaceRef surface = IOSurfaceLookupFromMachPort(message->surface.name);
        if (!surface || IOSurfaceGetWidth(surface) != WIDTH || IOSurfaceGetHeight(surface) != HEIGHT) abort();
        surfaceIDs[slot] = IOSurfaceGetID(surface);
        [CATransaction begin];
        [CATransaction setDisableActions:YES];
        panes[slot].contents = nil;
        panes[slot].contents = (__bridge id)surface;
        [CATransaction commit];
        CFRelease(surface);
        mach_port_deallocate(mach_task_self(), message->surface.name);
        if (inputs[slot]) mach_port_deallocate(mach_task_self(), inputs[slot]);
        inputs[slot] = message->input.name;
        frames[slot] = message->frame;
        clicks[slot] = message->clicks;
      }
      if (!interactive && !resized && frames[0] >= 3 && frames[1] >= 3) {
        [window setContentSize:NSMakeSize(800, 300)];
        resized = YES;
      }
      if (!interactive && !sentClicks && resized && frames[0] >= 5 && frames[1] >= 5) {
        postClick(window, 100);
        postClick(window, 600);
        sentClicks = YES;
      }
      double elapsed = NSProcessInfo.processInfo.systemUptime - started;
      if ((!interactive && elapsed >= 2 && clicks[0] == 1 && clicks[1] == 1) || (!interactive && elapsed > 10)) {
        NSUInteger visible = 0;
        for (NSWindow *candidate in NSApp.windows) if (candidate.visible) visible++;
        BOOL passed = clicks[0] == 1 && clicks[1] == 1 && frames[0] >= 10 && frames[1] >= 10 &&
          surfaceIDs[0] != surfaceIDs[1] && surfaceIDs[0] != 0 && surfaceIDs[1] != 0 && visible == 1 &&
          CGRectGetWidth(panes[0].frame) == 400 && CGRectGetWidth(panes[1].frame) == 400;
        NSDictionary *report = @{@"native_transport_probe": passed ? @"PASS" : @"FAIL",
          @"gecko_connected": @NO, @"synthetic_surfaces": @YES, @"visible_host_windows": @(visible),
          @"host_pid": @(getpid()),
          @"worker_pids": @[@(tasks[0].processIdentifier), @(tasks[1].processIdentifier)],
          @"surface_ids": @[@(surfaceIDs[0]), @(surfaceIDs[1])], @"frames": @[@(frames[0]), @(frames[1])],
          @"worker_click_acks": @[@(clicks[0]), @(clicks[1])], @"resize_pass": @(CGRectGetWidth(panes[0].frame) == 400)};
        NSData *data = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil];
        puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
        fflush(stdout);
        result = passed ? 0 : 1;
        [unused invalidate];
        stopApplication();
      }
    }];
    [NSApp run];
    [timer invalidate];
    for (int i = 0; i < 2; i++) { if (tasks[i].running) [tasks[i] terminate]; [tasks[i] waitUntilExit]; }
    mach_port_destroy(mach_task_self(), port);
    return result;
  }
}
