#!/usr/bin/python3
"""Offline actual-body producer check; no Gecko/IPDL compilation or UI.

External boundaries are controlled C++ document/widget/layout/IPC adapters.
The manager check executes its actual observation/send slice, not its command
builder, resource or shmem implementation. No prior acceptance tests are run.
"""
import argparse
import pathlib
import re
import subprocess
import tempfile
import os
import json
import hashlib
import sys


def body(text, signature):
    start = text.index(signature)
    opening = text.index('{', start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=pathlib.Path,
                        default=pathlib.Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
    root = args.root / 'engine'
    paths = ['dom/ipc/PBrowser.ipdl', 'dom/ipc/BrowserParent.cpp',
             'dom/ipc/BrowserChild.cpp', 'gfx/layers/wr/WebRenderLayerManager.cpp',
             'gfx/layers/wr/WebRenderLayerManager.h']
    paths += ['dom/ipc/BrowserParent.h', 'dom/ipc/BrowserChild.h',
              'gfx/layers/LayersTypes.h', 'ipc/glue/MessageChannel.cpp']
    src = {p: (root / p).read_text() for p in paths}
    hashes = {p: hashlib.sha256((root / p).read_bytes()).hexdigest() for p in paths}
    hashes['test'] = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
    (args.output / 'inputs.json').write_text(json.dumps({
        'hashes': hashes, 'pythonExecutable': sys.executable,
        'pythonVersion': sys.version}, indent=2))
    ipdl = src[paths[0]]
    assert 'async ProduceDisplayList(DimensionInfo dimensions,' in ipdl, 'API-contract RED: carried-dimensions producer request absent'
    request = ipdl.split('async ProduceDisplayList(', 1)[1].split(';', 1)[0]
    assert 'expectedInnerWindowId' in request and 'expectedDefaultScale' in request
    assert 'expectedDesktopToDeviceScale' in request and 'returns (ProducerAck receipt)' in request
    assert not re.search(r'\[[^\]]+\]\s*async ProduceDisplayList', ipdl)
    run_bodies(src, args.output, root)
    child_body = src['dom/ipc/BrowserChild.cpp']
    assert 'mozilla::ipc::IPCResult BrowserChild::RecvProduceDisplayList(' in child_body, 'API-contract RED: producer receiver absent'
    run_child(src, args.output, root)
    run_parent(src, args.output)


def run_bodies(src, output, root):
    header = src['gfx/layers/wr/WebRenderLayerManager.h']
    assert 'struct FullDisplayListSubmission' in header, 'API-contract RED: full-submission observation absent'
    struct = body(header, 'struct FullDisplayListSubmission') + ';'
    manager = src['gfx/layers/wr/WebRenderLayerManager.cpp']
    full = body(manager, 'void WebRenderLayerManager::EndTransactionWithoutLayer(')
    empty = body(manager, 'bool WebRenderLayerManager::EndEmptyTransaction(')
    assert 'mLastFullDisplayListSubmission.emplace' not in empty
    assert full.index('mLastFullDisplayListSubmission.reset();') < full.index('WrBridge()->BeginTransaction();')
    send = full[full.index('    RefPtr<WebRenderBridgeChild> bridge = WrBridge();'):full.index('    WrBridge()->SendSetFocusTarget')]
    for signature in ['void WebRenderLayerManager::DoDestroy(', 'void WebRenderLayerManager::WrUpdated()']:
        assert 'mLastFullDisplayListSubmission.reset();' in body(manager, signature)
    resets = '\n'.join('void ' + name + '(){' + body(manager, signature).split('{', 1)[1].split(';', 1)[0] + ';}'
                       for name, signature in [('Destroy', 'void WebRenderLayerManager::DoDestroy('), ('Updated', 'void WebRenderLayerManager::WrUpdated()')])
    empty_prefix = empty[empty.index('{') + 1:empty.index('  LayoutDeviceIntSize size')]
    code = r'''
#include <cassert>
#include <cstdint>
#include <optional>
#include <utility>
#include <compare>
#include <iostream>
template<class T> using RefPtr = T*;
#define MOZ_ASSERT(...) assert((__VA_ARGS__))
template<class F> struct Exit { F f; ~Exit(){f();} };
template<class F> Exit<F> MakeScopeExit(F f){return {f};}
namespace wr {
struct IdNamespace { uint32_t mHandle; auto operator<=>(const IdNamespace&) const = default; };
struct PipelineId { uint32_t mNamespace, mHandle; auto operator<=>(const PipelineId&) const = default; };
}
struct TransactionId { uint64_t mId = 0; TransactionId Prev()const{return {mId-1};} explicit operator uint64_t() const { return mId; } auto operator<=>(const TransactionId&) const = default; };
struct LayoutDeviceRect { int x=0,y=0,width=800,height=600; bool operator==(const LayoutDeviceRect&) const = default; };
struct WebRenderBridgeChild {
  wr::IdNamespace ns{7}; wr::PipelineId pipeline{0,41}; uint64_t fwd=13; bool sent=true; int sends=0;
  wr::IdNamespace GetNamespace(){return ns;} wr::PipelineId GetPipeline(){return pipeline;}
  uint64_t GetFwdTransactionId(){return fwd;}
  bool GetSentDisplayList(){return true;} void SendSetFocusTarget(int){}
  template<class... T> bool EndTransaction(T&&...){++sends; ++fwd; return sent;}
};
struct Allocator { int GetVsyncId(){return 0;} int GetVsyncStart(){return 0;} TransactionId GetTransactionId(bool){return {22};} void RevokeTransactionId(TransactionId){} };
struct Manager {
''' + struct + r'''
  std::optional<FullDisplayListSubmission> mLastFullDisplayListSubmission;
  WebRenderBridgeChild bridge; Allocator allocator; Allocator* mTransactionIdAllocator=&allocator;
  TransactionId mLatestTransactionId{20}; int mTransactionStart=0,mURL=0;
  enum EndTransactionFlags { END_NO_COMPOSITE=1 };
  void* mTarget=nullptr; int mFocusTarget=0;
  struct Commands {bool NeedsEmptyTransaction(){return false;}} mWebRenderCommandBuilder;
  struct Updates {bool IsEmpty(){return true;}} mPendingScrollUpdates;
  WebRenderBridgeChild* WrBridge(){return &bridge;}
''' + resets + r'''
  bool Empty(EndTransactionFlags aFlags){
''' + empty_prefix + r'''
    return false; // boundary: remaining ordinary empty-transaction work not executed
  }
  void Send(bool list, bool builder, bool offscreen, bool succeeds) {
    mLastFullDisplayListSubmission.reset();
    bool aDisplayList=list,aDisplayListBuilder=builder,aRenderOffscreen=offscreen,containsSVGGroup=false;
    int refreshStart=0; struct { LayoutDeviceRect mRect; } dlData;
    bridge.sent=succeeds;
''' + send + r'''
  }
};
int main(){
  Manager m;
  m.Send(true,true,false,true);
  assert(m.mLastFullDisplayListSubmission);
  auto first=*m.mLastFullDisplayListSubmission;
  assert(first.mIdNamespace==m.bridge.ns && first.mPipelineId==m.bridge.pipeline);
  assert(first.mTransactionId==TransactionId{20} && first.mFwdTransactionId==13);
  assert(m.bridge.fwd==14 && m.bridge.sends==1);
  m.mLatestTransactionId={21}; m.Send(true,true,false,true);
  assert(m.mLastFullDisplayListSubmission->mTransactionId>first.mTransactionId);
  assert(m.mLastFullDisplayListSubmission->mRect==first.mRect);
  auto cached=*m.mLastFullDisplayListSubmission;
  assert(m.Empty(Manager::END_NO_COMPOSITE));
  assert(m.mLastFullDisplayListSubmission->mTransactionId==cached.mTransactionId);
  m.Destroy();assert(!m.mLastFullDisplayListSubmission);
  m.Send(true,true,false,true);m.Updated();assert(!m.mLastFullDisplayListSubmission);
  for(int mode=0;mode<4;++mode){
    m.Send(mode!=0,mode!=1,mode==2,mode!=3);
    assert(!m.mLastFullDisplayListSubmission);
  }
  std::cout << "manager observation: fresh same-size, exact send IDs, false/null/offscreen/background/empty/reset PASS\n";
}
'''
    compile_run(code, output)


def run_child(src, output, root):
    receiver = body(src['dom/ipc/BrowserChild.cpp'], 'mozilla::ipc::IPCResult BrowserChild::RecvProduceDisplayList(')
    full = body(src['gfx/layers/wr/WebRenderLayerManager.cpp'], 'void WebRenderLayerManager::EndTransactionWithoutLayer(')
    send = full[full.index('    RefPtr<WebRenderBridgeChild> bridge = WrBridge();'):full.index('    WrBridge()->SendSetFocusTarget')]
    protocol = src['dom/ipc/PBrowser.ipdl']
    fields = re.findall(r'(\w+) (\w+);', body(protocol, 'struct ProducerAck'))
    compression = body((root / 'ipc/glue/MessageChannel.cpp').read_text(), '    for (MessageTask* p = mPending.getLast();')
    ack = 'struct ProducerAck {\n' + '\n'.join(t + ' ' + n + '_{};' for t, n in fields)
    ack += '\nProducerAck(' + ','.join(t + ' a' + n for t, n in fields) + ') : '
    ack += ','.join(n + '_(a' + n + ')' for t, n in fields) + '{}\n'
    ack += '\n'.join(t + '& ' + n + '(){return ' + n + '_;}' for t, n in fields) + '\n};\n'
    # The adapter's IPC result/promise schedules only the actual receiver callback.
    # It never fabricates a successful producer receipt.
    code = r'''
#include <cassert>
#include <cmath>
#include <cstdint>
#include <functional>
#include <optional>
#include <utility>
#include <compare>
#include <iostream>
#include <tuple>
#include <vector>
#include <string>
#define MOZ_ASSERT(...) assert((__VA_ARGS__))
#define MOZ_RELEASE_ASSERT(...) assert((__VA_ARGS__))
template<class T> struct RefPtr {
 T* p=nullptr; RefPtr()=default; RefPtr(T* q):p(q){} T* operator->()const{return p;} T* get()const{return p;}
 operator T*()const{return p;}
};
template<class T> using nsCOMPtr=RefPtr<T>;
template<class T> std::optional<T> Some(T v){return v;}
struct Size { double width=800,height=600; bool operator==(const Size&)const=default; };
struct Point { double x=0,y=0; bool operator==(const Point&)const=default; };
struct LayoutDeviceRect {
 double x=0,y=0,width=800,height=600;
 Point TopLeft()const{return {x,y};} Size Size()const{return {width,height};}
 bool IsEqualEdges(const LayoutDeviceRect& b)const{return *this==b;}
 bool operator==(const LayoutDeviceRect&)const=default;
};
using CSSSize=Size; using LayoutDeviceIntSize=Size; using LayoutDeviceSize=Size; using LayoutDevicePoint=Point;
struct Scale { double scale=2; bool operator==(const Scale&)const=default; };
Size operator*(Size s,Scale f){return {s.width*f.scale,s.height*f.scale};}
Size RoundedToInt(Size s){return {std::round(s.width),std::round(s.height)};}
struct DimensionInfo {
 LayoutDeviceRect r; Size s{400,300}; Point c,h;
 auto rect()const{return r;} auto size()const{return s;} auto clientOffset()const{return c;} auto chromeOffset()const{return h;}
};
namespace wr {
struct IdNamespace { uint32_t mHandle; auto operator<=>(const IdNamespace&)const=default; };
struct PipelineId { uint32_t mNamespace,mHandle; auto operator<=>(const PipelineId&)const=default; };
uint64_t AsUint64(PipelineId id){return (uint64_t(id.mNamespace)<<32)+id.mHandle;}
}
''' + body((root / 'gfx/layers/LayersTypes.h').read_text(), 'struct LayersId final') + ';\n' + r'''
namespace wr { PipelineId AsPipelineId(LayersId id){return {uint32_t(uint64_t(id)>>32),uint32_t(uint64_t(id))};} }
''' + body((root / 'gfx/layers/LayersTypes.h').read_text(), 'template <typename T>\nstruct BaseTransactionId final') + ';\nusing TransactionId=BaseTransactionId<int>;\n' + r'''
enum class nsresult : uint32_t { Ok=0, Unavailable=0x80040111 };
constexpr auto NS_OK=nsresult::Ok, NS_ERROR_NOT_AVAILABLE=nsresult::Unavailable;
bool NS_FAILED(nsresult s){return (uint32_t(s)&0x80000000)!=0;}
namespace mozilla { namespace ipc { using IPCResult=int; } }
int IPC_OK(){return 0;}
struct ScriptBlocker { static bool active; ScriptBlocker(){assert(!active);active=true;} ~ScriptBlocker(){active=false;} };
bool ScriptBlocker::active=false; using nsAutoScriptBlocker=ScriptBlocker;
struct ChangesToFlush { template<class... T> ChangesToFlush(T...){} };
enum class FlushType{Layout}; enum class PaintFlags{PaintSyncDecodeImages};
struct nsIFrame {};
struct nsPresContext { int app=30; int AppUnitsPerDevPixel(){return app;} };
struct nsPIDOMWindowInner { uint64_t id=91; uint64_t WindowID(){return id;} };
struct Document;
struct nsIDocShell;
struct BrowsingContext;
struct WebRenderLayerManager;
struct WindowRenderer { WebRenderLayerManager* AsWebRender(); };
struct DisplayListAcceptance {
 nsresult status_=NS_OK; wr::PipelineId pipelineId_{0,41}; wr::IdNamespace idNamespace_{7};
 TransactionId transactionId_{21}; uint64_t fwdTransactionId_=13; uint32_t epoch_=5; LayoutDeviceRect rect_;
 auto status()const{return status_;} auto pipelineId()const{return pipelineId_;} auto idNamespace()const{return idNamespace_;}
 auto transactionId()const{return transactionId_;} auto fwdTransactionId()const{return fwdTransactionId_;}
 auto epoch()const{return epoch_;} auto rect()const{return rect_;}
};
struct PWebRenderBridgeChild { struct GetDisplayListAcceptancePromise {
 struct ResolveOrRejectValue { bool rejected=false; DisplayListAcceptance receipt;
 bool IsReject(){return rejected;} auto& ResolveValue(){assert(!rejected);return receipt;} };
}; };
struct Query {
 using Value=PWebRenderBridgeChild::GetDisplayListAcceptancePromise::ResolveOrRejectValue;
 std::function<void(Value&&)> reply;
 template<class F> void Then(int,const char*,F f){reply=std::move(f);}
 void Complete(Value v){auto f=std::move(reply); assert(f); f(std::move(v)); assert(!reply);}
};
int GetCurrentSerialEventTarget(){return 0;}
struct WebRenderBridgeChild {
 wr::IdNamespace ns{7}; wr::PipelineId pipeline{0,41}; bool open=true; Query query; int queries=0;
 bool sent=true; uint64_t fwd=13; uint64_t GetFwdTransactionId(){return fwd;}
 template<class... T> bool EndTransaction(T&&...){++fwd;return sent;}
 bool IPCOpen(){return open;} auto GetNamespace(){return ns;} auto GetPipeline(){return pipeline;}
 Query* SendGetDisplayListAcceptance(wr::IdNamespace n,TransactionId t){assert(ScriptBlocker::active);assert(n==ns);assert(t==TransactionId{21});++queries;return &query;}
};
struct WebRenderLayerManager : WindowRenderer {
''' + body(src['gfx/layers/wr/WebRenderLayerManager.h'], 'struct FullDisplayListSubmission') + ';\n' + r'''
 WebRenderBridgeChild bridge; TransactionId last{20}; bool destroyed=false;
 std::optional<FullDisplayListSubmission> record;
 std::optional<FullDisplayListSubmission>& mLastFullDisplayListSubmission=record;
 TransactionId& mLatestTransactionId=last;
 struct Allocator {int GetVsyncId(){return 0;}int GetVsyncStart(){return 0;}} allocator;
 Allocator* mTransactionIdAllocator=&allocator;int mTransactionStart=0,mURL=0;
 auto WrBridge(){return &bridge;} bool IsDestroyed(){return destroyed;}
 auto GetLastTransactionId(){return last;} auto& GetLastFullDisplayListSubmission(){return record;}
 void Submit(bool aDisplayList,bool aDisplayListBuilder,bool aRenderOffscreen,bool succeeds){
   mLastFullDisplayListSubmission.reset();
   bool containsSVGGroup=false;int refreshStart=0;struct {LayoutDeviceRect mRect;} dlData;
   bridge.sent=succeeds;
''' + send + r'''
 }
};
WebRenderLayerManager* WindowRenderer::AsWebRender(){return static_cast<WebRenderLayerManager*>(this);}
struct PuppetWidget {
 bool visible=true,destroyed=false,has=true; Scale scale,desktop; Size size; WebRenderLayerManager renderer;
 bool IsVisible(){return visible;} bool Destroyed(){return destroyed;} bool HasWindowRenderer(){return has;}
 WindowRenderer* GetWindowRenderer(){assert(has);return &renderer;} auto GetDefaultScale(){return scale;}
 auto GetDesktopToDeviceScale(){return desktop;} auto GetClientSize(){return size;}
};
struct PresShell {
 bool destroying=false,active=true,never=false,suppressed=false,visible=true; nsIFrame root; bool hasRoot=true;
 Document* doc; nsPresContext pc; std::function<void()> delayed,layout,paint;
 bool IsDestroying(){return destroying;} bool IsActive(){return active;} bool IsNeverPainting(){return never;}
 bool IsPaintingSuppressed(){return suppressed;} bool IsVisible(){return visible;}
 nsIFrame* GetRootFrame(){return hasRoot?&root:nullptr;} auto GetDocument(){return doc;}
 auto GetPresContext(){return &pc;}
 void FlushDelayedResize(){if(delayed)delayed();}
 void FlushPendingNotifications(ChangesToFlush){if(layout)layout();}
 void PaintAndRequestComposite(nsIFrame* r,WindowRenderer*,PaintFlags){assert(r && ScriptBlocker::active);if(paint)paint();}
};
struct Document { PresShell* shell; nsPIDOMWindowInner inner; nsIDocShell* docshell; bool current=true;
 auto GetInnerWindow(){return &inner;} bool IsCurrentActiveDocument(){return current;}
 auto GetPresShell(){return shell;} auto GetDocShell(){return docshell;}
 void FlushPendingNotifications(ChangesToFlush c){shell->FlushPendingNotifications(c);}
};
struct nsIDocShell { PresShell* shell; auto GetPresShell(){return shell;} };
nsIDocShell* do_GetInterface(nsIDocShell* p){return p;}
struct BrowsingContext { bool active=true; Document* doc; uint64_t id=81;
 bool IsActive(){return active;} auto GetExtantDocument(){return doc;} auto Id(){return id;}
};
''' + ack + r'''
struct BrowserChild {
 using ProduceDisplayListResolver=std::function<void(const ProducerAck&)>;
 bool mDestroyed=false,live=true,mRenderLayers=true; std::optional<bool> mLayersConnected=true;
 PuppetWidget* mPuppetWidget; BrowsingContext* mBrowsingContext; nsIDocShell* docshell;
 LayersId mLayersId{41}; Size mUnscaledInnerSize{400,300}; LayoutDeviceRect mUnscaledOuterRect; Point mClientOffset,mChromeOffset;
 bool IPCOpen(){return live;} bool CanSend(){return live;} bool IsVisible(){return mPuppetWidget->visible;}
 auto WebNavigation(){return docshell;} auto GetInnerSize(){return RoundedToInt(mUnscaledInnerSize*mPuppetWidget->scale);}
 auto GetTabId(){return uint64_t(71);}
 mozilla::ipc::IPCResult RecvUpdateDimensions(const DimensionInfo& d){mUnscaledInnerSize=d.size();mUnscaledOuterRect=d.rect();mClientOffset=d.clientOffset();mChromeOffset=d.chromeOffset();mPuppetWidget->size=GetInnerSize();return IPC_OK();}
 mozilla::ipc::IPCResult RecvProduceDisplayList(const DimensionInfo&,const uint64_t&,const double&,const double&,ProduceDisplayListResolver&&);
};
''' + receiver + r'''
namespace IPC { struct Message {enum {COMPRESSION_ALL=2};int kind;int type(){return kind;}int routing_id(){return 41;}int compress_type(){return COMPRESSION_ALL;}};}
struct MessageTask {IPC::Message message;MessageTask* previous=nullptr;bool removed=false;auto Msg(){return &message;}auto getPrevious(){return previous;}void AssertMonitorHeld(int){}void remove(){removed=true;}};
bool IsAlwaysDeferred(IPC::Message&){return true;}
void CompressionHazard(){
 MessageTask a{{1}},request{{2},&a};IPC::Message b{1};auto* aMsg=&b;int monitor=0;auto* mMonitor=&monitor;
 struct Pending{MessageTask* last;auto getLast(){return last;}}mPending{&request};
''' + compression + r'''
 assert(a.removed && !request.removed);
}
struct Fixture {
 PresShell shell; Document doc; nsIDocShell docshell; BrowsingContext bc; PuppetWidget widget; BrowserChild child;
 int resolved=0; std::optional<ProducerAck> result; DimensionInfo dims;
 Fixture():doc{&shell,{},&docshell},docshell{&shell},bc{true,&doc},child{} {
 shell.doc=&doc;child.mPuppetWidget=&widget;child.mBrowsingContext=&bc;child.docshell=&docshell;
 shell.paint=[this]{auto& m=widget.renderer; m.last={21};m.Submit(true,true,false,true);};
 }
 void Start(){child.RecvProduceDisplayList(dims,91,2,2,[this](const ProducerAck& a){++resolved;assert(resolved==1);result=a;});}
 void Complete(bool reject=false){Query::Value v;v.rejected=reject;widget.renderer.bridge.query.Complete(v);}
 void Refused(){assert(resolved==1 && result && result->status()==NS_ERROR_NOT_AVAILABLE);
''' + '\n'.join('assert(result->' + n + '()==0);' for t, n in fields if n != 'status') + r'''
 }
};
int main(){
 {Fixture f;f.Start();assert(f.resolved==0);f.Complete();assert(f.result->status()==NS_OK && f.result->transactionId()==21 && f.result->epoch()==5 && f.result->innerWidthDevicePx()==800);}
 for(int mode=0;mode<7;++mode){Fixture f;
   if(mode==0)f.shell.paint=[]{};
   if(mode==1)f.shell.paint=[&]{f.widget.renderer.last={21};f.widget.renderer.record.reset();};
   if(mode==2)f.widget.renderer.record.emplace(WebRenderLayerManager::FullDisplayListSubmission{{7},{0,41},{20},13,{}}),f.shell.paint=[]{};
   if(mode==3)f.widget.visible=false;
   if(mode==4)f.shell.hasRoot=false;
   if(mode==5)f.shell.suppressed=true;
   if(mode==6)f.bc.active=false;
   f.Start();f.Refused();assert(f.widget.renderer.bridge.queries==0);
 }
 for(int mode=0;mode<4;++mode){Fixture f;f.shell.paint=[&]{auto& m=f.widget.renderer;m.last={21};m.Submit(mode!=0,mode!=1,mode==2,mode!=3);};f.Start();f.Refused();assert(f.widget.renderer.bridge.queries==0);}
 for(int mode=0;mode<10;++mode){Fixture f;f.Start();
   if(mode==0)f.child.live=false;
   if(mode==1)f.doc.inner.id=92;
   if(mode==2)f.bc.doc=nullptr;
   if(mode==3)f.widget.renderer.bridge.ns={8};
   if(mode==4)f.widget.size={801,600};
   if(mode==5)f.widget.scale.scale=3;
   if(mode==6)f.widget.desktop.scale=3;
   if(mode==7)f.docshell.shell=nullptr;
   if(mode==8)f.widget.renderer.destroyed=true;
   f.Complete(mode==9);f.Refused();
 }
 {Fixture f;f.shell.layout=[&]{f.bc.doc=nullptr;};f.Start();f.Refused();}
 {Fixture f;f.shell.layout=[&]{f.widget.renderer.bridge.ns={8};};f.Start();f.Refused();}
 // Layout itself can submit: the baseline must be sampled after that work.
 {Fixture f;f.shell.layout=f.shell.paint;f.shell.paint=[]{};f.Start();f.Refused();}
 // Compression-all may erase ordinary A before request A and ordinary B.
 // Only carried A is applied by the receiver; B arriving before reply refuses.
 {CompressionHazard();Fixture f;f.child.mUnscaledInnerSize={500,300};f.widget.size={1000,600};f.Start();assert(f.widget.size.width==800);DimensionInfo b=f.dims;b.s={500,300};f.child.RecvUpdateDimensions(b);f.Complete();f.Refused();}
 for(int mode=0;mode<7;++mode){Fixture f;f.Start();auto& q=f.widget.renderer.bridge.query;Query::Value v;
   if(mode==0)v.receipt.status_=NS_ERROR_NOT_AVAILABLE;
   if(mode==1)v.receipt.pipelineId_={0,42};
   if(mode==2)v.receipt.idNamespace_={8};
   if(mode==3)v.receipt.transactionId_={22};
   if(mode==4)v.receipt.fwdTransactionId_=14;
   if(mode==5)v.receipt.epoch_=0;
   if(mode==6)v.receipt.rect_.x=1;
   q.Complete(v);f.Refused();
 }
 std::cout<<"actual receiver: fresh same-size, stale/no-paint, carried A/B, replacement/rejection, full tuple, resolver once PASS\n";
}
'''
    target = output / 'receiver'
    target.mkdir(mode=0o700)
    compile_run(code, target)


def run_parent(src, output):
    text = src['dom/ipc/BrowserParent.cpp']
    signature = 'RefPtr<PBrowserParent::ProduceDisplayListPromise>\nBrowserParent::ProduceDisplayListForCurrentDimensions('
    assert signature in text, 'API-contract RED: owning parent helper absent'
    helper = body(text, signature)
    code = r'''
#include <cassert>
#include <cmath>
#include <cstdint>
#include <iostream>
template<class T> using RefPtr=T*;
template<class T> using nsCOMPtr=T*;
namespace mozilla { namespace ipc { enum class ResponseRejectReason{SendError}; } }
using mozilla::ipc::ResponseRejectReason;
struct Promise { bool rejected=false; static Promise* CreateAndReject(ResponseRejectReason,const char*){static Promise p{true};return &p;} };
struct PBrowserParent{using ProduceDisplayListPromise=Promise;};
struct Size {int width=800,height=600;int Width()const{return width;}int Height()const{return height;}};
struct Scale {double scale=2;bool operator==(const Scale&)const=default;};
struct DimensionInfo{Size size;};
struct nsIWidget {Scale scale,desktop; auto GetDefaultScale(){return scale;} auto GetDesktopToDeviceScale(){return desktop;} bool Destroyed(){return false;}};
struct BrowserParent;
struct Element {bool connected=true;bool IsInComposedDoc(){return connected;}};
struct CanonicalBrowsingContext;
struct WindowGlobal {BrowserParent* parent;uint64_t id=91;CanonicalBrowsingContext* bc=nullptr;auto GetBrowsingContext(){return bc;}bool CanSend(){return true;}auto GetBrowserParent(){return parent;}auto InnerWindowId(){return id;}bool IsCurrentGlobal(){return true;}};
struct CanonicalBrowsingContext {WindowGlobal* global;auto GetCurrentWindowGlobal(){return global;}};
struct nsFrameLoader {BrowserParent* parent;Element* owner=nullptr;CanonicalBrowsingContext* bc=nullptr;auto GetOwnerContent(){return owner;}auto GetExtantBrowsingContext(){return bc;}auto GetBrowserParent(){return parent;}};
struct BrowserParent:PBrowserParent {
 bool mIsDestroyed=false,live=true,mUpdatedDimensions=true;Size mDimensions,mRect;Scale mDefaultScale,mDesktopToDeviceScale;
 Element* mFrameElement;CanonicalBrowsingContext* mBrowsingContext;nsIWidget* widget;nsFrameLoader* loader;
 bool CanSend(){return live;}auto GetWidget(){return widget;}auto GetFrameLoader(){return loader;}
 DimensionInfo GetDimensionInfo(){return {mDimensions};}
 int sends=0;uint64_t sentId=0;DimensionInfo carried;double sentDefault=0,sentDesktop=0;Promise promise;
 auto SendProduceDisplayList(DimensionInfo d,uint64_t id,double a,double b){++sends;carried=d;sentId=id;sentDefault=a;sentDesktop=b;return &promise;}
 RefPtr<ProduceDisplayListPromise> ProduceDisplayListForCurrentDimensions(uint64_t);
};
''' + helper + r'''
int main(){
 for(int mode=0;mode<12;++mode){BrowserParent p;Element e;WindowGlobal w{&p};CanonicalBrowsingContext bc{&w};nsIWidget widget;nsFrameLoader loader{&p};
 p.mFrameElement=&e;p.mBrowsingContext=&bc;p.widget=&widget;p.loader=&loader;
 w.bc=&bc;
 loader.owner=&e;loader.bc=&bc;
 if(mode==1)p.mIsDestroyed=true;if(mode==2)p.live=false;if(mode==3)p.mUpdatedDimensions=false;
 if(mode==4)p.mDimensions.width=0;if(mode==5)w.id=92;if(mode==6)w.parent=nullptr;
 if(mode==7)widget.scale.scale=3;if(mode==8)widget.desktop.scale=3;if(mode==9)loader.parent=nullptr;
 if(mode==10)loader.owner=nullptr;if(mode==11)loader.bc=nullptr;
 auto result=p.ProduceDisplayListForCurrentDimensions(91);
 if(mode){assert(result->rejected && p.sends==0);}else{assert(!result->rejected && p.sends==1 && p.carried.size.width==800 && p.sentId==91 && p.sentDefault==2 && p.sentDesktop==2);}
 }
 std::cout<<"actual parent: carried snapshot, owner/document/scale/liveness refusal PASS\n";
}
'''
    target = output / 'parent'
    target.mkdir(mode=0o700)
    compile_run(code, target)


def compile_run(code, output):
    source = output / 'actual-bodies.cpp'
    source.write_text(code)
    scratch = pathlib.Path(tempfile.mkdtemp(prefix='zen-producer-', dir='/Users/kenkuang/.hermes/cache/scratch'))
    os.chmod(scratch, 0o700)
    env = dict(os.environ, TMPDIR=str(scratch))
    for label, argv in [('compile', ['/usr/bin/clang++', '-std=c++20', '-Wall', '-Wextra', str(source), '-o', str(output / 'check')]),
                        ('run', [str(output / 'check')])]:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, umask=0o077)
        stdout, stderr = proc.communicate()
        (output / (label + '.stdout.raw')).write_bytes(stdout)
        (output / (label + '.stderr.raw')).write_bytes(stderr)
        (output / (label + '.json')).write_text(json.dumps({'argv': argv, 'pid': proc.pid, 'actualWait': proc.returncode, 'scratch': str(scratch)}, indent=2))
        print(stdout.decode(), stderr.decode(), end='')
        assert proc.returncode == 0, label + ' failed'



if __name__ == '__main__':
    main()
