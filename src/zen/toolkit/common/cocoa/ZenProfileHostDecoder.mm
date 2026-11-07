/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "ZenProfileHostDecoder.h"
#import <IOSurface/IOSurface.h>

// Match NativeLayerCA's guarded IOSurface opacity hint.
@interface CALayer (ZenProfileHostContentsOpaque)
- (void)setContentsOpaque:(BOOL)opaque;
@end

namespace zen::profilehost {
static CATransform3D Transform(const float* f) {
  return CATransform3D{f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7],
                       f[8], f[9], f[10], f[11], f[12], f[13], f[14], f[15]};
}

bool Consume(mach_msg_header_t* header, size_t capacity, const Gate& owner,
             double expectedScale, CALayer** staged) {
  Received rights(header, capacity);
  if (!staged || !MessageLayout(header, capacity) ||
      header->msgh_size != sizeof(Packet) || header->msgh_id != kFrameMessage ||
      !(header->msgh_bits & MACH_MSGH_BITS_COMPLEX)) return false;
  const auto* p = reinterpret_cast<const Packet*>(header);
  if (p->body.msgh_descriptor_count != kNodes ||
      !owner.Matches(p->identity, AuditPID(header, capacity)) ||
      !std::isfinite(expectedScale) || expectedScale <= 0 || expectedScale > 16 ||
      !std::isfinite(p->backingScale) || p->backingScale != expectedScale ||
      ValidateTree(p->frame) != Error::Ok) return false;
  for (uint32_t i = 0; i < kNodes; ++i) {
    const auto& d = p->surfaces[i];
    if (d.type != MACH_MSG_PORT_DESCRIPTOR ||
        d.disposition != MACH_MSG_TYPE_PORT_SEND || d.name == MACH_PORT_DEAD ||
        (i >= p->frame.count && d.name != MACH_PORT_NULL)) return false;
  }
  // Retained by this local array until the complete tree has decoded. No layer
  // in this transaction belongs to the source view or a published remote root.
  NSMutableArray<CALayer*>* layers = [[NSMutableArray alloc] init];
  bool valid = true;
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  for (uint32_t i = 0; i < p->frame.count; ++i) {
    const Node& n = p->frame.nodes[i];
    CALayer* layer = [CALayer layer];
    layer.actions = @{@"contents": [NSNull null], @"sublayers": [NSNull null]};
    layer.position = CGPointMake(n.position[0], n.position[1]);
    layer.bounds = CGRectMake(n.bounds[0], n.bounds[1], n.bounds[2], n.bounds[3]);
    layer.anchorPoint = CGPointMake(n.anchor[0], n.anchor[1]);
    layer.contentsRect = CGRectMake(n.contentsRect[0], n.contentsRect[1],
                                    n.contentsRect[2], n.contentsRect[3]);
    layer.transform = Transform(n.transform);
    layer.sublayerTransform = Transform(n.sublayerTransform);
    layer.opacity = n.opacity;
    layer.contentsScale = n.contentsScale;
    layer.cornerRadius = n.cornerRadius;
    layer.hidden = (n.flags & 1) != 0;
    layer.masksToBounds = (n.flags & 2) != 0;
    layer.geometryFlipped = (n.flags & 4) != 0;
    layer.contentsGravity = (n.flags & 8) ? kCAGravityTopLeft : kCAGravityResize;
    layer.minificationFilter = (n.flags & 16) ? kCAFilterNearest : kCAFilterLinear;
    layer.opaque = (n.flags & 32) != 0;
    layer.magnificationFilter = (n.flags & 64) ? kCAFilterNearest : kCAFilterLinear;
    layer.edgeAntialiasingMask = n.edgeAntialiasingMask;
    layer.maskedCorners = n.maskedCorners;
    if (!i && (!n.bounds[2] || !n.bounds[3])) layer.masksToBounds = NO;
    CGFloat rgba[] = {n.background[0], n.background[1], n.background[2], n.background[3]};
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGColorRef color = CGColorCreate(space, rgba);
    layer.backgroundColor = color;
    CGColorRelease(color);
    CGColorSpaceRelease(space);
    if (p->surfaces[i].name != MACH_PORT_NULL) {
      IOSurfaceRef surface = IOSurfaceLookupFromMachPort(p->surfaces[i].name);
      if (!surface || !IOSurfaceGetWidth(surface) || !IOSurfaceGetHeight(surface) ||
          IOSurfaceGetWidth(surface) > 32768 || IOSurfaceGetHeight(surface) > 32768) {
        if (surface) CFRelease(surface);
        valid = false;
        break;
      }
      layer.contents = (id)surface;
      if ([layer respondsToSelector:@selector(setContentsOpaque:)]) {
        [layer setContentsOpaque:layer.opaque];
      }
      CFRelease(surface); // CALayer holds its own reference, not a Mach right.
    }
    [layers addObject:layer];
    if (i) [layers[uint32_t(n.parent)] addSublayer:layer];
  }
  if (valid) {
    CALayer* root = [layers[0] retain];
    [*staged release];
    *staged = root;
  }
  [CATransaction commit];
  [layers release];
  return valid;
}
} // namespace zen::profilehost
