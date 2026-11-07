#!/usr/bin/env python3
"""Actual frontdoor bodies, external Gecko/Cocoa/IPC doubles; no browser/build.

The native extraction is compiled with Foundation only, never AppKit or UI.
Its real JSON serialization feeds the actual exported ESM wrapper. RefPtr,
geometry/layout, DOM and the existing core IPC request are external doubles.
This is not generated XPIDL/PBrowser or whole-Gecko compilation/lifetime proof.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
NODE = "/Users/kenkuang/.local/share/mise/installs/node/22.22.0/bin/node"
PATHS = ["src/zen/toolkit/common/nsIZenCommonUtils.idl", "src/zen/toolkit/common/ZenCommonUtils.cpp", "src/zen/toolkit/common/ZenProfileHostNative.h", "src/zen/toolkit/common/cocoa/ZenProfileHost.mm", "src/zen/common/modules/ZenCommonUtils.mjs"]


def definition(text, signature):
    start = text.index(signature)
    opening = text.index("{", start)
    depth = 0
    for token in re.finditer(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|//[^\n]*|/\*[\s\S]*?\*/|[{}]', text[opening:]):
        if token.group() == "{":
            depth += 1
        elif token.group() == "}":
            depth -= 1
            if depth == 0:
                return text[start:opening + token.end()]
    raise AssertionError("Unclosed definition: " + signature)


NATIVE = r'''
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <functional>
#include <fstream>
#include <iostream>
#include <limits>
#include <memory>
#include <string>
#include <utility>
enum class nsresult : uint32_t { OK, UNAVAILABLE, INVALID, FAILURE };
constexpr auto NS_OK=nsresult::OK, NS_ERROR_NOT_AVAILABLE=nsresult::UNAVAILABLE,
 NS_ERROR_INVALID_ARG=nsresult::INVALID, NS_ERROR_FAILURE=nsresult::FAILURE;
bool NS_FAILED(nsresult n){return n!=NS_OK;} bool NS_SUCCEEDED(nsresult n){return n==NS_OK;}
struct JSContext{}; struct nsIGlobalObject{};
namespace mozilla { namespace dom {} }
// Deliberately non-owning DOM/refcount boundaries; ObjC source retain is real MRC.
template<class T> struct already_AddRefed {T* p; already_AddRefed(T* q):p(q){} already_AddRefed(std::nullptr_t):p(nullptr){} };
template<class T> struct RefPtr { T* p=nullptr; RefPtr()=default; RefPtr(T* q):p(q){} RefPtr(already_AddRefed<T> q):p(q.p){}
 T* operator->()const{return p;} operator T*()const{return p;} T* get()const{return p;}
 void forget(T** q){*q=p;p=nullptr;} };
template<class T> using nsCOMPtr=RefPtr<T>;
struct nsACString:std::string {using std::string::string; bool IsEmpty()const{return empty();}
 uint32_t Length()const{return size();} char First()const{return at(0);} char CharAt(uint32_t n)const{return at(n);} };
std::string NS_ConvertUTF8toUTF16(const char* s){return s;}
bool mainThread=true, chrome=true;
bool NS_IsMainThread(){return mainThread;}
struct nsContentUtils {static bool IsCallerChrome(){return chrome;}};
namespace xpc {nsIGlobalObject* CurrentNativeGlobal(JSContext*) {static nsIGlobalObject g;return &g;} }
namespace mozilla {
struct ErrorResult {bool Failed(){return false;} nsresult StealNSResult(){return NS_ERROR_FAILURE;}};
namespace layers { struct NativeLayerRootCA {}; }
struct Scale {double scale;};
using CSSToLayoutDeviceScale=Scale;
struct Size {double width=120,height=80; Size Rounded()const{return {std::round(width),std::round(height)};}
 bool operator==(const Size&)const=default;};
Size operator*(Size s, Scale f){return {s.width*f.scale,s.height*f.scale};}
Size RoundedToInt(Size s){return s.Rounded();}
struct Rect {double x=0,y=0,w=120,h=80; bool IsEqualEdges(const Rect& r)const{return x==r.x&&y==r.y&&w==r.w&&h==r.h;}};
namespace wr {uint64_t AsPipelineId(uint64_t n){return n;} uint64_t AsUint64(uint64_t n){return n;}}
struct ChangesToFlush {ChangesToFlush(int,bool,bool){}}; struct FlushType {static constexpr int Layout=1;};
struct PresShell {bool destroyed=false; std::function<void()> flush; bool IsDestroying(){return destroyed;}
 void FlushDelayedResize(){if(flush)flush();}};
namespace dom {
struct Promise {bool settled=false,rejected=false; std::string json;
 static Promise* Create(nsIGlobalObject*,ErrorResult&){return new Promise;}
 void MaybeReject(nsresult){assert(!settled);settled=true;rejected=true;}
 void MaybeResolve(std::string s){assert(!settled);settled=true;json=std::move(s);} };
struct Document {PresShell* shell; std::function<void()> flush; PresShell* GetPresShell(){return shell;}
 void FlushPendingNotifications(ChangesToFlush){if(flush)flush();}};
struct Element; struct BrowserParent; struct WindowGlobalParent; struct CanonicalBrowsingContext;
struct ContentParent {uint64_t id=9007199254740997ULL; uint64_t ChildID(){return id;}};
struct DimensionInfo {Rect r; Size s; int client=0, chrome=0;
 Rect rect()const{return r;} Size size()const{return s;} int clientOffset()const{return client;} int chromeOffset()const{return chrome;}};
struct ProducerAck {
__FIELDS__
};
struct NativeReply {bool reject=false; ProducerAck ack; bool IsReject(){return reject;} const ProducerAck& ResolveValue(){return ack;}};
struct CorePromise {using ResolveOrRejectValue=NativeReply; std::function<void(NativeReply&&)> callback;
 template<class F> void Then(int,const char*,F f){callback=std::move(f);}
 void complete(NativeReply reply={}){auto f=std::move(callback);f(std::move(reply));}};
struct PBrowserParent {using ProduceDisplayListPromise=CorePromise;};
struct CanonicalBrowsingContext {WindowGlobalParent* global; uint64_t id=9007199254740993ULL;
 WindowGlobalParent* GetCurrentWindowGlobal(){return global;} uint64_t Id(){return id;} };
struct WindowGlobalParent {BrowserParent* parent; CanonicalBrowsingContext* bc; ContentParent* cp;
 uint64_t id=9007199254740995ULL; bool live=true,current=true;
 bool CanSend(){return live;} bool IsCurrentGlobal(){return current;}
 BrowserParent* GetBrowserParent(){return parent;} CanonicalBrowsingContext* GetBrowsingContext(){return bc;}
 ContentParent* GetContentParent(){return cp;} uint64_t InnerWindowId(){return id;} };
}
}
using namespace mozilla; using namespace mozilla::dom;
struct nsIWidget {Scale ds{2},desktop{2}; bool destroyed=false;
 bool Destroyed(){return destroyed;} Scale GetDefaultScale(){return ds;} Scale GetDesktopToDeviceScale(){return desktop;}};
struct nsFrameLoader;
struct nsFrameLoaderOwner {nsFrameLoader* loader; already_AddRefed<nsFrameLoader> GetFrameLoader(){return loader;}};
namespace mozilla::dom {
struct Element:nsFrameLoaderOwner {Document* doc; bool connected=true;
 Document* OwnerDoc(){return doc;} bool IsInComposedDoc(){return connected;}};
struct BrowserParent {Element* element; nsIWidget* widget; CanonicalBrowsingContext* bc; ContentParent* cp;
 bool live=true; uint64_t tab=9007199254740999ULL,layers=9007199254741001ULL; DimensionInfo dim; CorePromise core; int sends=0;
 Element* GetOwnerElement(){return element;} already_AddRefed<nsIWidget> GetWidget(){return widget;}
 CanonicalBrowsingContext* GetBrowsingContext(){return bc;} ContentParent* Manager(){return cp;}
 bool CanSend(){return live;} uint64_t GetTabId(){return tab;} uint64_t GetLayersId(){return layers;}
 DimensionInfo GetDimensionInfo(){return dim;}
 CorePromise* ProduceDisplayListForCurrentDimensions(uint64_t id){assert(id==bc->global->id);sends++;return &core;} };
}
struct nsFrameLoader {Element* element; BrowserParent* parent; CanonicalBrowsingContext* bc;
 Element* GetOwnerContent(){return element;} BrowserParent* GetBrowserParent(){return parent;}
 CanonicalBrowsingContext* GetExtantBrowsingContext(){return bc;}};
nsFrameLoaderOwner* do_QueryObject(Element* e){return e;}
struct mozIDOMWindowProxy{};
// NSObject identity stands in for NSWindow: never allocate NSApplication/windows.
typedef NSObject NSWindow;
struct nsGlobalWindowOuter:mozIDOMWindowProxy {Document* doc; NSWindow* window; nsIWidget* widget; bool live=true;
 static nsGlobalWindowOuter* Cast(mozIDOMWindowProxy* p){return static_cast<nsGlobalWindowOuter*>(p);}
 Document* GetDoc(){return doc;} };
static char sProfileSourceKey;
struct Identity {uint32_t pid=7;uint64_t token=99,widget=111,root=222,generation=3;};
int sourceDeaths=0;
@interface ZenProfileSource:NSObject { @public RefPtr<nsIWidget> widget; RefPtr<layers::NativeLayerRootCA> root;
 Identity identity; bool observing; bool live; }
-(BOOL)valid;
@end
@implementation ZenProfileSource
-(BOOL)valid {return live;}
-(void)dealloc {sourceDeaths++;[super dealloc];}
@end
#define NS_OBJC_BEGIN_TRY_IGNORE_BLOCK
#define NS_OBJC_END_TRY_IGNORE_BLOCK
__RETAIN__
int GetCurrentSerialEventTarget(){return 0;}
namespace zen::profilehost {
nsresult Resolve(mozIDOMWindowProxy* dom,NSWindow** w,nsCOMPtr<nsIWidget>& widget){
 if(!dom)return NS_ERROR_INVALID_ARG; auto* o=nsGlobalWindowOuter::Cast(dom);
 if(!o->live)return NS_ERROR_NOT_AVAILABLE;*w=o->window;widget=o->widget;return NS_OK;}
__DECIMAL__
__REQUEST__
}
using zen::profilehost::RequestProducerAck;
struct Fixture {
 nsIWidget widget; PresShell shell; Document doc{&shell}; Element element; nsFrameLoader loader;
 ContentParent cp; CanonicalBrowsingContext bc; WindowGlobalParent inner; BrowserParent parent;
 layers::NativeLayerRootCA root; nsGlobalWindowOuter outer; ZenProfileSource* source;
 Fixture(){element.doc=&doc;element.loader=&loader;loader={&element,&parent,&bc};
 inner.parent=&parent;inner.bc=&bc;inner.cp=&cp;bc.global=&inner;
 parent.element=&element;parent.widget=&widget;parent.bc=&bc;parent.cp=&cp;
 outer.doc=&doc;outer.widget=&widget;outer.window=[[NSObject alloc]init];
 source=[[ZenProfileSource alloc]init];source->widget=&widget;source->root=&root;source->identity=Identity{};
 source->identity.widget=reinterpret_cast<uintptr_t>(&widget);source->identity.root=reinterpret_cast<uintptr_t>(&root);
 source->observing=true;source->live=true;objc_setAssociatedObject(outer.window,&sProfileSourceKey,source,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
 ~Fixture(){parent.core.callback=nullptr;objc_setAssociatedObject(outer.window,&sProfileSourceKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);[source release];[outer.window release];}
 Promise* request(const char* generation="3",Element* e=nullptr){Promise* p=nullptr;assert(RequestProducerAck(&outer,e?e:&element,nsACString(generation),nullptr,&p)==NS_OK);return p;}
 NativeReply reply(){NativeReply r;auto& a=r.ack;a.v_status=NS_OK;a.v_browsingContextId=bc.id;a.v_innerWindowId=inner.id;
 a.v_tabId=parent.tab;a.v_layersId=parent.layers;a.v_pipelineId=parent.layers;a.v_idNamespace=9;
 a.v_transactionId=9007199254741003ULL;a.v_fwdTransactionId=9007199254741005ULL;a.v_epoch=11;
 a.v_innerWidthDevicePx=240;a.v_innerHeightDevicePx=160;a.v_widgetDefaultScale=2;a.v_desktopToDeviceScale=2;a.v_appUnitsPerDevPixel=30;return r;}
};
int main(int argc,char** argv){@autoreleasepool {
 {Fixture f;auto* p=f.request();assert(!p->settled&&f.parent.sends==1);f.parent.core.complete(f.reply());
 assert(p->settled&&!p->rejected);std::ofstream(argv[1])<<p->json;delete p;}
 // Admission/source provenance and script-capable work.
 for(int i=0;i<10;i++){Fixture f;Element other=f.element;const char* gen="3";
 if(i==0)objc_setAssociatedObject(f.outer.window,&sProfileSourceKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
 if(i==1)gen="4";if(i==2)gen="03";if(i==3)gen="18446744073709551616";
 if(i==4)f.source->live=false;if(i==5)other.doc=nullptr;
 if(i==6)f.loader.element=&other;if(i==7)f.loader.bc=nullptr;
 if(i==8)f.shell.flush=[&]{f.element.connected=false;};
 if(i==9)f.doc.flush=[&]{f.outer.doc=nullptr;};
 auto* p=f.request(gen,i==5?&other:nullptr);assert(p->rejected&&f.parent.sends==0);delete p;}
 // Revalidate all ownership families, source replacement, geometry and scales.
 for(int i=0;i<20;i++){Fixture f;auto* p=f.request();assert(!p->settled);
 switch(i){case 0:f.source->live=false;break;case 1:f.source->identity.generation++;break;
 case 2:objc_setAssociatedObject(f.outer.window,&sProfileSourceKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);break;
 case 3:f.element.loader=nullptr;break;case 4:f.loader.element=nullptr;break;
 case 5:f.loader.parent=nullptr;break;case 6:f.loader.bc=nullptr;break;
 case 7:f.bc.global=nullptr;break;case 8:f.inner.parent=nullptr;break;
 case 9:f.parent.cp=nullptr;break;case 10:f.cp.id++;break;case 11:f.inner.id++;break;
 case 12:f.outer.doc=nullptr;break;case 13:f.outer.live=false;break;
 case 14:f.parent.dim.s.width++;break;case 15:f.parent.dim.client++;break;
 case 16:f.widget.ds.scale=1;break;case 17:f.widget.desktop.scale=1;break;
 case 18:f.parent.widget=nullptr;break;case 19:f.source->root=nullptr;break;}
 f.parent.core.complete(f.reply());assert(p->rejected);delete p;}
 {Fixture f;auto* p=f.request();auto* replacement=[[ZenProfileSource alloc]init];
 replacement->widget=&f.widget;replacement->root=&f.root;replacement->identity=f.source->identity;
 replacement->identity.generation++;replacement->observing=true;replacement->live=true;
 f.source->live=false;objc_setAssociatedObject(f.outer.window,&sProfileSourceKey,replacement,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
 f.parent.core.complete(f.reply());assert(p->rejected&&[replacement valid]);
 assert(objc_getAssociatedObject(f.outer.window,&sProfileSourceKey)==replacement);[replacement release];delete p;}
 for(int i=0;i<15;i++){Fixture f;auto* p=f.request();auto r=f.reply();
 switch(i){case 0:r.reject=true;break;case 1:r.ack.v_status=NS_ERROR_FAILURE;break;
 case 2:r.ack.v_browsingContextId++;break;case 3:r.ack.v_innerWindowId++;break;
 case 4:r.ack.v_tabId++;break;case 5:r.ack.v_layersId++;break;case 6:r.ack.v_pipelineId++;break;
 case 7:r.ack.v_transactionId=0;break;case 8:r.ack.v_fwdTransactionId=0;break;
 case 9:r.ack.v_idNamespace=0;break;case 10:r.ack.v_epoch=0;break;
 case 11:r.ack.v_innerWidthDevicePx++;break;case 12:r.ack.v_widgetDefaultScale=1;break;
 case 13:r.ack.v_desktopToDeviceScale=1;break;case 14:r.ack.v_appUnitsPerDevPixel=0;break;}
 f.parent.core.complete(std::move(r));assert(p->rejected);delete p;}
 // Actual shared MRC guard retains through either asynchronous outcome.
 for(bool reject:{false,true}){Fixture f;auto* p=f.request();int before=sourceDeaths;
 objc_setAssociatedObject(f.outer.window,&sProfileSourceKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
 [f.source release];f.source=nil;assert(sourceDeaths==before);auto r=f.reply();r.reject=reject;
 f.parent.core.complete(std::move(r));assert(p->rejected&&sourceDeaths==before+1);delete p;}
 {Fixture f;Promise* p=reinterpret_cast<Promise*>(1);chrome=false;
 assert(RequestProducerAck(&f.outer,&f.element,nsACString("3"),nullptr,&p)==NS_ERROR_NOT_AVAILABLE&&p==nullptr);chrome=true;}
 {Fixture f;Promise* p=reinterpret_cast<Promise*>(1);mainThread=false;
 assert(RequestProducerAck(&f.outer,&f.element,nsACString("3"),nullptr,&p)==NS_ERROR_NOT_AVAILABLE&&p==nullptr);mainThread=true;}
 for(int i=0;i<4;i++){Fixture f;if(i==0)f.widget.ds.scale=0;
 if(i==1)f.widget.desktop.scale=std::numeric_limits<double>::quiet_NaN();
 if(i==2)f.parent.dim.s.width=std::numeric_limits<double>::infinity();
 if(i==3)f.parent.dim.s.height=double(INT32_MAX);
 auto* p=f.request();assert(p->rejected&&f.parent.sends==0);delete p;}
 std::cout<<"native actual-body ownership/serialization/MRC groups PASS\n";
} }
'''

JS = r'''
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
const receipt = JSON.parse(await readFile(process.argv[3], "utf8"));
function events() {const listeners=new Map();return {listeners,
 addEventListener(type, fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
 removeEventListener(type, fn){listeners.get(type)?.delete(fn);},
 fire(type,target=this){for(const fn of listeners.get(type)||[])fn({target});},
 count(){return [...listeners.values()].reduce((n,s)=>n+s.size,0);}};}
function fixture(){const w={...events(),closed:false,document:{},timers:new Map(),
 setTimeout(fn,ms){assert.equal(ms,5000);this.timers.set(1,fn);return 1;},clearTimeout(id){this.timers.delete(id);}};
 w.performance={now:()=>w.clock??0};
 const browser={isConnected:true,isRemoteBrowser:true,ownerDocument:w.document,frameLoader:{remoteTab:{}},
 browsingContext:{currentWindowGlobal:{innerWindowId:9007199254740995}},webProgress:{isLoadingDocument:false}};
 const tab={linkedBrowser:browser,isConnected:true,hasAttribute(){return false;}};
 const gb={selectedBrowser:browser,selectedTab:tab,selectedBrowsers:[browser],tabContainer:events(),progress:new Set(),
 addTabsProgressListener(p){this.progress.add(p);},removeTabsProgressListener(p){this.progress.delete(p);}};
 w.gBrowser=gb;return {w,browser,tab,gb,clean(){assert.equal(w.count()+gb.tabContainer.count()+gb.progress.size+w.timers.size,0);}};}
let target, native, calls=0;
globalThis.window={};
globalThis.Ci={nsIWebProgressListener:{STATE_START:1}};
globalThis.Services={zen:{requestProfileHostProducerAck(w,b,g){calls++;assert.equal(w,target.w);assert.equal(b,target.browser);assert.equal(g,"3");
 assert.equal(w.count(),2);assert.equal(w.gBrowser.tabContainer.count(),3);assert.equal(w.gBrowser.progress.size,1);return native();}},
 wm:{getMostRecentWindow(){throw Error("forbidden implicit source fallback");}}};
const {requestProfileHostProducerAck:request}=await import(pathToFileURL(process.argv[2]));
function begin(f=fixture()){target=f;let resolve,reject;native=()=>new Promise((yes,no)=>{resolve=yes;reject=no;});const p=request(f.w,"3");
 return {...f,p,resolve,reject};}
{const f=begin();f.resolve(JSON.stringify(receipt));const r=await f.p;assert.deepEqual(r,receipt);assert(Object.isFrozen(r));f.clean();}
// Cancellation, observed away/back, suppressed events, navigation/BFCache and late delivery.
for(const change of [
 f=>{f.gb.tabContainer.fire("TabSelect");f.gb.tabContainer.fire("TabSelect");},
 f=>{f.gb.selectedBrowser={};},f=>{f.gb.selectedBrowsers=[f.browser,{}];},
 f=>{f.browser.frameLoader={remoteTab:{}};},f=>{f.browser.frameLoader.remoteTab={};},
 f=>{f.browser.browsingContext={};},f=>{f.browser.browsingContext.currentWindowGlobal={innerWindowId:42};},
 f=>{f.browser.ownerDocument={};},f=>{f.browser.webProgress.isLoadingDocument=true;},
 f=>f.gb.tabContainer.fire("TabClose",f.tab),f=>f.gb.tabContainer.fire("BeforeTabRemotenessChange",f.tab),
 f=>{f.w.closed=true;f.w.fire("unload");},
 f=>{for(const p of f.gb.progress)p.onStateChange(f.browser,{isTopLevel:true},null,1);},
 f=>{for(const p of f.gb.progress)p.onLocationChange(f.browser,{isTopLevel:true});},
 f=>{for(const fn of f.w.timers.values())fn();},
]){const f=begin();const rejected=assert.rejects(f.p);change(f);f.resolve(JSON.stringify(receipt));await rejected;f.clean();}
// Clock deadline must refuse even when a delayed timer task has not fired.
{const f=begin();f.w.clock=5000;f.resolve(JSON.stringify(receipt));await assert.rejects(f.p);f.clean();}
// Cancellation settles without a native reply and still ignores its eventual success.
{const f=begin();const rejected=assert.rejects(f.p);f.gb.tabContainer.fire("TabSelect");await rejected;f.clean();f.resolve(JSON.stringify(receipt));await Promise.resolve();f.clean();}
// Other tabs/windows and subframes must not cancel the original browser.
{const f=begin();f.gb.tabContainer.fire("TabClose",{});
 for(const p of f.gb.progress){p.onStateChange({}, {isTopLevel:true},null,1);p.onLocationChange(f.browser,{isTopLevel:false});}
 f.resolve(JSON.stringify(receipt));await f.p;f.clean();}
for(const mutate of [r=>r.sourceWidget=9007199254740993,r=>r.transactionId="01",r=>r.innerWindowId="0",
 r=>r.contentParentId="18446744073709551616",r=>r.epoch="4294967296",r=>r.sourceGeneration="4",
 r=>r.pipelineId="4",r=>r.widgetDefaultScale=0,r=>r.appUnitsPerDevPixel=0,r=>r.innerWidthDevicePx=1.5,
 r=>r.extra={},r=>r.status="rendered",r=>r.version=2]){
 const f=begin(),r={...receipt};mutate(r);f.resolve(JSON.stringify(r));await assert.rejects(f.p);f.clean();}
for(const value of ["[]","null","{}","not json",receipt]){const f=begin();f.resolve(value);await assert.rejects(f.p);f.clean();}
for(const change of [f=>f.gb.selectedBrowsers.push({}),f=>f.browser.isRemoteBrowser=false,
 f=>f.browser.webProgress.isLoadingDocument=true,f=>f.browser.isConnected=false,
 f=>f.browser.ownerDocument={},f=>f.w.gBrowser=null]){
 const f=fixture();change(f);const before=calls;await assert.rejects(request(f.w,"3"));assert.equal(calls,before);f.clean();}
for(const generation of ["0","03","18446744073709551616",3])await assert.rejects(request(fixture().w,generation));
{const f=begin();f.reject(Error("native source missing/stale"));await assert.rejects(f.p);f.clean();}
{const f=fixture();target=f;native=()=>{f.gb.tabContainer.fire("TabSelect");throw Error("sync native refusal");};
 await assert.rejects(request(f.w,"3"));f.clean();await new Promise(resolve=>setImmediate(resolve));}
{const f=fixture();target=f;native=()=>{throw Error("sync native refusal");};await assert.rejects(request(f.w,"3"));f.clean();}
console.log("actual exported wrapper explicit-source/cancellation/schema/cleanup groups PASS");
'''


def run(command, output, stem, env):
    p = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, umask=0o077)
    stdout, stderr = p.communicate(timeout=90)
    (output / (stem + ".stdout")).write_bytes(stdout)
    (output / (stem + ".stderr")).write_bytes(stderr)
    (output / (stem + ".wait.json")).write_text(json.dumps({"command": command, "actualWait": p.returncode, "TMPDIR": env["TMPDIR"]}, indent=2))
    assert p.returncode == 0, stem + " failed; see retained raw stderr"
    print(stdout.decode(), end="")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--source-root", type=Path, default=ROOT)
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    a.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    sources = {f: (a.source_root / f).read_text() for f in PATHS}
    bindings = {f: hashlib.sha256(s.encode()).hexdigest() for f, s in sources.items()}
    bindings[str(Path(__file__).resolve())] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    (a.output / "inputs.json").write_text(json.dumps(bindings, indent=2))
    assert "export async function requestProfileHostProducerAck(" in sources[PATHS[4]], "API-contract RED: exported explicit-source ProducerAck wrapper absent"
    assert "nsresult RequestProducerAck(" in sources[PATHS[3]], "API-contract RED: native ProducerAck method absent"
    assert re.search(r'\[implicit_jscontext\]\s*Promise requestProfileHostProducerAck\(in mozIDOMWindowProxy window,\s*in Element browser,\s*in ACString sourceGeneration\)', sources[PATHS[0]])
    assert "webidl Element;" in sources[PATHS[0]]
    assert "aacbc3ad-b30d-4e94-880b-e21b5f635330" not in sources[PATHS[0]]
    forwarding = definition(sources[PATHS[1]], "ZenCommonUtils::RequestProfileHostProducerAck(")
    assert "*aPromise = nullptr;" in forwarding and "profilehost::RequestProducerAck(" in forwarding
    assert "#else\n  return NS_ERROR_NOT_AVAILABLE;" in forwarding
    native_body = definition(sources[PATHS[3]], "nsresult RequestProducerAck(")
    wrapper_body = definition(sources[PATHS[4]], "export async function requestProfileHostProducerAck(")
    assert not any(token in native_body for token in ["StartSource(", "invalidate]", "GetMostRecent", "identity.token", "RenderLayers("])
    assert "ProduceDisplayListForCurrentDimensions(innerId)" in native_body
    assert "nsZenMultiWindowFeature" not in wrapper_body and "window.gBrowser" not in wrapper_body
    protocol = ROOT / "engine/dom/ipc/PBrowser.ipdl"
    retain_owner = ROOT / "engine/widget/cocoa/nsCocoaUtils.h"
    owners = [ROOT / f for f in ["engine/dom/base/nsFrameLoaderOwner.h", "engine/dom/ipc/BrowserParent.h", "engine/gfx/2d/Point.h", "src/zen/common/jar.inc.mn", "src/zen/toolkit/common/moz.build", "src/zen/toolkit/common/cocoa/moz.build", "src/zen/toolkit/common/components.conf"]]
    assert "already_AddRefed<nsFrameLoader> GetFrameLoader();" in owners[0].read_text()
    assert "already_AddRefed<nsIWidget> GetWidget() const;" in owners[1].read_text()
    assert "RoundedToInt(const SizeTyped<Units>& aSize)" in owners[2].read_text()
    assert "content/browser/zen-components/ZenCommonUtils.mjs" in owners[3].read_text()
    assert '"nsIZenCommonUtils.idl"' in owners[4].read_text()
    assert '"ZenProfileHost.mm"' in owners[5].read_text()
    assert "'js_name': 'zen'" in owners[6].read_text()
    dependencies = {str(f): hashlib.sha256(f.read_bytes()).hexdigest() for f in [protocol, retain_owner, *owners]}
    (a.output / "dependency-inputs.json").write_text(json.dumps(dependencies, indent=2))
    match = re.search(r'struct ProducerAck\s*\{(.*?)\};', protocol.read_text(), re.S)
    assert match, "Missing actual ProducerAck protocol"
    fields = match.group(1)
    defaults = {"status": "NS_OK"}
    declarations = "\n".join(f"{kind} v_{name}={defaults.get(name, '0')}; {kind} {name}()const{{return v_{name};}}" for kind, name in re.findall(r'(\w+)\s+(\w+);', fields))
    retain = definition(retain_owner.read_text(), "class nsAutoRetainCocoaObject {") + ";"
    native = NATIVE.replace("__FIELDS__", declarations).replace("__RETAIN__", retain)
    native = native.replace("__DECIMAL__", definition(sources[PATHS[3]], "static bool Decimal("))
    native = native.replace("__REQUEST__", definition(sources[PATHS[3]], "nsresult RequestProducerAck("))
    (a.output / "native.mm").write_text(native)
    (a.output / "wrapper.mjs").write_text(sources[PATHS[4]])
    (a.output / "check.mjs").write_text(JS)
    scratch = tempfile.mkdtemp(prefix="zen-producer-frontdoor-", dir=str(Path.home() / ".hermes/cache/scratch"))
    os.chmod(scratch, 0o700)
    env = {**os.environ, "TMPDIR": scratch, "PYTHONDONTWRITEBYTECODE": "1"}
    run(["/usr/bin/clang++", "-std=c++20", "-fno-objc-arc", "-framework", "Foundation", str(a.output / "native.mm"), "-o", str(a.output / "native")], a.output, "native-compile", env)
    run([str(a.output / "native"), str(a.output / "receipt.json")], a.output, "native-run", env)
    run([NODE, str(a.output / "check.mjs"), str(a.output / "wrapper.mjs"), str(a.output / "receipt.json")], a.output, "wrapper-run", env)
    assert all(hashlib.sha256((a.source_root / f).read_bytes()).hexdigest() == bindings[f] for f in PATHS)
    print("PASS: native JSON -> exported wrapper; external boundaries only, no Gecko/IPC/UI proof")


if __name__ == "__main__":
    main()
