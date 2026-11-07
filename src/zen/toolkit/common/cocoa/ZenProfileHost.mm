/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "ZenProfileHostNative.h"
#include "ZenProfileHostDecoder.h"
#include "ZenProfileHostSender.h"
#include "mozilla/layers/NativeLayerCA.h"
#include "nsCocoaWindow.h"
#include "WidgetUtils.h"
#include "nsGlobalWindowOuter.h"
#include "nsIWidget.h"
#include "nsThreadUtils.h"
#include "nsString.h"
#include "nsCocoaUtils.h"
#include "nsContentUtils.h"
#include "nsFrameLoader.h"
#include "nsFrameLoaderOwner.h"
#include "nsQueryObject.h"
#include "mozilla/PresShell.h"
#include "mozilla/dom/BrowserParent.h"
#include "mozilla/dom/CanonicalBrowsingContext.h"
#include "mozilla/dom/ContentParent.h"
#include "mozilla/dom/Document.h"
#include "mozilla/dom/Element.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/dom/WindowGlobalParent.h"
#include "mozilla/webrender/WebRenderTypes.h"
#include "xpcpublic.h"
#include <cmath>
#include <memory>
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <servers/bootstrap.h>
#include <dispatch/dispatch.h>
#include <cstdlib>
#include <limits>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <fcntl.h>
#include <cerrno>
#include <pthread.h>
#include <chrono>
#include "nsIFile.h"
#include "nsIObserver.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIPrefService.h"
#include "nsICryptoHash.h"
#include "nsServiceManagerUtils.h"
#include "nsISupportsImpl.h"
#include "nsTArray.h"
#include <cstring>
#include <new>
#include <utility>

// Private raw bytes/records stay here; only fixed metadata enters StartupExpectation.
struct PrefsFailure {
  nsresult result = NS_OK;
  nsresult parserResult = NS_OK;
  int io = 0;
  bool parserSeen = false, parserCopyFailed = false;
  nsCString parser;
};
struct PrefsRecord {
  enum class Type { String, Int, Bool } type;
  nsCString name, string;
  int32_t integer = 0;
  bool boolean = false;
};
struct PrefsRaw {
  const char* name = nullptr; // build-owned label only
  bool present = false;
  uint64_t device = 0, inode = 0;
  nsTArray<uint8_t> raw;
  nsCString sha256;
};
struct PrefsInputSnapshot {
  uint64_t limit = 0;
  PrefsRaw files[2];
  nsTArray<PrefsRecord> records;
};

// Callback return values are ignored by libpref. Failure is irreversible even
// when copying the first diagnostic fails. No services or script in callbacks.
class PrefsCollector final : public nsIPrefObserver {
 public:
  NS_DECL_ISUPPORTS
  PrefsFailure error;
  nsTArray<PrefsRecord> records;
  void Fail(nsresult rv) {
    if (NS_SUCCEEDED(error.result)) error.result = rv;
  }
  bool Start(const char* kind, const char* name, bool sticky, bool locked,
             PrefsRecord& record) {
    if (NS_FAILED(error.result)) return false;
    if (!kind || strcmp(kind, "User") || !name || sticky || locked) {
      Fail(NS_ERROR_FILE_CORRUPTED); return false;
    }
    if (!record.name.Assign(name, mozilla::fallible)) {
      Fail(NS_ERROR_OUT_OF_MEMORY); return false;
    }
    return true;
  }
  void Append(PrefsRecord&& record) {
    if (records.Length() >= (INT32_MAX - sizeof(nsTArrayHeader)) / sizeof(PrefsRecord)) {
      Fail(NS_ERROR_FILE_TOO_BIG); return;
    }
    if (!records.AppendElement(std::move(record), mozilla::fallible))
      Fail(NS_ERROR_OUT_OF_MEMORY);
  }
  NS_IMETHOD OnStringPref(const char* kind, const char* name, const char* value,
                          bool sticky, bool locked) override {
    PrefsRecord record; record.type = PrefsRecord::Type::String;
    if (Start(kind, name, sticky, locked, record)) {
      if (!value) Fail(NS_ERROR_FILE_CORRUPTED);
      else if (!record.string.Assign(value, mozilla::fallible)) Fail(NS_ERROR_OUT_OF_MEMORY);
      else Append(std::move(record));
    }
    return NS_OK;
  }
  NS_IMETHOD OnIntPref(const char* kind, const char* name, int32_t value,
                       bool sticky, bool locked) override {
    PrefsRecord record; record.type = PrefsRecord::Type::Int;
    if (Start(kind, name, sticky, locked, record)) {
      record.integer = value; Append(std::move(record));
    }
    return NS_OK;
  }
  NS_IMETHOD OnBoolPref(const char* kind, const char* name, bool value,
                        bool sticky, bool locked) override {
    PrefsRecord record; record.type = PrefsRecord::Type::Bool;
    if (Start(kind, name, sticky, locked, record)) {
      record.boolean = value; Append(std::move(record));
    }
    return NS_OK;
  }
  NS_IMETHOD OnError(const char* message) override {
    Fail(NS_ERROR_FILE_CORRUPTED);
    if (!error.parserSeen) {
      error.parserSeen = true;
      if (!message || !error.parser.Assign(message, mozilla::fallible))
        error.parserCopyFailed = true;
    }
    return NS_OK;
  }
 private:
  ~PrefsCollector() = default;
};
NS_IMPL_ISUPPORTS(PrefsCollector, nsIPrefObserver)

static nsresult PrefsRefuse(PrefsFailure& error, nsresult rv, int io = 0) {
  if (NS_SUCCEEDED(error.result)) { error.result = rv; error.io = io; }
  return error.result;
}
static bool SamePrefsStat(const struct stat& a, const struct stat& b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size &&
      a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec &&
      a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
      a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec &&
      a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec;
}
static nsresult ReadPrefsRaw(int directory, const char* name, uint64_t limit,
                            uint64_t& total, PrefsRaw& out, PrefsFailure& error) {
  out.name = name;
  const int fd = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) {
    const int original = errno;
    if (original != ENOENT) return PrefsRefuse(error, NS_ERROR_FILE_ACCESS_DENIED, original);
  } else {
    auto finish = [&](nsresult rv) {
      const int status = close(fd);
      const int original = errno;
      if (NS_FAILED(rv)) return rv;
      return status == 0 ? NS_OK : PrefsRefuse(error, NS_ERROR_FAILURE, original);
    };
    struct stat before{}, after{};
    if (fstat(fd, &before) != 0)
      return finish(PrefsRefuse(error, NS_ERROR_FAILURE, errno));
    if (!S_ISREG(before.st_mode) || before.st_size < 0)
      return finish(PrefsRefuse(error, NS_ERROR_FILE_CORRUPTED));
    const uint64_t length = uint64_t(before.st_size);
    // Representation ceiling, NOT a product policy/default: the existing parser
    // clones nsTArray<uint8_t>, then appends NUL. Leave header + NUL room.
    if (total > limit || length > limit - total ||
        length > uint64_t(INT32_MAX) - sizeof(nsTArrayHeader) - 1 ||
        length > uint64_t(std::numeric_limits<ssize_t>::max()))
      return finish(PrefsRefuse(error, NS_ERROR_FILE_TOO_BIG));
    if (length && !out.raw.SetLength(uint32_t(length), mozilla::fallible))
      return finish(PrefsRefuse(error, NS_ERROR_OUT_OF_MEMORY));
    size_t used = 0;
    while (used < length) {
      const ssize_t count = read(fd, out.raw.Elements() + used, size_t(length) - used);
      if (count < 0) {
        const int original = errno;
        if (original == EINTR) continue;
        return finish(PrefsRefuse(error, NS_ERROR_FAILURE, original));
      }
      if (count == 0) return finish(PrefsRefuse(error, NS_ERROR_FILE_CORRUPTED));
      used += size_t(count);
    }
    uint8_t extra; ssize_t tail;
    do { tail = read(fd, &extra, 1); } while (tail < 0 && errno == EINTR);
    if (tail < 0) return finish(PrefsRefuse(error, NS_ERROR_FAILURE, errno));
    if (tail != 0) return finish(PrefsRefuse(error, NS_ERROR_FILE_CORRUPTED));
    if (fstat(fd, &after) != 0)
      return finish(PrefsRefuse(error, NS_ERROR_FAILURE, errno));
    if (!S_ISREG(after.st_mode) || !SamePrefsStat(before, after))
      return finish(PrefsRefuse(error, NS_ERROR_FILE_CORRUPTED));
    nsresult rv = finish(NS_OK);
    if (NS_FAILED(rv)) return rv;
    out.present = true; out.device = uint64_t(before.st_dev); out.inode = uint64_t(before.st_ino);
    total += length;
  }
  // Digest is retained for absent as well as present/empty; presence is separate.
  nsCOMPtr<nsICryptoHash> hash;
  nsresult rv = NS_NewCryptoHash(nsICryptoHash::SHA256, getter_AddRefs(hash));
  if (NS_SUCCEEDED(rv) && !out.raw.IsEmpty()) rv = hash->Update(out.raw.Elements(), out.raw.Length());
  if (NS_SUCCEEDED(rv)) rv = hash->Finish(false, out.sha256);
  return NS_FAILED(rv) ? PrefsRefuse(error, rv) : NS_OK;
}

static nsresult ParsePrefsInput(nsIPrefService* service, PrefsInputSnapshot& out,
                               PrefsFailure& error) {
  RefPtr<PrefsCollector> collector = new PrefsCollector();
  for (const auto& file : out.files) {
    if (!file.present) continue;
    const nsresult rv = service->ParsePrefsFromBuffer(file.raw, collector, file.name);
    // Only normal return plus the private latch authorizes the entire batch.
    if (NS_FAILED(rv) || NS_FAILED(collector->error.result)) {
      error = std::move(collector->error);
      error.parserResult = rv;
      if (NS_FAILED(rv)) { error.result = rv; return rv; }
      return PrefsRefuse(error, NS_FAILED(rv) ? rv : NS_ERROR_FILE_CORRUPTED);
    }
  }
  out.records = std::move(collector->records);
  return NS_OK;
}

