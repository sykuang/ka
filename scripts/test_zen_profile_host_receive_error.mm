// Included by test_zen_profile_host_receive_error.py's generated translation unit.
// No-UI receive-method fixture, NOT native host/window lifecycle acceptance.
#import <Foundation/Foundation.h>
#import <QuartzCore/QuartzCore.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <initializer_list>

static int destroyed, decoded, receiveCalls;
static void CountDestroy(mach_msg_header_t* h) {
  ++destroyed;
  mach_msg_destroy(h);
}
#define mach_msg_destroy CountDestroy
#include "ZenProfileHostProtocol.h"
#undef mach_msg_destroy
using namespace zen::profilehost;

static void Check(bool ok, const char* text) {
  if (!ok) throw std::runtime_error(text);
}
static mach_port_urefs_t Refs(mach_port_t p) {
  mach_port_urefs_t n = 0;
  Check(mach_port_get_refs(mach_task_self(), p, MACH_PORT_RIGHT_SEND, &n) == KERN_SUCCESS,
        "get send refs");
  return n;
}
static bool Mapped(mach_vm_address_t address) {
  mach_vm_address_t start = address;
  mach_vm_size_t size = 0;
  vm_region_basic_info_data_64_t info{};
  mach_msg_type_number_t count = VM_REGION_BASIC_INFO_COUNT_64;
  mach_port_t object = MACH_PORT_NULL;
  kern_return_t result = mach_vm_region(mach_task_self(), &start, &size,
      VM_REGION_BASIC_INFO_64, reinterpret_cast<vm_region_info_t>(&info), &count, &object);
  if (object) mach_port_deallocate(mach_task_self(), object);
  return result == KERN_SUCCESS && start <= address && address < start + size;
}
struct Resources {
  mach_port_t endpoint = 0, body = 0, reply = 0;
  mach_vm_address_t sent = 0, received = 0;
  struct Message {
    mach_msg_header_t header;
    mach_msg_body_t body;
    mach_msg_port_descriptor_t right;
    mach_msg_ool_descriptor_t memory;
  } snapshot{};
  bool pending = false;
  ~Resources() {
    // Graceful RED fallback: snapshot owns the same rights only if production
    // did not destroy them. Do not retain a pointer into the expired stack buffer.
    if (pending && destroyed == 0) mach_msg_destroy(&snapshot.header);
    if (sent) mach_vm_deallocate(mach_task_self(), sent, vm_page_size);
    for (auto p : {endpoint, body, reply}) if (p) {
      mach_port_deallocate(mach_task_self(), p);
      mach_port_mod_refs(mach_task_self(), p, MACH_PORT_RIGHT_RECEIVE, -1);
    }
  }
  void Prepare() {
    for (auto p : {&endpoint, &body, &reply}) {
      Check(mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, p) == KERN_SUCCESS,
            "allocate receive right");
      Check(mach_port_insert_right(mach_task_self(), *p, *p, MACH_MSG_TYPE_MAKE_SEND) == KERN_SUCCESS,
            "insert send right");
    }
  }
  void Send() {
    Check(mach_vm_allocate(mach_task_self(), &sent, vm_page_size, VM_FLAGS_ANYWHERE) == KERN_SUCCESS,
          "allocate OOL source");
    memset(reinterpret_cast<void*>(sent), 0x5a, vm_page_size);
    Message out{};
    out.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_COPY_SEND) |
                           MACH_MSGH_BITS_COMPLEX;
    out.header.msgh_size = sizeof(out);
    out.header.msgh_remote_port = endpoint;
    out.header.msgh_local_port = reply;
    out.body.msgh_descriptor_count = 2;
    out.right.name = body;
    out.right.disposition = MACH_MSG_TYPE_COPY_SEND;
    out.right.type = MACH_MSG_PORT_DESCRIPTOR;
    out.memory.address = reinterpret_cast<void*>(sent);
    out.memory.size = vm_page_size;
    out.memory.copy = MACH_MSG_VIRTUAL_COPY;
    out.memory.type = MACH_MSG_OOL_DESCRIPTOR;
    Check(mach_msg(&out.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(out), 0,
                  MACH_PORT_NULL, 0, MACH_PORT_NULL) == KERN_SUCCESS, "real kernel send");
  }
};
static Resources* active;
static mach_msg_return_t injected;
static bool transfer;
static mach_msg_return_t ReceiveAdapter(mach_msg_header_t* h, mach_msg_option_t options,
    mach_msg_size_t sendSize, mach_msg_size_t capacity, mach_port_name_t port,
    mach_msg_timeout_t timeout, mach_port_name_t notify) {
  ++receiveCalls;
  if (!transfer && injected) return injected; // empty zeroed buffer, no owned resources
  auto result = mach_msg(h, options, sendSize, capacity, port, timeout, notify);
  if (result != KERN_SUCCESS) return result; // natural timeout/invalid-name controls
  memcpy(&active->snapshot, h, sizeof(active->snapshot));
  active->pending = true;
  active->received = reinterpret_cast<mach_vm_address_t>(active->snapshot.memory.address);
  Check(MessageLayout(h, capacity), "real received layout is bounded");
  Check(Refs(active->body) == 2 && Refs(active->reply) == 2, "real body and reply transfer");
  Check(Mapped(active->received) && active->received != active->sent, "distinct real OOL mapping");
  Check(*reinterpret_cast<unsigned char*>(active->received) == 0x5a, "OOL payload");
  return injected; // result-only injection after SUCCESS; no actual resource exhaustion
}
static bool Consume(mach_msg_header_t* h, size_t capacity, const Gate&, double, CALayer**) {
  ++decoded;
  Received owned(h, capacity);
  return false;
}
@interface ScaleFixture : NSObject
@property(readonly) double backingScaleFactor;
@end
@implementation ScaleFixture
- (double)backingScaleFactor { return 2; }
@end
@interface ReceiveFixture : NSObject {
 @public
  mach_port_t port;
  Gate gate;
  CALayer* staged;
  ScaleFixture* window;
  bool invalid;
  bool eligible;
  int invalidations;
  int destroyedAtInvalidation;
}
- (BOOL)valid;
- (void)invalidate;
- (void)receive;
@end
@implementation ReceiveFixture
- (BOOL)valid { return eligible && !invalid; }
// Deliberate lifecycle double: retains staging for refusal inspection; production
// invalidate releases it. Does NOT model dispatch cancellation or endpoint teardown.
- (void)invalidate {
  ++invalidations;
  destroyedAtInvalidation = destroyed;
  invalid = true;
}
#define mach_msg ReceiveAdapter
// ACTUAL_RECEIVE_METHOD
#undef mach_msg
@end

