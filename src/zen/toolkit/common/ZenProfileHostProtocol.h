/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef ZenProfileHostProtocol_h
#define ZenProfileHostProtocol_h

#include <mach/mach.h>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace zen::profilehost {
constexpr uint32_t kNodes = 128;
enum class Error : uint32_t { Ok, UnsupportedTree, Tree, Geometry };
struct Identity {
  uint32_t pid = 0;
  uint64_t token = 0, widget = 0, root = 0, generation = 0;
  bool operator==(const Identity& b) const {
    return pid == b.pid && token == b.token && widget == b.widget &&
           root == b.root && generation == b.generation;
  }
  bool Valid() const { return pid && token && widget && root && generation; }
};
inline bool WorkerBootstrap(uint32_t expectedParent, uint32_t actualParent,
                            uint64_t token) {
  return expectedParent > 1 && expectedParent == actualParent && token;
}
// Fixed native control ABI; no evaluation, URL or process-lifetime authority.
constexpr uint32_t kControlVersion = 1, kProfilePathBytes = 4096;
constexpr mach_msg_id_t kHelloMessage = 0x5a504901;
constexpr mach_msg_id_t kBootstrapMessage = 0x5a504902;
constexpr mach_msg_id_t kRegisteredMessage = 0x5a504903;
constexpr mach_msg_id_t kNormalQuitMessage = 0x5a504904;
constexpr mach_msg_id_t kQuitReplyMessage = 0x5a504905;
struct ProfileDirectory {
  uint32_t length = 0;
  uint64_t device = 0, inode = 0;
  char bytes[kProfilePathBytes]{};
};
inline bool ValidProfileDirectory(const ProfileDirectory& p) {
  if (!p.length || p.length > kProfilePathBytes || !p.inode || p.bytes[0] != '/')
    return false;
  // Strict UTF-8, excluding NUL, overlongs, surrogates and out-of-range scalars.
  for (uint32_t i = 0; i < p.length;) {
    uint32_t c = uint8_t(p.bytes[i++]);
    if (!c) return false;
    if (c < 0x80) continue;
    uint32_t rest, minimum;
    if (c >= 0xc2 && c <= 0xdf) { rest = 1; minimum = 0x80; c &= 31; }
    else if (c >= 0xe0 && c <= 0xef) { rest = 2; minimum = 0x800; c &= 15; }
    else if (c >= 0xf0 && c <= 0xf4) { rest = 3; minimum = 0x10000; c &= 7; }
    else return false;
    if (rest > p.length - i) return false;
    while (rest--) {
      uint32_t next = uint8_t(p.bytes[i++]);
      if ((next & 0xc0) != 0x80) return false;
      c = (c << 6) | (next & 63);
    }
    if (c < minimum || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) return false;
  }
  return true;
}
inline bool SetProfileDirectory(ProfileDirectory& out, const char* bytes,
                                size_t length, uint64_t device, uint64_t inode) {
  if (!bytes || length > kProfilePathBytes) return false;
  ProfileDirectory p{};
  p.length = uint32_t(length); p.device = device; p.inode = inode;
  memcpy(p.bytes, bytes, length);
  if (!ValidProfileDirectory(p)) return false;
  out = p;
  return true;
}
inline bool SameProfileDirectory(const ProfileDirectory& a, const ProfileDirectory& b) {
  return ValidProfileDirectory(a) && ValidProfileDirectory(b) &&
      a.length == b.length && a.device == b.device && a.inode == b.inode &&
      !memcmp(a.bytes, b.bytes, a.length);
}
// Authentication preimages only; qualification belongs to the Profile service.
// Each literal/preimage has a hard 4096-byte ceiling. Never truncate.
constexpr uint32_t kStartupVersion = 3, kStartupBytes = 4096;
constexpr mach_msg_id_t kStartupHelloMessage = 0x5a504906;
constexpr mach_msg_id_t kStartupBindingMessage = 0x5a504907;
struct StartupBytes {
  uint32_t present = 0, length = 0;
  char bytes[kStartupBytes]{};
};
inline bool ValidStartupBytes(const StartupBytes& b) {
  return b.present <= 1 && b.length <= kStartupBytes && (b.present || !b.length);
}
inline bool SetStartupBytes(StartupBytes& out, bool present, const char* bytes, size_t length) {
  if (length > kStartupBytes || (!present && length) || (!bytes && length)) return false;
  StartupBytes b{}; b.present = present; b.length = uint32_t(length);
  if (length) memcpy(b.bytes, bytes, length);
  out = b; return true;
}
inline bool SameStartupBytes(const StartupBytes& a, const StartupBytes& b) {
  return ValidStartupBytes(a) && ValidStartupBytes(b) && a.present == b.present &&
      a.length == b.length && !memcmp(a.bytes, b.bytes, a.length);
}
// Raw input metadata only, not child disk verification or effective prefs.
// Absent files have all-zero fields/digest; presence distinguishes present-empty.
struct StartupPrefsFile {
  uint32_t present = 0;
  uint64_t length = 0, device = 0, inode = 0;
  uint8_t sha256[32]{};
};
struct StartupExpectation {
  ProfileDirectory authority, root, local;
  StartupBytes profiles, installs, name, path, isRelative, storeID, showSelector;
  uint32_t prefsSupplied = 0;
  uint64_t prefsAggregateLimit = 0;
  StartupPrefsFile prefsFiles[2]; // prefs.js, user.js, in capture order
};
inline bool ValidStartupSelection(const StartupExpectation& e) {
  return ValidProfileDirectory(e.authority) && ValidProfileDirectory(e.root) &&
      ValidProfileDirectory(e.local) && ValidStartupBytes(e.profiles) &&
      ValidStartupBytes(e.installs) && ValidStartupBytes(e.name) && e.name.present &&
      ValidStartupBytes(e.path) && e.path.present && ValidStartupBytes(e.isRelative) &&
      e.isRelative.present && ValidStartupBytes(e.storeID) && ValidStartupBytes(e.showSelector);
}
inline bool ValidStartupExpectation(const StartupExpectation& e) {
  if (!ValidStartupSelection(e) || e.prefsSupplied != 1) return false;
  uint64_t total = 0;
  for (const auto& file : e.prefsFiles) {
    if (file.present > 1) return false;
    if (!file.present) {
      if (file.length || file.device || file.inode) return false;
      for (uint8_t byte : file.sha256) if (byte) return false;
    } else if (!file.inode || file.length > uint64_t(INT32_MAX)) return false;
    if (total > e.prefsAggregateLimit || file.length > e.prefsAggregateLimit - total)
      return false;
    total += file.length;
  }
  return true;
}
inline bool SameStartupExpectation(const StartupExpectation& a, const StartupExpectation& b) {
  if (!ValidStartupExpectation(a) || !ValidStartupExpectation(b) ||
      a.prefsSupplied != b.prefsSupplied || a.prefsAggregateLimit != b.prefsAggregateLimit)
    return false;
  for (size_t i = 0; i < 2; ++i) {
    const auto& x = a.prefsFiles[i]; const auto& y = b.prefsFiles[i];
    if (x.present != y.present || x.length != y.length || x.device != y.device ||
        x.inode != y.inode || memcmp(x.sha256, y.sha256, sizeof(x.sha256))) return false;
  }
  return SameProfileDirectory(a.authority, b.authority) && SameProfileDirectory(a.root, b.root) &&
      SameProfileDirectory(a.local, b.local) && SameStartupBytes(a.profiles, b.profiles) &&
      SameStartupBytes(a.installs, b.installs) && SameStartupBytes(a.name, b.name) &&
      SameStartupBytes(a.path, b.path) && SameStartupBytes(a.isRelative, b.isRelative) &&
      SameStartupBytes(a.storeID, b.storeID) && SameStartupBytes(a.showSelector, b.showSelector);
}
struct StartupHelloRecord {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t control;
  uint32_t version = kStartupVersion, pid = 0;
  uint64_t owner = 0;
};
struct StartupBindingRecord {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t host;
  uint32_t version = kStartupVersion, cleanupOnly = 0;
  uint64_t owner = 0, token = 0;
  StartupExpectation expectation;
};
inline bool ControlEndpointAlive(mach_port_t endpoint) {
  mach_port_type_t type = 0;
  return MACH_PORT_VALID(endpoint) &&
      mach_port_type(mach_task_self(), endpoint, &type) == KERN_SUCCESS &&
      (type & MACH_PORT_TYPE_SEND) && !(type & MACH_PORT_TYPE_DEAD_NAME);
}
inline bool ParentAuthenticated(uint32_t expected, uint32_t current, uint32_t audit) {
  return expected > 1 && expected <= INT32_MAX && expected == current && expected == audit;
}
enum class QuitStatus : uint32_t { Requested = 1, Vetoed = 2, NotAvailable = 3 };
inline bool ValidQuitStatus(QuitStatus s) {
  return s == QuitStatus::Requested || s == QuitStatus::Vetoed || s == QuitStatus::NotAvailable;
}
enum class QuitAction { Reject, Start, Pending, Cached };
struct QuitSequence {
  uint64_t request = 0;
  bool pending = false;
  QuitStatus status = QuitStatus::NotAvailable;
  QuitAction Begin(uint64_t id) {
    if (!id || id < request) return QuitAction::Reject;
    if (pending) return QuitAction::Pending;
    if (id == request) return QuitAction::Cached;
    request = id; pending = true;
    return QuitAction::Start;
  }
  bool Complete(uint64_t id, QuitStatus result) {
    if (!pending || id != request || !ValidQuitStatus(result)) return false;
    status = result; pending = false; return true;
  }
};
struct HelloRecord {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t control;
  uint32_t version = kControlVersion, pid = 0;
  uint64_t owner = 0;
  ProfileDirectory profile;
};
struct BootstrapRecord {
  mach_msg_header_t header;
  uint32_t version = kControlVersion, cleanupOnly = 0;
  uint64_t owner = 0, token = 0;
};
struct RegisteredRecord {
  mach_msg_header_t header;
  uint32_t version = kControlVersion;
  uint64_t owner = 0;
  Identity identity;
  ProfileDirectory profile;
};
struct QuitRecord {
  mach_msg_header_t header;
  uint32_t version = kControlVersion;
  uint64_t owner = 0, request = 0;
  Identity identity;
};
struct QuitReplyRecord {
  mach_msg_header_t header;
  uint32_t version = kControlVersion;
  uint64_t owner = 0, request = 0;
  Identity identity;
  QuitStatus status = QuitStatus::NotAvailable;
};
// Metadata only: the native host separately owns its retained right. A PID here
// is not proof of Subprocess ownership; only the later real handle owner binds it.
struct WorkerBinding {
  ProfileDirectory profile;
  uint32_t pid = 0;
  uint64_t owner = 0;
  mach_port_t control = MACH_PORT_NULL;
  Identity identity;
  bool prepared = false, cleanupOnly = false;
  bool Prepare(const ProfileDirectory& p) {
    if (prepared || !ValidProfileDirectory(p)) return false;
    profile = p; prepared = true; return true;
  }
  bool Bind(uint32_t child, bool cleanup) {
    if (!prepared || pid || child <= 1 || child > INT32_MAX) return false;
    pid = child; cleanupOnly |= cleanup; return true;
  }
  void Tighten() { cleanupOnly = true; }
  bool Hello(uint32_t audit, uint32_t claimedPID, const ProfileDirectory& p,
             uint64_t cookie, mach_port_t right) {
    if (!pid || audit != pid || claimedPID != pid || !cookie ||
        !MACH_PORT_VALID(right) || !SameProfileDirectory(profile, p) ||
        (owner && (owner != cookie || control != right))) return false;
    owner = cookie; control = right; return true;
  }
  bool Register(const Identity& id, uint32_t audit, const ProfileDirectory& p,
                uint64_t cookie, uint64_t token) {
    if (cleanupOnly || !owner || cookie != owner || audit != pid || id.pid != pid ||
        !id.Valid() || id.token != token || !SameProfileDirectory(profile, p) ||
        (identity.Valid() && !(identity == id))) return false;
    identity = id; return true;
  }
};
struct Node {
  int32_t parent;
  uint32_t flags;
  // SDK 4-bit masks; defaults preserve manually constructed CALayer fixtures.
  uint32_t edgeAntialiasingMask = 15, maskedCorners = 15;
  float position[2], bounds[4], anchor[2], contentsRect[4];
  float transform[16], sublayerTransform[16];
  float opacity, contentsScale, cornerRadius, background[4];
};
struct Frame {
  uint32_t count = 0, unsupported = 0;
  Node nodes[kNodes]{};
};
// INTERNAL/PARTIAL native staging transport, not a supported JS controller ABI.
// Fixed descriptors permit bounded kernel receive/destruction. No ready, fence,
// input or presentation signal exists in this packet.
constexpr mach_msg_id_t kFrameMessage = 0x5a504832; // PH2: explicit layer masks/flags
struct Packet {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t surfaces[kNodes];
  Identity identity;
  float backingScale;
  Frame frame;
};
inline Error ValidateTree(const Frame& f) {
  if (f.unsupported) return Error::UnsupportedTree;
  if (!f.count || f.count > kNodes) return Error::Tree;
  for (uint32_t i = 0; i < f.count; ++i) {
    const Node& n = f.nodes[i];
    if ((!i && n.parent != -1) ||
        (i && (n.parent < 0 || uint32_t(n.parent) >= i)) ||
        (n.flags & ~127u) || (n.edgeAntialiasingMask & ~15u) ||
        (n.maskedCorners & ~15u)) return Error::Tree;
    for (size_t j = offsetof(Node, position); j < sizeof(n); j += sizeof(float)) {
      float v;
      memcpy(&v, reinterpret_cast<const char*>(&n) + j, sizeof(v));
      if (!std::isfinite(v) || std::fabs(v) > 1e7f) return Error::Geometry;
    }
    if (n.bounds[2] < 0 || n.bounds[3] < 0 || n.bounds[2] > 32768 ||
        n.bounds[3] > 32768 || n.contentsRect[2] < 0 || n.contentsRect[3] < 0 ||
        n.opacity < 0 || n.opacity > 1 || n.contentsScale <= 0 ||
        n.contentsScale > 16 || n.cornerRadius < 0) return Error::Geometry;
    for (float v : n.background) if (v < 0 || v > 1) return Error::Geometry;
  }
  return Error::Ok;
}