using namespace zen::profilehost;
static char sProfileHostKey;
@class ZenProfileHost;
using ControlClock = std::chrono::steady_clock;
static bool CaptureDirectory(nsIFile* file, ProfileDirectory& out) {
  nsAutoCString path;
  if (!file || NS_FAILED(file->GetNativePath(path)) || path.FindChar('\0') != kNotFound ||
      path.IsEmpty() || path.Length() > kProfilePathBytes) return false;
  struct stat info{};
  return stat(path.get(), &info) == 0 && S_ISDIR(info.st_mode) &&
      SetProfileDirectory(out, path.get(), path.Length(), uint64_t(info.st_dev), uint64_t(info.st_ino));
}
static nsresult CapturePrefsInput(nsIFile* root, const ProfileDirectory& expected,
                                  uint64_t limit, PrefsInputSnapshot& out,
                                  PrefsFailure& error) {
  nsAutoCString path;
  nsresult rv = root->GetNativePath(path);
  if (NS_FAILED(rv)) return PrefsRefuse(error, rv);
  if (path.Length() != expected.length || memcmp(path.get(), expected.bytes, expected.length))
    return PrefsRefuse(error, NS_ERROR_FILE_CORRUPTED);
  const int fd = open(path.get(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) return PrefsRefuse(error, NS_ERROR_FILE_ACCESS_DENIED, errno);
  out.limit = limit;
  struct stat before{}, after{};
  if (fstat(fd, &before) != 0) rv = PrefsRefuse(error, NS_ERROR_FAILURE, errno);
  else if (!S_ISDIR(before.st_mode) || uint64_t(before.st_dev) != expected.device ||
           uint64_t(before.st_ino) != expected.inode)
    rv = PrefsRefuse(error, NS_ERROR_FILE_CORRUPTED);
  uint64_t total = 0;
  if (NS_SUCCEEDED(rv)) rv = ReadPrefsRaw(fd, "prefs.js", limit, total, out.files[0], error);
  if (NS_SUCCEEDED(rv)) rv = ReadPrefsRaw(fd, "user.js", limit, total, out.files[1], error);
  if (NS_SUCCEEDED(rv)) {
    if (fstat(fd, &after) != 0) rv = PrefsRefuse(error, NS_ERROR_FAILURE, errno);
    else if (!S_ISDIR(after.st_mode) || !SamePrefsStat(before, after))
      rv = PrefsRefuse(error, NS_ERROR_FILE_CORRUPTED);
  }
  const int status = close(fd);
  const int original = errno;
  if (NS_SUCCEEDED(rv) && status != 0) rv = PrefsRefuse(error, NS_ERROR_FAILURE, original);
  struct stat live{};
  if (NS_SUCCEEDED(rv)) {
    if (lstat(path.get(), &live) != 0) rv = PrefsRefuse(error, NS_ERROR_FAILURE, errno);
    else if (!S_ISDIR(live.st_mode) || uint64_t(live.st_dev) != expected.device ||
             uint64_t(live.st_ino) != expected.inode)
      rv = PrefsRefuse(error, NS_ERROR_FILE_CORRUPTED);
  }
  return rv;
}
static bool SamePrefsInput(const PrefsInputSnapshot& expected, const PrefsInputSnapshot& current) {
  if (expected.limit != current.limit) return false;
  for (size_t i = 0; i < 2; ++i) {
    const auto& a = expected.files[i]; const auto& b = current.files[i];
    if (a.present != b.present || a.device != b.device || a.inode != b.inode ||
        a.raw.Length() != b.raw.Length() || !a.sha256.Equals(b.sha256) ||
        (a.raw.Length() && memcmp(a.raw.Elements(), b.raw.Elements(), a.raw.Length()))) return false;
  }
  return true;
}
static bool ChildOfCurrentProcess(uint32_t pid) {
  if (pid <= 1 || pid > INT32_MAX) return false;
  int query[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, int(pid)};
  struct kinfo_proc info{}; size_t length = sizeof(info);
  return sysctl(query, 4, &info, &length, nullptr, 0) == 0 && length == sizeof(info) &&
      info.kp_proc.p_pid == pid_t(pid) && info.kp_eproc.e_ppid == getpid();
}
static bool CloneStartupDirectory(nsIFile* input, nsCOMPtr<nsIFile>& clone,
                                  ProfileDirectory& out) {
  return input && NS_SUCCEEDED(input->Clone(getter_AddRefs(clone))) &&
      NS_SUCCEEDED(clone->Normalize()) && CaptureDirectory(clone, out);
}
static bool ReadStartupRaw(int authority, const char* name, StartupBytes& out) {
  const int fd = openat(authority, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) return errno == ENOENT && SetStartupBytes(out, false, nullptr, 0);
  auto finish = [&](bool ok) { return close(fd) == 0 && ok; };
  struct stat before{}, after{};
  if (fstat(fd, &before) != 0 || !S_ISREG(before.st_mode) || before.st_size < 0 ||
      uint64_t(before.st_size) > kStartupBytes) return finish(false);
  char raw[kStartupBytes + 1]; size_t used = 0; uint32_t calls = 0;
  while (used < sizeof(raw)) {
    if (++calls > kStartupBytes + 16) return finish(false);
    ssize_t count = read(fd, raw + used, sizeof(raw) - used);
    if (count < 0) { if (errno == EINTR) continue; return finish(false); }
    if (!count) break;
    used += size_t(count);
  }
  if (used > kStartupBytes || used != uint64_t(before.st_size) || fstat(fd, &after) != 0 ||
      before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
      before.st_size != after.st_size || before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec ||
      before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec ||
      before.st_ctimespec.tv_sec != after.st_ctimespec.tv_sec ||
      before.st_ctimespec.tv_nsec != after.st_ctimespec.tv_nsec) return finish(false);
  return finish(SetStartupBytes(out, true, raw, used));
}
static bool CaptureStartupRegistry(nsIFile* authority, StartupExpectation& out) {
  ProfileDirectory current;
  if (!CaptureDirectory(authority, current) || !SameProfileDirectory(out.authority, current)) return false;
  nsAutoCString path;
  if (NS_FAILED(authority->GetNativePath(path))) return false;
  const int fd = open(path.get(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return false;
  struct stat info{};
  bool ok = fstat(fd, &info) == 0 && S_ISDIR(info.st_mode) &&
      uint64_t(info.st_dev) == out.authority.device && uint64_t(info.st_ino) == out.authority.inode &&
      ReadStartupRaw(fd, "profiles.ini", out.profiles) && ReadStartupRaw(fd, "installs.ini", out.installs);
  ok = close(fd) == 0 && ok;
  return ok && CaptureDirectory(authority, current) && SameProfileDirectory(out.authority, current);
}
static bool CurrentStartupLocal(const ProfileDirectory& expected) {
  nsCOMPtr<nsIFile> local; ProfileDirectory current;
  return NS_SUCCEEDED(NS_GetSpecialDirectory(NS_APP_USER_PROFILE_LOCAL_50_DIR, getter_AddRefs(local))) &&
      CaptureDirectory(local, current) && SameProfileDirectory(expected, current);
}
static bool CurrentProfile(const ProfileDirectory& expected) {
  nsCOMPtr<nsIFile> profile;
  ProfileDirectory current;
  return NS_SUCCEEDED(NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR, getter_AddRefs(profile))) &&
      CaptureDirectory(profile, current) && SameProfileDirectory(expected, current);
}
static void NotifyControl(nsIObserver* listener, const char* topic, const nsACString& data) {
  // Copy across script-capable callbacks. Callers hold/revalidate native owners.
  nsCOMPtr<nsIObserver> hold = listener;
  if (hold) hold->Observe(nullptr, topic, NS_ConvertUTF8toUTF16(data).get());
}

// A hidden sibling, never an input/responder owner. The staged tree deliberately
// remains detached even from this view until a separate real fence/publication
// implementation exists.
@interface ZenProfileHostView : NSView {
 @public
  ZenProfileHost* owner; // non-owning, cleared before owner teardown
}
@end

@interface ZenProfileHost : NSObject {
 @public
  NSWindow* window; // non-owning; window association owns this object
  NSView* content;
  NSView* child;
  NSView* childParent; // identity only; never dereferenced
  ZenProfileHostView* view;
  nsCOMPtr<nsIWidget> widget;
  mach_port_t port;
  dispatch_source_t source;
  dispatch_source_t lifetime;
  NSString* service;
  uint64_t token;
  Gate gate;
  CALayer* staged;
  bool invalid;
  bool registered;
  WorkerBinding worker;
  StartupExpectation startupExpectation;
  bool startupPrepared, startupSend;
  bool prefsPreparing;
  std::unique_ptr<const PrefsInputSnapshot> prefsInput;
  PrefsFailure prefsFailure;
  nsCOMPtr<nsIFile> startupAuthority, startupLocal;
  nsCOMPtr<nsIFile> expectedDirectory;
  nsCOMPtr<nsIObserver> listener;
  QuitSequence quit;
  ControlClock::time_point quitDeadline;
  uint32_t quitSends;
}
- (BOOL)valid;
- (BOOL)workerCurrent;
- (void)control:(mach_msg_header_t*)header capacity:(size_t)capacity;
- (void)bootstrap;
- (void)sendQuit;
- (void)tick;
- (void)invalidate;
- (void)receive;
- (void)windowClosed:(NSNotification*)notification;
@end

@implementation ZenProfileHostView
- (BOOL)acceptsFirstResponder { return NO; }
- (NSView*)hitTest:(NSPoint)point { (void)point; return nil; }
- (void)viewDidMoveToWindow {
  [super viewDidMoveToWindow];
  if (owner && ![owner valid]) {
    [[self retain] autorelease];
    [owner invalidate];
  }
}
- (void)viewDidMoveToSuperview {
  [super viewDidMoveToSuperview];
  if (owner && ![owner valid]) {
    [[self retain] autorelease];
    [owner invalidate];
  }
}
@end

@implementation ZenProfileHost
- (BOOL)workerCurrent {
  ProfileDirectory current;
  if (![self valid] || !worker.prepared || !CaptureDirectory(expectedDirectory, current) ||
      !SameProfileDirectory(worker.profile, current)) return NO;
  if (startupPrepared) {
    StartupExpectation fresh = startupExpectation;
    if (!CaptureDirectory(startupLocal, current) || !SameProfileDirectory(fresh.local, current) ||
        !CaptureStartupRegistry(startupAuthority, fresh) ||
        !SameStartupExpectation(startupExpectation, fresh) ||
        (worker.pid && !ChildOfCurrentProcess(worker.pid))) return NO;
  }
  return YES;
}
- (void)bootstrap {
  if (![self workerCurrent] || !worker.owner) return;
  if (startupPrepared) {
    if (!startupSend || !ChildOfCurrentProcess(worker.pid)) return;
    StartupBindingRecord p{};
    p.owner = worker.owner; p.token = token; p.cleanupOnly = worker.cleanupOnly;
    p.expectation = startupExpectation;
    p.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
    p.header.msgh_size = sizeof(p); p.header.msgh_remote_port = worker.control;
    p.header.msgh_id = kStartupBindingMessage; p.body.msgh_descriptor_count = 1;
    p.host.name = port; p.host.type = MACH_MSG_PORT_DESCRIPTOR;
    p.host.disposition = MACH_MSG_TYPE_COPY_SEND;
    (void)SendControlMessage(&p.header); return;
  }
  BootstrapRecord p{};
  p.owner = worker.owner; p.token = token; p.cleanupOnly = worker.cleanupOnly;
  (void)SendControl(p, worker.control, kBootstrapMessage);
}
- (void)sendQuit {
  if (![self workerCurrent] || !worker.owner || !quit.pending || quitSends >= 50) return;
  if (ControlClock::now() >= quitDeadline) return;
  QuitRecord p{};
  p.owner = worker.owner; p.request = quit.request;
  p.identity = worker.identity.Valid() ? worker.identity : Identity{worker.pid, token, 0, 0, 0};
  ++quitSends;
  (void)SendControl(p, worker.control, kNormalQuitMessage);
}
- (void)tick {
  nsAutoRetainCocoaObject hold(self);
  if (![self valid]) { [self invalidate]; return; }
  if (!worker.prepared) return;
  if (![self workerCurrent]) {
    worker.Tighten(); gate.ReturnLocal();
    // Do not discard process ownership or adopt a replacement on root failure.
    [self invalidate]; return;
  }
  if (quit.pending) {
    if (ControlClock::now() >= quitDeadline) {
      quit.Complete(quit.request, QuitStatus::NotAvailable);
      nsAutoCString data; data.AppendInt(quit.request); data.AppendLiteral(":3");
      NotifyControl(listener, "zen-profile-host-quit-reply", data);
      return;
    }
    [self sendQuit];
  }
}
- (void)control:(mach_msg_header_t*)header capacity:(size_t)capacity {
  nsAutoRetainCocoaObject hold(self);
  Received rights(header, capacity);
  if (![self workerCurrent]) return;
  const uint32_t audit = AuditPID(header, capacity);
  if (startupPrepared && StartupLayout<StartupHelloRecord>(header, capacity, kStartupHelloMessage)) {
    const auto& p = *reinterpret_cast<const StartupHelloRecord*>(header);
    if (!worker.pid || audit != worker.pid || p.pid != worker.pid ||
        !ChildOfCurrentProcess(worker.pid) || !ControlEndpointAlive(p.control.name) ||
        (worker.owner && (worker.owner != p.owner || worker.control != p.control.name))) return;
    if (!worker.owner) {
      if (mach_port_mod_refs(mach_task_self(), p.control.name, MACH_PORT_RIGHT_SEND, 1) != KERN_SUCCESS) return;
      worker.owner = p.owner; worker.control = p.control.name;
    }
    [self bootstrap]; return;
  }
  if (!startupPrepared && HelloLayout(header, capacity)) {
    const auto& p = *reinterpret_cast<const HelloRecord*>(header);
    // No queue before Bind: Received drops this attempt, source retries finitely.
    WorkerBinding candidate = worker;
    if (!candidate.Hello(audit, p.pid, p.profile, p.owner, p.control.name)) return;
    if (!worker.owner) {
      if (mach_port_mod_refs(mach_task_self(), p.control.name, MACH_PORT_RIGHT_SEND, 1) != KERN_SUCCESS)
        return;
      worker = candidate; // retained copy; Received destroys the incoming reference.
    }
    [self bootstrap];
    if (quit.pending) [self sendQuit];
    return;
  }
  if (ControlLayout<RegisteredRecord>(header, capacity, kRegisteredMessage)) {
    const auto& p = *reinterpret_cast<const RegisteredRecord*>(header);
    WorkerBinding candidate = worker;
    if (!candidate.Register(p.identity, audit, p.profile, p.owner, token)) return;
    const bool duplicate = worker.identity.Valid();
    if (!duplicate && !gate.Admit(p.identity)) return;
    worker = candidate;
    if (!duplicate) NotifyControl(listener, "zen-profile-host-staging", "registered"_ns);
    // Callback may detach the host. No member/native-window use after it.
    return;
  }
  if (ControlLayout<QuitReplyRecord>(header, capacity, kQuitReplyMessage)) {
    const auto& p = *reinterpret_cast<const QuitReplyRecord*>(header);
    const Identity expected = worker.identity.Valid() ? worker.identity : Identity{worker.pid, token, 0, 0, 0};
    if (audit != worker.pid || p.owner != worker.owner || !(p.identity == expected) ||
        !quit.Complete(p.request, p.status)) return;
    nsAutoCString data; data.AppendInt(p.request); data.Append(':'); data.AppendInt(uint32_t(p.status));
    NotifyControl(listener, "zen-profile-host-quit-reply", data);
  }
}
- (BOOL)valid {
  return !invalid && window && window.contentView == content &&
         child.window == window && child.superview == childParent &&
         view.window == window &&
         view.superview == content && widget &&
         widget->GetNativeData(NS_NATIVE_WINDOW) == window &&
         widget->GetNativeData(NS_NATIVE_WIDGET) == child;
}
- (void)invalidate {
  if (invalid) return;
  [[self retain] autorelease];
  if (startupPrepared) { worker.Tighten(); [self bootstrap]; }
  invalid = true;
  if (!startupPrepared && worker.control && worker.owner) {
    // Best-effort authenticated normal shutdown on detach/root/window failure.
    // No wait/exit inference: a veto or dead endpoint retains the outer slot.
    worker.Tighten();
    BootstrapRecord bootstrap{};
    bootstrap.owner = worker.owner; bootstrap.token = token; bootstrap.cleanupOnly = 1;
    (void)SendControl(bootstrap, worker.control, kBootstrapMessage);
    uint64_t request = quit.pending ? quit.request :
        (quit.request == UINT64_MAX ? 0 : quit.request + 1);
    if (request) {
      QuitRecord p{}; p.owner = worker.owner; p.request = request;
      p.identity = worker.identity.Valid() ? worker.identity : Identity{worker.pid, token, 0, 0, 0};
      (void)SendControl(p, worker.control, kNormalQuitMessage);
    }
  }
  if (worker.control) mach_port_deallocate(mach_task_self(), worker.control);
  worker.control = MACH_PORT_NULL;
  listener = nullptr;
  expectedDirectory = nullptr;
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  if (lifetime) {
    dispatch_source_cancel(lifetime);
    dispatch_release(lifetime);
    lifetime = nullptr;
  }
  if (registered) {
    // Dynamic, per-attachment registration, not a launchd job or executable.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    kern_return_t result = bootstrap_register(bootstrap_port,
        const_cast<char*>(service.UTF8String), MACH_PORT_NULL);
#pragma clang diagnostic pop
    (void)result; // Receive-right destruction also retires any remaining lookup.
    registered = false;
  }
  if (source) {
    // The cancel handler runs after any event handler on the same main queue;
    // it alone drops the owned receive right and its queued message rights.
    dispatch_source_cancel(source);
    dispatch_release(source);
    source = nullptr;
  } else if (port) {
    mach_port_mod_refs(mach_task_self(), port, MACH_PORT_RIGHT_RECEIVE, -1);
  }
  if (startupSend) mach_port_deallocate(mach_task_self(), port);
  startupSend = false; startupAuthority = nullptr; startupLocal = nullptr;
  startupExpectation = {};
  prefsInput.reset();
  port = MACH_PORT_NULL;
  if (view) {
    view->owner = nil;
    [view removeFromSuperview];
    [view release]; view = nil;
  }
  [staged release]; staged = nil;
  [content release]; content = nil;
  [child release]; child = nil;
  widget = nullptr;
  if (window && objc_getAssociatedObject(window, &sProfileHostKey) == self)
    objc_setAssociatedObject(window, &sProfileHostKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  window = nil;
  // Detachment is not worker exit. No PID signal, child wait, or readiness reply.
}
- (void)windowClosed:(NSNotification*)notification {
  if (notification.object == window) [self invalidate];
}
- (void)receive {
  nsAutoRetainCocoaObject hold(self);
  if (![self valid]) { [self invalidate]; return; }
  for (int batch = 0; batch < 16; ++batch) {
    union Buffer {
      Packet packet;
      StartupBindingRecord startup;
      unsigned char bytes[(sizeof(Packet) > sizeof(StartupBindingRecord) ? sizeof(Packet) : sizeof(StartupBindingRecord)) + MAX_TRAILER_SIZE];
    } buffer{};
    mach_msg_return_t result = mach_msg(&buffer.packet.header,
        MACH_RCV_MSG | MACH_RCV_TIMEOUT |
        MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
        MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
        0, sizeof(buffer), port, 0, MACH_PORT_NULL);
    if (result == MACH_RCV_TIMED_OUT) break;
    // Without MACH_RCV_LARGE an oversized message is dequeued/destroyed by
    // the kernel. No unreceived buffer is passed to the successful-receive API.
    if (result == MACH_RCV_TOO_LARGE) continue;
    if (result != KERN_SUCCESS) {
      if ((result & ~MACH_MSG_MASK) == MACH_RCV_BODY_ERROR) {
        // Copyout may have transferred reply/body rights and OOL memory.
        Received partial(&buffer.packet.header, sizeof(buffer));
      }
      [self invalidate]; break;
    }
    if (buffer.packet.header.msgh_id != kFrameMessage) {
      [self control:&buffer.packet.header capacity:sizeof(buffer)];
      if (![self valid]) return;
      continue;
    }
    if (worker.prepared && (worker.cleanupOnly || ![self workerCurrent])) {
      Received rejected(&buffer.packet.header, sizeof(buffer));
      continue;
    }
    Consume(&buffer.packet.header, sizeof(buffer), gate,
            window.backingScaleFactor, &staged);
  }
}
- (void)dealloc {
  // Normal close/detach retires the association and source first. A remaining
  // event handler retains self until cancellation has completed.
  [service release];
  [super dealloc];
}
@end

static char sProfileSourceKey;

static nsCocoaWindow* CocoaWidget(NSWindow* window, nsIWidget* widget) {
  // nsIWidget's base getter is protected. Verify the concrete Cocoa owner via
  // its native delegate, then use nsCocoaWindow's public override.
  id delegate = window.delegate;
  if (![delegate isKindOfClass:[WindowDelegate class]]) return nullptr;
  nsCocoaWindow* cocoa = [(WindowDelegate*)delegate geckoWidget];
  return cocoa == widget ? cocoa : nullptr;
}

// The window association owns the source. Stop synchronizes with the root lock
// before releasing the callback's immutable identity and owned lookup right.
@interface ZenProfileSource : NSObject {
 @public
  NSWindow* window; // borrowed from the association; never used by callback
  NSView* child;
  NSView* content;
  NSView* childParent; // identity only
  nsCOMPtr<nsIWidget> widget;
  RefPtr<mozilla::layers::NativeLayerRootCA> root;
  mach_port_t endpoint;
  Identity identity;
  dispatch_source_t lifetime;
  bool observing;
  bool invalid;
}
- (BOOL)valid;
- (void)invalidate;
- (void)windowClosed:(NSNotification*)notification;
@end

static void ObserveProfileSource(void* context, CALayer* modelRoot, float scale) {
  // May run on a compositor thread. No main-thread ObjC/widget state access.
  @autoreleasepool {
    auto* source = static_cast<ZenProfileSource*>(context);
    (void)SendStaging(source->endpoint, source->identity, modelRoot, scale);
  }
}

@implementation ZenProfileSource
- (BOOL)valid {
  auto* cocoa = CocoaWidget(window, widget);
  return !invalid && window && window.contentView == content &&
      child.window == window && child.superview == childParent && widget &&
      widget->GetNativeData(NS_NATIVE_WINDOW) == window &&
      widget->GetNativeData(NS_NATIVE_WIDGET) == child &&
      cocoa && cocoa->IsProfileHostSource() &&
      cocoa->GetNativeLayerRoot() == root.get();
}
- (void)invalidate {
  if (invalid) return;
  [[self retain] autorelease];
  invalid = true;
  // Root lock serializes with the callback, including on non-main threads.
  if (observing) root->StopStagingObservation(self);
  observing = false;
  if (endpoint) mach_port_deallocate(mach_task_self(), endpoint);
  endpoint = MACH_PORT_NULL;
  root = nullptr;
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  if (lifetime) {
    dispatch_source_cancel(lifetime);
    dispatch_release(lifetime);
    lifetime = nullptr;
  }
  [child release]; child = nil;
  [content release]; content = nil;
  widget = nullptr;
  if (window && objc_getAssociatedObject(window, &sProfileSourceKey) == self)
    objc_setAssociatedObject(window, &sProfileSourceKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  window = nil;
  // This is source retirement, not a quit request or evidence of child exit.
}
- (void)windowClosed:(NSNotification*)notification {
  if (notification.object == window) [self invalidate];
}
@end

static char sProfileControlKey;
// One control owner on the exact early-role window, before/after StartSource.
// This is not a second resident or observation owner.
@interface ZenProfileControl : NSObject {
 @public
  NSWindow* window;
  nsCOMPtr<mozIDOMWindowProxy> dom;
  nsCOMPtr<nsIWidget> widget;
  RefPtr<mozilla::layers::NativeLayerRootCA> root;
  NSView* child;
  NSView* content;
  NSView* childParent;
  nsCOMPtr<nsIObserver> listener;
  nsCString service;
  ProfileDirectory profile;
  StartupExpectation startupExpectation;
  bool startup, attached;
  uint32_t parentPID;
  uint64_t owner, token;
  Identity identity, quitIdentity;
  mach_port_t receivePort, endpoint;
  dispatch_source_t receiver, lifetime;
  ControlClock::time_point deadline;
  uint32_t helloSends, registeredSends;
  QuitSequence quit;
  bool cleanupOnly, invalid, bootstrapped, receiveSend, callbackActive, receiveDrained;
}
- (BOOL)valid;
- (void)invalidate;
- (void)retire;
- (void)tick;
- (void)startupHello;
- (void)hello;
- (void)sendRegistered;
- (void)receive;
- (void)handle:(mach_msg_header_t*)header capacity:(size_t)capacity;
- (void)reply;
- (void)windowClosed:(NSNotification*)notification;
@end

static ZenProfileControl* sStartupControl; // Owns the same later window control, including its tombstone.

@implementation ZenProfileControl
- (BOOL)valid {
  if (startup) {
    if (invalid || (cleanupOnly && !attached) || uint32_t(getppid()) != parentPID ||
        !ControlEndpointAlive(endpoint) || !receiveSend || !receivePort) return NO;
    if (!attached) return ControlClock::now() < deadline &&
        (!bootstrapped || ValidStartupExpectation(startupExpectation));
    if (!CurrentStartupLocal(startupExpectation.local)) return NO;
  }
  auto* cocoa = window ? CocoaWidget(window, widget) : nullptr;
  if (invalid || !window || window.contentView != content || child.window != window ||
      child.superview != childParent || !widget ||
      widget->GetNativeData(NS_NATIVE_WINDOW) != window ||
      widget->GetNativeData(NS_NATIVE_WIDGET) != child || !cocoa ||
      !cocoa->IsProfileHostSource() || cocoa->GetNativeLayerRoot() != root.get() ||
      uint32_t(getppid()) != parentPID || !ControlEndpointAlive(endpoint) ||
      !CurrentProfile(profile)) return NO;
  if (identity.Valid() && !cleanupOnly) {
    ZenProfileSource* staged = (ZenProfileSource*)objc_getAssociatedObject(window, &sProfileSourceKey);
    if (!staged || ![staged valid] || !staged->observing || !(staged->identity == identity)) return NO;
  }
  return YES;
}
- (void)invalidate {
  if (invalid) return;
  nsAutoRetainCocoaObject hold(self);
  invalid = true;
  // Stop only this control's exact staging owner, never an unrelated source.
  ZenProfileSource* staged = window ? (ZenProfileSource*)objc_getAssociatedObject(window, &sProfileSourceKey) : nil;
  if (staged && identity.Valid() && staged->identity == identity) [staged invalidate];
  if (!startup || attached) [[NSNotificationCenter defaultCenter] removeObserver:self];
  if (lifetime) { dispatch_source_cancel(lifetime); dispatch_release(lifetime); lifetime = nullptr; }
  if (receiveSend) mach_port_deallocate(mach_task_self(), receivePort);
  receiveSend = false;
  if (receiver) {
    dispatch_source_cancel(receiver); dispatch_release(receiver); receiver = nullptr;
  } else if (receivePort) {
    mach_port_mod_refs(mach_task_self(), receivePort, MACH_PORT_RIGHT_RECEIVE, -1);
  }
  receivePort = MACH_PORT_NULL;
  if (endpoint) mach_port_deallocate(mach_task_self(), endpoint);
  endpoint = MACH_PORT_NULL;
  if (startup) { cleanupOnly = true; token = 0; startupExpectation = {}; }
  // Keep the invalid association as a one-owner tombstone until window death.
  // In particular a veto after retirement must not make this resident adoptable.
  window = nil; dom = nullptr; widget = nullptr; root = nullptr; listener = nullptr;
  [child release]; child = nil; [content release]; content = nil;
}
- (void)retire {
  if (invalid) return;
  nsAutoRetainCocoaObject hold(self);
  nsCOMPtr<nsIObserver> callback = listener;
  const bool inQuit = quit.pending || callbackActive;
  [self invalidate];
  // Retire first; modal/synchronous JS may close the source and reenter native.
  // A veto leaves the early-role window hidden/resident, never adoptable.
  if (!inQuit && (!startup || attached)) NotifyControl(callback, "zen-profile-host-normal-quit", "0"_ns);
}
- (void)windowClosed:(NSNotification*)notification {
  if (notification.object == window) [self retire];
}
- (void)startupHello {
  if (!startup || ![self valid] || bootstrapped || helloSends >= 50 || ControlClock::now() >= deadline) return;
  StartupHelloRecord p{}; p.pid = uint32_t(getpid()); p.owner = owner;
  p.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
  p.header.msgh_size = sizeof(p); p.header.msgh_remote_port = endpoint;
  p.header.msgh_id = kStartupHelloMessage; p.body.msgh_descriptor_count = 1;
  p.control.name = receivePort; p.control.type = MACH_MSG_PORT_DESCRIPTOR;
  p.control.disposition = MACH_MSG_TYPE_COPY_SEND;
  ++helloSends; (void)SendControlMessage(&p.header);
}
- (void)hello {
  if (startup) return;
  if (![self valid] || bootstrapped || helloSends >= 50 || ControlClock::now() >= deadline) return;
  HelloRecord p{};
  p.pid = uint32_t(getpid()); p.owner = owner; p.profile = profile;
  p.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
  p.header.msgh_size = sizeof(p); p.header.msgh_remote_port = endpoint; p.header.msgh_id = kHelloMessage;
  p.body.msgh_descriptor_count = 1;
  // Keep one explicit local send reference for the owner's entire lifetime.
  p.control.name = receivePort; p.control.type = MACH_MSG_PORT_DESCRIPTOR;
  p.control.disposition = MACH_MSG_TYPE_COPY_SEND;
  ++helloSends;
  (void)SendControlMessage(&p.header);
}
- (void)sendRegistered {
  if (![self valid] || cleanupOnly || !identity.Valid() || registeredSends >= 50 ||
      ControlClock::now() >= deadline) return;
  RegisteredRecord p{}; p.owner = owner; p.identity = identity; p.profile = profile;
  ++registeredSends;
  (void)SendControl(p, endpoint, kRegisteredMessage);
}
- (void)tick {
  nsAutoRetainCocoaObject hold(self);
  if (![self valid]) { [self retire]; return; }
  if (!bootstrapped) {
    if (ControlClock::now() >= deadline) { [self retire]; return; }
    [self hello];
  } else if (!cleanupOnly) {
    [self sendRegistered];
  }
}
- (void)reply {
  if (invalid || !bootstrapped || quit.pending || !quit.request) return;
  QuitReplyRecord p{};
  p.owner = owner; p.request = quit.request; p.identity = quitIdentity; p.status = quit.status;
  (void)SendControl(p, endpoint, kQuitReplyMessage);
}
- (void)handle:(mach_msg_header_t*)header capacity:(size_t)capacity {
  nsAutoRetainCocoaObject hold(self);
  Received rights(header, capacity);
  if (![self valid] || !ParentAuthenticated(parentPID, uint32_t(getppid()), AuditPID(header, capacity))) return;
  if (startup && StartupLayout<StartupBindingRecord>(header, capacity, kStartupBindingMessage)) {
    const auto& p = *reinterpret_cast<const StartupBindingRecord*>(header);
    if (p.owner != owner) return;
    if (!p.token || p.cleanupOnly > 1 || !ValidStartupExpectation(p.expectation) ||
        (!attached && ControlClock::now() >= deadline) || !ControlEndpointAlive(p.host.name) ||
        (bootstrapped && (token != p.token || endpoint != p.host.name ||
          !SameStartupExpectation(startupExpectation, p.expectation)))) { [self retire]; return; }
    if (p.cleanupOnly) {
      cleanupOnly = true;
      if (!attached) { [self retire]; return; }
      // Cleanup ends staging, not the attached owner's normal-quit transport.
      ZenProfileSource* staged = (ZenProfileSource*)objc_getAssociatedObject(window, &sProfileSourceKey);
      if (staged && identity.Valid() && staged->identity == identity) [staged invalidate];
      return;
    }
    if (!bootstrapped) {
      if (mach_port_mod_refs(mach_task_self(), p.host.name, MACH_PORT_RIGHT_SEND, 1) != KERN_SUCCESS) {
        [self retire]; return;
      }
      mach_port_deallocate(mach_task_self(), endpoint);
      endpoint = p.host.name; startupExpectation = p.expectation; profile = p.expectation.root;
      token = p.token; bootstrapped = true;
    }
    return; // Authentication alone never starts observation or sends Registered.
  }
  if (!startup && ControlLayout<BootstrapRecord>(header, capacity, kBootstrapMessage)) {
    const auto& p = *reinterpret_cast<const BootstrapRecord*>(header);
    if (p.owner != owner || !p.token || p.cleanupOnly > 1 ||
        (bootstrapped && p.token != token) || (!bootstrapped && ControlClock::now() >= deadline)) return;
    token = p.token;
    cleanupOnly |= bool(p.cleanupOnly); // Never loosen after cancellation.
    if (bootstrapped) {
      if (cleanupOnly && identity.Valid()) {
        ZenProfileSource* staged = (ZenProfileSource*)objc_getAssociatedObject(window, &sProfileSourceKey);
        if (staged && staged->identity == identity) [staged invalidate];
      }
      [self sendRegistered]; return;
    }
    bootstrapped = true;
    identity = Identity{uint32_t(getpid()), token, 0, 0, 0};
    if (cleanupOnly) return; // NormalQuit works without starting observation.
    nsAutoCString tokenText, descriptor; tokenText.AppendInt(token);
    if (NS_FAILED(zen::profilehost::StartSource(dom, parentPID, service, tokenText, descriptor))) {
      [self retire]; return;
    }
    ZenProfileSource* staged = (ZenProfileSource*)objc_getAssociatedObject(window, &sProfileSourceKey);
    if (!staged || ![staged valid] || staged->root != root || staged->widget != widget) {
      [self retire]; return;
    }
    identity = staged->identity;
    if (![self valid]) { [self retire]; return; }
    [self sendRegistered]; return;
  }
  if (ControlLayout<QuitRecord>(header, capacity, kNormalQuitMessage)) {
    const auto& p = *reinterpret_cast<const QuitRecord*>(header);
    const Identity preStaging{uint32_t(getpid()), token, 0, 0, 0};
    if (!bootstrapped || callbackActive || p.owner != owner ||
        (!(p.identity == identity) && !(cleanupOnly && p.identity == preStaging))) return;
    if (p.request == quit.request && !(p.identity == quitIdentity)) return;
    const QuitAction action = quit.Begin(p.request);
    if (action == QuitAction::Cached) { [self reply]; return; }
    if (action != QuitAction::Start) return;
    quitIdentity = p.identity;
    nsCOMPtr<nsIObserver> callback = listener;
    nsAutoCString request; request.AppendInt(p.request);
    callbackActive = true;
    NotifyControl(callback, "zen-profile-host-normal-quit", request);
    callbackActive = false;
    if (invalid) return;
    if (![self valid]) { [self retire]; return; }
    // Listener must synchronously reply. Missing/failed implementations are finite.
    if (quit.pending) quit.Complete(p.request, QuitStatus::NotAvailable);
    [self reply];
  }
}
- (void)receive {
  nsAutoRetainCocoaObject hold(self);
  receiveDrained = false;
  if (![self valid]) { [self retire]; return; }
  for (int batch = 0; batch < 16; ++batch) {
    union Buffer { StartupBindingRecord record; unsigned char bytes[sizeof(StartupBindingRecord) + MAX_TRAILER_SIZE]; } buffer{};
    auto result = mach_msg(&buffer.record.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT |
        MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
        MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
        0, sizeof(buffer), receivePort, 0, MACH_PORT_NULL);
    if (result == MACH_RCV_TIMED_OUT) { receiveDrained = true; break; }
    if (result == MACH_RCV_TOO_LARGE) continue;
    if (result != KERN_SUCCESS) {
      if ((result & ~MACH_MSG_MASK) == MACH_RCV_BODY_ERROR) {
        Received partial(&buffer.record.header, sizeof(buffer));
      }
      [self retire]; return;
    }
    [self handle:&buffer.record.header capacity:sizeof(buffer)];
    if (invalid) return;
    if (![self valid]) { [self retire]; return; }
  }
}
@end

namespace zen::profilehost {
static nsresult Resolve(mozIDOMWindowProxy* dom, NSWindow** native,
                        nsCOMPtr<nsIWidget>& widget) {
  *native = nil;
  if (!NS_IsMainThread()) return NS_ERROR_NOT_AVAILABLE;
  if (!dom) return NS_ERROR_INVALID_ARG;
  auto* outer = nsGlobalWindowOuter::Cast(dom);
  if (!outer || outer->GetClosedOuter() || !outer->IsChromeWindow())
    return NS_ERROR_INVALID_ARG;
  widget = mozilla::widget::WidgetUtils::DOMWindowToWidget(outer);
  if (!widget) return NS_ERROR_INVALID_ARG;
  NSWindow* window = (NSWindow*)widget->GetNativeData(NS_NATIVE_WINDOW);
  NSView* child = (NSView*)widget->GetNativeData(NS_NATIVE_WIDGET);
  if (!window || !child || child.window != window || !window.contentView ||
      [window isKindOfClass:[NSPanel class]] ||
      !(window.styleMask & NSWindowStyleMaskTitled)) return NS_ERROR_INVALID_ARG;
  *native = window;
  return NS_OK;
}

static bool Decimal(const nsACString& text, uint64_t* value) {
  if (text.IsEmpty() || text.Length() > 20 || text.First() == '0') return false;
  uint64_t n = 0;
  for (uint32_t i = 0; i < text.Length(); ++i) {
    char c = text.CharAt(i);
    if (c < '0' || c > '9' ||
        n > (std::numeric_limits<uint64_t>::max() - uint64_t(c - '0')) / 10)
      return false;
    n = n * 10 + uint64_t(c - '0');
  }
  *value = n;
  return true;
}
static bool PrefsAggregateLimit(const nsACString& text, uint64_t* value) {
  if (text.EqualsLiteral("0")) { *value = 0; return true; }
  return Decimal(text, value);
}

static bool StartupService(const nsACString& service) {
  if (service.IsEmpty() || service.Length() >= BOOTSTRAP_MAX_NAME_LEN ||
      !StringBeginsWith(service, "org.zen.profilehost."_ns)) return false;
  for (uint32_t i = 0; i < service.Length(); ++i) {
    const char c = service.CharAt(i);
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '.' || c == '-')) return false;
  }
  return true;
}
nsresult AuthenticateStartupWorker(uint32_t parentPID, const nsACString& service) {
  if (!pthread_main_np()) return NS_ERROR_NOT_AVAILABLE;
  if (sStartupControl) return NS_ERROR_ALREADY_INITIALIZED;
  if (!ParentAuthenticated(parentPID, uint32_t(getppid()), parentPID) || !StartupService(service))
    return NS_ERROR_INVALID_ARG;
  ZenProfileControl* control = [[ZenProfileControl alloc] init];
  sStartupControl = control;
  control->startup = true; control->parentPID = parentPID; control->service = service;
  arc4random_buf(&control->owner, sizeof(control->owner));
  control->deadline = ControlClock::now() + std::chrono::seconds(5);
  auto fail = [&]() { [control invalidate]; return NS_ERROR_NOT_AVAILABLE; };
  if (!control->owner) return fail();
  if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &control->receivePort) != KERN_SUCCESS ||
      mach_port_insert_right(mach_task_self(), control->receivePort, control->receivePort,
                             MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS) return fail();
  control->receiveSend = true;
  if (bootstrap_look_up(bootstrap_port, const_cast<char*>(control->service.get()), &control->endpoint) != KERN_SUCCESS)
    return fail();
  for (uint32_t attempt = 0; attempt < 50 && !control->bootstrapped; ++attempt) {
    if (![control valid]) return fail();
    [control startupHello];
    union Buffer { StartupBindingRecord record; unsigned char bytes[sizeof(StartupBindingRecord) + MAX_TRAILER_SIZE]; } buffer{};
    const auto result = mach_msg(&buffer.record.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT |
        MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
        MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
        0, sizeof(buffer), control->receivePort, 100, MACH_PORT_NULL);
    if (result == MACH_RCV_TIMED_OUT || result == MACH_RCV_TOO_LARGE) continue;
    if (result != KERN_SUCCESS) {
      if ((result & ~MACH_MSG_MASK) == MACH_RCV_BODY_ERROR) {
        Received partial(&buffer.record.header, sizeof(buffer));
      }
      return fail();
    }
    [control handle:&buffer.record.header capacity:sizeof(buffer)];
  }
  return control->bootstrapped && [control valid] ? NS_OK : fail();
}
nsresult GetAuthenticatedStartupBinding(StartupExpectation& out) {
  out = {};
  if (!pthread_main_np() || !sStartupControl || !sStartupControl->bootstrapped) return NS_ERROR_NOT_AVAILABLE;
  [sStartupControl receive];
  // Cleanup cannot publish a snapshot; an undrained batch must not kill its quit owner.
  if (sStartupControl->cleanupOnly) return NS_ERROR_NOT_AVAILABLE;
  if (!sStartupControl->receiveDrained || ![sStartupControl valid]) {
    [sStartupControl invalidate]; return NS_ERROR_NOT_AVAILABLE;
  }
  out = sStartupControl->startupExpectation;
  return NS_OK;
}
nsresult AbandonStartupWorker() {
  if (!pthread_main_np() || !sStartupControl) return NS_ERROR_NOT_AVAILABLE;
  [sStartupControl invalidate];
  return NS_OK;
}
nsresult PrepareStartupWorker(mozIDOMWindowProxy* dom, nsIFile* authority,
    nsIFile* root, nsIFile* local, const nsACString& name, const nsACString& path,
    const nsACString& isRelative, bool storeIDPresent, const nsACString& storeID,
    bool showSelectorPresent, const nsACString& showSelector,
    const nsACString& prefsAggregateLimit, nsIObserver* listener) {
  NSWindow* window; nsCOMPtr<nsIWidget> widget;
  nsresult rv = Resolve(dom, &window, widget);
  if (NS_FAILED(rv)) return rv;
  ZenProfileHost* host = (ZenProfileHost*)objc_getAssociatedObject(window, &sProfileHostKey);
  if (!host || ![host valid] || !listener) return NS_ERROR_NOT_AVAILABLE;
  if (host->prefsPreparing || host->worker.prepared || host->gate.Owner().Valid())
    return NS_ERROR_ALREADY_INITIALIZED;
  nsAutoRetainCocoaObject hold(host);
  host->prefsPreparing = true;
  struct Phase {
    bool& active;
    ~Phase() { active = false; }
  } phase{host->prefsPreparing};
  uint64_t limit;
  if (!PrefsAggregateLimit(prefsAggregateLimit, &limit)) return NS_ERROR_INVALID_ARG;
  StartupExpectation expectation{};
  nsCOMPtr<nsIFile> authorityClone, rootClone, localClone;
  if (!SetStartupBytes(expectation.name, true, name.BeginReading(), name.Length()) ||
      !SetStartupBytes(expectation.path, true, path.BeginReading(), path.Length()) ||
      !SetStartupBytes(expectation.isRelative, true, isRelative.BeginReading(), isRelative.Length()) ||
      !SetStartupBytes(expectation.storeID, storeIDPresent, storeID.BeginReading(), storeID.Length()) ||
      !SetStartupBytes(expectation.showSelector, showSelectorPresent, showSelector.BeginReading(), showSelector.Length()) ||
      !CloneStartupDirectory(authority, authorityClone, expectation.authority) ||
      !CloneStartupDirectory(root, rootClone, expectation.root) ||
      !CloneStartupDirectory(local, localClone, expectation.local) ||
      !CaptureStartupRegistry(authorityClone, expectation) || !ValidStartupSelection(expectation))
    return NS_ERROR_INVALID_ARG;
  // Acquire services before parsing. The private synchronous observer cannot
  // dispatch script, notify, recurse, or pump an event loop.
  PrefsFailure failure;
  std::unique_ptr<PrefsInputSnapshot> input(new (std::nothrow) PrefsInputSnapshot());
  nsCOMPtr<nsIPrefService> prefs = do_GetService(NS_PREFSERVICE_CONTRACTID, &rv);
  if (NS_SUCCEEDED(rv) && !prefs) rv = NS_ERROR_NOT_AVAILABLE;
  if (NS_SUCCEEDED(rv) && !input) rv = NS_ERROR_OUT_OF_MEMORY;
  if (NS_SUCCEEDED(rv)) rv = CapturePrefsInput(rootClone, expectation.root, limit, *input, failure);
  if (NS_SUCCEEDED(rv)) rv = ParsePrefsInput(prefs, *input, failure);
  if (NS_SUCCEEDED(rv)) {
    expectation.prefsSupplied = 1;
    expectation.prefsAggregateLimit = input->limit;
    for (size_t i = 0; i < 2; ++i) {
      const auto& file = input->files[i];
      auto& metadata = expectation.prefsFiles[i];
      if (file.sha256.Length() != sizeof(metadata.sha256)) {
        rv = NS_ERROR_FILE_CORRUPTED; break;
      }
      // Capture hashes absent empty input too (SHA256(empty)). Translate its
      // private digest to canonical zero wire fields; present-empty keeps it.
      if (file.present) {
        metadata.present = 1; metadata.length = file.raw.Length();
        metadata.device = file.device; metadata.inode = file.inode;
        memcpy(metadata.sha256, file.sha256.BeginReading(), sizeof(metadata.sha256));
      }
    }
    if (NS_SUCCEEDED(rv) && !ValidStartupExpectation(expectation)) rv = NS_ERROR_FILE_CORRUPTED;
  }
  if (NS_FAILED(rv)) {
    PrefsRefuse(failure, rv);
    host->prefsFailure = std::move(failure);
    const nsresult original = rv;
    // Retain original raw diagnostic privately before script-capable reporting.
    // No raw input/records are logged or sent; owner is held and reentry refused.
    nsAutoCString data;
    data.AppendInt(uint32_t(original)); data.Append(':');
    data.AppendInt(host->prefsFailure.io); data.Append(':');
    data.AppendInt(uint32_t(host->prefsFailure.parserCopyFailed)); data.Append(':');
    data.Append(host->prefsFailure.parser);
    NotifyControl(listener, "zen-profile-host-prefs-input-error", data);
    return original;
  }
  if (![host valid] || objc_getAssociatedObject(window, &sProfileHostKey) != host ||
      host->worker.prepared || host->gate.Owner().Valid()) return NS_ERROR_NOT_AVAILABLE;
  ProfileDirectory recheck;
  if (!CaptureDirectory(rootClone, recheck) || !SameProfileDirectory(expectation.root, recheck) ||
      !CaptureDirectory(localClone, recheck) || !SameProfileDirectory(expectation.local, recheck))
    return NS_ERROR_NOT_AVAILABLE;
  if (mach_port_insert_right(mach_task_self(), host->port, host->port, MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS)
    return NS_ERROR_NOT_AVAILABLE;
  host->prefsInput = std::move(input);
  host->prefsFailure = {};
  host->startupSend = true; host->startupPrepared = true; host->startupExpectation = expectation;
  host->worker.Prepare(expectation.root);
  host->expectedDirectory = rootClone; host->startupAuthority = authorityClone;
  host->startupLocal = localClone; host->listener = listener;
  return NS_OK;
}

nsresult PrepareWorker(mozIDOMWindowProxy* dom, nsIFile* expected, nsIObserver* listener) {
  NSWindow* window; nsCOMPtr<nsIWidget> widget;
  nsresult rv = Resolve(dom, &window, widget);
  if (NS_FAILED(rv)) return rv;
  ZenProfileHost* host = (ZenProfileHost*)objc_getAssociatedObject(window, &sProfileHostKey);
  if (!host || ![host valid] || !listener) return NS_ERROR_NOT_AVAILABLE;
  if (host->prefsPreparing || host->worker.prepared || host->gate.Owner().Valid())
    return NS_ERROR_ALREADY_INITIALIZED;
  nsCOMPtr<nsIFile> captured;
  ProfileDirectory profile;
  if (!expected || NS_FAILED(expected->Clone(getter_AddRefs(captured))) ||
      !CaptureDirectory(captured, profile)) return NS_ERROR_INVALID_ARG;
  if (!host->worker.Prepare(profile)) return NS_ERROR_ALREADY_INITIALIZED;
  host->expectedDirectory = captured; host->listener = listener;
  return NS_OK;
}
nsresult BindWorker(mozIDOMWindowProxy* dom, uint32_t ownedPID, bool cleanupOnly) {
  NSWindow* window; nsCOMPtr<nsIWidget> widget;
  nsresult rv = Resolve(dom, &window, widget);
  if (NS_FAILED(rv)) return rv;
  ZenProfileHost* host = (ZenProfileHost*)objc_getAssociatedObject(window, &sProfileHostKey);
  if (!host || ![host workerCurrent]) return NS_ERROR_NOT_AVAILABLE;
  // Caller must retain the real returned Subprocess handle and its wait. Native
  // controls admission only; it cannot prove handle ownership from this PID.
  nsAutoRetainCocoaObject hold(host);
  if (host->prefsPreparing) return NS_ERROR_ALREADY_INITIALIZED;
  if (host->startupPrepared && !host->worker.pid &&
      !cleanupOnly && !host->worker.cleanupOnly) {
    if (!host->prefsInput) return NS_ERROR_NOT_AVAILABLE;
    host->prefsPreparing = true;
    struct Phase {
      bool& active;
      ~Phase() { active = false; }
    } phase{host->prefsPreparing};
    PrefsInputSnapshot fresh;
    host->prefsFailure = {};
    rv = CapturePrefsInput(host->expectedDirectory, host->worker.profile,
                           host->prefsInput->limit, fresh, host->prefsFailure);
    if (NS_FAILED(rv)) return rv;
    if (!SamePrefsInput(*host->prefsInput, fresh))
      return PrefsRefuse(host->prefsFailure, NS_ERROR_FILE_CORRUPTED);
    if (![host workerCurrent] || objc_getAssociatedObject(window, &sProfileHostKey) != host ||
        host->worker.pid) return NS_ERROR_NOT_AVAILABLE;
    // Compare ORIGINAL bytes/absence once, immediately before first Bind.
    // Sequential reads are not an atomic pair or normal-consumer pinned bytes.
    // Post-bind writes must not retire the running worker/normal-Quit owner.
  }
  if (ownedPID == uint32_t(getpid()) || !host->worker.Bind(ownedPID, cleanupOnly))
    return NS_ERROR_INVALID_ARG;
  return NS_OK;
}
nsresult CleanupWorker(mozIDOMWindowProxy* dom) {
  NSWindow* window; nsCOMPtr<nsIWidget> widget;
  nsresult rv = Resolve(dom, &window, widget);
  if (NS_FAILED(rv)) return rv;
  ZenProfileHost* host = (ZenProfileHost*)objc_getAssociatedObject(window, &sProfileHostKey);
  if (!host || ![host valid] || !host->worker.prepared) return NS_ERROR_NOT_AVAILABLE;
  host->worker.Tighten(); host->gate.ReturnLocal();
  [host bootstrap];
  return NS_OK;
}
nsresult ConnectSource(mozIDOMWindowProxy* dom, uint32_t parentPID,
                       const nsACString& service, nsIObserver* listener) {
  NSWindow* window; nsCOMPtr<nsIWidget> widget;
  nsresult rv = Resolve(dom, &window, widget);
  if (NS_FAILED(rv)) return rv;
  if (!listener || !ParentAuthenticated(parentPID, uint32_t(getppid()), parentPID) ||
      service.IsEmpty() || service.Length() >= BOOTSTRAP_MAX_NAME_LEN ||
      service.FindChar('\0') != kNotFound ||
      !StringBeginsWith(service, "org.zen.profilehost."_ns)) return NS_ERROR_INVALID_ARG;
  // The host service grammar is ASCII only; never let UTF-8 conversion truncate.
  for (uint32_t i = 0; i < service.Length(); ++i) {
    char c = service.CharAt(i);
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '.' || c == '-')) return NS_ERROR_INVALID_ARG;
  }
  auto* cocoa = CocoaWidget(window, widget);
  auto* nativeRoot = cocoa ? cocoa->GetNativeLayerRoot() : nullptr;
  auto* root = nativeRoot ? nativeRoot->AsNativeLayerRootCA() : nullptr;
  if (!cocoa || !cocoa->IsProfileHostSource() || !root) return NS_ERROR_NOT_AVAILABLE;
  if (objc_getAssociatedObject(window, &sProfileControlKey) ||
      objc_getAssociatedObject(window, &sProfileSourceKey)) return NS_ERROR_ALREADY_INITIALIZED;
  nsCOMPtr<nsIFile> selected;
  ProfileDirectory profile;
  if (NS_FAILED(NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR, getter_AddRefs(selected))) ||
      !CaptureDirectory(selected, profile)) return NS_ERROR_NOT_AVAILABLE;
  ZenProfileControl* control;
  if (sStartupControl) {
    StartupExpectation expectation;
    if (sStartupControl->attached) return NS_ERROR_ALREADY_INITIALIZED;
    if (NS_FAILED(GetAuthenticatedStartupBinding(expectation)) || sStartupControl->parentPID != parentPID ||
        !sStartupControl->service.Equals(service) || !SameProfileDirectory(expectation.root, profile) ||
        !CurrentStartupLocal(expectation.local)) return NS_ERROR_NOT_AVAILABLE;
    control = [sStartupControl retain];
  } else {
    control = [[ZenProfileControl alloc] init];
  }
  control->window = window; control->dom = dom; control->widget = widget; control->root = root;
  control->child = [(NSView*)widget->GetNativeData(NS_NATIVE_WIDGET) retain];
  control->childParent = control->child.superview; control->content = [window.contentView retain];
  control->parentPID = parentPID; control->service = service; control->profile = profile;
  control->listener = listener;
  if (!control->startup) {
    do { arc4random_buf(&control->owner, sizeof(control->owner)); } while (!control->owner);
  }
  control->deadline = ControlClock::now() + std::chrono::seconds(5);
  control->attached = true;
  auto fail = [&]() { [control invalidate]; [control release]; return NS_ERROR_NOT_AVAILABLE; };
  if (!control->startup) {
    if (bootstrap_look_up(bootstrap_port, const_cast<char*>(control->service.get()), &control->endpoint) != KERN_SUCCESS)
      return fail();
    if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &control->receivePort) != KERN_SUCCESS)
      return fail();
    if (mach_port_insert_right(mach_task_self(), control->receivePort, control->receivePort,
                              MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS) return fail();
    control->receiveSend = true;
  }
  control->receiver = dispatch_source_create(DISPATCH_SOURCE_TYPE_MACH_RECV, control->receivePort, 0,
                                              dispatch_get_main_queue());
  if (!control->receiver) return fail();
  mach_port_t ownedPort = control->receivePort;
  dispatch_source_set_cancel_handler(control->receiver, ^{
    mach_port_mod_refs(mach_task_self(), ownedPort, MACH_PORT_RIGHT_RECEIVE, -1);
  });
  dispatch_source_set_event_handler(control->receiver, ^{ [control receive]; });
  // Resume before later allocation can fail: cancelling a suspended source does
  // not run its receive-right cancel handler until it has been resumed.
  dispatch_resume(control->receiver);
  control->lifetime = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  if (!control->lifetime) return fail();
  dispatch_source_set_timer(control->lifetime, dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC),
                            100 * NSEC_PER_MSEC, 10 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(control->lifetime, ^{ [control tick]; });
  objc_setAssociatedObject(window, &sProfileControlKey, control, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [[NSNotificationCenter defaultCenter] addObserver:control selector:@selector(windowClosed:)
      name:NSWindowWillCloseNotification object:window];
  dispatch_resume(control->lifetime);
  if (control->startup) {
    nsAutoCString descriptor;
    if (NS_FAILED(StartSource(dom, parentPID, service, EmptyCString(), descriptor))) return fail();
    ZenProfileSource* staged = (ZenProfileSource*)objc_getAssociatedObject(window, &sProfileSourceKey);
    if (!staged || ![staged valid] || staged->root != root || staged->widget != widget) return fail();
    control->identity = staged->identity;
    if (![control valid]) return fail();
    [control sendRegistered];
  } else {
    [control hello];
  }
  [control release];
  return NS_OK;
}
nsresult RequestQuit(mozIDOMWindowProxy* dom, const nsACString& requestText) {
  NSWindow* window; nsCOMPtr<nsIWidget> widget;
  nsresult rv = Resolve(dom, &window, widget);
  if (NS_FAILED(rv)) return rv;
  ZenProfileHost* host = (ZenProfileHost*)objc_getAssociatedObject(window, &sProfileHostKey);
  uint64_t request;
  if (!host || ![host workerCurrent] || !host->worker.owner ||
      (!host->worker.cleanupOnly && !host->worker.identity.Valid())) return NS_ERROR_NOT_AVAILABLE;
  if (!Decimal(requestText, &request)) return NS_ERROR_INVALID_ARG;
  nsAutoRetainCocoaObject hold(host);
  auto action = host->quit.Begin(request);
  if (action == QuitAction::Reject || action == QuitAction::Pending) return NS_ERROR_NOT_AVAILABLE;
  if (action == QuitAction::Cached) {
    nsAutoCString data; data.AppendInt(request); data.Append(':'); data.AppendInt(uint32_t(host->quit.status));
    NotifyControl(host->listener, "zen-profile-host-quit-reply", data);
    return NS_OK;
  }
  host->quitDeadline = ControlClock::now() + std::chrono::seconds(5); host->quitSends = 0;
  [host bootstrap]; // Propagate the monotonic cleanup-only state before Quit.
  [host sendQuit];
  return NS_OK;
}
nsresult ReplyQuit(mozIDOMWindowProxy* dom, const nsACString& requestText, uint32_t status) {
  NSWindow* window; nsCOMPtr<nsIWidget> widget;
  nsresult rv = Resolve(dom, &window, widget);
  if (NS_FAILED(rv)) return rv;
  ZenProfileControl* control = (ZenProfileControl*)objc_getAssociatedObject(window, &sProfileControlKey);
  uint64_t request;
  if (!control || ![control valid] || !Decimal(requestText, &request) ||
      !control->quit.Complete(request, QuitStatus(status))) return NS_ERROR_NOT_AVAILABLE;
  // The receive handler sends after the script-capable callback revalidation.
  return NS_OK;
}

