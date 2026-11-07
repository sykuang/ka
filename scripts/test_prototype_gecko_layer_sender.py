#!/usr/bin/env python3
"""Sender transport UNIT regression, NOT Gecko hosting or rendered-page evidence."""
import json
import os
import secrets
import select
import signal
import subprocess
import tempfile
import time
from pathlib import Path

import prototype_profile_hosting as probe
from prototype_gecko_hosting import Host


def main():
    work = Path(tempfile.mkdtemp(prefix='zen-gecko-sender-unit-', dir=probe.SCRATCH))
    host_work, sender_work = work / 'host', work / 'sender'
    host_work.mkdir()
    sender_work.mkdir()
    source = sender_work / 'sender.mm'
    source.write_text('#import <Cocoa/Cocoa.h>\n#include ' + json.dumps(str(probe.ROOT / 'scripts/prototype_gecko_layer_sender.h')) + r'''
extern "C" mach_port_t ZenProbeInputPort() { return MACH_PORT_NULL; }
static unsigned sendRightNames() {
  mach_port_name_array_t names; mach_port_type_array_t types;
  mach_msg_type_number_t count, typeCount;
  if (mach_port_names(mach_task_self(), &names, &count, &types, &typeCount) != KERN_SUCCESS) abort();
  unsigned result = 0;
  for (unsigned i = 0; i < typeCount; ++i) if (types[i] & MACH_PORT_TYPE_SEND) ++result;
  vm_deallocate(mach_task_self(), (vm_address_t)names, count * sizeof(*names));
  vm_deallocate(mach_task_self(), (vm_address_t)types, typeCount * sizeof(*types));
  return result;
}
static unsigned refs(mach_port_t port) {
  mach_port_urefs_t result = 0;
  if (port && mach_port_get_refs(mach_task_self(), port, MACH_PORT_RIGHT_SEND, &result) != KERN_SUCCESS) abort();
  return result;
}
int main(int argc, const char** argv) {
  @autoreleasepool {
    (void)argc;
    puts("READY"); fflush(stdout); getchar();
    CALayer* layer = [CALayer layer];
    layer.bounds = CGRectMake(0, 0, 100, 100);
    layer.backgroundColor = NSColor.redColor.CGColor;
    int count = atoi(argv[1]);
    mach_port_t observedHost = MACH_PORT_NULL;
    if (count > 2) {
      mach_port_t host;
      if (bootstrap_look_up(bootstrap_port, getenv("ZEN_GECKO_LAYER_SERVICE"), &host) != KERN_SUCCESS) abort();
      unsigned queued = 0;
      for (; queued < 80; ++queued) {
        ZenProbeFrame frame = {};
        frame.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
        frame.header.msgh_remote_port = host;
        frame.header.msgh_size = sizeof(frame);
        frame.header.msgh_id = frame.magic = ZEN_LAYER_PROBE_MAGIC;
        frame.body.msgh_descriptor_count = ZEN_LAYER_PROBE_NODES;
        for (auto& port : frame.surfaces) { port.disposition = MACH_MSG_TYPE_COPY_SEND; port.type = MACH_MSG_PORT_DESCRIPTOR; }
        frame.pid = getpid(); frame.token = strtoull(getenv("ZEN_GECKO_LAYER_TOKEN"), nullptr, 10);
        frame.root = reinterpret_cast<uintptr_t>(layer); frame.backingScale = 1;
        ZenProbeAppend(layer, -1, frame);
        kern_return_t result = mach_msg(&frame.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
          sizeof(frame), 0, MACH_PORT_NULL, 0, MACH_PORT_NULL);
        if (result == MACH_SEND_TIMED_OUT) { mach_msg_destroy(&frame.header); break; }
        if (result != KERN_SUCCESS) abort();
      }
      observedHost = host;
      if (queued != 64) abort();
    }
    IOSurfaceRef surface = IOSurfaceCreate((__bridge CFDictionaryRef)@{
      (id)kIOSurfaceWidth: @16, (id)kIOSurfaceHeight: @16, (id)kIOSurfaceBytesPerElement: @4});
    if (!surface) abort();
    layer.contents = (__bridge id)surface;
    CFRelease(surface);
    unsigned before = sendRightNames(), beforeRefs = refs(observedHost);
    for (int i = 0; i < count; ++i) {
      layer.backgroundColor = (i == count - 1 ? NSColor.greenColor : NSColor.redColor).CGColor;
      ZenProbeExport(layer, 1);
      if (count > 2 && i < 20) usleep(20000); // Force repeated timeout/supersession, not just one burst.
    }
    printf("PUBLISHED %u %u %u\n", before, sendRightNames(), refs(observedHost)-beforeRefs); fflush(stdout);
    getchar(); // Stay alive with no more commits: the final pending snapshot must deliver by itself.
  }
  return 0;
}
''')
    host_binary = probe.compile_native_host(host_work, probe.ROOT / 'scripts/prototype_gecko_layer_host.m')
    sender_binary = probe.compile_native_host(sender_work, source)
    results = {}
    print('Sender UNIT artifacts: ' + str(work), flush=True)
    for case, count in [('last_commit_preserved', 2), ('saturated_queue_delivers_tail_without_new_commit', 1000)]:
        case_work = work / case
        case_work.mkdir()
        token, service = secrets.randbits(63), 'local.zen-sender-unit.' + secrets.token_hex(8)
        host = Host(host_binary, service, token, case_work)
        child = None
        stopped = False
        try:
            with (case_work / 'sender.log').open('w') as error:
                child = subprocess.Popen([str(sender_binary), str(count)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=error, text=True, env={**os.environ, 'ZEN_GECKO_LAYER_SERVICE': service,
                    'ZEN_GECKO_LAYER_TOKEN': str(token), 'ZEN_GECKO_LAYER_SLOT': '0'})
                assert child.stdin is not None and child.stdout is not None
                assert child.stdout.readline().strip() == 'READY'
                host.send('allow', slot=0, pid=child.pid)
                host.wait('status', lambda value: value.get('action') == 'allow')
                if count > 2:
                    os.kill(host.process.pid, signal.SIGSTOP)
                    stopped = True
                started = time.monotonic()
                child.stdin.write('\n')
                child.stdin.flush()
                assert select.select([child.stdout], [], [], 2)[0], 'Publishing waited for stopped receiver'
                published = child.stdout.readline().strip().split()
                assert published and published[0] == 'PUBLISHED', ('publisher exited or blocked', child.poll())
                elapsed = time.monotonic() - started
                growth = int(published[2]) - int(published[1])
                urefs_growth = int(published[3])
                assert urefs_growth <= 1, ('timeout leaked host send-right urefs', urefs_growth)
                assert growth <= 16, ('unbounded sender Mach-right names', growth)
                if stopped:
                    os.kill(host.process.pid, signal.SIGCONT)
                    stopped = False
                deadline = time.monotonic() + 8
                while True:
                    host.send('status', tree=True)
                    status = host.wait('status', lambda value: 'action' not in value)
                    if status['trees'][0] and status['trees'][0][0]['background'] == [0, 1, 0, 1]:
                        assert status['slots'][0]['surface_count'] == 1, status
                        break
                    assert time.monotonic() < deadline, 'Final snapshot lost after publishing stopped'
                    time.sleep(.02)
                assert child.poll() is None, 'Publisher died under backpressure'
                child.stdin.write('\n')
                child.stdin.flush()
                assert child.wait(timeout=5) == 0
                results[case] = {'result': 'PASS', 'frames': status['slots'][0]['frame_counter'],
                    'publishing_seconds': elapsed, 'send_right_name_growth': growth, 'host_send_urefs_growth': urefs_growth, 'final_surface_received': True}
        finally:
            if stopped:
                os.kill(host.process.pid, signal.SIGCONT)
            if child is not None and child.poll() is None:
                child.kill()
                child.wait()
            host.close()
    (work / 'result.json').write_text(json.dumps(results, indent=2))
    print(json.dumps({'scope': 'sender UNIT only, NOT Gecko', 'artifacts': str(work), 'cases': results}, indent=2))


if __name__ == '__main__':
    main()