// One owned worker and one pending transition. Only an authenticated Ready can
// supply Identity; a frame never chooses a backing root or replaces its owner.
class Gate final {
 public:
  bool Admit(const Identity& id) {
    if (mIdentity.Valid() || !id.Valid()) return false;
    mIdentity = id;
    return true;
  }
  bool Matches(const Identity& id, uint32_t auditPID) const {
    return mIdentity.Valid() && id == mIdentity && auditPID == mIdentity.pid;
  }
  bool Begin(uint64_t request, uint64_t revision, double width, double height,
             double scale) {
    if (!mIdentity.Valid() || request <= mRequest || !revision ||
        !std::isfinite(width) || !std::isfinite(height) ||
        !std::isfinite(scale) || width <= 0 || height <= 0 || width > 32768 ||
        height > 32768 || scale <= 0 || scale > 16) return false;
    mRequest = request; mRevision = revision;
    mWidth = width; mHeight = height; mScale = scale;
    mPending = true;
    mSpace = mResize = mFrame = mComposition = mBlur = mFocus = false;
    return true;
  }
  bool Space(uint64_t request, uint64_t revision) {
    if (!Current(request) || revision != mRevision) return false;
    mSpace = true;
    return true;
  }
  bool Resize(uint64_t request, double width, double height, double scale) {
    if (!Current(request) || !mSpace || width != mWidth || height != mHeight ||
        scale != mScale) return false;
    mResize = true;
    return true;
  }
  // The caller must pass the request carried by an actual post-resize paint
  // barrier, not stamp a current request onto an arbitrary compositor commit.
  bool Frame(uint64_t request, uint64_t serial) {
    if (!Current(request) || !mResize || serial <= mFrameSerial) return false;
    mFrameSerial = serial;
    mFrame = true;
    return true;
  }
  bool Composition(uint64_t request) {
    if (!Current(request) || !mFrame) return false;
    mComposition = true;
    return true;
  }
  bool Blur(uint64_t request) {
    if (!Current(request) || !mComposition) return false;
    mBlur = true;
    return true;
  }
  bool Focus(uint64_t request) {
    if (!Current(request) || !mBlur) return false;
    mFocus = true;
    return true;
  }
  bool CanPublish() const {
    return mPending && mSpace && mResize && mFrame && mComposition && mBlur && mFocus;
  }
  bool Publish() {
    if (!CanPublish()) return false;
    mPending = false; mPresented = true;
    return true;
  }
  bool Input(const Identity& id, uint32_t auditPID) const {
    return mPresented && Matches(id, auditPID);
  }
  void Cancel() { mPending = false; }
  void ReturnLocal() { Cancel(); mPresented = false; }
  const Identity& Owner() const { return mIdentity; }
 private:
  bool Current(uint64_t request) const {
    return mPending && request && request == mRequest;
  }
  Identity mIdentity;
  uint64_t mRequest = 0, mRevision = 0, mFrameSerial = 0;
  double mWidth = 0, mHeight = 0, mScale = 0;
  bool mPending = false, mPresented = false;
  bool mSpace = false, mResize = false, mFrame = false;
  bool mComposition = false, mBlur = false, mFocus = false;
};