nsresult RequestProducerAck(mozIDOMWindowProxy* dom,
                            mozilla::dom::Element* browser,
                            const nsACString& generationText, JSContext* cx,
                            mozilla::dom::Promise** aPromise) {
  using namespace mozilla;
  using namespace mozilla::dom;
  *aPromise = nullptr;
  if (!NS_IsMainThread() || !nsContentUtils::IsCallerChrome())
    return NS_ERROR_NOT_AVAILABLE;
  nsIGlobalObject* global = xpc::CurrentNativeGlobal(cx);
  if (!global) return NS_ERROR_FAILURE;
  ErrorResult error;
  RefPtr<Promise> promise = Promise::Create(global, error);
  if (error.Failed()) return error.StealNSResult();
  auto refuse = [&](nsresult rv) {
    promise->MaybeReject(rv);
    promise.forget(aPromise);
    return NS_OK;
  };
  NSWindow* window;
  nsCOMPtr<nsIWidget> widget;
  nsresult rv = Resolve(dom, &window, widget);
  if (NS_FAILED(rv)) return refuse(rv);
  uint64_t generation;
  if (!Decimal(generationText, &generation)) return refuse(NS_ERROR_INVALID_ARG);
  ZenProfileSource* source = (ZenProfileSource*)objc_getAssociatedObject(window, &sProfileSourceKey);
  if (!source || ![source valid] || source->identity.generation != generation)
    return refuse(NS_ERROR_NOT_AVAILABLE);
  // Share the existing MRC retain guard across the exclusive async outcome.
  auto sourceHold = std::make_shared<nsAutoRetainCocoaObject>(source);
  RefPtr<nsGlobalWindowOuter> outer = nsGlobalWindowOuter::Cast(dom);
  RefPtr<Document> document = outer->GetDoc();
  RefPtr<Element> element = browser;
  RefPtr<nsFrameLoaderOwner> owner = do_QueryObject(browser);
  RefPtr<nsFrameLoader> frameLoader = owner ? owner->GetFrameLoader() : nullptr;
  RefPtr<BrowserParent> parent = frameLoader ? frameLoader->GetBrowserParent() : nullptr;
  RefPtr<CanonicalBrowsingContext> bc = parent ? parent->GetBrowsingContext() : nullptr;
  RefPtr<WindowGlobalParent> inner = bc ? bc->GetCurrentWindowGlobal() : nullptr;
  RefPtr<ContentParent> contentParent = parent ? parent->Manager() : nullptr;
  RefPtr<layers::NativeLayerRootCA> root = source->root;
  if (!document || !element || !frameLoader || !parent || !bc || !inner ||
      !contentParent || !root) return refuse(NS_ERROR_NOT_AVAILABLE);
  const uint64_t innerId = inner->InnerWindowId();
  const uint64_t contentId = contentParent->ChildID();
  const auto tabId = parent->GetTabId();
  const auto layersId = parent->GetLayersId();
  const Identity identity = source->identity;
  auto current = [outer, document, element, owner, frameLoader, parent, bc,
                  inner, contentParent, widget, root, sourceHold, source,
                  window, identity, innerId, contentId, tabId, layersId]() {
    NSWindow* liveWindow;
    nsCOMPtr<nsIWidget> liveWidget;
    RefPtr<nsFrameLoader> liveFrameLoader = owner->GetFrameLoader();
    nsCOMPtr<nsIWidget> parentWidget = parent->GetWidget();
    return NS_SUCCEEDED(Resolve(outer, &liveWindow, liveWidget)) &&
        liveWindow == window && liveWidget == widget && !widget->Destroyed() &&
        objc_getAssociatedObject(liveWindow, &sProfileSourceKey) == source &&
        [source valid] && source->observing && source->widget == widget &&
        source->root == root && source->identity.generation == identity.generation &&
        source->identity.widget == identity.widget && source->identity.root == identity.root &&
        identity.widget == uint64_t(reinterpret_cast<uintptr_t>(widget.get())) &&
        identity.root == uint64_t(reinterpret_cast<uintptr_t>(root.get())) &&
        outer->GetDoc() == document && element->OwnerDoc() == document &&
        element->IsInComposedDoc() && liveFrameLoader == frameLoader &&
        frameLoader->GetOwnerContent() == element &&
        frameLoader->GetExtantBrowsingContext() == bc &&
        frameLoader->GetBrowserParent() == parent && parent->CanSend() &&
        parent->GetOwnerElement() == element && parentWidget == widget &&
        parent->GetBrowsingContext() == bc && bc->GetCurrentWindowGlobal() == inner &&
        inner->CanSend() && inner->IsCurrentGlobal() && inner->GetBrowserParent() == parent &&
        inner->GetBrowsingContext() == bc && inner->GetContentParent() == contentParent &&
        parent->Manager() == contentParent && contentParent->ChildID() == contentId &&
        inner->InnerWindowId() == innerId && parent->GetTabId() == tabId &&
        parent->GetLayersId() == layersId && innerId && contentId && uint64_t(tabId) &&
        uint64_t(layersId) && identity.widget && identity.root && identity.generation;
  };
  if (!current()) return refuse(NS_ERROR_NOT_AVAILABLE);
  RefPtr<PresShell> shell = document->GetPresShell();
  if (!shell || shell->IsDestroying()) return refuse(NS_ERROR_NOT_AVAILABLE);
  shell->FlushDelayedResize();
  if (!current() || document->GetPresShell() != shell || shell->IsDestroying())
    return refuse(NS_ERROR_NOT_AVAILABLE);
  document->FlushPendingNotifications(ChangesToFlush(FlushType::Layout, false, true));
  if (!current() || document->GetPresShell() != shell || shell->IsDestroying())
    return refuse(NS_ERROR_NOT_AVAILABLE);
  const auto dimensions = parent->GetDimensionInfo();
  const double defaultScale = widget->GetDefaultScale().scale;
  const double desktopScale = widget->GetDesktopToDeviceScale().scale;
  if (!std::isfinite(defaultScale) || defaultScale <= 0 ||
      !std::isfinite(desktopScale) || desktopScale <= 0 ||
      dimensions.size().width <= 0 || dimensions.size().height <= 0)
    return refuse(NS_ERROR_NOT_AVAILABLE);
  const auto physical = dimensions.size() * widget->GetDefaultScale();
  if (!std::isfinite(physical.width) || !std::isfinite(physical.height) ||
      physical.width <= 0 || physical.height <= 0 ||
      double(physical.width) > INT32_MAX || double(physical.height) > INT32_MAX)
    return refuse(NS_ERROR_NOT_AVAILABLE);
  const auto size = RoundedToInt(physical);
  parent->ProduceDisplayListForCurrentDimensions(innerId)
      ->Then(GetCurrentSerialEventTarget(), __func__,
          [promise, current, parent, widget, identity, bc, innerId, contentId,
           tabId, layersId, dimensions, defaultScale, desktopScale, size](
              PBrowserParent::ProduceDisplayListPromise::ResolveOrRejectValue&& result) {
            if (result.IsReject() || !current()) {
              promise->MaybeReject(NS_ERROR_NOT_AVAILABLE);
              return;
            }
            const auto now = parent->GetDimensionInfo();
            const auto& ack = result.ResolveValue();
            if (!now.rect().IsEqualEdges(dimensions.rect()) || now.size() != dimensions.size() ||
                now.clientOffset() != dimensions.clientOffset() || now.chromeOffset() != dimensions.chromeOffset() ||
                widget->GetDefaultScale().scale != defaultScale ||
                widget->GetDesktopToDeviceScale().scale != desktopScale ||
                ack.status() != NS_OK || ack.browsingContextId() != bc->Id() ||
                ack.innerWindowId() != innerId || ack.tabId() != uint64_t(tabId) ||
                ack.layersId() != uint64_t(layersId) ||
                ack.pipelineId() != wr::AsUint64(wr::AsPipelineId(layersId)) ||
                !ack.transactionId() || !ack.fwdTransactionId() || !ack.idNamespace() || !ack.epoch() ||
                ack.innerWidthDevicePx() <= 0 || ack.innerHeightDevicePx() <= 0 ||
                ack.innerWidthDevicePx() != size.width || ack.innerHeightDevicePx() != size.height ||
                ack.widgetDefaultScale() != defaultScale || ack.desktopToDeviceScale() != desktopScale ||
                ack.appUnitsPerDevPixel() <= 0) {
              promise->MaybeReject(NS_ERROR_NOT_AVAILABLE);
              return;
            }
            NSString* json = [NSString stringWithFormat:
                @"{\"version\":1,\"status\":\"accepted-producer-only\",\"sourceWidget\":\"%llu\",\"sourceRoot\":\"%llu\",\"sourceGeneration\":\"%llu\",\"browsingContextId\":\"%llu\",\"innerWindowId\":\"%llu\",\"contentParentId\":\"%llu\",\"tabId\":\"%llu\",\"layersId\":\"%llu\",\"pipelineId\":\"%llu\",\"transactionId\":\"%llu\",\"fwdTransactionId\":\"%llu\",\"idNamespace\":\"%u\",\"epoch\":\"%u\",\"innerWidthDevicePx\":%d,\"innerHeightDevicePx\":%d,\"widgetDefaultScale\":%.17g,\"desktopToDeviceScale\":%.17g,\"appUnitsPerDevPixel\":%d}",
                (unsigned long long)identity.widget, (unsigned long long)identity.root,
                (unsigned long long)identity.generation, (unsigned long long)ack.browsingContextId(),
                (unsigned long long)ack.innerWindowId(), (unsigned long long)contentId,
                (unsigned long long)ack.tabId(), (unsigned long long)ack.layersId(),
                (unsigned long long)ack.pipelineId(), (unsigned long long)ack.transactionId(),
                (unsigned long long)ack.fwdTransactionId(), ack.idNamespace(), ack.epoch(),
                ack.innerWidthDevicePx(), ack.innerHeightDevicePx(), ack.widgetDefaultScale(),
                ack.desktopToDeviceScale(), ack.appUnitsPerDevPixel()];
            promise->MaybeResolve(NS_ConvertUTF8toUTF16(json.UTF8String));
          });
  promise.forget(aPromise);
  return NS_OK;
}

