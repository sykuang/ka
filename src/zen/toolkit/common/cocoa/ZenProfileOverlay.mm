/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Shows another Profile's Gecko compositor output inside this Zen window.
// Receiver side of the proven prototype layer transport
// (scripts/prototype_gecko_layer_host.m); the worker side is the env-gated
// NativeLayerCA hook. ponytail: one overlay, one worker slot (0); add slots
// when more than one foreign Profile must stay live at once.

#import <Cocoa/Cocoa.h>
#import <IOSurface/IOSurface.h>
#import <QuartzCore/QuartzCore.h>
#include <servers/bootstrap.h>

#include "ZenProfileOverlay.h"
#include "prototype_gecko_layer_protocol.h"
#include "WidgetUtils.h"
#include "nsThreadUtils.h"
#include <cmath>
#include "nsGlobalWindowOuter.h"
#include "nsIWidget.h"
#include "nsString.h"

@interface ZenProfileOverlayView : NSView
@end
@implementation ZenProfileOverlayView
- (BOOL)isFlipped { return YES; }
@end

namespace {
mach_port_t sReceive = MACH_PORT_NULL;
uint64_t sToken = 0;
uint32_t sWorkerPID = 0;
uint64_t sFrames = 0;
CALayer* sRoot = nil;
ZenProfileOverlayView* sView = nil;
NSTimer* sTimer = nil;

NSWindow* Resolve(mozIDOMWindowProxy* dom) {
  if (!NS_IsMainThread() || !dom) return nil;
  auto* outer = nsGlobalWindowOuter::Cast(dom);
  if (!outer || outer->GetClosedOuter() || !outer->IsChromeWindow()) return nil;
  nsCOMPtr<nsIWidget> widget = mozilla::widget::WidgetUtils::DOMWindowToWidget(outer);
  return widget ? (NSWindow*)widget->GetNativeData(NS_NATIVE_WINDOW) : nil;
}

CATransform3D Transform(const float* f) {
  return (CATransform3D){f[0], f[1], f[2],  f[3],  f[4],  f[5],  f[6],  f[7],
                         f[8], f[9], f[10], f[11], f[12], f[13], f[14], f[15]};
}

// Same structural checks as the prototype host: token, pid (kernel audit),
// topology, finite geometry and IOSurface extent.
bool Valid(const ZenProbeFrame* f, uint32_t sender) {
  if (f->header.msgh_size != sizeof(*f) || !(f->header.msgh_bits & MACH_MSGH_BITS_COMPLEX) ||
      f->body.msgh_descriptor_count != ZEN_LAYER_PROBE_NODES || f->magic != ZEN_LAYER_PROBE_MAGIC ||
      f->token != sToken || f->slot != 0 || !sWorkerPID || f->pid != sWorkerPID || sender != f->pid ||
      !f->root || !f->count || f->count > ZEN_LAYER_PROBE_NODES || f->truncated ||
      !std::isfinite(f->backingScale) || f->backingScale <= 0 || f->backingScale > 16) {
    return false;
  }
  for (uint32_t i = 0; i < ZEN_LAYER_PROBE_NODES; i++) {
    const mach_msg_port_descriptor_t* d = &f->surfaces[i];
    if (d->type != MACH_MSG_PORT_DESCRIPTOR || d->disposition != MACH_MSG_TYPE_PORT_SEND ||
        d->name == MACH_PORT_DEAD || (i >= f->count && d->name != MACH_PORT_NULL)) return false;
    if (i >= f->count) continue;
    const ZenProbeNode* n = &f->nodes[i];
    if ((i == 0 && n->parent != -1) || (i && (n->parent < 0 || (uint32_t)n->parent >= i)) ||
        (n->flags & ~31u)) return false;
    for (size_t o = offsetof(ZenProbeNode, position); o < sizeof(*n); o += sizeof(float)) {
      float v;
      memcpy(&v, (const char*)n + o, sizeof(v));
      if (!std::isfinite(v) || fabsf(v) > 1e7f) return false;
    }
    if (n->bounds[2] < 0 || n->bounds[3] < 0 || n->bounds[2] > 32768 || n->bounds[3] > 32768 ||
        n->contentsRect[2] < 0 || n->contentsRect[3] < 0 || n->opacity < 0 || n->opacity > 1 ||
        n->contentsScale <= 0 || n->contentsScale > 16 || n->cornerRadius < 0) return false;
    for (int c = 0; c < 4; c++) if (n->background[c] < 0 || n->background[c] > 1) return false;
  }
  return true;
}

void Accept(const ZenProbeFrame* f) {
  NSMutableArray<CALayer*>* layers = [NSMutableArray arrayWithCapacity:f->count];
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  for (uint32_t i = 0; i < f->count; i++) {
    const ZenProbeNode* n = &f->nodes[i];
    CALayer* layer = [CALayer layer];
    layer.position = CGPointMake(n->position[0], n->position[1]);
    layer.bounds = CGRectMake(n->bounds[0], n->bounds[1], n->bounds[2], n->bounds[3]);
    layer.anchorPoint = CGPointMake(n->anchor[0], n->anchor[1]);
    layer.contentsRect = CGRectMake(n->contentsRect[0], n->contentsRect[1], n->contentsRect[2],
                                    n->contentsRect[3]);
    layer.transform = Transform(n->transform);
    layer.sublayerTransform = Transform(n->sublayerTransform);
    layer.opacity = n->opacity;
    layer.contentsScale = n->contentsScale;
    layer.cornerRadius = n->cornerRadius;
    layer.hidden = (n->flags & 1) != 0;
    layer.masksToBounds = (n->flags & 2) != 0 && (i || (n->bounds[2] && n->bounds[3]));
    layer.geometryFlipped = (n->flags & 4) != 0;
    layer.contentsGravity = (n->flags & 8) ? kCAGravityTopLeft : kCAGravityResize;
    layer.minificationFilter = (n->flags & 16) ? kCAFilterNearest : kCAFilterLinear;
    CGColorRef color = CGColorCreateSRGB(n->background[0], n->background[1], n->background[2],
                                         n->background[3]);
    layer.backgroundColor = color;
    CGColorRelease(color);
    if (f->surfaces[i].name != MACH_PORT_NULL) {
      IOSurfaceRef surface = IOSurfaceLookupFromMachPort(f->surfaces[i].name);
      if (!surface || !IOSurfaceGetWidth(surface) || !IOSurfaceGetHeight(surface) ||
          IOSurfaceGetWidth(surface) > 32768 || IOSurfaceGetHeight(surface) > 32768) {
        if (surface) CFRelease(surface);
        [CATransaction commit];
        return;
      }
      layer.contents = (__bridge id)surface;
      CFRelease(surface);  // CALayer retains it; the caller destroys message rights.
    }
    [layers addObject:layer];
    if (i) [layers[(NSUInteger)n->parent] addSublayer:layer];
  }
  sRoot = layers[0];
  sFrames++;
  if (sView) sView.layer.sublayers = @[ sRoot ];
  [CATransaction commit];
}

void Receive() {
  for (int batch = 0; batch < 16; batch++) {
    union {
      ZenProbeFrame frame;
      unsigned char bytes[sizeof(ZenProbeFrame) + MAX_TRAILER_SIZE];
    } buffer = {};
    mach_msg_return_t r = mach_msg(
        &buffer.frame.header,
        MACH_RCV_MSG | MACH_RCV_TIMEOUT | MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
            MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
        0, sizeof(buffer), sReceive, 0, MACH_PORT_NULL);
    if (r == MACH_RCV_TIMED_OUT) return;
    if (r != MACH_MSG_SUCCESS) continue;  // oversized messages are destroyed by the kernel
    if (!ZenProbeMessageLayout(&buffer.frame.header, sizeof(buffer))) continue;
    uint32_t sender = ZenProbeSenderPID(&buffer.frame.header, sizeof(buffer));
    if (Valid(&buffer.frame, sender)) Accept(&buffer.frame);
    mach_msg_destroy(&buffer.frame.header);
  }
}
}  // namespace

