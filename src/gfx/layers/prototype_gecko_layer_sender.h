// Opt-in local compositor transport probe; no readback or screenshot transport.
#pragma once
#import <IOSurface/IOSurface.h>
#import <QuartzCore/QuartzCore.h>
#include <servers/bootstrap.h>
#include <cstdlib>
#include <cstdio>
#include <unistd.h>
#include <os/lock.h>
#include <dispatch/dispatch.h>
#include "prototype_gecko_layer_protocol.h"
extern "C" mach_port_t ZenProbeInputPort();

static os_unfair_lock sZenOutboxLock = OS_UNFAIR_LOCK_INIT;
static ZenProbeFrame* sZenOutboxPending;
static mach_port_t sZenOutboxHost;
static dispatch_source_t sZenOutboxTimer;

static void ZenProbeFreeFrame(ZenProbeFrame* frame) {
  if (!frame) return;
  for (auto& surface : frame->surfaces) {
    if (surface.name) mach_port_deallocate(mach_task_self(), surface.name);
  }
  delete frame;
}

static void ZenProbeDrainOutbox() {
  ZenProbeFrame* frame;
  os_unfair_lock_lock(&sZenOutboxLock);
  frame = sZenOutboxPending; sZenOutboxPending = nullptr;
  os_unfair_lock_unlock(&sZenOutboxLock);
  if (!frame) return;
  kern_return_t result = MACH_SEND_TIMED_OUT;
  if (sZenOutboxHost || bootstrap_look_up(bootstrap_port, getenv("ZEN_GECKO_LAYER_SERVICE"), &sZenOutboxHost) == KERN_SUCCESS) {
    // A timed-out COPY_SEND is pseudo-received with extra MOVE_SEND rights.
    // Keep the owned snapshot pristine; destroy only those returned wire-copy rights.
    ZenProbeFrame wire = *frame;
    wire.header.msgh_remote_port = sZenOutboxHost;
    result = mach_msg(&wire.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
      sizeof(wire), 0, MACH_PORT_NULL, 0, MACH_PORT_NULL);
    if (result == MACH_SEND_TIMED_OUT) mach_msg_destroy(&wire.header);
  }
  if (result == MACH_SEND_TIMED_OUT) {
    os_unfair_lock_lock(&sZenOutboxLock);
    if (!sZenOutboxPending) { sZenOutboxPending = frame; frame = nullptr; }
    os_unfair_lock_unlock(&sZenOutboxLock);
  } else {
    static bool reported = false;
    if (!reported || result != KERN_SUCCESS) {
      fprintf(stderr, "ZEN_GECKO_LAYER_SEND pid=%u nodes=%u truncated=%u result=%d\n",
        frame->pid, frame->count, frame->truncated, result);
      reported = true;
    }
  }
  ZenProbeFreeFrame(frame);
  if (result != KERN_SUCCESS && result != MACH_SEND_TIMED_OUT) _exit(70);
}

static void ZenProbeQueueFrame(ZenProbeFrame* frame) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    // ponytail: process-lifetime, one backing root per disposable worker; one pending plus one sending snapshot.
    sZenOutboxTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
      dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0));
    dispatch_source_set_timer(sZenOutboxTimer, dispatch_time(DISPATCH_TIME_NOW, 0), 16 * NSEC_PER_MSEC, NSEC_PER_MSEC);
    dispatch_source_set_event_handler(sZenOutboxTimer, ^{ ZenProbeDrainOutbox(); });
    dispatch_resume(sZenOutboxTimer);
  });
  os_unfair_lock_lock(&sZenOutboxLock);
  ZenProbeFrame* previous = sZenOutboxPending; sZenOutboxPending = frame;
  os_unfair_lock_unlock(&sZenOutboxLock);
  ZenProbeFreeFrame(previous);
}


static void ZenProbeTransform(float* aOutput, CATransform3D aTransform) {
  const CGFloat values[] = {
      aTransform.m11, aTransform.m12, aTransform.m13, aTransform.m14,
      aTransform.m21, aTransform.m22, aTransform.m23, aTransform.m24,
      aTransform.m31, aTransform.m32, aTransform.m33, aTransform.m34,
      aTransform.m41, aTransform.m42, aTransform.m43, aTransform.m44};
  for (int i = 0; i < 16; ++i) aOutput[i] = values[i];
}