int main() {
  @autoreleasepool {
    int failures = 0;
    const mach_msg_return_t cases[] = {MACH_RCV_TIMED_OUT, MACH_RCV_INVALID_NAME,
      MACH_RCV_HEADER_ERROR | MACH_MSG_IPC_SPACE, MACH_RCV_INVALID_DATA,
      MACH_RCV_BODY_ERROR, MACH_RCV_BODY_ERROR | MACH_MSG_IPC_SPACE,
      MACH_RCV_BODY_ERROR | MACH_MSG_VM_SPACE, MACH_RCV_BODY_ERROR | MACH_MSG_IPC_KERNEL,
      MACH_RCV_BODY_ERROR | MACH_MSG_VM_KERNEL,
      MACH_RCV_BODY_ERROR | MACH_MSG_MASK, KERN_SUCCESS};
    for (auto code : cases) {
      destroyed = decoded = receiveCalls = 0;
      Resources resources;
      active = &resources;
      ReceiveFixture* host = [ReceiveFixture new];
      ScaleFixture* scale = [ScaleFixture new];
      CALayer* marker = [CALayer new];
      host->staged = marker; host->window = scale; host->eligible = true;
      try {
        resources.Prepare();
        bool partial = (code & ~MACH_MSG_MASK) == MACH_RCV_BODY_ERROR;
        transfer = partial || code == KERN_SUCCESS;
        // Timeout and invalid-name controls use actual kernel receive results.
        injected = (code == MACH_RCV_TIMED_OUT || code == MACH_RCV_INVALID_NAME) ? 0 : code;
        host->port = code == MACH_RCV_INVALID_NAME ? MACH_PORT_NULL : resources.endpoint;
        if (transfer) resources.Send();
        [host receive];
        Check(host->staged == marker, "staging pointer unchanged");
        Check(decoded == (code == KERN_SUCCESS ? 1 : 0), "partial/error never reaches decoder");
        Check(host->invalidations == ((code == MACH_RCV_TIMED_OUT || code == KERN_SUCCESS) ? 0 : 1),
              "invalidation routing");
        if (transfer) {
          Check(destroyed == 1, "returned resources must be destroyed exactly once");
          Check(Refs(resources.body) == 1 && Refs(resources.reply) == 1,
                "surviving body/reply rights released");
          Check(!Mapped(resources.received) && Mapped(resources.sent), "only received OOL unmapped");
          if (partial) Check(host->destroyedAtInvalidation == 1, "cleanup precedes invalidation");
        } else Check(destroyed == 0, "no destruction for timeout/ordinary errors");
        printf("PASS receive result 0x%x: destroy=%d decode=%d calls=%d\n", code, destroyed, decoded, receiveCalls);
      } catch (const std::exception& e) {
        ++failures;
        printf("FAIL receive result 0x%x: %s (destroy=%d decode=%d)\n", code, e.what(), destroyed, decoded);
      }
      [marker release]; [scale release]; [host release];
    }
    // Invalid host must not even attempt receive or destroy a buffer.
    ReceiveFixture* host = [ReceiveFixture new];
    destroyed = decoded = receiveCalls = 0;
    [host receive];
    bool invalidControl = receiveCalls == 0 && destroyed == 0 && decoded == 0 && host->invalidations == 1;
    [host release];
    if (!invalidControl) ++failures;
    printf("%s invalid-host precheck; failures=%d\n", invalidControl ? "PASS" : "FAIL", failures);
    return failures ? 1 : 0;
  }
}
