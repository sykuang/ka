// Real no-UI consumer test: no NSApplication, NSWindow or compositor publication.
#include "../src/zen/toolkit/common/cocoa/ZenProfileHostDecoder.h"
#import <IOSurface/IOSurface.h>
#include <cassert>
#include <cstdio>
#include <unistd.h>
using namespace zen::profilehost;

static mach_port_urefs_t Refs(mach_port_t port) {
  mach_port_urefs_t refs = 0;
  assert(mach_port_get_refs(mach_task_self(), port, MACH_PORT_RIGHT_SEND,
                            &refs) == KERN_SUCCESS);
  return refs;
}
int main() {
  @autoreleasepool {
    NSDictionary* props = @{(id)kIOSurfaceWidth: @8, (id)kIOSurfaceHeight: @4,
                            (id)kIOSurfaceBytesPerElement: @4};
    IOSurfaceRef surface = IOSurfaceCreate((CFDictionaryRef)props);
    assert(surface);
    mach_port_t surfacePort = IOSurfaceCreateMachPort(surface);
    assert(surfacePort);
    mach_port_t endpoint = MACH_PORT_NULL;
    assert(mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE,
                              &endpoint) == KERN_SUCCESS);
    assert(mach_port_insert_right(mach_task_self(), endpoint, endpoint,
                                  MACH_MSG_TYPE_MAKE_SEND) == KERN_SUCCESS);
    Identity owner{uint32_t(getpid()), 19, 20, 21, 22};
    Gate gate;
    assert(gate.Admit(owner));
    Gate unadmitted, wrongPeer;
    Identity claimed = owner;
    claimed.pid++;
    assert(wrongPeer.Admit(claimed));
    CALayer* staged = nil;
    // Each case uses actual kernel delivery; rejection must destroy transferred
    // rights and leave the previous staged root untouched.
    for (int test = 0; test < 24; ++test) {
      Packet out{};
      out.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) |
                             MACH_MSGH_BITS_COMPLEX;
      out.header.msgh_size = sizeof(out);
      out.header.msgh_id = kFrameMessage;
      out.header.msgh_remote_port = endpoint;
      out.body.msgh_descriptor_count = kNodes;
      for (auto& d : out.surfaces) {
        d.type = MACH_MSG_PORT_DESCRIPTOR;
        d.disposition = MACH_MSG_TYPE_COPY_SEND;
      }
      out.surfaces[1].name = surfacePort;
      out.identity = owner;
      out.backingScale = 2;
      out.frame.count = 2;
      for (uint32_t i = 0; i < 2; ++i) {
        Node& n = out.frame.nodes[i];
        n.parent = i ? 0 : -1;
        n.contentsScale = 2; n.opacity = 0.75;
        n.bounds[2] = 8; n.bounds[3] = 4;
        n.position[0] = 3; n.position[1] = 5;
        n.anchor[0] = 0.25; n.anchor[1] = 0.75;
        n.contentsRect[2] = 1; n.contentsRect[3] = 1;
        n.flags = 2 | 4 | 8 | 16;
        n.cornerRadius = 1; n.background[3] = 1;
        for (int j = 0; j < 16; ++j)
          n.transform[j] = n.sublayerTransform[j] = j % 5 == 0 ? 1 : 0;
      }
      if (test == 1) out.identity.pid++;
      if (test == 2) out.identity.root++;
      if (test == 3) out.identity.generation++;
      if (test == 4) out.frame.unsupported = 1;
      if (test == 5) out.frame.count = kNodes + 1;
      if (test == 6) out.frame.nodes[1].parent = 1;
      if (test == 7) out.backingScale = 0;
      if (test == 8) out.frame.nodes[1].opacity = NAN;
      if (test == 9) out.surfaces[kNodes - 1].name = surfacePort;
      if (test == 10) out.surfaces[1].name = endpoint; // real right, not an IOSurface
      if (test == 11) out.identity.widget++;
      if (test == 12) out.identity.token++;
      if (test == 13) out.header.msgh_size = sizeof(out) - 4; // truncated payload
      if (test == 15) out.identity = claimed; // matches admission, NOT kernel audit PID
      if (test == 17) out.body.msgh_descriptor_count = kNodes - 1;
      if (test == 18) {
        out.surfaces[1].name = endpoint;
        out.surfaces[1].disposition = MACH_MSG_TYPE_MAKE_SEND_ONCE;
      }
      if (test == 19) out.header.msgh_id = 0x5a504831; // PH1 must not be reinterpreted
      if (test == 20) out.frame.nodes[1].edgeAntialiasingMask = 16;
      if (test == 21) out.frame.nodes[1].maskedCorners = 16;
      if (test == 22) out.frame.nodes[1].flags = 1u << 31; // still unknown (32 is opaque)
      if (test == 23) out.header.msgh_size = sizeof(out) - kNodes * 8; // PH1 node size
      auto before = Refs(surfacePort);
      assert(mach_msg(&out.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
                      out.header.msgh_size, 0, MACH_PORT_NULL, 100,
                      MACH_PORT_NULL) == KERN_SUCCESS);
      union Buffer {
        Packet packet;
        unsigned char bytes[sizeof(Packet) + MAX_TRAILER_SIZE];
      } in{};
      assert(mach_msg(&in.packet.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT |
                      MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
                      MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
                      0, sizeof(in), endpoint, 100, MACH_PORT_NULL) == KERN_SUCCESS);
      CALayer* old = staged;
      mach_port_t once = in.packet.surfaces[1].name;
      mach_port_urefs_t onceRefs = 0;
      if (test == 18) {
        assert(mach_port_get_refs(mach_task_self(), once, MACH_PORT_RIGHT_SEND_ONCE,
                                  &onceRefs) == KERN_SUCCESS && onceRefs == 1);
      }
      const Gate& admitted = test == 14 ? unadmitted : test == 15 ? wrongPeer : gate;
      bool accepted = Consume(&in.packet.header, sizeof(in), admitted,
                              test == 16 ? 1 : 2, &staged);
      assert(accepted == (test == 0));
      assert(Refs(surfacePort) == before);
      if (test == 18) {
        assert(mach_port_get_refs(mach_task_self(), once, MACH_PORT_RIGHT_SEND_ONCE,
                                  &onceRefs) == KERN_INVALID_NAME);
      }
      if (test) assert(staged == old);
      else {
        assert(staged && !staged.superlayer);
        assert(staged.sublayers.count == 1);
        CALayer* child = staged.sublayers[0];
        assert(IOSurfaceGetID((IOSurfaceRef)child.contents) == IOSurfaceGetID(surface));
        assert(child.bounds.size.width == 8 && child.bounds.size.height == 4);
        assert(child.position.x == 3 && child.anchorPoint.y == 0.75);
        assert(child.geometryFlipped && child.masksToBounds && !child.hidden);
        assert(child.contentsScale == 2 && child.cornerRadius == 1);
        assert(child.opacity == 0.75 && child.transform.m44 == 1);
        assert([child.contentsGravity isEqual:kCAGravityTopLeft]);
        assert([child.minificationFilter isEqual:kCAFilterNearest]);
        // Legacy hand-built fixtures retain ordinary CALayer defaults.
        assert(!child.opaque && [child.magnificationFilter isEqual:kCAFilterLinear]);
        assert(child.edgeAntialiasingMask == 15 && child.maskedCorners == 15);
      }
    }
    [staged release];
    CFRelease(surface);
    assert(mach_port_deallocate(mach_task_self(), surfacePort) == KERN_SUCCESS);
    assert(mach_port_deallocate(mach_task_self(), endpoint) == KERN_SUCCESS);
    assert(mach_port_mod_refs(mach_task_self(), endpoint, MACH_PORT_RIGHT_RECEIVE,
                              -1) == KERN_SUCCESS);
    puts("PASS real IOSurface CALayer staging; 23 refused frames (including PH1, malformed masks/flags) preserve staging and release received rights");
  }
}