nsresult StartSource(mozIDOMWindowProxy* dom, uint32_t parentPID,
                     const nsACString& service, const nsACString& tokenText,
                     nsACString& descriptor) {
  descriptor.Truncate();
  NSWindow* window;
  nsCOMPtr<nsIWidget> widget;
  nsresult rv = Resolve(dom, &window, widget);
  if (NS_FAILED(rv)) return rv;
  ZenProfileControl* control = (ZenProfileControl*)objc_getAssociatedObject(window, &sProfileControlKey);
  const bool startup = control && control->startup;
  uint64_t token = startup ? control->token : 0;
  if ((sStartupControl && control != sStartupControl) ||
      (startup ? (!tokenText.IsEmpty() || !control->attached || !control->bootstrapped || ![control valid])
               : !Decimal(tokenText, &token)) ||
      !WorkerBootstrap(parentPID, uint32_t(getppid()), token) ||
      parentPID > INT32_MAX || service.IsEmpty() ||
      service.Length() >= BOOTSTRAP_MAX_NAME_LEN ||
      service.FindChar('\0') != kNotFound) return NS_ERROR_INVALID_ARG;
  nsCString serviceName(service);
  if (!StringBeginsWith(serviceName, "org.zen.profilehost."_ns))
    return NS_ERROR_INVALID_ARG;
  auto* cocoa = CocoaWidget(window, widget);
  auto* nativeRoot = cocoa ? cocoa->GetNativeLayerRoot() : nullptr;
  if (!cocoa || !cocoa->IsProfileHostSource()) return NS_ERROR_NOT_AVAILABLE;
  auto* root = nativeRoot ? nativeRoot->AsNativeLayerRootCA() : nullptr;
  if (!root) return NS_ERROR_NOT_AVAILABLE;
  ZenProfileSource* existing = (ZenProfileSource*)objc_getAssociatedObject(window, &sProfileSourceKey);
  if (existing) {
    if (![existing valid]) { [existing invalidate]; return NS_ERROR_INVALID_ARG; }
    return NS_ERROR_ALREADY_INITIALIZED;
  }
  // Main-thread-only monotonic generation, not a received frame/request stamp.
  static uint64_t generation = 0;
  if (generation == std::numeric_limits<uint64_t>::max()) return NS_ERROR_NOT_AVAILABLE;
  ZenProfileSource* source = [[ZenProfileSource alloc] init];
  source->window = window;
  source->widget = widget;
  source->root = root;
  source->content = [window.contentView retain];
  source->child = [(NSView*)widget->GetNativeData(NS_NATIVE_WIDGET) retain];
  source->childParent = source->child.superview;
  source->identity = Identity{uint32_t(getpid()), token,
      uint64_t(reinterpret_cast<uintptr_t>(widget.get())),
      uint64_t(reinterpret_cast<uintptr_t>(root)), ++generation};
  kern_return_t result;
  if (control) {
    // Bootstrap authenticated this exact receive owner. Never re-look-up a
    // potentially replaced service and leak token-bearing frames to it.
    if (![control valid] || !control->bootstrapped || control->cleanupOnly ||
        control->token != token || control->parentPID != parentPID ||
        !control->service.Equals(serviceName)) {
      [source invalidate]; [source release]; return NS_ERROR_NOT_AVAILABLE;
    }
    result = mach_port_mod_refs(mach_task_self(), control->endpoint, MACH_PORT_RIGHT_SEND, 1);
    if (result == KERN_SUCCESS) source->endpoint = control->endpoint;
  } else {
    result = bootstrap_look_up(bootstrap_port,
        const_cast<char*>(serviceName.get()), &source->endpoint);
  }
  if (result != KERN_SUCCESS) {
    [source invalidate]; [source release]; return NS_ERROR_NOT_AVAILABLE;
  }
  if (!root->StartStagingObservation(ObserveProfileSource, source)) {
    [source invalidate]; [source release]; return NS_ERROR_ALREADY_INITIALIZED;
  }
  source->observing = true;
  objc_setAssociatedObject(window, &sProfileSourceKey, source, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [[NSNotificationCenter defaultCenter] addObserver:source selector:@selector(windowClosed:)
      name:NSWindowWillCloseNotification object:window];
  source->lifetime = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
                                            dispatch_get_main_queue());
  if (!source->lifetime) {
    [source invalidate]; [source release]; return NS_ERROR_NOT_AVAILABLE;
  }
  dispatch_source_set_timer(source->lifetime,
      dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC),
      100 * NSEC_PER_MSEC, 10 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(source->lifetime, ^{
    if (![source valid]) [source invalidate];
  });
  dispatch_resume(source->lifetime);
  // A privileged controller must obtain these exact native IDs before Admit.
  // The source neither admits itself nor requests readiness/publication/input.
  NSString* json = [NSString stringWithFormat:
      @"{\"status\":\"internal-partial-staging-only\",\"pid\":%u,\"widget\":\"%llu\",\"root\":\"%llu\",\"generation\":\"%llu\"}",
      source->identity.pid, (unsigned long long)source->identity.widget,
      (unsigned long long)source->identity.root,
      (unsigned long long)source->identity.generation];
  descriptor.Assign(json.UTF8String);
  [source release];
  return NS_OK;
}

