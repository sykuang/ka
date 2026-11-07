// No-UI executable. Compile with xcrun clang++ -std=c++17 -x objective-c++.
#include "../src/zen/toolkit/common/ZenProfileHostProtocol.h"
#include <cassert>
#include <cstdio>
#include <unistd.h>
using namespace zen::profilehost;

// Real kernel delivery, including an audit trailer and one received send right.
// This does not initialize NSApplication, connect to WindowServer, or draw UI.
static void RightsCleanup() {
  struct Packet {
    mach_msg_header_t header;
    mach_msg_body_t body;
    mach_msg_port_descriptor_t descriptor;
  };
  mach_port_t endpoint = MACH_PORT_NULL, surface = MACH_PORT_NULL;
  assert(mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE,
                            &endpoint) == KERN_SUCCESS);
  assert(mach_port_insert_right(mach_task_self(), endpoint, endpoint,
                                MACH_MSG_TYPE_MAKE_SEND) == KERN_SUCCESS);
  assert(mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE,
                            &surface) == KERN_SUCCESS);
  assert(mach_port_insert_right(mach_task_self(), surface, surface,
                                MACH_MSG_TYPE_MAKE_SEND) == KERN_SUCCESS);
  for (int rejected = 0; rejected != 2; ++rejected) {
    mach_port_urefs_t before = 0, held = 0, after = 0;
    assert(mach_port_get_refs(mach_task_self(), surface, MACH_PORT_RIGHT_SEND,
                              &before) == KERN_SUCCESS);
    Packet out{};
    out.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) |
                           MACH_MSGH_BITS_COMPLEX;
    out.header.msgh_size = sizeof(out);
    out.header.msgh_remote_port = endpoint;
    out.body.msgh_descriptor_count = 1;
    out.descriptor.name = surface;
    out.descriptor.type = MACH_MSG_PORT_DESCRIPTOR;
    out.descriptor.disposition = MACH_MSG_TYPE_COPY_SEND;
    assert(mach_msg(&out.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
                    sizeof(out), 0, MACH_PORT_NULL, 100, MACH_PORT_NULL) == KERN_SUCCESS);
    union {
      Packet packet;
      unsigned char bytes[sizeof(Packet) + MAX_TRAILER_SIZE];
    } in{};
    assert(mach_msg(&in.packet.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT |
                    MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
                    MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
                    0, sizeof(in), endpoint, 100, MACH_PORT_NULL) == KERN_SUCCESS);
    {
      Received owned(&in.packet.header, sizeof(in));
      assert(MessageLayout(&in.packet.header, sizeof(in)));
      assert(!MessageLayout(&in.packet.header, sizeof(mach_msg_header_t)));
      assert(AuditPID(&in.packet.header, sizeof(in)) == uint32_t(getpid()));
      assert(AuditPID(&in.packet.header, sizeof(Packet)) == 0);
      assert(mach_port_get_refs(mach_task_self(), surface, MACH_PORT_RIGHT_SEND,
                                &held) == KERN_SUCCESS);
      assert(held == before + 1);
      Frame frame{};
      frame.count = 1; frame.nodes[0].parent = -1;
      frame.nodes[0].contentsScale = 1;
      frame.unsupported = rejected;
      assert(ValidateTree(frame) == (rejected ? Error::UnsupportedTree : Error::Ok));
    }
    assert(mach_port_get_refs(mach_task_self(), surface, MACH_PORT_RIGHT_SEND,
                              &after) == KERN_SUCCESS);
    assert(after == before);
  }
  const mach_port_t ports[] = {surface, endpoint};
  for (mach_port_t port : ports) {
    assert(mach_port_deallocate(mach_task_self(), port) == KERN_SUCCESS);
    assert(mach_port_mod_refs(mach_task_self(), port, MACH_PORT_RIGHT_RECEIVE,
                              -1) == KERN_SUCCESS);
  }
}
int main() {
  RightsCleanup();
  Identity id{42, 17, 18, 19, 20};
  Gate g;
  assert(!g.Admit({0,17,18,19,20}));
  assert(g.Admit(id));
  assert(!g.Matches(id, 41));
  auto wrong = id; wrong.root++;
  assert(!g.Matches(wrong,42));
  wrong=id; wrong.generation++;
  assert(!g.Matches(wrong,42));
  assert(g.Matches(id,42));
  assert(g.Begin(1,2,800,600,2));
  assert(!g.CanPublish());
  assert(!g.Space(2,2));
  assert(g.Space(1,2));
  assert(!g.Resize(1,799,600,2));
  assert(g.Resize(1,800,600,2));
  assert(!g.Frame(1,0));
  assert(!g.Frame(2,1));
  assert(!g.CanPublish());
  assert(g.Frame(1,1));
  assert(!g.CanPublish());
  assert(!g.Focus(2));
  assert(!g.Focus(1)); // A's composition and blur must complete before focus.
  assert(!g.Composition(2));
  assert(g.Composition(1));
  assert(!g.Focus(1));
  assert(!g.Blur(2));
  assert(g.Blur(1));
  assert(g.Focus(1));
  assert(g.CanPublish());
  assert(g.Publish());
  assert(g.Input(id,42));
  assert(!g.Input(wrong,42));
  assert(g.Begin(2,3,801,600,2));
  assert(!g.CanPublish());
  assert(!g.Frame(1,2));
  assert(!g.Focus(1));
  g.ReturnLocal();
  assert(!g.Input(id,42));
  assert(!g.CanPublish());
  assert(!WorkerBootstrap(42,41,17));
  assert(!WorkerBootstrap(42,42,0));
  assert(WorkerBootstrap(42,42,17));
  assert(!WorkerBootstrap(0,42,17)); // ordinary A/manager has no worker role
  Frame frame{};
  frame.count=1; frame.nodes[0].parent=-1;
  frame.nodes[0].contentsScale=1; frame.nodes[0].opacity=1;
  assert(ValidateTree(frame)==Error::Ok);
  frame.unsupported=1;
  assert(ValidateTree(frame)==Error::UnsupportedTree);
  frame.unsupported=0; frame.nodes[0].parent=0;
  assert(ValidateTree(frame)==Error::Tree);
  frame.nodes[0].parent=-1;
  frame.nodes[0].flags=32 | 64;
  frame.nodes[0].edgeAntialiasingMask=0; frame.nodes[0].maskedCorners=5;
  assert(ValidateTree(frame)==Error::Ok);
  frame.nodes[0].flags=1u << 31;
  assert(ValidateTree(frame)==Error::Tree);
  frame.nodes[0].flags=0; frame.nodes[0].edgeAntialiasingMask=16;
  assert(ValidateTree(frame)==Error::Tree);
  frame.nodes[0].edgeAntialiasingMask=15; frame.nodes[0].maskedCorners=16;
  assert(ValidateTree(frame)==Error::Tree);
  puts("PASS actual protocol/state: PID/root/generation, stale resize/frame/focus, no early publish, unsupported tree, ordinary role");
}