namespace zen::profileoverlay {

nsresult Start(mozIDOMWindowProxy* aWindow, nsACString& aDescriptor) {
  if (!Resolve(aWindow)) return NS_ERROR_INVALID_ARG;
  if (!sReceive) {
    kern_return_t kr = mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &sReceive);
    mach_port_limits_t limits = {.mpl_qlimit = 64};
    if (kr == KERN_SUCCESS)
      kr = mach_port_set_attributes(mach_task_self(), sReceive, MACH_PORT_LIMITS_INFO,
                                    (mach_port_info_t)&limits, MACH_PORT_LIMITS_INFO_COUNT);
    if (kr == KERN_SUCCESS)
      kr = mach_port_insert_right(mach_task_self(), sReceive, sReceive, MACH_MSG_TYPE_MAKE_SEND);
    nsPrintfCString name("org.zen.profile-overlay.%d", getpid());
    if (kr == KERN_SUCCESS)
      kr = bootstrap_register(bootstrap_port, const_cast<char*>(name.get()), sReceive);
    if (kr != KERN_SUCCESS) {
      if (sReceive) mach_port_destroy(mach_task_self(), sReceive);
      sReceive = MACH_PORT_NULL;
      return NS_ERROR_FAILURE;
    }
    arc4random_buf(&sToken, sizeof(sToken));
    sToken |= 1;
    sTimer = [NSTimer scheduledTimerWithTimeInterval:0.016
                                             repeats:YES
                                               block:^(NSTimer*) { Receive(); }];
  }
  aDescriptor = nsPrintfCString("org.zen.profile-overlay.%d %llu", getpid(),
                                (unsigned long long)sToken);
  return NS_OK;
}

nsresult Admit(uint32_t aWorkerPID) {
  if (!sReceive || !aWorkerPID) return NS_ERROR_NOT_AVAILABLE;
  sWorkerPID = aWorkerPID;
  sRoot = nil;
  sFrames = 0;
  return NS_OK;
}

nsresult Show(mozIDOMWindowProxy* aWindow, double aX, double aY, double aW, double aH) {
  NSWindow* window = Resolve(aWindow);
  if (!window || !sReceive || !(aW > 0) || !(aH > 0)) return NS_ERROR_INVALID_ARG;
  NSView* content = window.contentView;
  // Chrome CSS px are top-left based; convert to the content view's coordinates.
  NSRect frame = NSMakeRect(aX, content.isFlipped ? aY : content.bounds.size.height - aY - aH, aW,
                            aH);
  if (!sView) {
    sView = [[ZenProfileOverlayView alloc] initWithFrame:frame];
    sView.wantsLayer = YES;
    sView.layer.masksToBounds = YES;
    sView.layer.backgroundColor = NSColor.windowBackgroundColor.CGColor;
  }
  if (sView.superview != content) [content addSubview:sView positioned:NSWindowAbove relativeTo:nil];
  sView.frame = frame;
  sView.hidden = NO;
  sView.layer.sublayers = sRoot ? @[ sRoot ] : @[];
  return NS_OK;
}

nsresult Hide() {
  if (sView) sView.hidden = YES;
  return NS_OK;
}

uint64_t FrameCount() { return sFrames; }

}  // namespace zen::profileoverlay
