// Source-derived NativeLayerCA property model, NOT a linked/live Gecko root.
// Real production sender -> Mach/audit -> decoder; detached CALayers only.
#include "../src/zen/toolkit/common/cocoa/ZenProfileHostSender.h"
#include "../src/zen/toolkit/common/cocoa/ZenProfileHostDecoder.h"
#import <IOSurface/IOSurface.h>
#include <cassert>
#include <cstdio>
#include <unistd.h>
using namespace zen::profilehost;

static_assert((kCALayerLeftEdge | kCALayerRightEdge | kCALayerTopEdge |
               kCALayerBottomEdge) == 15, "wire preserves SDK edge bits");
static_assert((kCALayerMinXMinYCorner | kCALayerMaxXMinYCorner |
               kCALayerMinXMaxYCorner | kCALayerMaxXMaxYCorner) == 15,
              "wire preserves SDK corner bits");

static mach_port_urefs_t Refs(mach_port_t port) {
  mach_port_urefs_t n = 0;
  assert(mach_port_get_refs(mach_task_self(), port, MACH_PORT_RIGHT_SEND, &n) == KERN_SUCCESS);
  return n;
}
static void EqualTree(CALayer* source, CALayer* copy) {
  assert(source != copy);
  assert(CGRectEqualToRect(source.bounds, copy.bounds));
  assert(CGPointEqualToPoint(source.position, copy.position));
  assert(CGPointEqualToPoint(source.anchorPoint, copy.anchorPoint));
  assert(CGRectEqualToRect(source.contentsRect, copy.contentsRect));
  assert(CATransform3DEqualToTransform(source.transform, copy.transform));
  assert(CATransform3DEqualToTransform(source.sublayerTransform, copy.sublayerTransform));
  assert(source.edgeAntialiasingMask == copy.edgeAntialiasingMask);
  assert(source.opaque == copy.opaque && source.maskedCorners == copy.maskedCorners);
  assert(source.cornerRadius == copy.cornerRadius && source.contentsScale == copy.contentsScale);
  assert(source.opacity == copy.opacity && source.hidden == copy.hidden);
  assert(source.geometryFlipped == copy.geometryFlipped && source.masksToBounds == copy.masksToBounds);
  assert([source.contentsGravity isEqual:copy.contentsGravity]);
  assert([source.minificationFilter isEqual:copy.minificationFilter]);
  assert([source.magnificationFilter isEqual:copy.magnificationFilter]);
  if (source.contents) {
    assert(copy.contents);
    assert(IOSurfaceGetID((IOSurfaceRef)source.contents) == IOSurfaceGetID((IOSurfaceRef)copy.contents));
  } else assert(!copy.contents);
  assert(source.sublayers.count == copy.sublayers.count);
  for (NSUInteger i = 0; i < source.sublayers.count; ++i) {
    assert(source.sublayers[i].superlayer == source);
    assert(copy.sublayers[i].superlayer == copy);
    EqualTree(source.sublayers[i], copy.sublayers[i]);
  }
}
static bool RoundTrip(const char* label, mach_port_t endpoint, const Identity& identity,
                      const Gate& gate, CALayer* root, mach_port_t surfacePort,
                      CALayer** staged) {
  auto before = Refs(surfacePort);
  CALayer* old = *staged;
  auto result = SendStaging(endpoint, identity, root, 2);
  if (result != KERN_SUCCESS) {
    assert(*staged == old && Refs(surfacePort) == before);
    std::printf("FAIL %s: send=0x%x (desired KERN_SUCCESS)\n", label, unsigned(result));
    return false;
  }
  union { Packet p; unsigned char bytes[sizeof(Packet) + MAX_TRAILER_SIZE]; } in{};
  assert(mach_msg(&in.p.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT |
      MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
      MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT), 0, sizeof(in),
      endpoint, 0, MACH_PORT_NULL) == KERN_SUCCESS);
  assert(AuditPID(&in.p.header, sizeof(in)) == uint32_t(getpid()));
  // IOSurfaceCreateMachPort can create a distinct port for the same surface.
  mach_port_t incoming = MACH_PORT_NULL;
  for (const auto& d : in.p.surfaces) if (d.name) { assert(!incoming); incoming = d.name; }
  assert(incoming);
  auto held = Refs(incoming);
  assert(held > 0);
  assert(Consume(&in.p.header, sizeof(in), gate, 2, staged));
  mach_port_urefs_t remaining = 0;
  auto status = mach_port_get_refs(mach_task_self(), incoming, MACH_PORT_RIGHT_SEND, &remaining);
  assert(held == 1 ? status == KERN_INVALID_NAME : status == KERN_SUCCESS && remaining == held - 1);
  assert(Refs(surfacePort) == before && *staged && !(*staged).superlayer);
  assert(!root.superlayer);
  EqualTree(root, *staged);
  return true;
}
int main() {
  @autoreleasepool {
    IOSurfaceRef surface = IOSurfaceCreate((CFDictionaryRef)@{
      (id)kIOSurfaceWidth: @8, (id)kIOSurfaceHeight: @4,
      (id)kIOSurfaceBytesPerElement: @4});
    assert(surface);
    mach_port_t surfacePort = IOSurfaceCreateMachPort(surface);
    assert(surfacePort);
    mach_port_t endpoint = 0;
    assert(mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &endpoint) == KERN_SUCCESS);
    assert(mach_port_insert_right(mach_task_self(), endpoint, endpoint, MACH_MSG_TYPE_MAKE_SEND) == KERN_SUCCESS);
    Identity identity{uint32_t(getpid()), 19, 20, 21, 22};
    Gate gate; assert(gate.Admit(identity));
    CALayer* staged = nil;
    CALayer* root = [CALayer layer];
    CALayer* child = [CALayer layer];
    child.bounds = CGRectMake(0, 0, 8, 4); child.contents = (id)surface;
    [root addSublayer:child];
    // Preserve the parent's exact default positive + ONE-property desired case.
    bool ok = RoundTrip("original default control", endpoint, identity, gate, root, surfacePort, &staged);
    child.edgeAntialiasingMask = 0;
    ok = RoundTrip("original Gecko edgeAntialiasingMask=0", endpoint, identity, gate, root, surfacePort, &staged) && ok;
    child.edgeAntialiasingMask = 15;
    child.opaque = YES;
    ok = RoundTrip("Gecko opaque content", endpoint, identity, gate, root, surfacePort, &staged) && ok;
    child.opaque = NO;
    child.magnificationFilter = kCAFilterNearest;
    ok = RoundTrip("Gecko POINT magnification", endpoint, identity, gate, root, surfacePort, &staged) && ok;
    child.magnificationFilter = kCAFilterLinear;
    child.cornerRadius = 1; child.maskedCorners = kCALayerMinXMinYCorner;
    ok = RoundTrip("Gecko rounded corner subset", endpoint, identity, gate, root, surfacePort, &staged) && ok;

    // nsCocoaWindow root factory: zero bounds, zero position/anchor, top-left.
    root.position = CGPointZero; root.bounds = CGRectZero;
    root.anchorPoint = CGPointZero; root.contentsGravity = kCAGravityTopLeft;
    CALayer* wrapper = [CALayer layer];
    CALayer* clip = [CALayer layer];
    root.sublayers = @[wrapper]; [wrapper addSublayer:clip]; [clip addSublayer:child];
    // NativeLayerCARepresentation::ApplyChanges normal wrapper/rounded/content.
    for (CALayer* layer in @[wrapper, clip, child]) {
      layer.anchorPoint = CGPointZero; layer.contentsGravity = kCAGravityTopLeft;
      layer.edgeAntialiasingMask = 0;
    }
    wrapper.position = CGPointMake(3, 5); wrapper.bounds = CGRectMake(0, 0, 8, 4);
    wrapper.masksToBounds = YES;
    clip.position = CGPointMake(1, 0.5); clip.bounds = CGRectMake(0, 0, 6, 3);
    clip.cornerRadius = 1; clip.masksToBounds = YES;
    clip.maskedCorners = kCALayerMinXMinYCorner | kCALayerMaxXMaxYCorner;
    child.position = CGPointZero; child.bounds = CGRectMake(0, 0, 4, 2);
    child.contentsScale = 2; child.opaque = YES; child.cornerRadius = 0;
    child.transform = CATransform3DMakeTranslation(-1, -0.5, 0);
    child.minificationFilter = kCAFilterNearest; child.magnificationFilter = kCAFilterNearest;
    ok = RoundTrip("complete normal Gecko-derived hierarchy", endpoint, identity, gate, root, surfacePort, &staged) && ok;
    if (ok) {
      // All valid bit combinations (not just zero/all) and independent filters.
      for (unsigned mask = 0; mask < 16; ++mask) {
        wrapper.edgeAntialiasingMask = mask; clip.edgeAntialiasingMask = 15 - mask;
        child.edgeAntialiasingMask = mask; clip.maskedCorners = mask;
        for (unsigned filters = 0; filters < 4; ++filters) {
          child.minificationFilter = (filters & 1) ? kCAFilterNearest : kCAFilterLinear;
          child.magnificationFilter = (filters & 2) ? kCAFilterNearest : kCAFilterLinear;
          child.opaque = (mask & 1) != 0;
          assert(RoundTrip("mask/filter matrix", endpoint, identity, gate, root, surfacePort, &staged));
        }
      }
    }
    [staged release]; CFRelease(surface);
    assert(mach_port_deallocate(mach_task_self(), surfacePort) == KERN_SUCCESS);
    assert(mach_port_deallocate(mach_task_self(), endpoint) == KERN_SUCCESS);
    assert(mach_port_mod_refs(mach_task_self(), endpoint, MACH_PORT_RIGHT_RECEIVE, -1) == KERN_SUCCESS);
    if (ok) puts("PASS original single-property regression + normal Gecko-derived wrapper/clip/IOSurface hierarchy + 64 mask/filter roundtrips; detached only");
    return ok ? 0 : 1;
  }
}