// Mach validates descriptors before a successful receive. This bounds traversal
// before destruction even for packets rejected by the product ABI validator.
inline bool MessageLayout(const mach_msg_header_t* h, size_t capacity) {
  const size_t size = h->msgh_size;
  if (size < sizeof(*h) || size > capacity) return false;
  if (!(h->msgh_bits & MACH_MSGH_BITS_COMPLEX)) return true;
  size_t offset = sizeof(*h);
  if (size - offset < sizeof(mach_msg_body_t)) return false;
  const auto* body = reinterpret_cast<const mach_msg_body_t*>(
      reinterpret_cast<const char*>(h) + offset);
  offset += sizeof(*body);
  for (uint32_t i = 0; i < body->msgh_descriptor_count; ++i) {
    if (size - offset < sizeof(mach_msg_type_descriptor_t)) return false;
    const auto* d = reinterpret_cast<const mach_msg_type_descriptor_t*>(
        reinterpret_cast<const char*>(h) + offset);
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
template<typename Record>
inline bool ControlLayout(const mach_msg_header_t* h, size_t capacity, mach_msg_id_t id) {
  if (!MessageLayout(h, capacity) || h->msgh_size != sizeof(Record) ||
      h->msgh_id != id || (h->msgh_bits & MACH_MSGH_BITS_COMPLEX) ||
      h->msgh_remote_port != MACH_PORT_NULL || h->msgh_voucher_port != MACH_PORT_NULL) return false;
  return reinterpret_cast<const Record*>(h)->version == kControlVersion;
}
inline bool HelloLayout(const mach_msg_header_t* h, size_t capacity) {
  if (!MessageLayout(h, capacity) || h->msgh_size != sizeof(HelloRecord) ||
      h->msgh_id != kHelloMessage || !(h->msgh_bits & MACH_MSGH_BITS_COMPLEX) ||
      h->msgh_remote_port != MACH_PORT_NULL || h->msgh_voucher_port != MACH_PORT_NULL) return false;
  const auto& p = *reinterpret_cast<const HelloRecord*>(h);
  return p.version == kControlVersion && p.body.msgh_descriptor_count == 1 &&
      p.control.type == MACH_MSG_PORT_DESCRIPTOR &&
      p.control.disposition == MACH_MSG_TYPE_PORT_SEND && MACH_PORT_VALID(p.control.name) &&
      p.owner && ValidProfileDirectory(p.profile);
}
template<typename Record>
inline bool StartupLayout(const mach_msg_header_t* h, size_t capacity, mach_msg_id_t id) {
  if (!MessageLayout(h, capacity) || h->msgh_size != sizeof(Record) || h->msgh_id != id ||
      !(h->msgh_bits & MACH_MSGH_BITS_COMPLEX) || h->msgh_remote_port != MACH_PORT_NULL ||
      h->msgh_voucher_port != MACH_PORT_NULL) return false;
  const auto& p = *reinterpret_cast<const Record*>(h);
  const auto* right = reinterpret_cast<const mach_msg_port_descriptor_t*>(&p.body + 1);
  return p.version == kStartupVersion && p.body.msgh_descriptor_count == 1 &&
      right->type == MACH_MSG_PORT_DESCRIPTOR && right->disposition == MACH_MSG_TYPE_PORT_SEND &&
      MACH_PORT_VALID(right->name) && p.owner;
}
// All outgoing rights are COPY_SEND. On pseudo-receive only, the kernel adds
// references back to the returned header/descriptors; destroy those once.
inline mach_msg_return_t SendControlMessage(mach_msg_header_t* h) {
  auto result = mach_msg(h, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
                         h->msgh_size, 0, MACH_PORT_NULL, 0, MACH_PORT_NULL);
  auto error = result & ~MACH_MSG_MASK;
  if (error == MACH_SEND_TIMED_OUT || error == MACH_SEND_INTERRUPTED) mach_msg_destroy(h);
  return result;
}
template<typename Record>
inline mach_msg_return_t SendControl(Record& p, mach_port_t endpoint, mach_msg_id_t id) {
  p.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  p.header.msgh_size = sizeof(p);
  p.header.msgh_remote_port = endpoint;
  p.header.msgh_id = id;
  return SendControlMessage(&p.header);
}
inline uint32_t AuditPID(const mach_msg_header_t* h, size_t capacity) {
  if (!MessageLayout(h, capacity)) return 0;
  const size_t offset = (h->msgh_size + 3u) & ~size_t(3u);
  if (offset > capacity || capacity - offset < sizeof(mach_msg_audit_trailer_t)) return 0;
  const auto* t = reinterpret_cast<const mach_msg_audit_trailer_t*>(
      reinterpret_cast<const char*>(h) + offset);
  if (t->msgh_trailer_type != MACH_MSG_TRAILER_FORMAT_0 ||
      t->msgh_trailer_size < sizeof(*t) || t->msgh_trailer_size > capacity-offset) return 0;
  return t->msgh_audit.val[5];
}
class Received final {
 public:
  Received(mach_msg_header_t* h, size_t capacity)
      : mHeader(MessageLayout(h, capacity) ? h : nullptr) {}
  ~Received() { if (mHeader) mach_msg_destroy(mHeader); }
  Received(const Received&) = delete;
  Received& operator=(const Received&) = delete;
 private:
  mach_msg_header_t* mHeader;
};
} // namespace zen::profilehost
#endif
