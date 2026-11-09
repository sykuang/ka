// Local-only opt-in Gecko CALayer/IOSurface transport probe, not product IPC.
#pragma once
#include <mach/mach.h>
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#define ZEN_LAYER_PROBE_MAGIC 0x5a4c5031u
// Sanity cap only: nodes and surfaces travel out of line, sized to the tree.
#define ZEN_LAYER_PROBE_NODES 65536

typedef struct {
  int32_t parent;
  uint32_t flags; // hidden=1, masksToBounds=2, geometryFlipped=4
  float position[2], bounds[4], anchor[2], contentsRect[4];
  float transform[16], sublayerTransform[16];
  float opacity, contentsScale, cornerRadius, background[4];
} ZenProbeNode;

typedef struct {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_ool_ports_descriptor_t surfaces; // count send rights, NULL for no contents
  mach_msg_ool_descriptor_t nodes;          // count ZenProbeNode
  uint32_t magic, pid, slot, count, truncated;
  uint64_t token, root;
  float backingScale;
} ZenProbeFrame;

#define ZEN_INPUT_PROBE_MAGIC 0x5a495031u
#define ZEN_INPUT_PROBE_CHARS 64
#define ZEN_INPUT_FOCUS 100u
#define ZEN_INPUT_BLUR 101u
#define ZEN_INPUT_MARK 102u
#define ZEN_INPUT_INSERT 103u
#define ZEN_INPUT_UNMARK 104u
#define ZEN_INPUT_QUERY 105u
#define ZEN_INPUT_RESIZE 106u // x,y = content width,height in points

typedef struct {
  mach_msg_header_t header;
  uint32_t magic, pid, slot, kind;
  uint64_t token, sequence, flags;
  double x, y, timestamp;
  uint32_t keyCode, length, ignoringLength, repeat, clickCount, buttons;
  uint64_t replacementStart, replacementLength, selectionStart, selectionLength;
  uint16_t characters[ZEN_INPUT_PROBE_CHARS], ignoring[ZEN_INPUT_PROBE_CHARS];
  double deltaX, deltaY;                 // scroll wheel, points when precise else lines
  uint32_t precise, phase, momentumPhase; // NSEventPhase values
} ZenProbeInput;

typedef struct {
  mach_msg_header_t header;
  uint32_t magic, pid, slot, kind, status;
  uint64_t sequence;
  uint64_t selectedStart, selectedLength, markedStart, markedLength, actualStart, actualLength;
  double caret[4]; // Worker ChildView-local rect; host maps it to its real screen.
} ZenProbeInputReply;

static inline bool ZenProbeMessageLayout(const mach_msg_header_t *header, size_t capacity) {
  size_t size = header->msgh_size;
  if (size < sizeof(*header) || size > capacity) return false;
  if (!(header->msgh_bits & MACH_MSGH_BITS_COMPLEX)) return true;
  size_t offset = sizeof(*header);
  if (size - offset < sizeof(mach_msg_body_t)) return false;
  const mach_msg_body_t *body = (const mach_msg_body_t *)((const char *)header + offset);
  offset += sizeof(*body);
  for (uint32_t i = 0; i < body->msgh_descriptor_count; i++) {
    if (size - offset < sizeof(mach_msg_type_descriptor_t)) return false;
    const mach_msg_type_descriptor_t *d = (const mach_msg_type_descriptor_t *)((const char *)header + offset);
    size_t length;
    switch (d->type) {
      case MACH_MSG_PORT_DESCRIPTOR: length = sizeof(mach_msg_port_descriptor_t); break;
      case MACH_MSG_OOL_DESCRIPTOR:
      case MACH_MSG_OOL_VOLATILE_DESCRIPTOR: length = sizeof(mach_msg_ool_descriptor_t); break;
      case MACH_MSG_OOL_PORTS_DESCRIPTOR: length = sizeof(mach_msg_ool_ports_descriptor_t); break;
      case MACH_MSG_GUARDED_PORT_DESCRIPTOR: length = sizeof(mach_msg_guarded_port_descriptor_t); break;
      default: return false;
    }
    if (length > size - offset) return false;
    offset += length;
  }
  return true;
}
static inline uint32_t ZenProbeSenderPID(const mach_msg_header_t *header, size_t capacity) {
  if (!ZenProbeMessageLayout(header, capacity)) return 0;
  size_t offset = (header->msgh_size + 3u) & ~(size_t)3u;
  if (offset > capacity || capacity - offset < sizeof(mach_msg_audit_trailer_t)) return 0;
  const mach_msg_audit_trailer_t *t = (const mach_msg_audit_trailer_t *)((const char *)header + offset);
  if (t->msgh_trailer_type != MACH_MSG_TRAILER_FORMAT_0 || t->msgh_trailer_size < sizeof(*t) ||
      t->msgh_trailer_size > capacity - offset) return 0;
  return t->msgh_audit.val[5];
}