static void ZenProbeAppend(CALayer* aLayer, int32_t aParent, ZenProbeFrame& aFrame) {
  if (aFrame.count == ZEN_LAYER_PROBE_NODES) {
    aFrame.truncated = 1;
    return;
  }
  uint32_t index = aFrame.count++;
  ZenProbeNode& node = aFrame.nodes[index];
  node.parent = aParent;
  node.flags = (aLayer.hidden ? 1u : 0u) | (aLayer.masksToBounds ? 2u : 0u) |
               (aLayer.geometryFlipped ? 4u : 0u) |
               ([aLayer.contentsGravity isEqualToString:kCAGravityTopLeft] ? 8u : 0u) |
               ([aLayer.minificationFilter isEqualToString:kCAFilterNearest] ? 16u : 0u);
  node.position[0] = aLayer.position.x;
  node.position[1] = aLayer.position.y;
  node.bounds[0] = aLayer.bounds.origin.x;
  node.bounds[1] = aLayer.bounds.origin.y;
  node.bounds[2] = aLayer.bounds.size.width;
  node.bounds[3] = aLayer.bounds.size.height;
  node.anchor[0] = aLayer.anchorPoint.x;
  node.anchor[1] = aLayer.anchorPoint.y;
  node.contentsRect[0] = aLayer.contentsRect.origin.x;
  node.contentsRect[1] = aLayer.contentsRect.origin.y;
  node.contentsRect[2] = aLayer.contentsRect.size.width;
  node.contentsRect[3] = aLayer.contentsRect.size.height;
  ZenProbeTransform(node.transform, aLayer.transform);
  ZenProbeTransform(node.sublayerTransform, aLayer.sublayerTransform);
  node.opacity = aLayer.opacity;
  node.contentsScale = aLayer.contentsScale;
  node.cornerRadius = aLayer.cornerRadius;
  if (CGColorRef color = aLayer.backgroundColor) {
    const CGFloat* components = CGColorGetComponents(color);
    size_t count = CGColorGetNumberOfComponents(color);
    if (count == 4) {
      for (int i = 0; i < 4; ++i) node.background[i] = components[i];
    } else if (count == 2) {
      node.background[0] = node.background[1] = node.background[2] = components[0];
      node.background[3] = components[1];
    }
  }
  CFTypeRef contents = (__bridge CFTypeRef)aLayer.contents;
  if (contents) {
    if (CFGetTypeID(contents) == IOSurfaceGetTypeID()) {
      aFrame.surfaces[index].name = IOSurfaceCreateMachPort((IOSurfaceRef)contents);
      if (!aFrame.surfaces[index].name) aFrame.truncated = 2;
    } else {
      aFrame.truncated = 3;
    }
  }
  for (CALayer* child in aLayer.sublayers) ZenProbeAppend(child, index, aFrame);
}

static void ZenProbeExport(CALayer* aRoot, float aBackingScale) {
  const char* service = getenv("ZEN_GECKO_LAYER_SERVICE");
  const char* token = getenv("ZEN_GECKO_LAYER_TOKEN");
  if (!service || !token) return;
  // Popups (extension panels) are real windows of their own, not content.
  if ([[aRoot valueForKey:@"zenNoExport"] boolValue]) return;
  ZenProbeFrame* owned = new ZenProbeFrame{};
  ZenProbeFrame& frame = *owned;
  mach_port_t input = ZenProbeInputPort();
  frame.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, input ? MACH_MSG_TYPE_COPY_SEND : 0) | MACH_MSGH_BITS_COMPLEX;
  frame.header.msgh_local_port = input;
  frame.header.msgh_size = sizeof(frame);
  frame.header.msgh_id = ZEN_LAYER_PROBE_MAGIC;
  frame.body.msgh_descriptor_count = ZEN_LAYER_PROBE_NODES;
  for (auto& surface : frame.surfaces) {
    surface.disposition = MACH_MSG_TYPE_COPY_SEND;
    surface.type = MACH_MSG_PORT_DESCRIPTOR;
  }
  frame.magic = ZEN_LAYER_PROBE_MAGIC;
  frame.pid = getpid();
  frame.token = strtoull(token, nullptr, 10);
  const char* slot = getenv("ZEN_GECKO_LAYER_SLOT");
  frame.slot = slot ? strtoul(slot, nullptr, 10) : 0;
  frame.root = reinterpret_cast<uintptr_t>(aRoot);
  frame.backingScale = aBackingScale;
  ZenProbeAppend(aRoot, -1, frame);
  if (frame.truncated) {
    NSMutableArray<CALayer*>* pending = [NSMutableArray arrayWithObject:aRoot];
    NSUInteger needed = 0;
    while (pending.count && needed < 1024) {
      CALayer* layer = pending.lastObject; [pending removeLastObject]; ++needed;
      if (layer.sublayers.count) [pending addObjectsFromArray:layer.sublayers];
    }
    fprintf(stderr, "ZEN_GECKO_LAYER_TREE_LIMIT needed=%lu remaining=%lu capacity=%u\n",
      (unsigned long)needed, (unsigned long)pending.count, ZEN_LAYER_PROBE_NODES);
  }
  if (frame.truncated) { ZenProbeFreeFrame(owned); _exit(70); }
  ZenProbeQueueFrame(owned);
}