nsresult StopSource(mozIDOMWindowProxy* dom) {
  NSWindow* window;
  nsCOMPtr<nsIWidget> widget;
  nsresult rv = Resolve(dom, &window, widget);
  if (NS_FAILED(rv)) return rv;
  ZenProfileSource* source = (ZenProfileSource*)objc_getAssociatedObject(window, &sProfileSourceKey);
  if (!source) return NS_ERROR_NOT_AVAILABLE;
  nsAutoRetainCocoaObject hold(source);
  bool valid = [source valid];
  ZenProfileControl* control = (ZenProfileControl*)objc_getAssociatedObject(window, &sProfileControlKey);
  if (control) [control invalidate]; // Explicit retirement is not Quit.
  [source invalidate];
  return valid ? NS_OK : NS_ERROR_INVALID_ARG;
}

nsresult Attach(mozIDOMWindowProxy* dom, nsACString& endpoint) {
  endpoint.Truncate();
  NSWindow* window;
  nsCOMPtr<nsIWidget> widget;
  nsresult rv = Resolve(dom, &window, widget);
  if (NS_FAILED(rv)) return rv;
  ZenProfileHost* existing = (ZenProfileHost*)objc_getAssociatedObject(window, &sProfileHostKey);
  if (existing) {
    if (![existing valid]) { [existing invalidate]; return NS_ERROR_INVALID_ARG; }
    return NS_ERROR_ALREADY_INITIALIZED;
  }
  ZenProfileHost* host = [[ZenProfileHost alloc] init];
  host->window = window;
  host->widget = widget;
  host->content = [window.contentView retain];
  host->child = [(NSView*)widget->GetNativeData(NS_NATIVE_WIDGET) retain];
  host->childParent = host->child.superview;
  do { arc4random_buf(&host->token, sizeof(host->token)); } while (!host->token);
  host->service = [[NSString stringWithFormat:@"org.zen.profilehost.%d.%@",
                    getpid(), NSUUID.UUID.UUIDString] copy];
  if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &host->port) != KERN_SUCCESS) {
    [host invalidate]; [host release]; return NS_ERROR_NOT_AVAILABLE;
  }
  // Keep the own send right only for registration. bootstrap retains its own
  // reference, which is withdrawn on detach; receive ownership stays here.
  if (mach_port_insert_right(mach_task_self(), host->port, host->port,
                            MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS) {
    [host invalidate]; [host release]; return NS_ERROR_NOT_AVAILABLE;
  }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  kern_return_t result = bootstrap_register(bootstrap_port,
      const_cast<char*>(host->service.UTF8String), host->port);
#pragma clang diagnostic pop
  mach_port_deallocate(mach_task_self(), host->port);
  if (result != KERN_SUCCESS) {
    [host invalidate]; [host release]; return NS_ERROR_NOT_AVAILABLE;
  }
  host->registered = true;
  host->source = dispatch_source_create(DISPATCH_SOURCE_TYPE_MACH_RECV,
      host->port, 0, dispatch_get_main_queue());
  if (!host->source) {
    [host invalidate]; [host release]; return NS_ERROR_NOT_AVAILABLE;
  }
  mach_port_t ownedPort = host->port;
  dispatch_source_set_cancel_handler(host->source, ^{
    mach_port_mod_refs(mach_task_self(), ownedPort, MACH_PORT_RIGHT_RECEIVE, -1);
  });
  dispatch_source_set_event_handler(host->source, ^{ [host receive]; });
  host->view = [[ZenProfileHostView alloc] initWithFrame:host->content.bounds];
  host->view.hidden = YES;
  host->view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [host->content addSubview:host->view positioned:NSWindowAbove relativeTo:nil];
  host->view->owner = host;
  objc_setAssociatedObject(window, &sProfileHostKey, host, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [[NSNotificationCenter defaultCenter] addObserver:host selector:@selector(windowClosed:)
      name:NSWindowWillCloseNotification object:window];
  dispatch_resume(host->source);
  // ChildView-only reparent/destruction need not move its sibling overlay.
  // Check idle attachments too; every receive additionally revalidates before
  // decoding. No engine hook, responder change or application loop is installed.
  host->lifetime = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
                                          dispatch_get_main_queue());
  if (!host->lifetime) {
    [host invalidate]; [host release]; return NS_ERROR_NOT_AVAILABLE;
  }
  dispatch_source_set_timer(host->lifetime,
      dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC),
      100 * NSEC_PER_MSEC, 10 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(host->lifetime, ^{ [host tick]; });
  dispatch_resume(host->lifetime);
  // No token logging. Decimal text avoids JS Number precision loss.
  NSString* descriptor = [NSString stringWithFormat:
      @"{\"status\":\"internal-partial-staging-only\",\"service\":\"%@\",\"token\":\"%llu\"}",
      host->service, (unsigned long long)host->token];
  endpoint.Assign(descriptor.UTF8String);
  [host release];
  return NS_OK;
}

