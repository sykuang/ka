#!/usr/bin/python3
"""Actual-source-body logic checks, NOT a Gecko object/IPDL/native render test.

External types, queues, IPC resolvers, APZ, resources and actor lifetimes are
narrow C++ doubles. The bodies under test are extracted without rewriting.
All compiler outputs and receipts must stay in the admitted evidence root.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

EVIDENCE = Path('/Users/kenkuang/.hermes/projects/zen-display-list-acceptance-ludbph0q')
FILES = ('gfx/webrender_bindings/WebRenderAPI.h',
         'gfx/webrender_bindings/WebRenderAPI.cpp',
         'gfx/layers/wr/WebRenderBridgeParent.h',
         'gfx/layers/wr/WebRenderBridgeParent.cpp',
         'gfx/layers/ipc/PWebRenderBridge.ipdl')
TYPE_FILES = ('xpcom/base/ErrorList.py', 'xpcom/base/nsError.h',
              'ipc/ipdl/ipdl/builtin.py', 'ipc/glue/InputStreamParams.ipdlh',
              'ipc/chromium/src/chrome/common/ipc_message_utils.h')


def error_types(sources):
    generator = sources[TYPE_FILES[0]]
    declaration = re.search(r'enum class nsresult\s*:\s*uint32_t', generator)
    assert declaration and 'const nsresult\n{}' in generator
    assert '{error} = nsresult::{error}' in generator
    assert '#include "ErrorList.h"' in sources[TYPE_FILES[1]]
    assert 'static_cast<uint32_t>(aErr)' in sources[TYPE_FILES[1]]
    assert '"nsresult",' in sources[TYPE_FILES[2]]
    assert 'nsresult status;' in sources[TYPE_FILES[3]]
    assert 'struct ParamTraitsMozilla<nsresult>' in sources[TYPE_FILES[4]]
    values = []
    for name in ('NS_OK', 'NS_ERROR_NOT_AVAILABLE'):
        value = re.search(r'errors\["' + name + r'"\] = (0x[0-9A-Fa-f]+|[0-9]+)\s*$',
                          generator, re.M)
        assert value, name
        values.append(name + ' = ' + value.group(1))
    return (declaration.group() + ' { ' + ', '.join(values) + ' };\n' +
            '\n'.join('const nsresult ' + name + ' = nsresult::' + name + ';'
                      for name in ('NS_OK', 'NS_ERROR_NOT_AVAILABLE')))


def body(text, anchor):
    """Find one explicit definition and balance braces, ignoring C++ literals/comments."""
    hits = list(re.finditer(re.escape(anchor), text))
    assert len(hits) == 1, (anchor, len(hits))
    start = text.index('{', hits[0].end())
    token = re.compile(r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[{}]', re.S)
    depth = 0
    for match in token.finditer(text, start):
        if match.group() == '{':
            depth += 1
        elif match.group() == '}':
            depth -= 1
            if depth == 0:
                return text[start:match.end()]
    raise AssertionError('unbalanced body: ' + anchor)


def harness(sources):
    api = sources[FILES[1]]
    parent = sources[FILES[3]]
    methods = {}
    for name in ('SetDisplayList', 'ProcessDisplayListData', 'RecvSetDisplayList',
                 'RecvGetDisplayListAcceptance', 'RecvClearCachedResources',
                 'ClearResources', 'UpdateWebRender', 'Destroy', 'ActorDestroy',
                 'EnsureInitialized'):
        anchor = 'WebRenderBridgeParent::' + name + '('
        start = parent.index(anchor)
        start = parent.rfind('\n', 0, start) + 1
        opening = parent.index('{', start)
        signature = parent[start:opening]
        methods[name] = signature + body(parent, signature)
    api_signature = 'bool WebRenderAPI::SendTransaction(TransactionBuilder& aTxn) '
    send = api_signature + body(api, api_signature)
    sender = 'class AutoTransactionSender ' + body(
        sources[FILES[0]], 'class MOZ_RAII AutoTransactionSender ') + ';'
    # Class/resolver/type shapes below are external dependency doubles, NOT
    # generated Gecko/IPDL headers. Production method bodies remain verbatim.
    prefix = r'''
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <queue>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>
#define LOG(...) ((void)0)
#define AUTO_PROFILER_MARKER_INNERWINDOWID(name, category, id) ((void)(id))
#define NS_INLINE_DECL_THREADSAFE_REFCOUNTING(...)
static int diagnostics = 0;
// Release-style diagnostic boundary: malformed-scroll refusal remains runnable.
#define MOZ_ASSERT(x, ...) do { if (!(x)) ++diagnostics; } while (0)
#define MOZ_RELEASE_ASSERT(x) assert(x)
#define IPC_OK() true
#define IPC_FAIL(...) false
@NSRESULT_TYPES@
static_assert(!std::is_convertible_v<nsresult, uint32_t>);
namespace mozilla { namespace ipc { using IPCResult = bool; } }
template<class T> struct Maybe : std::optional<T> {
  using std::optional<T>::optional;
  T& ref() { return this->value(); }
  const T& ref() const { return this->value(); }
  bool isNothing() const { return !this->has_value(); }
};
template<class T> using RefPtr = T*;
template<class T> struct nsTArray : std::vector<T> {
  using std::vector<T>::vector;
  void AppendElement(T value) { this->push_back(value); }
};
using TransactionId = uint64_t;
using nsACString = std::string;
struct TimeStamp { static TimeStamp Now() { return {}; } };
struct VsyncId {};
struct LayoutDeviceRect {
  float x=0, y=0, width=0, height=0;
  bool operator==(const LayoutDeviceRect& b) const {
    return x==b.x && y==b.y && width==b.width && height==b.height;
  }
};
struct LayoutDeviceIntPoint {};
struct LayoutDeviceIntSize {};
struct LayoutDeviceIntRect { LayoutDeviceIntRect(LayoutDeviceIntPoint, LayoutDeviceIntSize) {} };
namespace ipc { struct ByteBuf {}; struct Shmem { bool released=false; }; }
struct RefCountedShmem { bool released=false; };
struct OpUpdateResource {};
struct OpDestroy {};
struct WebRenderParentCommand {};
enum class CompositionPayloadType { eContentPaint };
struct CompositionPayload { CompositionPayloadType type; TimeStamp time; };
struct FocusTarget {};
namespace CrashReporter {
  enum class Annotation { URL };
  void RecordAnnotationNSCString(Annotation, const nsACString&) {}
}
struct CompositorThreadHolder { static bool IsInCompositorThread() { return true; } };
namespace wr {
struct IdNamespace { uint32_t mHandle; bool operator==(const IdNamespace& b) const { return mHandle==b.mHandle; } };
struct Epoch { uint32_t mHandle; };
struct PipelineId {
  uint32_t mNamespace, mHandle;
  bool operator==(const PipelineId& b) const { return mNamespace==b.mNamespace && mHandle==b.mHandle; }
};
inline PipelineId AsPipelineId(uint64_t n) { return {uint32_t(n>>32), uint32_t(n)}; }
struct BuiltDisplayListDescriptor {};
template<class T> struct Vec { explicit Vec(ipc::ByteBuf&&) {} };
enum class Checkpoint { SceneBuilt };
enum class RenderReasons { CLEAR_RESOURCES };
enum class RemoteTextureWaitType { AsyncWait };
struct Scheduler { int notified=0; void NotifyTxn(int) { ++notified; } };
struct List { std::vector<int> mList; };
class WebRenderAPI;
struct TransactionBuilder {
  bool full=false;
  bool scene=true;
  Scheduler* mRemoteTextureTxnScheduler=nullptr;
  int mRemoteTextureTxnId=7;
  TransactionBuilder(WebRenderAPI*, bool s=true, void* =nullptr, uint64_t=0) : scene(s) {}
  void* Raw() { return this; }
  bool UseSceneBuilderThread() { return scene; }
  void SetLowPriority(bool) {}
  void SetDocumentView(LayoutDeviceIntRect) {}
  void SetDisplayList(Epoch, IdNamespace, PipelineId, const BuiltDisplayListDescriptor&, Vec<uint8_t>&, Vec<uint8_t>&) { full=true; }
  void RenderOffscreen(PipelineId) {}
  void RemovePipeline(PipelineId) {}
  template<class T> void Notify(Checkpoint, T&&) {}
  void ClearDisplayList(Epoch, IdNamespace, PipelineId) {}
};
static int forwarded=0, queued=0;
inline void wr_api_send_transaction(void*, void* raw, bool) {
  auto* txn=static_cast<TransactionBuilder*>(raw);
  if (txn->full) ++forwarded;
  txn->full=false;
}
struct WrTransactionEvent {
  static int PendingRemoteTextures(std::unique_ptr<List>&&) { return 1; }
  static int PendingAsyncImagePipelineOps(std::unique_ptr<List>&&, WebRenderAPI*, TransactionBuilder&) { return 2; }
  static int Transaction(WebRenderAPI*, TransactionBuilder& txn) {
    if (txn.full) ++queued;
    txn.full=false;
    return 3;
  }
};
class WebRenderAPI {
 public:
  WebRenderAPI* mRootApi=nullptr;
  bool mRendererDestroyed=false;
  std::unique_ptr<List> mPendingRemoteTextureInfoList;
  std::unique_ptr<List> mPendingAsyncImagePipelineOps;
  std::queue<int> mPendingWrTransactionEvents;
  void* mDocHandle=nullptr;
  int handled=0;
  IdNamespace ownNamespace{5};
  bool SendTransaction(TransactionBuilder&);
  void HandleWrTransactionEvents(RemoteTextureWaitType) { ++handled; }
  void FlushPendingWrTransactionEventsWithoutWait() {}
  void DestroyRenderer() { mRendererDestroyed=true; }
  IdNamespace GetNamespace() { return ownNamespace; }
};
'''
    prefix += send + '\n' + sender + '\n}\n'
    prefix += r'''
namespace gfx {
  wr::PipelineId GetTemporaryWebRenderPipelineId(wr::PipelineId p) { ++p.mHandle; return p; }
}
struct SceneBuiltNotification { template<class... T> SceneBuiltNotification(T&&...) {} };
template<class T, class... A> std::unique_ptr<T> MakeUnique(A&&... args) {
  return std::make_unique<T>(std::forward<A>(args)...);
}
struct ScrollData {
  bool valid=true, first=false;
  bool ValidateShape() { return valid; }
  bool IsFirstPaint() { return first; }
};
using WebRenderScrollData = ScrollData;
struct DisplayListData {
  wr::IdNamespace mIdNamespace{5};
  Maybe<ScrollData> mScrollData;
  Maybe<ipc::ByteBuf> mDLItems{ipc::ByteBuf{}};
  Maybe<ipc::ByteBuf> mDLSpatialTree{ipc::ByteBuf{}};
  wr::BuiltDisplayListDescriptor mDLDesc;
  LayoutDeviceRect mRect{0,0,640,480};
  nsTArray<WebRenderParentCommand> mCommands;
  nsTArray<OpUpdateResource> mResourceUpdates;
  nsTArray<RefCountedShmem> mSmallShmems{RefCountedShmem{}};
  nsTArray<ipc::Shmem> mLargeShmems{ipc::Shmem{}};
};
// Handwritten result shape double. Never used as a generated-header compile claim.
struct DisplayListAcceptance {
  @STATUS_TYPE@ s;
  wr::PipelineId p;
  wr::IdNamespace n;
  TransactionId t;
  uint64_t f;
  uint32_t e;
  LayoutDeviceRect r;
  DisplayListAcceptance(@STATUS_TYPE@ s_, wr::PipelineId p_, wr::IdNamespace n_,
      TransactionId t_, uint64_t f_, uint32_t e_, LayoutDeviceRect r_)
      : s(s_),p(p_),n(n_),t(t_),f(f_),e(e_),r(r_) {}
  @STATUS_TYPE@ status() const { return s; }
  wr::PipelineId pipelineId() const { return p; }
  wr::IdNamespace idNamespace() const { return n; }
  TransactionId transactionId() const { return t; }
  uint64_t fwdTransactionId() const { return f; }
  uint32_t epoch() const { return e; }
  LayoutDeviceRect rect() const { return r; }
};
using GetDisplayListAcceptanceResolver = std::function<void(const DisplayListAcceptance&)>;
struct WebRenderBridgeParent;
struct CompositorBridgeParent {
  int rendered=0;
  bool* destroyed=nullptr;
  void EnsureWebRenderBridgeParentInitialized() { assert(destroyed); *destroyed=true; }
  uint64_t GetInnerWindowId() { return 9; }
  template<class... T> void NotifyPipelineRendered(T&&...) { ++rendered; }
  static void DisconnectWrBridge(WebRenderBridgeParent*) {}
};
using CompositorBridgeParentBase = CompositorBridgeParent;
struct CompositorVsyncScheduler { void Destroy() {} };
struct TextureFactoryIdentifier {};
struct WebRenderTextureHost {};
struct WebRenderImageHost {
  void ClearWrBridge(wr::PipelineId, WebRenderBridgeParent*) {}
};
struct ExternalHost {
  WebRenderTextureHost* AsWebRenderTextureHost() { return nullptr; }
  void Clear() {}
  void OnReleased() {}
};
struct AsyncImagePipelineManager {
  template<class T> void HoldExternalImage(wr::PipelineId, wr::Epoch, T) {}
  void RemovePipeline(wr::PipelineId, wr::Epoch) {}
  void AddPipeline(wr::PipelineId, WebRenderBridgeParent*) {}
  void RemoveAsyncImagePipeline(wr::PipelineId, void*, wr::TransactionBuilder&) {}
};
struct Widget { LayoutDeviceIntSize GetClientSize() { return {}; } };
namespace wr { struct IpcResourceUpdateQueue {
  template<class T> static void ReleaseShmems(WebRenderBridgeParent*, nsTArray<T>& shmems) {
    for (auto& s : shmems) { assert(!s.released); s.released=true; }
  }
}; }
struct AutoWebRenderBridgeParentAsyncMessageSender {
  WebRenderBridgeParent* bridge;
  nsTArray<OpDestroy>* actors;
  AutoWebRenderBridgeParentAsyncMessageSender(WebRenderBridgeParent* b, nsTArray<OpDestroy>* a) : bridge(b), actors(a) {}
  ~AutoWebRenderBridgeParentAsyncMessageSender();
};
using ActorDestroyReason = int;
struct WebRenderBridgeParent {
  struct LateInit {
    wr::WebRenderAPI* mApi;
    AsyncImagePipelineManager* mAsyncImageManager;
    CompositorVsyncScheduler* mCompositorScheduler;
    wr::IdNamespace mIdNamespace;
  };
  Maybe<LateInit> mLateInit;
  Maybe<DisplayListAcceptance> mLastDisplayListAcceptance;
  bool mDestroyed=false, root=false, mReceivedDisplayList=false, mIsFirstPaint=false;
  bool commandsOK=true, resourcesOK=true;
  int destroyedActors=0, held=0, sanitized=0, apz=0;
  uint64_t mFwdTransactionId=0;
  wr::Epoch mWrEpoch{0};
  wr::PipelineId mPipelineId{11,22};
  Widget widget;
  Widget* mWidget=&widget;
  void* mRemoteTextureTxnScheduler=nullptr;
  ExternalHost* mWebRenderBridgeRef=nullptr;
  std::map<int, ExternalHost*> mCompositables, mTextureHosts;
  std::map<int, int> mSharedSurfaceIds;
  std::map<int, WebRenderImageHost*> mAsyncCompositables;
  CompositorBridgeParent cbp;
  CompositorBridgeParentBase* mCompositorBridge=&cbp;
  CompositorVsyncScheduler scheduler;
  AsyncImagePipelineManager images;
  explicit WebRenderBridgeParent(wr::WebRenderAPI* api) {
    mLateInit.emplace(LateInit{api,&images,&scheduler,api->GetNamespace()});
    cbp.destroyed=&mDestroyed;
  }
  bool IsRootWebRenderBridgeParent() const { return root; }
  CompositorBridgeParent* GetRootCompositorBridgeParent() { return &cbp; }
  void DestroyActors(nsTArray<OpDestroy>& a) { destroyedActors += a.size(); a.clear(); }
  void UpdateFwdTransactionId(uint64_t id) { mFwdTransactionId=id; }
  wr::Epoch GetNextWrEpoch() { return {++mWrEpoch.mHandle}; }
  void SanitizeScrollData(ScrollData&) { ++sanitized; }
  void UpdateAPZScrollData(wr::Epoch, ScrollData&&) { ++apz; }
  bool UpdateResources(const nsTArray<OpUpdateResource>&, const nsTArray<RefCountedShmem>&,
                       const nsTArray<ipc::Shmem>&, wr::TransactionBuilder&) { return resourcesOK; }
  bool ProcessWebRenderParentCommands(const nsTArray<WebRenderParentCommand>&, wr::TransactionBuilder&) { return commandsOK; }
  void MaybeNotifyOfLayers(wr::TransactionBuilder&, bool) {}
  void NeedIncreasedMaxDirtyPageModifier() {}
  template<class... T> void HoldPendingTransactionId(T&&...) { ++held; }
  void ClearAnimationResources() {}
  void ScheduleGenerateFrame(wr::RenderReasons) {}
  bool SendWrUpdated(wr::IdNamespace, const TextureFactoryIdentifier&) { return true; }
'''
    for value in methods.values():
        prefix += value.replace('WebRenderBridgeParent::', '', 1) + '\n'
    prefix += r'''
};
AutoWebRenderBridgeParentAsyncMessageSender::~AutoWebRenderBridgeParentAsyncMessageSender() {
  bridge->DestroyActors(*actors);
}
static DisplayListAcceptance query(WebRenderBridgeParent& b, uint32_t ns=5, uint64_t txn=20) {
  Maybe<DisplayListAcceptance> answer;
  int resolved=0;
  assert(b.RecvGetDisplayListAcceptance(wr::IdNamespace{ns}, txn,
      [&](const DisplayListAcceptance& r) { ++resolved; answer.emplace(r); }));
  assert(resolved==1 && answer);
  return answer.ref();
}
static void refused(const DisplayListAcceptance& r) {
  assert(r.status()==NS_ERROR_NOT_AVAILABLE);
  assert((r.pipelineId()==wr::PipelineId{0,0}));
  assert(r.idNamespace().mHandle==0 && r.transactionId()==0);
  assert(r.fwdTransactionId()==0 && r.epoch()==0);
  assert(r.rect()==LayoutDeviceRect{});
}
static bool receive(WebRenderBridgeParent& b, DisplayListData& d, uint64_t txn=20,
                    bool offscreen=false, uint64_t fwd=31) {
  nsTArray<OpDestroy> actors{OpDestroy{}};
  nsTArray<CompositionPayload> payloads;
  int old=b.destroyedActors;
  bool result=b.RecvSetDisplayList(std::move(d), std::move(actors), fwd, txn,
      false, VsyncId{}, TimeStamp{}, TimeStamp{}, TimeStamp{}, std::string{},
      TimeStamp{}, std::move(payloads), offscreen);
  assert(b.destroyedActors==old+1 && actors.empty());
  assert(d.mSmallShmems[0].released && d.mLargeShmems[0].released);
  return result;
}
static void accepted(WebRenderBridgeParent& b, uint64_t txn=20, uint64_t fwd=31) {
  auto r=query(b,b.mLateInit->mIdNamespace.mHandle,txn);
  assert(r.status()==NS_OK && r.pipelineId()==b.mPipelineId);
  assert(r.idNamespace()==b.mLateInit->mIdNamespace);
  assert(r.transactionId()==txn && r.fwdTransactionId()==fwd);
  assert(r.epoch()==b.mWrEpoch.mHandle);
  assert((r.rect()==LayoutDeviceRect{0,0,640,480}));
}
static void pass(const char* label) { std::printf("PASS %s\n",label); std::fflush(stdout); }
int main() {
  // API queue admission branches, actual SendTransaction body.
  {
    wr::WebRenderAPI root, api;
    api.mRootApi=&root;
    wr::TransactionBuilder txn(&api);
    wr::Scheduler scheduler;
    txn.mRemoteTextureTxnScheduler=&scheduler;
    txn.full=true;
    int f=wr::forwarded;
    assert(api.SendTransaction(txn) && wr::forwarded==f+1 && scheduler.notified==1);
    pass("api-forward");
    root.mRendererDestroyed=true;
    txn.full=true;
    assert(!api.SendTransaction(txn) && txn.full && wr::forwarded==f+1);
    pass("api-renderer-drop");
    root.mRendererDestroyed=false;
    api.mPendingWrTransactionEvents.emplace(0);
    assert(api.SendTransaction(txn) && api.handled==1 && wr::queued==1 && !txn.full);
    pass("api-existing-pending");
  }
  for (int kind=0;kind<2;++kind) {
    wr::WebRenderAPI api;
    auto list=std::make_unique<wr::List>(); list->mList.push_back(1);
    if (kind) api.mPendingAsyncImagePipelineOps=std::move(list);
    else api.mPendingRemoteTextureInfoList=std::move(list);
    wr::TransactionBuilder txn(&api); txn.full=true;
    int q=wr::queued;
    assert(api.SendTransaction(txn) && wr::queued==q+1 && api.handled==1);
    assert(api.mPendingWrTransactionEvents.size()==2);
    pass(kind ? "api-async-image-pending" : "api-remote-texture-pending");
  }
  {
    wr::WebRenderAPI api; api.mRendererDestroyed=true;
    wr::TransactionBuilder txn(&api);
    assert(api.SendTransaction(txn)); // preserve existing root-api semantics
    pass("api-no-root-preserved");
  }
  {
    wr::WebRenderAPI api;
    WebRenderBridgeParent b(&api);
    DisplayListData d;
    assert(receive(b,d)); accepted(b);
    pass("exact-tuple");
    // Unrelated current counters must not restamp the stored receipt.
    auto saved=query(b);
    b.mFwdTransactionId=999; b.mWrEpoch.mHandle=999;
    auto again=query(b);
    assert(again.fwdTransactionId()==saved.fwdTransactionId());
    assert(again.epoch()==saved.epoch());
    pass("stored-not-current-metadata");
    refused(query(b,5,19)); refused(query(b,5,21)); refused(query(b,4,20));
    pass("exact-query-not-greater-or-equal");
    b.mLateInit->mIdNamespace={6};
    refused(query(b,5,20)); refused(query(b,6,20));
    pass("owning-namespace-changed");
  }
  {
    wr::WebRenderAPI api; WebRenderBridgeParent b(&api);
    DisplayListData d; assert(receive(b,d));
    DisplayListData sameSize; assert(receive(b,sameSize,21,false,32)); accepted(b,21,32);
    refused(query(b,5,20));
    pass("same-size-new-positive-old-negative");
  }
  {
    wr::WebRenderAPI api; WebRenderBridgeParent b(&api);
    DisplayListData d; d.mRect={1.25f,2.5f,123.5f,456.25f};
    assert(receive(b,d,22,false,33));
    auto r=query(b,5,22);
    assert(r.status()==NS_OK && r.rect()==d.mRect);
    assert(r.transactionId()==22 && r.fwdTransactionId()==33);
    pass("exact-incoming-rect");
  }
  for (int kind=0;kind<3;++kind) {
    wr::WebRenderAPI api; WebRenderBridgeParent b(&api);
    DisplayListData d; assert(receive(b,d));
    if (kind==0) b.mLateInit->mApi=nullptr;
    if (kind==1) b.mDestroyed=true;
    if (kind==2) b.root=true;
    refused(query(b));
    static const char* names[]={"query-api-null", "query-destroyed", "query-root"};
    pass(names[kind]);
  }
  for (int kind=0;kind<3;++kind) {
    wr::WebRenderAPI api;
    if (kind==0) api.mPendingWrTransactionEvents.emplace(0);
    if (kind==1) { api.mPendingRemoteTextureInfoList=std::make_unique<wr::List>();
                  api.mPendingRemoteTextureInfoList->mList.push_back(1); }
    if (kind==2) { api.mPendingAsyncImagePipelineOps=std::make_unique<wr::List>();
                  api.mPendingAsyncImagePipelineOps->mList.push_back(1); }
    WebRenderBridgeParent b(&api);
    DisplayListData d; int q=wr::queued;
    assert(receive(b,d)); accepted(b);
    assert(wr::queued==q+1);
    static const char* names[]={"parent-existing-pending", "parent-remote-pending", "parent-async-pending"};
    pass(names[kind]);
  }
  // Every failed attempt first has a genuine admitted predecessor, not a
  // manufactured successful record. Receiver cleanup remains asserted.
  for (int kind=0;kind<11;++kind) {
    wr::WebRenderAPI root, api; api.mRootApi=&root;
    WebRenderBridgeParent b(&api);
    DisplayListData first; assert(receive(b,first)); accepted(b);
    DisplayListData d;
    switch(kind) {
      case 0: d.mIdNamespace={4}; break;
      case 1: d.mScrollData.emplace(); d.mScrollData->valid=false; break;
      case 2: d.mDLItems.reset(); break;
      case 3: d.mDLSpatialTree.reset(); break;
      case 4: d.mDLItems.reset(); d.mDLSpatialTree.reset(); break;
      case 5: b.commandsOK=false; break;
      case 6: b.resourcesOK=false; break;
      case 7: break; // offscreen argument below
      case 8: b.mDestroyed=true; break;
      case 9: root.mRendererDestroyed=true; break;
      case 10: b.root=true; break;
    }
    int forwarded=wr::forwarded, queued=wr::queued;
    bool ok=receive(b,d,21,kind==7);
    assert(ok==(kind!=5 && kind!=6));
    // Existing command/resource failures still send their transaction; a drop,
    // malformed scroll or absent DL buffers must not enqueue a full list.
    bool sendsFull=(kind==5 || kind==6 || kind==7 || kind==10);
    assert(wr::forwarded==forwarded+(sendsFull ? 1 : 0) && wr::queued==queued);
    refused(query(b,5,20)); refused(query(b,5,21));
    assert(!b.mLastDisplayListAcceptance);
    if (kind==0) assert(b.cbp.rendered==1 && b.held==2);
    static const char* names[]={"stale-namespace-notify-preserved", "malformed-scroll",
      "missing-items", "missing-spatial-tree", "missing-both", "command-failure",
      "resource-failure", "offscreen", "uninitialized-destroyed-attempt", "api-drop-composed", "root-refusal"};
    pass(names[kind]);
  }
  {
    wr::WebRenderAPI api; WebRenderBridgeParent b(&api);
    DisplayListData d; d.mScrollData.emplace();
    assert(receive(b,d)); accepted(b);
    assert(b.sanitized==1 && b.apz==1);
    pass("valid-scroll-composed");
  }
  for (int kind=0;kind<8;++kind) {
    wr::WebRenderAPI api, replacement;
    WebRenderBridgeParent b(&api);
    DisplayListData d; assert(receive(b,d)); accepted(b);
    switch(kind) {
      case 0: assert(b.RecvClearCachedResources()); break;
      case 1: b.ClearResources(); break;
      case 2: b.mLateInit->mApi=nullptr; b.ClearResources(); break;
      case 3: replacement.ownNamespace={6};
              b.UpdateWebRender(&b.scheduler,&replacement,&b.images,TextureFactoryIdentifier{});
              assert(b.mLateInit->mIdNamespace.mHandle==6 && b.mLateInit->mApi==&replacement); break;
      case 4: b.Destroy(); assert(b.mDestroyed); break;
      case 5: b.ActorDestroy(0); assert(b.mDestroyed); break;
      case 6: b.mDestroyed=true; b.Destroy(); break;
      case 7: b.mDestroyed=true; assert(b.RecvClearCachedResources()); break;
    }
    assert(!b.mLastDisplayListAcceptance);
    refused(query(b)); refused(query(b,6));
    static const char* names[]={"clear-cached", "clear-resources", "clear-api-null",
      "namespace-api-replacement", "destroy", "actor-destroy", "destroy-early", "clear-cached-early"};
    pass(names[kind]);
  }
  {
    wr::WebRenderAPI api; WebRenderBridgeParent b(&api);
    b.mLateInit.reset(); refused(query(b));
    DisplayListData d; assert(receive(b,d));
    assert(b.mDestroyed && !b.mLastDisplayListAcceptance);
    pass("initialization-failure-cleanup");
  }
  {
    wr::WebRenderAPI api, replacement; WebRenderBridgeParent b(&api);
    DisplayListData d; assert(receive(b,d)); accepted(b);
    b.UpdateWebRender(&b.scheduler,&replacement,&b.images,TextureFactoryIdentifier{});
    assert(b.mLateInit->mIdNamespace.mHandle==5 && b.mLateInit->mApi==&replacement);
    assert(!b.mLastDisplayListAcceptance); refused(query(b));
    DisplayListData fresh; assert(receive(b,fresh,21,false,32)); accepted(b,21,32);
    pass("same-namespace-api-replacement-and-recovery");
  }
  assert(diagnostics==1); // only the deliberate malformed-scroll diagnostic
  std::puts("ALL ACTUAL-BODY CONTROLS PASSED (external doubles; no Gecko/IPDL/native render claim)");
}
'''
    extracted = dict(methods, SendTransaction=send, AutoTransactionSender=sender)
    status_type = re.search(r'struct DisplayListAcceptance\s*\{\s*(\w+) status;',
                            sources[FILES[4]])
    assert status_type, 'receipt status field absent'
    prefix = prefix.replace('@NSRESULT_TYPES@', error_types(sources))
    prefix = prefix.replace('@STATUS_TYPE@', status_type.group(1))
    return prefix, {name: hashlib.sha256(text.encode()).hexdigest()
                    for name, text in extracted.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--output-root', type=Path, required=True)
    args = parser.parse_args()
    out = args.output_root.resolve()
    assert EVIDENCE.resolve() in out.parents, 'output must be an owned evidence child'
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name in ('tmp', 'modules'):
        (out / name).mkdir(mode=0o700)
    env = dict(os.environ, TMPDIR=str(out / 'tmp'),
               CLANG_MODULE_CACHE_PATH=str(out / 'modules'))
    sources = {f: (args.source_root / 'engine' / f).read_text() for f in FILES + TYPE_FILES}
    inputs = {f: hashlib.sha256((args.source_root / 'engine' / f).read_bytes()).hexdigest()
              for f in FILES + TYPE_FILES}
    inputs['driver'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    receipt = {'argv': sys.argv, 'python': sys.version, 'inputs': inputs,
               'evidenceKind': 'actual C++ source bodies with external dependencies doubled',
               'commands': [], 'category': 'ERROR'}

    def run(argv):
        proc = subprocess.run(argv, cwd=out, env=env, capture_output=True, text=True)
        index = len(receipt['commands'])
        (out / ('command-%d.stdout' % index)).write_text(proc.stdout)
        (out / ('command-%d.stderr' % index)).write_text(proc.stderr)
        receipt['commands'].append({'argv': argv, 'returncode': proc.returncode,
                                    'TMPDIR': env['TMPDIR'],
                                    'CLANG_MODULE_CACHE_PATH': env['CLANG_MODULE_CACHE_PATH']})
        return proc

    try:
        version = run(['/usr/bin/clang++', '--version'])
        assert version.returncode == 0
        assert 'bool SendTransaction(TransactionBuilder& aTxn);' in sources[FILES[0]], \
            'API-contract RED: queue admission bool is absent (not native/behavioral RED)'
        assert 'async GetDisplayListAcceptance(' in sources[FILES[4]], \
            'API-contract RED: exact acceptance query is absent'
        fields = re.search(r'struct DisplayListAcceptance\s*\{(.*?)\};',
                           sources[FILES[4]], re.S)
        assert fields, 'flat IPC result contract absent'
        status_type = re.match(r'\s*(nsresult|uint32_t) status;', fields.group(1))
        assert status_type, 'unsupported IPC status type'
        receipt['receiptStatusType'] = status_type.group(1)
        assert re.sub(r'\s+', ' ', fields.group(1)).strip() == (
            status_type.group(1) + ' status; PipelineId pipelineId; IdNamespace idNamespace; '
            'TransactionId transactionId; uint64_t fwdTransactionId; uint32_t epoch; '
            'LayoutDeviceRect rect;'), 'flat IPC result contract differs'
        cpp = out / 'actual-bodies.cpp'
        generated, receipt['extractedBodyHashes'] = harness(sources)
        cpp.write_text(generated)
        receipt['harnessSHA256'] = hashlib.sha256(cpp.read_bytes()).hexdigest()
        compile_result = run(['/usr/bin/clang++', '-std=c++17', '-Wall', '-Wextra',
                              '-Werror', '-Wno-unused-parameter', str(cpp), '-o', str(out / 'controls')])
        assert compile_result.returncode == 0, (
            'typed-contract RED: strong nsresult versus uint32_t; see raw stderr'
            if status_type.group(1) == 'uint32_t' else 'compile ERROR; see raw stderr')
        result = run([str(out / 'controls')])
        receipt['passedControls'] = re.findall(r'^PASS (.+)$', result.stdout, re.M)
        assert result.returncode == 0, 'behavioral failure; see raw stdout/stderr'
        assert 'ALL ACTUAL-BODY CONTROLS PASSED' in result.stdout, 'runtime did not complete'
        assert len(receipt['passedControls']) == len(set(receipt['passedControls']))
        receipt['category'] = 'PASS'
    except AssertionError as exc:
        receipt['failure'] = str(exc)
        receipt['category'] = ('typed-contract RED' if str(exc).startswith('typed-contract RED')
                               else 'API-contract RED' if str(exc).startswith('API-contract RED')
                               else 'ERROR/FAIL')
    finally:
        receipt['afterInputs'] = {
            f: hashlib.sha256((args.source_root / 'engine' / f).read_bytes()).hexdigest()
            for f in FILES + TYPE_FILES}
        receipt['afterInputs']['driver'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        receipt['inputsUnchanged'] = receipt['afterInputs'] == inputs
        (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))
    return 0 if receipt['category'] == 'PASS' and receipt['inputsUnchanged'] else 1


if __name__ == '__main__':
    sys.exit(main())
