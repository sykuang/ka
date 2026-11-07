// No UI: actual production sender -> kernel audit trailer -> production decoder.
#include "../src/zen/toolkit/common/cocoa/ZenProfileHostSender.h"
#include "../src/zen/toolkit/common/cocoa/ZenProfileHostDecoder.h"
#import <IOSurface/IOSurface.h>
#include <cassert>
#include <cstdio>
#include <unistd.h>
using namespace zen::profilehost;
static mach_port_urefs_t Refs(mach_port_t port) {
  mach_port_urefs_t n = 0;
  assert(mach_port_get_refs(mach_task_self(), port, MACH_PORT_RIGHT_SEND, &n) == KERN_SUCCESS);
  return n;
}
static bool Receive(mach_port_t endpoint, const Gate& gate, CALayer** staged) {
  union { Packet p; unsigned char bytes[sizeof(Packet) + MAX_TRAILER_SIZE]; } in{};
  assert(mach_msg(&in.p.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT |
      MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
      MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT), 0, sizeof(in),
      endpoint, 0, MACH_PORT_NULL) == KERN_SUCCESS);
  assert(AuditPID(&in.p.header, sizeof(in)) == uint32_t(getpid()));
  return Consume(&in.p.header, sizeof(in), gate, 2, staged);
}
int main() {
  @autoreleasepool {
    IOSurfaceRef surface = IOSurfaceCreate((CFDictionaryRef)@{
      (id)kIOSurfaceWidth: @8, (id)kIOSurfaceHeight: @4,
      (id)kIOSurfaceBytesPerElement: @4});
    assert(surface);
    mach_port_t surfacePort = IOSurfaceCreateMachPort(surface);
    auto baseline = Refs(surfacePort);
    mach_port_t endpoint = 0;
    assert(mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &endpoint) == KERN_SUCCESS);
    assert(mach_port_insert_right(mach_task_self(), endpoint, endpoint, MACH_MSG_TYPE_MAKE_SEND) == KERN_SUCCESS);
    Identity identity{uint32_t(getpid()), 19, 20, 21, 22};
    Gate gate; assert(gate.Admit(identity));
    CALayer* root = [CALayer layer]; // zero-bounds root must not clip children
    CALayer* child = [CALayer layer];
    child.contents = (id)surface;
    child.bounds = CGRectMake(1, 2, 8, 4);
    child.position = CGPointMake(3, 5);
    child.anchorPoint = CGPointMake(0.25, 0.75);
    child.contentsRect = CGRectMake(0.125, 0.25, 0.5, 0.5);
    child.contentsScale = 2; child.opacity = 0.75;
    child.cornerRadius = 1; child.masksToBounds = YES; child.geometryFlipped = YES;
    child.contentsGravity = kCAGravityTopLeft;
    child.minificationFilter = kCAFilterNearest;
    child.transform = CATransform3DMakeTranslation(2, 3, 0);
    root.sublayerTransform = CATransform3DMakeScale(2, 2, 1);
    CGColorRef color = CGColorCreateGenericRGB(0.25, 0.5, 0.75, 1);
    child.backgroundColor = color; CGColorRelease(color);
    [root addSublayer:child];
    CALayer* staged = nil;
    assert(SendStaging(endpoint, identity, root, 2) == KERN_SUCCESS);
    assert(Receive(endpoint, gate, &staged));
    assert(Refs(surfacePort) == baseline);
    assert(staged && !staged.superlayer && !staged.masksToBounds);
    CALayer* copy = staged.sublayers[0];
    assert(copy != child && child.superlayer == root && !root.superlayer);
    assert(IOSurfaceGetID((IOSurfaceRef)copy.contents) == IOSurfaceGetID(surface));
    assert(CGRectEqualToRect(copy.bounds, child.bounds));
    assert(CGPointEqualToPoint(copy.position, child.position));
    assert(CGPointEqualToPoint(copy.anchorPoint, child.anchorPoint));
    assert(CGRectEqualToRect(copy.contentsRect, child.contentsRect));
    assert(CATransform3DEqualToTransform(copy.transform, child.transform));
    assert(CATransform3DEqualToTransform(staged.sublayerTransform, root.sublayerTransform));
    assert(copy.opacity == 0.75 && copy.contentsScale == 2 && copy.cornerRadius == 1);
    assert(copy.geometryFlipped && copy.masksToBounds);
    assert([copy.contentsGravity isEqual:kCAGravityTopLeft]);
    assert([copy.minificationFilter isEqual:kCAFilterNearest]);
    const CGFloat* rgba = CGColorGetComponents(copy.backgroundColor);
    assert(rgba[0] == 0.25 && rgba[1] == 0.5 && rgba[2] == 0.75 && rgba[3] == 1);
    CALayer* old = staged;
    // Refuse the entire tree; don't send a truncated/approximated replacement.
    child.mask = [CALayer layer];
    assert(SendStaging(endpoint, identity, root, 2) != KERN_SUCCESS);
    child.mask = nil;
    child.opaque = YES;
    assert(SendStaging(endpoint, identity, root, 2) == KERN_SUCCESS);
    assert(Receive(endpoint, gate, &staged));
    assert(staged.sublayers[0].opaque && Refs(surfacePort) == baseline);
    child.opaque = NO;
    child.allowsGroupOpacity = NO;
    assert(SendStaging(endpoint, identity, root, 2) != KERN_SUCCESS);
    child.allowsGroupOpacity = YES;
    child.minificationFilterBias = 1;
    assert(SendStaging(endpoint, identity, root, 2) != KERN_SUCCESS);
    child.minificationFilterBias = 0;
    child.magnificationFilter = kCAFilterNearest;
    assert(SendStaging(endpoint, identity, root, 2) == KERN_SUCCESS);
    assert(Receive(endpoint, gate, &staged));
    assert([staged.sublayers[0].magnificationFilter isEqual:kCAFilterNearest]);
    assert(!staged.sublayers[0].opaque && Refs(surfacePort) == baseline);
    old = staged;
    child.magnificationFilter = kCAFilterTrilinear;
    assert(SendStaging(endpoint, identity, root, 2) != KERN_SUCCESS);
    child.magnificationFilter = kCAFilterLinear;
    child.minificationFilter = kCAFilterTrilinear;
    assert(SendStaging(endpoint, identity, root, 2) != KERN_SUCCESS);
    child.minificationFilter = kCAFilterNearest;
    [root addSublayer:[CATransformLayer layer]];
    assert(SendStaging(endpoint, identity, root, 2) != KERN_SUCCESS);
    root.sublayers = @[child];
    for (unsigned i = 0; i < kNodes; ++i) [root addSublayer:[CALayer layer]];
    assert(SendStaging(endpoint, identity, root, 2) != KERN_SUCCESS);
    root.sublayers = @[child];
    mach_msg_header_t empty{};
    assert(mach_msg(&empty, MACH_RCV_MSG | MACH_RCV_TIMEOUT, 0, sizeof(empty), endpoint, 0, 0) == MACH_RCV_TIMED_OUT);
    assert(staged == old && Refs(surfacePort) == baseline);
    // Real kernel queue-full, zero-timeout failure; drain accepted packets.
    mach_port_limits_t limits{1};
    assert(mach_port_set_attributes(mach_task_self(), endpoint, MACH_PORT_LIMITS_INFO,
        (mach_port_info_t)&limits, MACH_PORT_LIMITS_INFO_COUNT) == KERN_SUCCESS);
    assert(SendStaging(endpoint, identity, root, 2) == KERN_SUCCESS);
    auto queued = Refs(surfacePort);
    for (int i = 0; i < 16; ++i) {
      assert(SendStaging(endpoint, identity, root, 2) == MACH_SEND_TIMED_OUT);
      assert(Refs(surfacePort) == queued);
    }
    assert(Receive(endpoint, gate, &staged));
    assert(Refs(surfacePort) == baseline);
    assert(SendStaging(MACH_PORT_DEAD, identity, root, 2) != KERN_SUCCESS);
    assert(Refs(surfacePort) == baseline);
    [staged release];
    CFRelease(surface);
    assert(mach_port_deallocate(mach_task_self(), surfacePort) == KERN_SUCCESS);
    assert(mach_port_deallocate(mach_task_self(), endpoint) == KERN_SUCCESS);
    assert(mach_port_mod_refs(mach_task_self(), endpoint, MACH_PORT_RIGHT_RECEIVE, -1) == KERN_SUCCESS);
    puts("PASS production CALayer/IOSurface sender -> kernel audit -> decoder; opaque/nearest positives, unsupported/bounded tree refusal, queue-full and invalid destination rights cleanup");
  }
}