nsresult Detach(mozIDOMWindowProxy* dom) {
  NSWindow* window;
  nsCOMPtr<nsIWidget> widget;
  nsresult rv = Resolve(dom, &window, widget);
  if (NS_FAILED(rv)) return rv;
  ZenProfileHost* host = (ZenProfileHost*)objc_getAssociatedObject(window, &sProfileHostKey);
  if (!host) return NS_ERROR_NOT_AVAILABLE;
  bool valid = [host valid];
  [host invalidate];
  return valid ? NS_OK : NS_ERROR_INVALID_ARG;
}

nsresult Admit(mozIDOMWindowProxy* dom, uint32_t workerPID,
               const nsACString& widgetID, const nsACString& rootID,
               const nsACString& generation) {
  NSWindow* window;
  nsCOMPtr<nsIWidget> widget;
  nsresult rv = Resolve(dom, &window, widget);
  if (NS_FAILED(rv)) return rv;
  ZenProfileHost* host = (ZenProfileHost*)objc_getAssociatedObject(window, &sProfileHostKey);
  if (!host) return NS_ERROR_NOT_AVAILABLE;
  if (![host valid]) { [host invalidate]; return NS_ERROR_INVALID_ARG; }
  Identity id{};
  id.pid = workerPID;
  id.token = host->token;
  if (workerPID <= 1 || workerPID > INT32_MAX || workerPID == uint32_t(getpid()) ||
      !Decimal(widgetID, &id.widget) || !Decimal(rootID, &id.root) ||
      !Decimal(generation, &id.generation)) return NS_ERROR_INVALID_ARG;
  if (host->worker.prepared) {
    // Legacy callers may not bypass the authenticated descriptor/cleanup gate.
    return [host workerCurrent] && !host->worker.cleanupOnly &&
        host->worker.identity.Valid() && host->worker.identity == id &&
        host->gate.Matches(id, host->worker.pid) ? NS_OK : NS_ERROR_NOT_AVAILABLE;
  }
  return host->gate.Admit(id) ? NS_OK : NS_ERROR_ALREADY_INITIALIZED;
}
} // namespace zen::profilehost
