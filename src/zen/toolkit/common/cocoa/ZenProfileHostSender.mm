/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "ZenProfileHostSender.h"
#import <IOSurface/IOSurface.h>

namespace zen::profilehost {
namespace {
struct Encoded {
  Packet packet{};
  mach_port_t owned[kNodes]{};
  ~Encoded() {
    // COPY_SEND keeps our local rights even on success. Never destroy the
    // outgoing header (its destination is borrowed from the source lifetime).
    for (auto port : owned) if (port) mach_port_deallocate(mach_task_self(), port);
  }
};
static void Rect(float* out, CGRect r) {
  out[0] = r.origin.x; out[1] = r.origin.y;
  out[2] = r.size.width; out[3] = r.size.height;
}
static void Transform(float* out, CATransform3D t) {
  const CGFloat values[] = {t.m11,t.m12,t.m13,t.m14,t.m21,t.m22,t.m23,t.m24,
                           t.m31,t.m32,t.m33,t.m34,t.m41,t.m42,t.m43,t.m44};
  for (unsigned i = 0; i < 16; ++i) out[i] = values[i];
}
static bool Encode(CALayer* layer, int32_t parent, Encoded& out) {
  Frame& frame = out.packet.frame;
  // ponytail: fixed 128-node wire ceiling; version the protocol before widening.
  // Refuse rather than flatten/approximate unsupported visual properties.
  if (!layer || [layer class] != [CALayer class] || frame.count == kNodes ||
      layer.mask || layer.filters.count || layer.backgroundFilters.count ||
      layer.compositingFilter || layer.animationKeys.count ||
      layer.shadowOpacity != 0 || layer.borderWidth != 0 ||
      layer.zPosition != 0 || layer.anchorPointZ != 0 || !layer.doubleSided ||
      !layer.allowsGroupOpacity || layer.minificationFilterBias != 0 ||
      layer.shouldRasterize || !layer.allowsEdgeAntialiasing ||
      (layer.edgeAntialiasingMask & ~15u) || (layer.maskedCorners & ~CACornerMask(15)) ||
      !CGRectEqualToRect(layer.contentsCenter, CGRectMake(0, 0, 1, 1)) ||
      ![layer.contentsFormat isEqual:kCAContentsFormatRGBA8Uint] ||
      (![layer.magnificationFilter isEqual:kCAFilterLinear] &&
       ![layer.magnificationFilter isEqual:kCAFilterNearest]) ||
      ![layer.cornerCurve isEqual:kCACornerCurveCircular] ||
      (![layer.contentsGravity isEqual:kCAGravityResize] &&
       ![layer.contentsGravity isEqual:kCAGravityTopLeft]) ||
      (![layer.minificationFilter isEqual:kCAFilterLinear] &&
       ![layer.minificationFilter isEqual:kCAFilterNearest])) return false;
  uint32_t index = frame.count++;
  Node& n = frame.nodes[index];
  n.parent = parent;
  n.flags = (layer.hidden ? 1 : 0) | (layer.masksToBounds ? 2 : 0) |
      (layer.geometryFlipped ? 4 : 0) |
      ([layer.contentsGravity isEqual:kCAGravityTopLeft] ? 8 : 0) |
      ([layer.minificationFilter isEqual:kCAFilterNearest] ? 16 : 0) |
      (layer.opaque ? 32 : 0) |
      ([layer.magnificationFilter isEqual:kCAFilterNearest] ? 64 : 0);
  n.edgeAntialiasingMask = layer.edgeAntialiasingMask;
  n.maskedCorners = layer.maskedCorners;
  // The receiver intentionally treats zero-bounds roots as unbounded containers.
  // A genuinely clipping empty root cannot be represented without semantic loss.
  if (!index && layer.masksToBounds &&
      (!layer.bounds.size.width || !layer.bounds.size.height)) return false;
  n.position[0] = layer.position.x; n.position[1] = layer.position.y;
  n.anchor[0] = layer.anchorPoint.x; n.anchor[1] = layer.anchorPoint.y;
  Rect(n.bounds, layer.bounds); Rect(n.contentsRect, layer.contentsRect);
  Transform(n.transform, layer.transform);
  Transform(n.sublayerTransform, layer.sublayerTransform);
  n.opacity = layer.opacity; n.contentsScale = layer.contentsScale;
  n.cornerRadius = layer.cornerRadius;
  if (CGColorRef color = layer.backgroundColor) {
    auto model = CGColorSpaceGetModel(CGColorGetColorSpace(color));
    const CGFloat* c = CGColorGetComponents(color);
    // No implicit color-space conversion or unsupported pattern color fallback.
    if (model == kCGColorSpaceModelRGB && CGColorGetNumberOfComponents(color) == 4) {
      for (unsigned i = 0; i < 4; ++i) n.background[i] = c[i];
    } else if (model == kCGColorSpaceModelMonochrome && CGColorGetNumberOfComponents(color) == 2) {
      n.background[0] = n.background[1] = n.background[2] = c[0]; n.background[3] = c[1];
    } else return false;
  }
  if (id contents = layer.contents) {
    if (CFGetTypeID((CFTypeRef)contents) != IOSurfaceGetTypeID()) return false;
    IOSurfaceRef surface = (IOSurfaceRef)contents;
    if (!IOSurfaceGetWidth(surface) || !IOSurfaceGetHeight(surface) ||
        IOSurfaceGetWidth(surface) > 32768 || IOSurfaceGetHeight(surface) > 32768)
      return false;
    out.owned[index] = IOSurfaceCreateMachPort(surface);
    if (!out.owned[index]) return false;
    out.packet.surfaces[index].name = out.owned[index];
  }
  for (CALayer* child in layer.sublayers) if (!Encode(child, index, out)) return false;
  return true;
}
} // namespace
mach_msg_return_t SendStaging(mach_port_t endpoint, const Identity& identity,
                              CALayer* modelRoot, float backingScale) {
  Encoded out;
  Packet& p = out.packet;
  p.identity = identity;
  p.backingScale = backingScale;
  p.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
  p.header.msgh_size = sizeof(Packet);
  p.header.msgh_remote_port = endpoint;
  p.header.msgh_id = kFrameMessage;
  p.body.msgh_descriptor_count = kNodes;
  for (auto& d : p.surfaces) {
    d.type = MACH_MSG_PORT_DESCRIPTOR;
    d.disposition = MACH_MSG_TYPE_COPY_SEND;
  }
  if (!identity.Valid() || !std::isfinite(backingScale) || backingScale <= 0 ||
      backingScale > 16 || !Encode(modelRoot, -1, out) ||
      ValidateTree(p.frame) != Error::Ok) return MACH_SEND_INVALID_DATA;
  auto result = mach_msg(&p.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
                         sizeof(Packet), 0, MACH_PORT_NULL, 0, MACH_PORT_NULL);
  // Pseudo-receive returns additional COPY_SEND references, including the
  // destination. Destroy only this returned message, not an untouched send.
  auto error = result & ~MACH_MSG_MASK;
  if (error == MACH_SEND_TIMED_OUT || error == MACH_SEND_INTERRUPTED)
    mach_msg_destroy(&p.header);
  return result;
}
} // namespace zen::profilehost
