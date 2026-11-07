// Standalone no-UI regression: include the ACTUAL sender, adapting only rights creation/release.
// Run: xcrun clang++ -std=c++17 -Wall -Wextra -Werror scripts/test_zen_profile_host_sender_rights.mm -framework Foundation -framework QuartzCore -framework IOSurface -framework CoreGraphics -o OWNED_OUTPUT && OWNED_OUTPUT
// The deliberate cleanup-suppression mutation must be caught; fixture reclaims its rights.
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#include "../src/zen/toolkit/common/cocoa/ZenProfileHostSender.h"
#include <vector>
#include <cstdio>
#include <unistd.h>
using namespace zen::profilehost;
struct Created { mach_port_t name; mach_port_urefs_t baseline; };
static std::vector<Created> created;
static bool suppressCleanup;
static mach_msg_return_t injectedSendResult;
static mach_msg_return_t ObserveMessage(mach_msg_header_t* h, mach_msg_option_t options,
    mach_msg_size_t send, mach_msg_size_t receive, mach_port_name_t port,
    mach_msg_timeout_t timeout, mach_port_name_t notify) {
  auto result = mach_msg(h, options, send, receive, port, timeout, notify);
  // Result-only control AFTER a real send timeout and kernel pseudo-receive.
  return result == MACH_SEND_TIMED_OUT && injectedSendResult ? injectedSendResult : result;
}
static mach_port_t ObserveCreate(IOSurfaceRef surface) {
  auto p = IOSurfaceCreateMachPort(surface);
  mach_port_urefs_t n = 0;
  if (p && mach_port_get_refs(mach_task_self(), p, MACH_PORT_RIGHT_SEND, &n) == KERN_SUCCESS)
    created.push_back({p, n - 1});
  return p;
}
static kern_return_t ObserveRelease(ipc_space_t task, mach_port_name_t port) {
  if (suppressCleanup) return KERN_SUCCESS; // controlled mutation; fixture reclaims below
  return mach_port_deallocate(task, port);
}
#define IOSurfaceCreateMachPort ObserveCreate
#define mach_port_deallocate ObserveRelease
#define mach_msg ObserveMessage
#include "../src/zen/toolkit/common/cocoa/ZenProfileHostSender.mm"
#undef IOSurfaceCreateMachPort
#undef mach_port_deallocate
#undef mach_msg
static bool AtBaseline(const Created& p) {
  mach_port_urefs_t n = 0;
  auto result = mach_port_get_refs(mach_task_self(), p.name, MACH_PORT_RIGHT_SEND, &n);
  return p.baseline ? result == KERN_SUCCESS && n == p.baseline : result == KERN_INVALID_NAME;
}
int main() {
  @autoreleasepool {
    IOSurfaceRef surface = IOSurfaceCreate((CFDictionaryRef)@{
      (id)kIOSurfaceWidth: @8, (id)kIOSurfaceHeight: @4,
      (id)kIOSurfaceBytesPerElement: @4});
    if (!surface) return 2;
    auto unrelated = IOSurfaceCreateMachPort(surface);
    mach_port_urefs_t initial = 0;
    if (!unrelated || mach_port_get_refs(mach_task_self(), unrelated, MACH_PORT_RIGHT_SEND, &initial)) return 2;
    CALayer* root = [CALayer layer];
    CALayer* child = [CALayer layer];
    child.bounds = CGRectMake(0, 0, 8, 4); child.contents = (id)surface;
    [root addSublayer:child];
    CALayer* unsupported = [CALayer layer];
    unsupported.mask = [CALayer layer];
    Identity identity{uint32_t(getpid()), 19, 20, 21, 22};
    int failures = 0, controls = 0, mutations = 0;
    for (bool mutation : {false, true}) {
      mach_port_t endpoint = 0;
      if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &endpoint) ||
          mach_port_insert_right(mach_task_self(), endpoint, endpoint, MACH_MSG_TYPE_MAKE_SEND)) return 2;
      mach_port_limits_t limit{1};
      if (mach_port_set_attributes(mach_task_self(), endpoint, MACH_PORT_LIMITS_INFO,
          reinterpret_cast<mach_port_info_t>(&limit), MACH_PORT_LIMITS_INFO_COUNT)) return 2;
      const char* labels[] = {"success", "queue-full", "invalid-destination", "partial-encode", "timeout-resource", "interrupted-resource"};
      const mach_msg_return_t expected[] = {KERN_SUCCESS, MACH_SEND_TIMED_OUT,
                                          MACH_SEND_INVALID_DEST, MACH_SEND_INVALID_DATA,
                                          MACH_SEND_TIMED_OUT | MACH_MSG_IPC_SPACE,
                                          MACH_SEND_INTERRUPTED | MACH_MSG_VM_KERNEL};
      for (unsigned scenario = 0; scenario < 6; ++scenario) {
        created.clear(); suppressCleanup = mutation;
        injectedSendResult = scenario >= 4 ? expected[scenario] : KERN_SUCCESS;
        if (scenario == 3) [root addSublayer:unsupported]; // valid surface encoded BEFORE refusal
        auto result = SendStaging(scenario == 2 ? MACH_PORT_DEAD : endpoint, identity, root, 2);
        if (scenario == 3) [unsupported removeFromSuperlayer];
        bool exactOracle = !created.empty(), distinct = false;
        for (auto p : created) { exactOracle = AtBaseline(p) && exactOracle; distinct |= p.name != unrelated; }
        mach_port_urefs_t remaining = 0;
        bool oldOracle = mach_port_get_refs(mach_task_self(), unrelated, MACH_PORT_RIGHT_SEND, &remaining) == KERN_SUCCESS && remaining == initial;
        mach_port_urefs_t endpointRefs = 0;
        bool endpointPreserved = mach_port_get_refs(mach_task_self(), endpoint,
            MACH_PORT_RIGHT_SEND, &endpointRefs) == KERN_SUCCESS && endpointRefs == 1;
        bool ok = result == expected[scenario] && created.size() == 1 && exactOracle != mutation && endpointPreserved;
        std::printf("%s %s mutation=%d exact_owned_cleanup=%d unrelated_port_unchanged=%d distinct_port=%d endpoint_refs=%u status=0x%x\n",
            ok ? "PASS" : "FAIL", labels[scenario], mutation, exactOracle, oldOracle, distinct, unsigned(endpointRefs), unsigned(result));
        if (!ok) ++failures;
        if (mutation && !exactOracle) ++mutations;
        if (!mutation && exactOracle) ++controls;
        // Reclaim this fixture's excess refs even on RED; never drop the borrowed endpoint.
        for (auto p : created) {
          mach_port_urefs_t refs = 0;
          while (mach_port_get_refs(mach_task_self(), p.name, MACH_PORT_RIGHT_SEND, &refs) == KERN_SUCCESS && refs > p.baseline)
            mach_port_deallocate(mach_task_self(), p.name);
        }
        while (mach_port_get_refs(mach_task_self(), endpoint, MACH_PORT_RIGHT_SEND, &endpointRefs) == KERN_SUCCESS && endpointRefs > 1)
          mach_port_deallocate(mach_task_self(), endpoint);
      }
      // The success case queued one real message, distinct from local send rights.
      union { Packet p; unsigned char bytes[sizeof(Packet) + MAX_TRAILER_SIZE]; } in{};
      if (mach_msg(&in.p.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT, 0, sizeof(in), endpoint, 0, 0) != KERN_SUCCESS) ++failures;
      else { Received received(&in.p.header, sizeof(in)); }
      mach_port_deallocate(mach_task_self(), endpoint);
      mach_port_mod_refs(mach_task_self(), endpoint, MACH_PORT_RIGHT_RECEIVE, -1);
    }
    mach_port_deallocate(mach_task_self(), unrelated); CFRelease(surface);
    std::printf("normal-owned-cleanup controls=%d; suppressed-cleanup mutations detected=%d; failures=%d\n", controls, mutations, failures);
    return failures || controls != 6 || mutations != 6 ? 1 : 0;
  }
}
