#!/usr/bin/env python3
"""Offline production control helpers + actual JS consumer; no native acceptance.

Uses installed Mach declarations with every executable Mach endpoint replaced by
an explicit inert double. Never imports AppKit/Foundation or executes the browser.
--root permits exactly the same oracle against an immutable source preimage.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import re

ROOT = Path(__file__).resolve().parents[1]
NODE = "/Users/kenkuang/.local/share/mise/installs/node/22.22.0/bin/node"
CLANG = "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang++"
SDK = "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
PATHS = ["src/zen/toolkit/common/" + p for p in [
    "ZenProfileHostProtocol.h", "ZenProfileHostNative.h", "ZenCommonUtils.cpp",
    "nsIZenCommonUtils.idl", "cocoa/ZenProfileHost.mm", "moz.build",
    "ZenProfileHostWorker.sys.mjs"]]

CPP = r'''
#include <mach/mach.h>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <initializer_list>
static int destroys=0, sends=0;
static mach_msg_return_t sendResult=KERN_SUCCESS;
static bool endpointAlive=true;
static kern_return_t InertType(mach_port_t,mach_port_t,mach_port_type_t* t){*t=endpointAlive?MACH_PORT_TYPE_SEND:MACH_PORT_TYPE_DEAD_NAME;return KERN_SUCCESS;}
#define mach_port_type InertType
#undef mach_task_self
#define mach_task_self() 1
static void InertDestroy(mach_msg_header_t*){++destroys;}
static mach_msg_return_t InertMessage(mach_msg_header_t*,mach_msg_option_t,
 mach_msg_size_t,mach_msg_size_t,mach_port_name_t,mach_msg_timeout_t,mach_port_name_t){++sends;return sendResult;}
#define mach_msg_destroy InertDestroy
#define mach_msg InertMessage
#include "ZenProfileHostProtocol.h"
#undef mach_msg
#undef mach_msg_destroy
using namespace zen::profilehost;
int main(){
 assert(ControlEndpointAlive(88));endpointAlive=false;assert(!ControlEndpointAlive(88));endpointAlive=true;
 StartupExpectation expectation{};
 expectation.prefsSupplied=1; // Explicit zero cap, both raw files absent.
 assert(SetProfileDirectory(expectation.authority,"/owned/authority",16,3,1));
 assert(SetProfileDirectory(expectation.root,"/owned/root",11,3,2));
 assert(SetProfileDirectory(expectation.local,"/owned/local",12,4,3));
 assert(SetStartupBytes(expectation.profiles,true,"raw\0bytes",9));
 assert(SetStartupBytes(expectation.installs,false,"",0));
 assert(SetStartupBytes(expectation.name,true,"",0));
 assert(SetStartupBytes(expectation.path,true,"literal/../path",15));
 assert(SetStartupBytes(expectation.isRelative,true,"1",1));
 assert(SetStartupBytes(expectation.storeID,false,"",0));
 assert(SetStartupBytes(expectation.showSelector,true,"",0));
 assert(ValidStartupExpectation(expectation));
 auto changed=expectation;changed.profiles.bytes[0]='R';assert(!SameStartupExpectation(expectation,changed));
 changed=expectation;changed.storeID.present=1;assert(!SameStartupExpectation(expectation,changed));
 changed=expectation;changed.local.inode++;assert(!SameStartupExpectation(expectation,changed));
 changed=expectation;changed.profiles.length=kStartupBytes+1;assert(!ValidStartupExpectation(changed));
 changed=expectation;changed.installs.length=1;assert(!ValidStartupExpectation(changed));
 changed=expectation;changed.name.present=2;assert(!ValidStartupExpectation(changed));
 assert(!SetStartupBytes(changed.name,false,"x",1));
 assert(!SetStartupBytes(changed.name,true,"x",kStartupBytes+1));
 assert(!SetStartupBytes(changed.name,true,nullptr,1));
 assert(!SameProfileDirectory(expectation.root,expectation.local));
 assert(kStartupVersion!=kControlVersion&&kStartupHelloMessage!=kHelloMessage&&kStartupBindingMessage!=kBootstrapMessage);

 ProfileDirectory p{}; assert(SetProfileDirectory(p,"/owned/profile",14,3,7));
 assert(ValidProfileDirectory(p));
 ProfileDirectory bad=p; bad.length=4097;assert(!ValidProfileDirectory(bad));
 bad=p;bad.bytes[2]=0;assert(!ValidProfileDirectory(bad));
 bad=p;bad.bytes[0]=char(0xc0);assert(!ValidProfileDirectory(bad));
 bad=p;bad.bytes[0]=char(0xed);bad.bytes[1]=char(0xa0);bad.bytes[2]=char(0x80);assert(!ValidProfileDirectory(bad));
 assert(!SetProfileDirectory(bad,"relative",8,3,7));
 WorkerBinding b; assert(!b.Hello(42,42,p,9,88));
 assert(b.Prepare(p));assert(!b.Prepare(p));assert(!b.Bind(1,false));
 assert(b.Bind(42,false));assert(!b.Bind(42,false));assert(!b.Bind(43,true));
 assert(!b.Hello(41,42,p,9,88));assert(!b.Hello(42,41,p,9,88));
 bad=p;bad.inode++;assert(!b.Hello(42,42,bad,9,88));
 bad=p;bad.device++;assert(!b.Hello(42,42,bad,9,88));
 bad=p;bad.bytes[7]='x';assert(!b.Hello(42,42,bad,9,88));
 assert(b.Hello(42,42,p,9,88));assert(b.Hello(42,42,p,9,88));
 assert(!b.Hello(42,42,p,10,88));assert(!b.Hello(42,42,p,9,89));
 Identity id{42,17,18,19,20};
 assert(!b.Register(id,41,p,9,17));
 auto wrong=id;wrong.token++;assert(!b.Register(wrong,42,p,9,17));
 assert(b.Register(id,42,p,9,17));assert(b.Register(id,42,p,9,17));
 wrong=id;wrong.root++;assert(!b.Register(wrong,42,p,9,17));
 Gate gate;assert(gate.Admit(b.identity));assert(!gate.CanPublish());assert(!gate.Input(id,42));
 b.Tighten();assert(b.cleanupOnly);assert(!b.Register(id,42,p,9,17));
 WorkerBinding late;assert(late.Prepare(p));assert(late.Bind(42,true));
 assert(late.Hello(42,42,p,9,88));assert(!late.Register(id,42,p,9,17));
 assert(ParentAuthenticated(7,7,7));assert(!ParentAuthenticated(7,8,7));assert(!ParentAuthenticated(7,7,8));
 QuitSequence q;assert(q.Begin(0)==QuitAction::Reject);
 assert(q.Begin(1)==QuitAction::Start);assert(q.Begin(1)==QuitAction::Pending);
 assert(q.Begin(2)==QuitAction::Pending);assert(!q.Complete(2,QuitStatus::Requested));
 assert(q.Complete(1,QuitStatus::Vetoed));assert(q.Begin(1)==QuitAction::Cached);
 assert(q.status==QuitStatus::Vetoed);assert(q.Begin(2)==QuitAction::Start);
 assert(!q.Complete(2,static_cast<QuitStatus>(99)));assert(q.Complete(2,QuitStatus::NotAvailable));
 assert(q.Begin(1)==QuitAction::Reject);assert(q.Begin(2)==QuitAction::Cached);
 // The real record validator sees explicit audit trailers, never a kernel call.
 struct Incoming {HelloRecord record;mach_msg_audit_trailer_t trailer;} in{};
 auto& h=in.record;h.header.msgh_size=sizeof(h);h.header.msgh_id=kHelloMessage;
 h.header.msgh_bits=MACH_MSGH_BITS_COMPLEX;h.body.msgh_descriptor_count=1;
 h.control.type=MACH_MSG_PORT_DESCRIPTOR;h.control.disposition=MACH_MSG_TYPE_PORT_SEND;h.control.name=88;
 h.version=kControlVersion;h.pid=42;h.owner=9;h.profile=p;
 in.trailer.msgh_trailer_type=MACH_MSG_TRAILER_FORMAT_0;
 in.trailer.msgh_trailer_size=sizeof(in.trailer);in.trailer.msgh_audit.val[5]=42;
 assert(HelloLayout(&h.header,sizeof(in)));assert(AuditPID(&h.header,sizeof(in))==42);
 for(int kind=0;kind<7;++kind){auto x=in;
 switch(kind){case 0:x.record.body.msgh_descriptor_count=2;break;
 case 1:x.record.control.type=MACH_MSG_OOL_DESCRIPTOR;break;
 case 2:x.record.control.disposition=MACH_MSG_TYPE_MOVE_RECEIVE;break;
 case 3:x.record.version++;break;case 4:x.record.header.msgh_size--;break;
 case 5:x.record.header.msgh_remote_port=77;break;
 case 6:x.record.header.msgh_voucher_port=77;break;}
 assert(!HelloLayout(&x.record.header,sizeof(x)));}
 {Received owned(&h.header,sizeof(in));}assert(destroys==1);
 BootstrapRecord boot{};boot.header.msgh_id=kBootstrapMessage;boot.header.msgh_size=sizeof(boot);
 boot.version=kControlVersion;assert(ControlLayout<BootstrapRecord>(&boot.header,sizeof(boot),kBootstrapMessage));
 boot.header.msgh_bits=MACH_MSGH_BITS_COMPLEX;assert(!ControlLayout<BootstrapRecord>(&boot.header,sizeof(boot),kBootstrapMessage));
 for(auto result:{KERN_SUCCESS,MACH_SEND_TIMED_OUT,MACH_SEND_INTERRUPTED,MACH_SEND_INVALID_DEST}){
 sendResult=result;int before=destroys;BootstrapRecord out{};
 assert(SendControl(out,88,kBootstrapMessage)==result);
 assert(destroys==before+((result==MACH_SEND_TIMED_OUT||result==MACH_SEND_INTERRUPTED)?1:0));}
 assert(sends==4);puts("PASS production control binding, audit/path/identity, late cleanup, quit dedup, wire and send cleanup (inert endpoints)");
}
'''

JS = r'''
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
let listener, connected, replies=[], attempts=0, votes=0;
globalThis.Ci={nsIAppStartup:{eAttemptQuit:17}};
globalThis.ChromeUtils={generateQI(){return function(){return this;}}};
globalThis.Services={zen:{connectProfileHostSource(w,p,s,l){connected=[w,p,s];listener=l;},
 replyProfileHostQuit(w,id,status){assert.equal(w,connected[0]);replies.push([id,status]);}},
 startup:{quit(flags){assert.equal(flags,17);attempts++;}}};
const {connectProfileHostWorker:connect}=await import(pathToFileURL(process.argv[2]));
const w={closed:false,canQuitApplication(a,s){assert.equal(a,undefined);assert.equal(s,'OS');votes++;return true;}};
const owner=connect(w,7,'org.zen.profilehost.inert');assert.deepEqual(connected,[w,7,'org.zen.profilehost.inert']);
assert(owner);listener.observe(null,'zen-profile-host-normal-quit','1');
assert.deepEqual(replies.at(-1),['1',1]);assert.equal(attempts,1);assert.equal(votes,1);
w.canQuitApplication=()=>false;listener.observe(null,'zen-profile-host-normal-quit','2');assert.deepEqual(replies.at(-1),['2',2]);assert.equal(attempts,1);
delete w.canQuitApplication;listener.observe(null,'zen-profile-host-normal-quit','3');assert.deepEqual(replies.at(-1),['3',3]);
// A nested native callback/modal loop must never reenter JS quit voting either.
w.canQuitApplication=()=>{votes++;listener.observe(null,'zen-profile-host-normal-quit','4');return true;};
listener.observe(null,'zen-profile-host-normal-quit','4');assert.equal(attempts,2);assert.equal(votes,2);
// Native invalidation during attemptQuit may make the reply unavailable.
Services.startup.quit=()=>{throw Error('retired endpoint');};
listener.observe(null,'zen-profile-host-normal-quit','5');assert.deepEqual(replies.at(-1),['5',3]);
console.log('PASS actual exported worker: exact window, normal observer vote, attemptQuit, veto/unavailable/reentrant refusal');
'''


def definition(text, signature):
    start = text.index(signature)
    opening = text.index('{', start + len(signature))
    depth = 0
    for token in re.finditer(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|//[^\n]*|/\*[\s\S]*?\*/|[{}]', text[opening:]):
        if token.group() == '{':
            depth += 1
        elif token.group() == '}':
            depth -= 1
            if not depth:
                return text[start:opening+token.end()]
    raise AssertionError('Unclosed production body: '+signature)


# Run after the unchanged JS oracle. Native consumes these observed JS replies
# at its observer boundary; this is not a live Gecko/native-to-JS transport.
B1_JS = r'''
const cleanupReplies=[];
Services.zen.replyProfileHostQuit=(window,id,status)=>{assert.equal(window,w);cleanupReplies.push([id,status]);};
Services.startup.quit=flags=>{assert.equal(flags,17);attempts++;};
w.canQuitApplication=()=>false;listener.observe(null,'zen-profile-host-normal-quit','41');
w.canQuitApplication=()=>true;listener.observe(null,'zen-profile-host-normal-quit','42');
delete w.canQuitApplication;listener.observe(null,'zen-profile-host-normal-quit','43');
assert.deepEqual(cleanupReplies,[['41',2],['42',1],['43',3]]);
console.log('B1_JS_REPLIES '+JSON.stringify(cleanupReplies));
'''


# Actual Objective-C++ dispatch bodies, not an independent policy implementation.
# Runtime root objects are inert libobjc allocations; no Foundation/AppKit linked.
NATIVE = r'''
#include <mach/mach.h>
#include <objc/runtime.h>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <string>
#include <functional>
#include <limits>
#include <chrono>
#include <vector>
#include <utility>
#include <memory>
#include <new>
static int destroys=0, retains=0, sends=0, votes=0, stopped=0;
static uint32_t currentParent=7;
static bool profileLive=true, hostLive=true, portLive=true, localLive=true, childParentLive=true;
static int profileReads=0, lookups=0;
static bool authReply=false;
static std::vector<mach_port_t> sendEndpoints;
static std::vector<std::pair<std::vector<unsigned char>,mach_msg_return_t>> incoming;
static std::vector<mach_msg_id_t> outgoing;
static std::vector<std::vector<unsigned char>> sentRecords;
static int sendRefs[256]{}, receiveRefs[256]{};
static void InertDestroy(mach_msg_header_t* h){++destroys;
 if(h->msgh_bits&MACH_MSGH_BITS_COMPLEX){auto* b=reinterpret_cast<mach_msg_body_t*>(h+1);
 auto* d=reinterpret_cast<mach_msg_port_descriptor_t*>(b+1);
 for(uint32_t i=0;i<b->msgh_descriptor_count;++i)if(d[i].type==MACH_MSG_PORT_DESCRIPTOR&&d[i].name<256&&d[i].name)sendRefs[d[i].name]--;}}
static void QueueAuth();
static mach_msg_return_t InertMessage(mach_msg_header_t* h,mach_msg_option_t options,
 mach_msg_size_t,mach_msg_size_t capacity,mach_port_name_t,mach_msg_timeout_t,mach_port_name_t){
 if(options&MACH_SEND_MSG){++sends;outgoing.push_back(h->msgh_id);sendEndpoints.push_back(h->msgh_remote_port);
 sentRecords.emplace_back(reinterpret_cast<unsigned char*>(h),reinterpret_cast<unsigned char*>(h)+h->msgh_size);
 if(authReply&&h->msgh_id==0x5a504906)QueueAuth();return KERN_SUCCESS;}
 if(incoming.empty())return MACH_RCV_TIMED_OUT;
 auto data=std::move(incoming.front());incoming.erase(incoming.begin());
 assert(data.first.size()<=capacity);memcpy(h,data.first.data(),data.first.size());return data.second;}
static kern_return_t InertRefs(mach_port_t,mach_port_t p,mach_port_right_t kind,mach_port_delta_t delta){
 assert(p<256);if(kind==MACH_PORT_RIGHT_SEND)sendRefs[p]+=delta;
 if(kind==MACH_PORT_RIGHT_RECEIVE){receiveRefs[p]+=delta;
  if(delta<0&&p==66){for(auto& item:incoming)InertDestroy(reinterpret_cast<mach_msg_header_t*>(item.first.data()));incoming.clear();}}
 return KERN_SUCCESS;}
static kern_return_t InertDeallocate(mach_port_t,mach_port_t p){assert(p<256);--sendRefs[p];return KERN_SUCCESS;}
static kern_return_t InertType(mach_port_t,mach_port_t,mach_port_type_t* type){*type=portLive?MACH_PORT_TYPE_SEND:MACH_PORT_TYPE_DEAD_NAME;return KERN_SUCCESS;}
#define mach_msg_destroy InertDestroy
#define mach_msg InertMessage
#define mach_port_mod_refs InertRefs
#define mach_port_deallocate InertDeallocate
#define mach_port_type InertType
#undef mach_task_self
#define mach_task_self() 1
#include "ZenProfileHostProtocol.h"
using namespace zen::profilehost;
#define getppid() currentParent
#define getpid() 42
#include <sys/sysctl.h>
static int InertSysctl(int* q,unsigned n,void* out,size_t* length,void*,size_t){
 assert(n==4&&q[0]==CTL_KERN&&q[1]==KERN_PROC&&q[2]==KERN_PROC_PID);
 if(!childParentLive)return -1;
 auto* p=static_cast<kinfo_proc*>(out);p->kp_proc.p_pid=q[3];p->kp_eproc.e_ppid=42;*length=sizeof(*p);return 0;}
#define sysctl InertSysctl
__CHILD_PARENT__
using ControlClock=std::chrono::steady_clock;
using BOOL=bool;
@class NSWindow;
static NSWindow* sourceWindow;
static id fixtureChild;
__attribute__((objc_root_class)) @interface InertObject {Class isa;int refs;}
+(id)alloc;-(id)init;-(id)retain;-(oneway void)release;-(id)autorelease;
@end
@implementation InertObject
+(id)alloc{return class_createInstance(self,0);}-(id)init{refs=1;return self;}
-(id)retain{refs++;retains++;return self;}-(oneway void)release{assert(refs>0);if(!--refs)object_dispose(self);}
-(id)autorelease{return self;}
@end
@interface NSView:InertObject
@property(readonly) NSView* superview;
@property(readonly) NSWindow* window;
@end
@implementation NSView
-(NSWindow*)window{return sourceWindow;}
-(NSView*)superview{return nil;}
@end
@interface NSWindow:InertObject
@property(readonly) double backingScaleFactor;
@property(readonly) NSView* contentView;
@end
@implementation NSWindow
-(NSView*)contentView{return nil;}
-(double)backingScaleFactor{return 2;}
@end
@interface NSNotification:InertObject
@property(readonly) id object;
@end
@implementation NSNotification
-(id)object{return nil;}
@end
@interface NSNotificationCenter:InertObject
+(id)defaultCenter;-(void)removeObserver:(id)o;
-(void)addObserver:(id)o selector:(SEL)s name:(id)n object:(id)t;
@end
@implementation NSNotificationCenter
-(void)addObserver:(id)o selector:(SEL)s name:(id)n object:(id)t{(void)o;(void)s;(void)n;(void)t;}
+(id)defaultCenter{return nil;}-(void)removeObserver:(id)o{(void)o;}
@end
struct nsAutoRetainCocoaObject {id obj;explicit nsAutoRetainCocoaObject(id o):obj([o retain]){}~nsAutoRetainCocoaObject(){[obj release];}};
template<class T>struct nsCOMPtr {T* p=nullptr;nsCOMPtr()=default;nsCOMPtr(T* q):p(q){}operator T*()const{return p;}T* operator->()const{return p;}T* get()const{return p;}nsCOMPtr& operator=(T* q){p=q;return *this;}};
template<class T>T** getter_AddRefs(nsCOMPtr<T>& p){return &p.p;}
template<class T>using RefPtr=nsCOMPtr<T>;
struct nsACString:std::string {using std::string::string;bool IsEmpty()const{return empty();}uint32_t Length()const{return size();}
 nsACString()=default;nsACString(const std::string& s):std::string(s){}
 char First()const{return front();}
 char CharAt(uint32_t i)const{return at(i);}int FindChar(char c)const{return find(c)==npos?-1:int(find(c));}
 bool EqualsLiteral(const char* s)const{return *this==s;}
 const char* BeginReading()const{return data();}const char* get()const{return c_str();}bool Equals(const nsACString& b)const{return *this==b;}};
struct nsCString:nsACString {using nsACString::nsACString;nsCString()=default;nsCString(const nsACString& s):nsACString(s){}
 void AppendInt(uint64_t n){append(std::to_string(n));}void Append(char c){push_back(c);}void Append(const nsACString& s){append(s);}void AppendLiteral(const char* c){append(c);}};
using nsAutoCString=nsCString;
static nsACString operator""_ns(const char* p,size_t n){return nsACString(p,n);}
struct nsIObserver {std::function<void(const char*,const nsACString&)> callback;};
struct nsIFile {ProfileDirectory dir;bool clone=false;
 int GetNativePath(nsACString& out){out.assign(dir.bytes,dir.length);return 0;}
 int Clone(nsIFile** out){*out=new nsIFile(*this);(*out)->clone=true;return 0;}
 int Normalize(){assert(clone);return 0;}};
static nsIFile selectedProfile,selectedLocal;
static constexpr const char* NS_APP_USER_PROFILE_50_DIR="ProfD";
static constexpr const char* NS_APP_USER_PROFILE_LOCAL_50_DIR="ProfLD";
static int NS_GetSpecialDirectory(const char* key,nsIFile** out){++profileReads;
 if(!profileLive||(std::string(key)=="ProfLD"&&!localLive))return 1;
 *out=std::string(key)=="ProfD"?&selectedProfile:&selectedLocal;return 0;}
constexpr int NS_NATIVE_WIDGET=1, NS_NATIVE_WINDOW=2;
struct nsIWidget{void* GetNativeData(int kind){return kind==NS_NATIVE_WINDOW?(void*)sourceWindow:(void*)fixtureChild;}};struct mozIDOMWindowProxy{};
static void NotifyControl(nsIObserver* l,const char* t,const nsACString& d){if(l)l->callback(t,d);}
static bool NS_FAILED(int rv){return rv!=0;}
static bool NS_SUCCEEDED(int rv){return rv==0;}
constexpr int kNotFound=-1;
#include <sys/stat.h>
#include <fcntl.h>
#include <cerrno>
static ProfileDirectory fixtureDirs[3];
static std::string fixtureRaw="same-size raw";
static bool fixtureMissing=true, fixtureReadError=false, fixtureQueryError=false, fixtureAuthorityChanged=false, fixtureInterrupted=false;
static int fixtureReads=0;
static int fixtureOpens=0, fixtureCloses=0;static size_t fixtureOffset;
static int InertStat(const char* path,struct stat* info){
 for(auto& d:fixtureDirs)if(std::string(d.bytes,d.length)==path){*info={};info->st_mode=S_IFDIR;info->st_dev=d.device;info->st_ino=d.inode;return 0;}
 errno=ENOENT;return -1;}
static int InertOpen(const char* path,int flags){assert(std::string(path)=="/owned/authority");assert(flags==(O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW));++fixtureOpens;return 20;}
static int InertOpenAt(int fd,const char* name,int flags){assert(fd==20);assert(flags==(O_RDONLY|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK));
 assert(std::string(name)=="profiles.ini"||std::string(name)=="installs.ini");
 if(fixtureQueryError){errno=EACCES;return -1;}
 if(std::string(name)=="installs.ini"&&fixtureMissing){errno=ENOENT;return -1;}++fixtureOpens;fixtureOffset=0;return std::string(name)=="profiles.ini"?21:22;}
static int InertFstat(int fd,struct stat* out){assert(fd>=20&&fd<=22);*out={};
 if(fd==20){out->st_mode=S_IFDIR;out->st_dev=fixtureDirs[0].device;out->st_ino=fixtureDirs[0].inode+(fixtureAuthorityChanged?1:0);}
 else{out->st_mode=S_IFREG;out->st_ino=fd;out->st_dev=3;out->st_size=fd==21?fixtureRaw.size():0;}return 0;}
static ssize_t InertRead(int fd,void* out,size_t length){assert(fd==21||fd==22);++fixtureReads;
 if(fixtureInterrupted){errno=EINTR;return -1;}if(fixtureReadError){errno=EIO;return -1;}
 size_t count=fd==22?0:std::min(length,fixtureRaw.size()-fixtureOffset);if(count)memcpy(out,fixtureRaw.data()+fixtureOffset,count);fixtureOffset+=count;return count;}
static int InertClose(int fd){assert(fd>=20&&fd<=22);++fixtureCloses;return 0;}
#define stat(path,out) InertStat(path,out)
#define open InertOpen
#define openat InertOpenAt
#define fstat InertFstat
#define read InertRead
#define close InertClose
__CAPTURE_DIRECTORY__
__CLONE_DIRECTORY__
__READ_RAW__
__CAPTURE_REGISTRY__
#undef stat
static void* dispatch_get_main_queue(){return nullptr;}
#include <Block.h>
struct InertDispatch{void(^cancel)()=nullptr;};
using dispatch_source_t=InertDispatch*;
static void dispatch_source_cancel(dispatch_source_t p){if(p&&p->cancel)p->cancel();}
static void dispatch_release(dispatch_source_t p){if(p->cancel)Block_release(p->cancel);delete p;}
static dispatch_source_t dispatch_source_create(int,uint64_t,uint64_t,void*){return new InertDispatch;}
static void dispatch_source_set_cancel_handler(dispatch_source_t p,void(^b)()){p->cancel=Block_copy(b);}
static void dispatch_source_set_event_handler(dispatch_source_t,void(^)()){}
static void dispatch_resume(dispatch_source_t){}
static void dispatch_source_set_timer(dispatch_source_t,uint64_t,uint64_t,uint64_t){}
static uint64_t dispatch_time(uint64_t t,uint64_t delta){return t+delta;}
constexpr int DISPATCH_SOURCE_TYPE_MACH_RECV=1, DISPATCH_SOURCE_TYPE_TIMER=2, DISPATCH_TIME_NOW=0;
static id NSWindowWillCloseNotification=nil;
static char sProfileSourceKey,sProfileControlKey,sProfileHostKey;
__CURRENT_PROFILE__
__CURRENT_LOCAL__
static bool CaptureDirectory(nsIFile*,ProfileDirectory& out);
namespace mozilla::layers {struct NativeLayerRootCA{NativeLayerRootCA* AsNativeLayerRootCA(){return this;}};}
static mozilla::layers::NativeLayerRootCA root;
static bool sourceRole=true;
struct nsCocoaWindow{bool IsProfileHostSource(){return sourceRole;}mozilla::layers::NativeLayerRootCA* GetNativeLayerRoot(){return &root;}};
static nsCocoaWindow* CocoaWidget(NSWindow*,nsIWidget*){static nsCocoaWindow c;return &c;}
@interface ZenProfileSource:InertObject {@public Identity identity; mach_port_t endpoint; RefPtr<nsIWidget> widget;RefPtr<mozilla::layers::NativeLayerRootCA> root;bool observing,invalid;}
-(BOOL)valid;-(void)invalidate;
@end
@implementation ZenProfileSource
-(BOOL)valid{return !invalid;}-(void)invalidate{if(invalid)return;invalid=true;observing=false;stopped++;if(endpoint)InertDeallocate(1,endpoint);endpoint=0;}
@end
@class CALayer;
static mach_port_t frameEndpoint;
namespace zen::profilehost {
static mach_msg_return_t SendStaging(mach_port_t endpoint,const Identity& identity,CALayer*,float scale){
 assert(ControlEndpointAlive(endpoint)&&identity.Valid()&&scale==2);frameEndpoint=endpoint;return KERN_SUCCESS;}
}
__OBSERVE_SOURCE__
static kern_return_t InertAllocate(mach_port_t,mach_port_right_t,mach_port_t* p){*p=66;++receiveRefs[66];return KERN_SUCCESS;}
static kern_return_t InertInsert(mach_port_t,mach_port_t p,mach_port_t,mach_msg_type_name_t){++sendRefs[p];return KERN_SUCCESS;}
static kern_return_t InertLookup(mach_port_t,char*,mach_port_t* p){++lookups;*p=77;++sendRefs[77];return KERN_SUCCESS;}
#define mach_port_allocate InertAllocate
#define mach_port_insert_right InertInsert
#define bootstrap_look_up InertLookup
#define bootstrap_port 1
constexpr int BOOTSTRAP_MAX_NAME_LEN=128;
static int InertMain(){return 1;}
#define pthread_main_np InertMain
static void InertRandom(void* out,size_t length){assert(length==sizeof(uint64_t));*static_cast<uint64_t*>(out)=9;}
#define arc4random_buf InertRandom
static bool StringBeginsWith(const nsACString& s,const nsACString& p){return s.compare(0,p.size(),p)==0;}
using nsresult=int;
constexpr int NS_OK=0, NS_ERROR_NOT_AVAILABLE=1, NS_ERROR_ALREADY_INITIALIZED=2, NS_ERROR_INVALID_ARG=3;
constexpr int NS_ERROR_OUT_OF_MEMORY=4;
constexpr int NS_ERROR_FILE_CORRUPTED=5;
// Explicit dependency stubs: this old control fixture does NOT exercise prefs
// IO/parser/qualification. The new source-only oracle inspects that real owner.
struct PrefsFailure {int result=0,io=0;bool parserCopyFailed=false;nsCString parser;};
// Inert absent-file dependency, NOT a hash/parser/raw-file implementation.
struct PrefsRaw {bool present=false;uint64_t device=0,inode=0;
 struct {uint32_t Length()const{return 0;}} raw;
 nsCString sha256=nsCString(32,'\0');};
struct PrefsInputSnapshot {uint64_t limit=0;PrefsRaw files[2];};
struct nsIPrefService {};
constexpr const char* NS_PREFSERVICE_CONTRACTID="inert-control-fixture-only";
static nsIPrefService* do_GetService(const char*,int* rv){static nsIPrefService p;*rv=0;return &p;}
static int PrefsRefuse(PrefsFailure& e,int rv){if(!e.result)e.result=rv;return e.result;}
static int CapturePrefsInput(nsIFile*,const ProfileDirectory&,uint64_t limit,PrefsInputSnapshot& out,PrefsFailure&){out.limit=limit;return 0;}
static int ParsePrefsInput(nsIPrefService*,PrefsInputSnapshot&,PrefsFailure&){return 0;}
__CONTROL_INTERFACE__
static ZenProfileControl* sStartupControl;
namespace zen::profilehost {static int StartSource(mozIDOMWindowProxy*,uint32_t,const nsACString&,const nsACString&,nsACString&);}
@implementation ZenProfileControl
__CONTROL_VALID__
__CONTROL_STARTUPHELLO__
__CONTROL_INVALIDATE__
__CONTROL_RETIRE__
__CONTROL_TICK__
__CONTROL_HELLO__
__CONTROL_REGISTER__
__CONTROL_REPLY__
__CONTROL_HANDLE__
__CONTROL_RECEIVE__
@end
static nsIWidget widget;
namespace zen::profilehost {static int StartSource(mozIDOMWindowProxy*,uint32_t parentPID,const nsACString& service,const nsACString&,nsACString&){
 auto* c=(ZenProfileControl*)objc_getAssociatedObject(sourceWindow,&sProfileControlKey);
 auto* source=[[ZenProfileSource alloc]init];auto* control=c;const uint64_t token=c->token;nsCString serviceName(service);
 __SOURCE_ENDPOINT__
 source->identity=Identity{42,c->token,18,19,20};source->widget=&widget;source->root=&root;source->observing=true;
 objc_setAssociatedObject(sourceWindow,&sProfileSourceKey,source,OBJC_ASSOCIATION_RETAIN_NONATOMIC);[source release];return 0;}}
@interface ZenProfileHost:InertObject {@public WorkerBinding worker;Gate gate;uint64_t token;nsCOMPtr<nsIObserver> listener;QuitSequence quit;
 ControlClock::time_point quitDeadline;uint32_t quitSends;bool invalid;mach_port_t port;NSWindow* window;void* staged;
 StartupExpectation startupExpectation;bool startupPrepared,startupSend,prefsPreparing;
 std::unique_ptr<const PrefsInputSnapshot> prefsInput;PrefsFailure prefsFailure;
 nsCOMPtr<nsIFile> expectedDirectory,startupAuthority,startupLocal;}
-(BOOL)valid;-(BOOL)workerCurrent;-(BOOL)startupCurrent;-(void)invalidate;-(void)control:(mach_msg_header_t*)header capacity:(size_t)capacity;
-(void)bootstrap;-(void)sendQuit;-(void)receive;
-(void)tick;
@end
static bool Consume(mach_msg_header_t* h,size_t capacity,const Gate&,double,void**){Received rights(h,capacity);return false;}
@implementation ZenProfileHost
-(BOOL)valid{return !invalid&&hostLive;}-(BOOL)workerCurrent{if(startupPrepared)return [self startupCurrent];return [self valid]&&profileLive&&worker.prepared;}
__HOST_STARTUP_CURRENT__
-(void)invalidate{invalid=true;if(worker.control){InertDeallocate(1,worker.control);worker.control=0;}}
__HOST_CONTROL__
__HOST_BOOTSTRAP__
__HOST_QUIT__
__HOST_RECEIVE__
__HOST_TICK__
@end
static ProfileDirectory profile;
template<class T>struct Incoming {T record{};mach_msg_audit_trailer_t trailer{};
 Incoming(mach_msg_id_t id,uint32_t audit){record.header.msgh_size=sizeof(T);record.header.msgh_id=id;
 trailer.msgh_trailer_type=MACH_MSG_TRAILER_FORMAT_0;trailer.msgh_trailer_size=sizeof(trailer);trailer.msgh_audit.val[5]=audit;}
 void queue(mach_msg_return_t result=KERN_SUCCESS){const auto* p=reinterpret_cast<const unsigned char*>(this);incoming.push_back({std::vector<unsigned char>(p,p+sizeof(*this)),result});}};
static StartupExpectation startupFixture(){StartupExpectation e{};
 e.prefsSupplied=1; // Explicit zero cap, canonical absent wire metadata.
 assert(SetProfileDirectory(e.authority,"/owned/authority",16,3,1));
 assert(SetProfileDirectory(e.root,"/owned/root",11,3,2));
 assert(SetProfileDirectory(e.local,"/owned/local",12,4,3));
 assert(SetStartupBytes(e.profiles,true,"same-size raw",13));assert(SetStartupBytes(e.installs,false,nullptr,0));
 assert(SetStartupBytes(e.name,true,"",0));assert(SetStartupBytes(e.path,true,"literal/../path",15));
 assert(SetStartupBytes(e.isRelative,true,"1",1));assert(SetStartupBytes(e.showSelector,true,"",0));return e;}
static void QueueAuth(){Incoming<StartupBindingRecord> b(kStartupBindingMessage,7);b.record.owner=9;b.record.token=17;
 b.record.expectation=startupFixture();b.record.header.msgh_bits=MACH_MSGH_BITS_COMPLEX;b.record.body.msgh_descriptor_count=1;
 b.record.host.name=90;b.record.host.type=MACH_MSG_PORT_DESCRIPTOR;b.record.host.disposition=MACH_MSG_TYPE_PORT_SEND;
 ++sendRefs[90];b.queue();}
static NSWindow* resolvedWindow;
namespace zen::profilehost {
static nsresult Resolve(mozIDOMWindowProxy*,NSWindow** out,nsCOMPtr<nsIWidget>& w){*out=resolvedWindow;w=&widget;return 0;}
__DECIMAL__
__PREFS_LIMIT__
__CLEANUP_WORKER__
__REQUEST_QUIT__
__REPLY_QUIT__
__STARTUP_PREPARE__
__STARTUP_SERVICE__
__STARTUP_AUTHENTICATE__
__STARTUP_GET__
__STARTUP_ABANDON__
static const nsACString& EmptyCString(){static nsACString empty;return empty;}
__STARTUP_CONNECT__
}
static void clearEarly(){assert(AbandonStartupWorker()==NS_OK);[sStartupControl release];sStartupControl=nil;assert(incoming.empty());}
static void testStartup(){
 StartupExpectation out{};assert(GetAuthenticatedStartupBinding(out)==NS_ERROR_NOT_AVAILABLE);
 assert(AuthenticateStartupWorker(8,"org.zen.profilehost.test")==NS_ERROR_INVALID_ARG);
 assert(AuthenticateStartupWorker(7,nsACString("org.zen.profilehost.\0bad",sizeof("org.zen.profilehost.\0bad")-1))==NS_ERROR_INVALID_ARG);
 // Real synchronous API, receiver and incoming-right destruction. No Profile read.
 int reads=profileReads;authReply=true;profileLive=false;
 assert(AuthenticateStartupWorker(7,"org.zen.profilehost.test")==NS_OK);
 auto* original=sStartupControl;assert(original->endpoint==90&&sendRefs[77]==0&&sendRefs[90]==1);
 assert(GetAuthenticatedStartupBinding(out)==NS_OK&&SameStartupExpectation(out,startupFixture()));
 out.profiles.bytes[0]='X';assert(GetAuthenticatedStartupBinding(out)==NS_OK&&SameStartupExpectation(out,startupFixture()));
 assert(profileReads==reads&&!original->identity.Valid()&&!original->attached);
 assert(AuthenticateStartupWorker(7,"org.zen.profilehost.test")==NS_ERROR_ALREADY_INITIALIZED);
 int sent=sends;[original sendRegistered];assert(sends==sent); // No early Registered.
 currentParent=8;assert(GetAuthenticatedStartupBinding(out)==NS_ERROR_NOT_AVAILABLE&&!out.root.length);
 currentParent=7;assert(GetAuthenticatedStartupBinding(out)==NS_ERROR_NOT_AVAILABLE);clearEarly();profileLive=true;
 for(int failure=0;failure<8;++failure){
  assert(AuthenticateStartupWorker(7,"org.zen.profilehost.test")==NS_OK);auto* c=sStartupControl;
  if(failure==0){QueueAuth();auto* b=reinterpret_cast<StartupBindingRecord*>(incoming.back().first.data());b->cleanupOnly=1;}
  if(failure==1){QueueAuth();auto* b=reinterpret_cast<StartupBindingRecord*>(incoming.back().first.data());b->host.name=91;--sendRefs[90];++sendRefs[91];}
  if(failure==2){QueueAuth();auto* b=reinterpret_cast<StartupBindingRecord*>(incoming.back().first.data());b->expectation.profiles.bytes[0]='S';}
  if(failure==3)c->deadline=ControlClock::now()-std::chrono::seconds(1);
  if(failure==4)portLive=false;
  if(failure==5){QueueAuth();incoming.back().second=MACH_RCV_BODY_ERROR|MACH_MSG_IPC_SPACE;}
  if(failure==6){QueueAuth();auto* b=reinterpret_cast<StartupBindingRecord*>(incoming.back().first.data());b->expectation.path.length=kStartupBytes+1;}
  if(failure==7){for(int i=0;i<16;++i){Incoming<BootstrapRecord> junk(kBootstrapMessage,7);junk.queue();}
   QueueAuth();reinterpret_cast<StartupBindingRecord*>(incoming.back().first.data())->cleanupOnly=1;}
  assert(GetAuthenticatedStartupBinding(out)==NS_ERROR_NOT_AVAILABLE&&!out.authority.length);portLive=true;
  assert(sendRefs[90]==0&&sendRefs[91]==0&&receiveRefs[66]==0&&sendRefs[66]==0);clearEarly();
 }
 // Audit and nonce rejection do not authenticate, timeout remains bounded.
 authReply=false;int before=sends;assert(AuthenticateStartupWorker(7,"org.zen.profilehost.test")==NS_ERROR_NOT_AVAILABLE);
 assert(sends-before==50&&sendRefs[77]==0&&receiveRefs[66]==0);clearEarly();
 for(int malformed=0;malformed<3;++malformed){QueueAuth();auto* b=reinterpret_cast<StartupBindingRecord*>(incoming.back().first.data());
  if(malformed==0)reinterpret_cast<mach_msg_audit_trailer_t*>(incoming.back().first.data()+sizeof(*b))->msgh_audit.val[5]=8;
  if(malformed==1)b->owner=10;if(malformed==2)b->version=kControlVersion;
  assert(AuthenticateStartupWorker(7,"org.zen.profilehost.test")==NS_ERROR_NOT_AVAILABLE);assert(sendRefs[90]==0);clearEarly();}
 assert(sends-before==200&&sendRefs[77]==0&&receiveRefs[66]==0);authReply=true;
 auto* host=[[ZenProfileHost alloc]init];host->window=[[NSWindow alloc]init];host->port=95;host->token=17;
 host->startupExpectation=startupFixture();fixtureDirs[0]=host->startupExpectation.authority;
 fixtureDirs[1]=host->startupExpectation.root;fixtureDirs[2]=host->startupExpectation.local;
 nsIFile authority{fixtureDirs[0]}, rootFile{fixtureDirs[1]}, localFile{fixtureDirs[2]};
 nsIObserver parentListener;parentListener.callback=[](const char*,const nsACString&){};resolvedWindow=host->window;
 objc_setAssociatedObject(resolvedWindow,&sProfileHostKey,host,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
 for(int failure=0;failure<4;++failure){
  if(failure==0)fixtureQueryError=true;if(failure==1)fixtureReadError=true;
  if(failure==2)fixtureAuthorityChanged=true;if(failure==3)fixtureRaw.assign(kStartupBytes+1,'x');
  assert(PrepareStartupWorker(nullptr,&authority,&rootFile,&localFile,"","literal/../path","1",false,"",true,"","0",&parentListener)==NS_ERROR_INVALID_ARG);
  assert(!host->worker.prepared);fixtureQueryError=fixtureReadError=fixtureAuthorityChanged=false;fixtureRaw="same-size raw";
 }
 assert(PrepareStartupWorker(nullptr,&authority,&rootFile,&localFile,"","literal/../path","1",false,"",true,"","0",&parentListener)==NS_OK);
 assert(SameStartupExpectation(host->startupExpectation,startupFixture()));assert(!authority.clone&&!rootFile.clone&&!localFile.clone);
 assert(host->expectedDirectory.get()!=&rootFile&&host->startupLocal.get()!=&localFile);
 assert(PrepareStartupWorker(nullptr,&authority,&rootFile,&localFile,"","literal/../path","1",false,"",true,"","0",&parentListener)==NS_ERROR_ALREADY_INITIALIZED);
 auto savedRaw=fixtureRaw;fixtureRaw[0]='S';assert(![host workerCurrent]);fixtureRaw=savedRaw;
 fixtureMissing=false;assert(![host workerCurrent]);fixtureMissing=true;
 fixtureDirs[2].inode++;assert(![host workerCurrent]);fixtureDirs[2].inode--;
 assert([host workerCurrent]&&fixtureOpens==fixtureCloses);
 Incoming<StartupHelloRecord> hello(kStartupHelloMessage,42);hello.record.header.msgh_bits=MACH_MSGH_BITS_COMPLEX;
 hello.record.body.msgh_descriptor_count=1;hello.record.control.name=88;hello.record.control.type=MACH_MSG_PORT_DESCRIPTOR;
 hello.record.control.disposition=MACH_MSG_TYPE_PORT_SEND;hello.record.owner=9;hello.record.pid=42;
 ++sendRefs[88];hello.queue();[host receive];assert(!host->worker.owner&&sendRefs[88]==0);
 assert(host->worker.Bind(42,false));childParentLive=false;++sendRefs[88];hello.queue();[host receive];assert(!host->worker.owner&&sendRefs[88]==0);
 childParentLive=true;hello.trailer.msgh_audit.val[5]=41;++sendRefs[88];hello.queue();[host receive];assert(!host->worker.owner&&sendRefs[88]==0);
 hello.trailer.msgh_audit.val[5]=42;++sendRefs[88];hello.queue();[host receive];assert(host->worker.owner==9&&sendRefs[88]==1);
 assert(outgoing.back()==kStartupBindingMessage&&sendEndpoints.back()==88);
 [host invalidate];InertDeallocate(1,95);[host->window release];[host release];
 // Existing ConnectSource attaches the exact early owner once; no second lookup.
 auto e=startupFixture();fixtureDirs[0]=e.authority;fixtureDirs[1]=e.root;fixtureDirs[2]=e.local;
 selectedProfile.dir=e.root;selectedLocal.dir=e.local;sourceWindow=[[NSWindow alloc]init];fixtureChild=[[NSView alloc]init];resolvedWindow=sourceWindow;
 assert(AuthenticateStartupWorker(7,"org.zen.profilehost.test")==NS_OK);auto* early=sStartupControl;int lookupBefore=lookups;
 sourceRole=false;assert(ConnectSource(nullptr,7,"org.zen.profilehost.test",&parentListener)==NS_ERROR_NOT_AVAILABLE);sourceRole=true;
 selectedProfile.dir=e.authority;assert(ConnectSource(nullptr,7,"org.zen.profilehost.test",&parentListener)==NS_ERROR_NOT_AVAILABLE);selectedProfile.dir=e.root;
 fixtureDirs[2].inode++;assert(ConnectSource(nullptr,7,"org.zen.profilehost.test",&parentListener)==NS_ERROR_NOT_AVAILABLE);fixtureDirs[2].inode--;
 assert(ConnectSource(nullptr,7,"org.zen.profilehost.test",&parentListener)==NS_OK);
 assert(sStartupControl==early&&objc_getAssociatedObject(sourceWindow,&sProfileControlKey)==early&&early->attached&&early->identity.Valid());
 auto* staged=(ZenProfileSource*)objc_getAssociatedObject(sourceWindow,&sProfileSourceKey);
 assert(staged->endpoint==90&&early->endpoint==90&&sendRefs[90]==2&&lookups==lookupBefore);
 ObserveProfileSource(staged,nil,2);assert(frameEndpoint==early->endpoint&&lookups==lookupBefore);
 assert(outgoing.back()==kRegisteredMessage&&sendEndpoints.back()==90);
 assert(ConnectSource(nullptr,7,"org.zen.profilehost.test",&parentListener)==NS_ERROR_ALREADY_INITIALIZED);
 NSWindow* other=[[NSWindow alloc]init];resolvedWindow=other;
 assert(ConnectSource(nullptr,7,"org.zen.profilehost.test",&parentListener)==NS_ERROR_ALREADY_INITIALIZED);
 [other release];resolvedWindow=sourceWindow;
 fixtureDirs[2].inode++;assert(GetAuthenticatedStartupBinding(out)==NS_ERROR_NOT_AVAILABLE);fixtureDirs[2].inode--;
 clearEarly();objc_setAssociatedObject(sourceWindow,&sProfileSourceKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
 objc_setAssociatedObject(sourceWindow,&sProfileControlKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
 [fixtureChild release];fixtureChild=nil;[sourceWindow release];sourceWindow=nil;authReply=false;
 assert(sendRefs[90]==0&&sendRefs[66]==0&&receiveRefs[66]==0&&sendRefs[88]==0);
 puts("PASS actual Prepare/ConnectSource, raw filesystem helpers, same early owner and staging endpoint, repeated attach refusal (inert endpoints)");
 puts("PASS actual early auth API/receiver, endpoint retention, bounded retries, parent query refusal; inert endpoints only");
}
static void clearSource(){if(sourceWindow){objc_setAssociatedObject(sourceWindow,&sProfileSourceKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
 objc_setAssociatedObject(sourceWindow,&sProfileControlKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);[sourceWindow release];sourceWindow=nil;}}
static ZenProfileControl* newSource(nsIObserver* l){clearSource();sourceWindow=[[NSWindow alloc]init];auto* c=[[ZenProfileControl alloc]init];
 c->window=sourceWindow;c->root=&root;c->widget=&widget;c->parentPID=7;c->owner=9;c->receivePort=66;c->endpoint=77;c->listener=l;c->profile=profile;
 c->child=[[NSView alloc]init];fixtureChild=c->child;
 c->deadline=ControlClock::now()+std::chrono::seconds(5);sendRefs[77]++;
 c->receiveSend=true;sendRefs[66]++;receiveRefs[66]++;
 objc_setAssociatedObject(sourceWindow,&sProfileControlKey,c,OBJC_ASSOCIATION_RETAIN_NONATOMIC);return c;}

// Copy actual emitted records through inert endpoints with explicit audit/right
// transfer. No model of the production decision or quit sequence lives here.
template<class T>static bool deliverSent(size_t start,mach_msg_id_t id,uint32_t audit){
 bool delivered=false;size_t end=sentRecords.size();
 for(size_t i=start;i<end;++i)if(outgoing[i]==id){Incoming<T> in(id,audit);
  assert(sentRecords[i].size()==sizeof(T));memcpy(&in.record,sentRecords[i].data(),sizeof(T));
  in.record.header.msgh_remote_port=0;
  if(in.record.header.msgh_bits&MACH_MSGH_BITS_COMPLEX){auto* b=reinterpret_cast<mach_msg_body_t*>(&in.record.header+1);
   auto* d=reinterpret_cast<mach_msg_port_descriptor_t*>(b+1);d->disposition=MACH_MSG_TYPE_PORT_SEND;++sendRefs[d->name];}
  in.queue();delivered=true;}
 return delivered;}
static void testStartupCleanup(){
 const uint32_t jsStatuses[]={__QUIT_VOTES__};
 auto e=startupFixture();fixtureDirs[0]=e.authority;fixtureDirs[1]=e.root;fixtureDirs[2]=e.local;
 selectedProfile.dir=e.root;selectedLocal.dir=e.local;authReply=true;
 // Cleanup before attach is still a terminal refusal, never a JS quit vote.
 assert(AuthenticateStartupWorker(7,"org.zen.profilehost.test")==NS_OK);
 nsIObserver preattach;int earlyVotes=0;preattach.callback=[&](const char*,const nsACString&){++earlyVotes;};sStartupControl->listener=&preattach;
 QueueAuth();reinterpret_cast<StartupBindingRecord*>(incoming.back().first.data())->cleanupOnly=1;
 StartupExpectation refused;assert(GetAuthenticatedStartupBinding(refused)==NS_ERROR_NOT_AVAILABLE&&!refused.root.length);
 assert(sStartupControl->invalid&&earlyVotes==0&&sendRefs[90]==0&&receiveRefs[66]==0);clearEarly();
 for(int mode=0;mode<8;++mode){
  sourceWindow=[[NSWindow alloc]init];fixtureChild=[[NSView alloc]init];resolvedWindow=sourceWindow;
  assert(AuthenticateStartupWorker(7,"org.zen.profilehost.test")==NS_OK);auto* c=sStartupControl;
  nsIObserver childListener,parentListener;std::vector<std::string> requests,replies;
  parentListener.callback=[&](const char* topic,const nsACString& data){if(!strcmp(topic,"zen-profile-host-quit-reply"))replies.push_back(data);};
  assert(ConnectSource(nullptr,7,"org.zen.profilehost.test",&childListener)==NS_OK);
  auto* staged=(ZenProfileSource*)objc_getAssociatedObject(sourceWindow,&sProfileSourceKey);
  auto identity=c->identity;assert(staged&&staged->observing&&identity.Valid());
  auto* host=[[ZenProfileHost alloc]init];host->window=[[NSWindow alloc]init];host->port=90;host->token=c->token;
  host->startupPrepared=host->startupSend=true;host->startupExpectation=e;
  nsIFile rootFile{e.root},localFile{e.local},authority{e.authority};
  host->expectedDirectory=&rootFile;host->startupLocal=&localFile;host->startupAuthority=&authority;host->listener=&parentListener;
  assert(host->worker.Prepare(e.root)&&host->worker.Bind(42,false));host->worker.owner=c->owner;host->worker.control=c->receivePort;++sendRefs[66];
  Incoming<RegisteredRecord> reg(kRegisteredMessage,42);reg.record.owner=c->owner;reg.record.identity=identity;reg.record.profile=e.root;
  reg.queue();[host receive];assert(host->worker.identity==identity);
  objc_setAssociatedObject(host->window,&sProfileHostKey,host,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  uint64_t id=41+mode;nsACString idText(std::to_string(id));
  childListener.callback=[&](const char* topic,const nsACString& request){
   assert(!strcmp(topic,"zen-profile-host-normal-quit"));requests.push_back(request);
   if(request=="0")return; // Preserve the baseline's actual local-vote counterexample.
   assert(request==idText);resolvedWindow=sourceWindow;
   if(mode<3)assert(ReplyQuit(nullptr,request,jsStatuses[mode])==NS_OK);
   if(mode==3){StartupExpectation out;assert(GetAuthenticatedStartupBinding(out)==NS_ERROR_NOT_AVAILABLE);
    assert(ReplyQuit(nullptr,request,2)==NS_OK);
    Incoming<QuitRecord> nested(kNormalQuitMessage,7);nested.record.owner=c->owner;nested.record.identity=identity;nested.record.request=id+1;
    nested.queue();[c receive];}
   if(mode==6){[c invalidate];objc_setAssociatedObject(sourceWindow,&sProfileControlKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
   if(mode==7){objc_setAssociatedObject(sourceWindow,&sProfileControlKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    assert(ReplyQuit(nullptr,request,2)==NS_ERROR_NOT_AVAILABLE);
    objc_setAssociatedObject(sourceWindow,&sProfileControlKey,c,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
  };
  resolvedWindow=host->window;size_t first=sentRecords.size();assert(CleanupWorker(nullptr)==NS_OK);
  assert(deliverSent<StartupBindingRecord>(first,kStartupBindingMessage,7));[c receive];
  first=sentRecords.size();assert(RequestQuit(nullptr,idText)==NS_OK);
  assert(deliverSent<StartupBindingRecord>(first,kStartupBindingMessage,7));
  assert(deliverSent<QuitRecord>(first,kNormalQuitMessage,7));
  if(mode==5)c->listener=nullptr;
  [c receive];
  deliverSent<QuitReplyRecord>(first,kQuitReplyMessage,42);[host receive];
  if(mode==0){fprintf(stderr,"B1 actual correlated wait: pending=%d status=%u replies=%zu callback=%s\n",host->quit.pending,unsigned(host->quit.status),replies.size(),requests.empty()?"none":requests.back().c_str());
   assert((!host->quit.pending&&host->quit.status==QuitStatus::Vetoed&&replies==std::vector<std::string>{"41:2"})&&"B1 attached cleanup must preserve correlated VETOED reply");}
  if(mode==6){assert(c->invalid&&host->quit.pending);host->quitDeadline=ControlClock::now()-std::chrono::seconds(1);[host tick];
   assert(host->quit.status==QuitStatus::NotAvailable&&replies.back()==idText+":3");}
  else{
   uint32_t expected=mode<3?jsStatuses[mode]:(mode==3?2:3);
   assert(!host->quit.pending&&uint32_t(host->quit.status)==expected&&replies.back()==idText+":"+std::to_string(expected));
   assert(requests==(mode==5?std::vector<std::string>{}:std::vector<std::string>{idText}));
   assert(!c->invalid&&c->cleanupOnly&&c->attached&&c->endpoint==90&&c->identity==identity&&[c valid]);
   assert(staged->invalid&&!staged->observing&&sendRefs[90]==1&&receiveRefs[66]==1);
   StartupExpectation out;int sent=sends;resolvedWindow=sourceWindow;
   assert(GetAuthenticatedStartupBinding(out)==NS_ERROR_NOT_AVAILABLE&&!out.root.length&&!c->invalid);
   [c tick];[c sendRegistered];assert(sends==sent);
   assert(ConnectSource(nullptr,7,"org.zen.profilehost.test",&childListener)==NS_ERROR_ALREADY_INITIALIZED);
   assert(AuthenticateStartupWorker(7,"org.zen.profilehost.test")==NS_ERROR_ALREADY_INITIALIZED);
   nsACString descriptor;assert(StartSource(nullptr,7,"org.zen.profilehost.test","",descriptor)==NS_ERROR_NOT_AVAILABLE);
   // Duplicate cleanup and an attempted false binding cannot reopen staging.
   QueueAuth();[c receive];assert(c->cleanupOnly&&!c->invalid&&c->identity==identity);
   resolvedWindow=host->window;first=sentRecords.size();assert(CleanupWorker(nullptr)==NS_OK);
   assert(deliverSent<StartupBindingRecord>(first,kStartupBindingMessage,7));[c receive];assert(c->cleanupOnly&&!c->invalid);
   size_t requestCount=requests.size();Incoming<QuitRecord> duplicate(kNormalQuitMessage,7);
   duplicate.record.owner=c->owner;duplicate.record.identity=identity;duplicate.record.request=id;
   first=sentRecords.size();duplicate.queue();[c receive];assert(requests.size()==requestCount);
   assert(deliverSent<QuitReplyRecord>(first,kQuitReplyMessage,42));[host receive];
   for(int bad=0;bad<6;++bad){auto q=duplicate;q.record.request=id+1;
    if(bad==0)q.trailer.msgh_audit.val[5]=8;if(bad==1)q.record.owner++;
    if(bad==2)q.record.identity.token++;if(bad==3)q.record.identity.root++;
    if(bad==4)q.record.version++;if(bad==5)q.record.request=0;
    q.queue();[c receive];assert(requests.size()==requestCount&&c->quit.request==id);}
   resolvedWindow=host->window;assert(RequestQuit(nullptr,idText)==NS_OK&&requests.size()==requestCount);
   // Exact staging ownership: cleanup never invalidates a foreign source.
   auto* foreign=[[ZenProfileSource alloc]init];foreign->identity=identity;foreign->identity.root++;
   objc_setAssociatedObject(sourceWindow,&sProfileSourceKey,foreign,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
   first=sentRecords.size();assert(CleanupWorker(nullptr)==NS_OK);assert(deliverSent<StartupBindingRecord>(first,kStartupBindingMessage,7));
   [c receive];assert(!foreign->invalid);[foreign release];
  }
  [host invalidate];objc_setAssociatedObject(host->window,&sProfileHostKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [host->window release];[host release];clearEarly();
  objc_setAssociatedObject(sourceWindow,&sProfileSourceKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  objc_setAssociatedObject(sourceWindow,&sProfileControlKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [fixtureChild release];fixtureChild=nil;[sourceWindow release];sourceWindow=nil;
  assert(sendRefs[90]==0&&sendRefs[66]==0&&receiveRefs[66]==0);
 }
 // Matching-owner malformed authority remains terminal; foreign audit/owner and
 // malformed wire cannot tighten, while local/root/dead-endpoint failures retire.
 for(int bad=0;bad<10;++bad){
  sourceWindow=[[NSWindow alloc]init];fixtureChild=[[NSView alloc]init];resolvedWindow=sourceWindow;
  assert(AuthenticateStartupWorker(7,"org.zen.profilehost.test")==NS_OK);auto* c=sStartupControl;
  nsIObserver l;l.callback=[](const char*,const nsACString&){};
  assert(ConnectSource(nullptr,7,"org.zen.profilehost.test",&l)==NS_OK);
  QueueAuth();auto* binding=reinterpret_cast<StartupBindingRecord*>(incoming.back().first.data());binding->cleanupOnly=1;
  if(bad==0)reinterpret_cast<mach_msg_audit_trailer_t*>(incoming.back().first.data()+sizeof(*binding))->msgh_audit.val[5]=8;
  if(bad==1)binding->owner++;if(bad==2)binding->version++;
  if(bad==3)binding->token++;if(bad==4){binding->host.name=91;--sendRefs[90];++sendRefs[91];}
  if(bad==5)binding->expectation.profiles.bytes[0]='X';
  if(bad==6)currentParent=8;if(bad==7)fixtureDirs[2].inode++;if(bad==8)portLive=false;
  if(bad==9){[c receive];assert(c->cleanupOnly&&!c->invalid);
   for(int i=0;i<16;++i){Incoming<BootstrapRecord> junk(kBootstrapMessage,7);junk.queue();}
   StartupExpectation out;assert(GetAuthenticatedStartupBinding(out)==NS_ERROR_NOT_AVAILABLE&&!out.root.length);
   assert((!c->invalid&&c->cleanupOnly&&c->attached&&!c->receiveDrained)&&"B2 cleanup snapshot refusal must preserve attached quit owner after bounded receive");
   l.callback=[&](const char* topic,const nsACString& request){
    assert(!strcmp(topic,"zen-profile-host-normal-quit")&&request=="91");
    assert(ReplyQuit(nullptr,request,2)==NS_OK);};
   Incoming<QuitRecord> q(kNormalQuitMessage,7);q.record.owner=c->owner;q.record.identity=c->identity;q.record.request=91;
   size_t first=sentRecords.size();q.queue();[c receive];
   assert(sentRecords.size()==first+1&&outgoing.back()==kQuitReplyMessage&&!c->quit.pending);
   const auto& reply=*reinterpret_cast<const QuitReplyRecord*>(sentRecords.back().data());
   assert(reply.request==91&&reply.status==QuitStatus::Vetoed&&reply.owner==c->owner&&reply.identity==c->identity);
  }
  else [c receive];
  assert(bad<3?(!c->invalid&&!c->cleanupOnly):(bad==9?(!c->invalid&&c->cleanupOnly):c->invalid));
  currentParent=7;fixtureDirs[2]=e.local;portLive=true;clearEarly();
  objc_setAssociatedObject(sourceWindow,&sProfileSourceKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  objc_setAssociatedObject(sourceWindow,&sProfileControlKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [fixtureChild release];fixtureChild=nil;[sourceWindow release];sourceWindow=nil;
  assert(sendRefs[90]==0&&sendRefs[91]==0&&sendRefs[66]==0&&receiveRefs[66]==0);
 }
 authReply=false;puts("PASS B1 actual attached owner cleanup/request/reply: JS-derived veto/requested/unavailable, dedup, getter/reentry, transport retention and staging refusal (inert endpoints)");
}
int main(){assert(SetProfileDirectory(profile,"/owned/profile",14,3,7));
 fixtureDirs[0]=profile;selectedProfile.dir=profile;
 nsIObserver listener;listener.callback=[](const char*,const nsACString&){};
 auto* host=[[ZenProfileHost alloc]init];host->window=[[NSWindow alloc]init];host->token=17;host->listener=&listener;
 Incoming<HelloRecord> hello(kHelloMessage,42);hello.record.header.msgh_bits=MACH_MSGH_BITS_COMPLEX;
 hello.record.body.msgh_descriptor_count=1;hello.record.control.name=88;hello.record.control.type=MACH_MSG_PORT_DESCRIPTOR;
 hello.record.control.disposition=MACH_MSG_TYPE_PORT_SEND;hello.record.pid=42;hello.record.owner=9;hello.record.profile=profile;
 for(int phase=0;phase<5;++phase){
 if(phase==1){assert(host->worker.Prepare(profile));assert(host->worker.Bind(42,false));hello.trailer.msgh_audit.val[5]=41;}
 if(phase==2)hello.trailer.msgh_audit.val[5]=42;
 if(phase==3)hello.record.owner=10;
 if(phase==4)hello.record.owner=9;
 sendRefs[88]++;hello.queue();[host receive];assert(sendRefs[88]==(phase>=2?1:0));}
 assert(host->worker.control==88&&host->worker.owner==9);
 Incoming<RegisteredRecord> reg(kRegisteredMessage,42);reg.record.owner=9;reg.record.identity=Identity{42,17,18,19,20};reg.record.profile=profile;
 reg.queue();[host receive];assert(host->gate.Matches(reg.record.identity,42));assert(!host->gate.CanPublish());
 auto original=host->worker.identity;reg.record.identity.root++;reg.queue();[host receive];assert(host->worker.identity==original);
 // Receive BODY_ERROR owns/destructs its returned rights exactly once, no decode.
 sendRefs[88]++;hello.queue(MACH_RCV_BODY_ERROR|MACH_MSG_IPC_SPACE);int before=destroys;
 [host receive];assert(destroys==before+1&&host->invalid&&sendRefs[88]==0);
 [host->window release];[host release];
 for(bool cleanup:{false,true}){
 auto* c=newSource(&listener);Incoming<BootstrapRecord> boot(kBootstrapMessage,7);
 boot.record.owner=9;boot.record.token=17;boot.record.cleanupOnly=cleanup;
 boot.trailer.msgh_audit.val[5]=8;boot.queue();[c receive];assert(!c->bootstrapped);
 boot.trailer.msgh_audit.val[5]=7;boot.queue();[c receive];assert(c->bootstrapped&&c->cleanupOnly==cleanup);
 assert(c->identity.Valid()==!cleanup);
 Incoming<QuitRecord> quit(kNormalQuitMessage,7);quit.record.owner=9;quit.record.identity=c->identity;quit.record.request=1;
 listener.callback=[&](const char* topic,const nsACString& request){assert(!strcmp(topic,"zen-profile-host-normal-quit"));assert(request=="1");votes++;
 // A synchronous completed reply cannot permit another nested request before callback returns.
 assert(c->quit.Complete(1,QuitStatus::Vetoed));auto nested=quit;nested.record.request=2;nested.queue();[c receive];};
 int v=votes;quit.queue();[c receive];assert(votes==v+1&&!c->quit.pending);
 quit.queue();[c receive];assert(votes==v+1); // cached, no re-vote
 quit.record.identity.token++;quit.record.request=2;quit.queue();[c receive];assert(votes==v+1);
 listener.callback=[&](const char*,const nsACString&){votes++;[c invalidate];};
 quit.record.identity=c->identity;quit.queue();int sent=sends;[c receive];assert(c->invalid&&sends==sent);
 [c invalidate];[c release];clearSource();}
 // Late cleanup stops the exact observation and never loosens or re-registers.
 {auto* c=newSource(&listener);Incoming<BootstrapRecord> boot(kBootstrapMessage,7);
 boot.record.owner=9;boot.record.token=17;boot.queue();[c receive];assert(c->identity.Valid());
 int stopBefore=stopped;boot.record.cleanupOnly=1;boot.queue();[c receive];assert(c->cleanupOnly&&stopped==stopBefore+1);
 boot.record.cleanupOnly=0;boot.queue();[c receive];assert(c->cleanupOnly);
 Incoming<QuitRecord> quit(kNormalQuitMessage,7);quit.record.owner=9;quit.record.identity=Identity{42,17,0,0,0};quit.record.request=1;
 listener.callback=[&](const char*,const nsACString&){votes++;assert(c->quit.Complete(1,QuitStatus::Requested));};
 int v=votes;quit.queue();[c receive];assert(votes==v+1);[c invalidate];[c release];clearSource();}
 // Source receive cleanup: unknown complex message, oversized result, BODY_ERROR.
 {auto* c=newSource(&listener);hello.record.owner=9;sendRefs[88]++;hello.queue();int before=destroys;
 [c receive];assert(destroys==before+1&&sendRefs[88]==0);
 Incoming<QuitRecord> oversized(kNormalQuitMessage,7);oversized.queue(MACH_RCV_TOO_LARGE);before=destroys;
 [c receive];assert(!c->invalid&&destroys==before);
 listener.callback=[](const char*,const nsACString&){};
 sendRefs[88]++;hello.queue(MACH_RCV_BODY_ERROR);[c receive];assert(c->invalid&&sendRefs[88]==0);
 [c release];clearSource();}
 // Callback removes both association and external ownership while handlers hold self.
 {auto* c=newSource(&listener);Incoming<BootstrapRecord> boot(kBootstrapMessage,7);boot.record.owner=9;boot.record.token=17;boot.record.cleanupOnly=1;
 boot.queue();[c receive];Incoming<QuitRecord> quit(kNormalQuitMessage,7);quit.record.owner=9;quit.record.identity=c->identity;quit.record.request=1;
 listener.callback=[&](const char*,const nsACString&){[c invalidate];objc_setAssociatedObject(sourceWindow,&sProfileControlKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);};
 [c release];quit.queue();int sent=sends;[c receive];assert(sends==sent);clearSource();}
 // Parent/root/dead-right failures retire and use the same local normal-quit route.
 for(int failure=0;failure<3;++failure){
 listener.callback=[](const char* topic,const nsACString& request){assert(!strcmp(topic,"zen-profile-host-normal-quit"));assert(request=="0");votes++;};
 auto* c=newSource(&listener);int v=votes;
 if(failure==0)currentParent=8;if(failure==1)profileLive=false;if(failure==2)portLive=false;
 [c tick];assert(c->invalid&&votes==v+1);[c tick];assert(votes==v+1);
 currentParent=7;profileLive=portLive=true;[c release];clearSource();}
 // Fixed retries reuse the same owner/right; deadline retires, never starts staging.
 auto* c=newSource(&listener);for(int i=0;i<60;++i)[c hello];assert(c->helloSends==50);
 c->deadline=ControlClock::now()-std::chrono::seconds(1);[c tick];assert(c->invalid);[c release];clearSource();
 assert(sendRefs[77]==0&&sendRefs[66]==0&&receiveRefs[66]==0);testStartup();testStartupCleanup();puts("PASS actual native receiver/handlers with inert libobjc/platform endpoints: once-only rights, audit, staging, cleanup, callback teardown/reentry, finite retries");}
'''


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', type=Path, default=ROOT)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    a.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    env = {'TMPDIR':'/Users/kenkuang/.hermes/cache/scratch', 'PYTHONDONTWRITEBYTECODE':'1',
           'CLANG_MODULE_CACHE_PATH':str(a.output/'modules'), 'HOME':str(a.output), 'PATH':'/usr/bin:/bin'}
    inputs = {x: hashlib.sha256((a.root/x).read_bytes()).hexdigest() if (a.root/x).exists() else None for x in PATHS}
    inputs['oracle'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    (a.output/'inputs.json').write_text(json.dumps(inputs, indent=2))
    commands = []
    def run(cmd):
        r = subprocess.run(cmd, capture_output=True, env=env)
        n = len(commands)
        (a.output/f'{n}.stdout').write_bytes(r.stdout)
        (a.output/f'{n}.stderr').write_bytes(r.stderr)
        commands.append(dict(command=cmd, actualWait=r.returncode))
        (a.output/'commands.json').write_text(json.dumps(commands, indent=2))
        print(r.stdout.decode()+r.stderr.decode(), end='')
        return r.returncode
    for cmd in [[CLANG,'--version'],['/usr/bin/python3','--version'],[NODE,'--version']]:
        assert run(cmd)==0
    for name in ['PrepareStartupWorker', 'AuthenticateStartupWorker',
                 'GetAuthenticatedStartupBinding', 'AbandonStartupWorker']:
        assert name+'(' in (a.root/PATHS[1]).read_text(), 'API-contract RED: missing '+name
    (a.output/'control.cpp').write_text(CPP)
    status=run([CLANG,'-isysroot',SDK,'-std=c++17','-Wall','-Wextra','-Werror','-I'+str(a.root/'src/zen/toolkit/common'),str(a.output/'control.cpp'),'-o',str(a.output/'control')])
    if status:
        return status
    assert run([str(a.output/'control')])==0
    assert (a.root/PATHS[-1]).exists(), 'API-contract RED: actual worker consumer absent'
    (a.output/'worker.mjs').write_bytes((a.root/PATHS[-1]).read_bytes())
    (a.output/'check.mjs').write_text(JS+B1_JS)
    assert run([NODE,str(a.output/'check.mjs'),str(a.output/'worker.mjs')])==0
    js_replies=json.loads((a.output/'5.stdout').read_text().split('B1_JS_REPLIES ',1)[1].splitlines()[0])
    assert js_replies==[['41',2],['42',1],['43',3]]
    # Compile real control and host receiver bodies with explicit inert endpoints.
    source=(a.root/PATHS[4]).read_text()
    control=source.split('@implementation ZenProfileControl',1)[1].split('@end',1)[0]
    host=source.split('@implementation ZenProfileHost\n',1)[1].split('@end',1)[0]
    native=NATIVE
    native=native.replace('__PREFS_LIMIT__', definition(source, 'static bool PrefsAggregateLimit('))
    native=native.replace('__QUIT_VOTES__',','.join(str(status) for _,status in js_replies))
    for key, signature in [('DECIMAL','static bool Decimal('),('CLEANUP_WORKER','nsresult CleanupWorker('),
            ('REQUEST_QUIT','nsresult RequestQuit('),('REPLY_QUIT','nsresult ReplyQuit(')]:
        native=native.replace('__'+key+'__',definition(source,signature))
    native=native.replace('__HOST_TICK__',definition(host,'- (void)tick'))
    native=native.replace('__CHILD_PARENT__', definition(source, 'static bool ChildOfCurrentProcess('))
    for key, signature in [('CAPTURE_DIRECTORY','static bool CaptureDirectory('),
            ('CLONE_DIRECTORY','static bool CloneStartupDirectory('), ('READ_RAW','static bool ReadStartupRaw('),
            ('CAPTURE_REGISTRY','static bool CaptureStartupRegistry(')]:
        native=native.replace('__'+key+'__', definition(source, signature))
    native=native.replace('__HOST_STARTUP_CURRENT__', definition(host, '- (BOOL)workerCurrent').replace('workerCurrent', 'startupCurrent', 1))
    native=native.replace('__STARTUP_PREPARE__', definition(source, 'nsresult PrepareStartupWorker('))
    native=native.replace('__STARTUP_CONNECT__', definition(source, 'nsresult ConnectSource('))
    native=native.replace('__CURRENT_LOCAL__', definition(source, 'static bool CurrentStartupLocal('))
    native=native.replace('__OBSERVE_SOURCE__', definition(source, 'static void ObserveProfileSource('))
    native=native.replace('__CURRENT_PROFILE__', definition(source, 'static bool CurrentProfile('))
    start = definition(source, 'nsresult StartSource(')
    native=native.replace('__SOURCE_ENDPOINT__', start[start.index('  kern_return_t result;'):start.index('  if (!root->StartStagingObservation')])
    valid = definition(control, '- (BOOL)valid')
    native=native.replace('__CONTROL_VALID__', valid)
    native=native.replace('__CONTROL_STARTUPHELLO__', definition(control, '- (void)startupHello'))
    for key, signature in [('SERVICE', 'static bool StartupService('),
            ('AUTHENTICATE', 'nsresult AuthenticateStartupWorker('),
            ('GET', 'nsresult GetAuthenticatedStartupBinding('), ('ABANDON', 'nsresult AbandonStartupWorker(')]:
        native=native.replace('__STARTUP_'+key+'__', definition(source, signature))
    interface=source.split('@interface ZenProfileControl',1)[1].split('@end',1)[0]
    native=native.replace('__CONTROL_INTERFACE__','@interface ZenProfileControl'+interface.replace(': NSObject',': InertObject')+'@end')
    for key, signature in [('INVALIDATE','- (void)invalidate'),('RETIRE','- (void)retire'),('TICK','- (void)tick'),('HELLO','- (void)hello'),('REGISTER','- (void)sendRegistered'),('REPLY','- (void)reply'),('HANDLE','- (void)handle:'),('RECEIVE','- (void)receive')]:
        native=native.replace('__CONTROL_'+key+'__',definition(control,signature))
    native=native.replace('__CONTROL_RECEIVE__',definition(control,'- (void)receive'))
    for key, signature in [('CONTROL','- (void)control:'),('BOOTSTRAP','- (void)bootstrap'),('QUIT','- (void)sendQuit'),('RECEIVE','- (void)receive')]:
        native=native.replace('__HOST_'+key+'__',definition(host,signature))
    (a.output/'native.mm').write_text(native)
    assert run([CLANG,'-isysroot',SDK,'-std=c++17','-Wall','-Wextra','-Werror','-Wno-unused-function','-Wno-incomplete-implementation','-fblocks','-fno-objc-arc','-I'+str(a.root/'src/zen/toolkit/common'),str(a.output/'native.mm'),'-lobjc','-o',str(a.output/'native')])==0
    assert run([str(a.output/'native')])==0
    # Explicit registration/wiring evidence; not execution of ObjC++ owners.
    source=(a.root/PATHS[4]).read_text()
    for name in ['PrepareWorker','PrepareStartupWorker','BindWorker','CleanupWorker','ConnectSource','RequestQuit','ReplyQuit']:
        assert 'nsresult '+name+'(' in source
        assert 'profilehost::'+name+'(' in (a.root/PATHS[2]).read_text()
        assert 'nsresult '+name+'(' in (a.root/PATHS[1]).read_text()
    for name in ['prepareProfileHostWorker','prepareProfileHostStartupWorker','bindProfileHostWorker','cleanupProfileHostWorker','connectProfileHostSource','requestProfileHostQuit','replyProfileHostQuit']:
        assert 'void '+name+'(' in (a.root/PATHS[3]).read_text()
    assert 'ControlEndpointAlive(endpoint)' in definition(control,'- (BOOL)valid')
    assert 'NS_APP_USER_PROFILE_50_DIR' in source and '#include "nsAppDirectoryServiceDefs.h"' in source
    assert '"ZenProfileHostWorker.sys.mjs"' in (a.root/PATHS[5]).read_text()
    assert 'EXTRA_JS_MODULES.zen' in (a.root/PATHS[5]).read_text()
    assert 'HelloLayout(' in source and 'ControlLayout<RegisteredRecord>' in source
    assert source.index('header.msgh_id != kFrameMessage') < source.index('Consume(&buffer.packet.header')
    for name in ['AuthenticateStartupWorker', 'GetAuthenticatedStartupBinding', 'AbandonStartupWorker']:
        assert 'nsresult '+name+'(' in source
        assert name not in (a.root/PATHS[3]).read_text(), 'early secrets/state must not be a JS API'
    early=definition(source, 'nsresult AuthenticateStartupWorker(')
    assert not any(x in early for x in ['Resolve(', 'CurrentProfile(', 'NS_GetSpecialDirectory(',
                                        'Services', 'NSApp', 'dispatch_', 'NotifyControl('])
    assert 'NS_APP_USER_PROFILE_LOCAL_50_DIR' in source
    assert '"ZenProfileHostNative.h"' in (a.root/PATHS[5]).read_text()
    assert '"ZenProfileHostProtocol.h"' in (a.root/PATHS[5]).read_text()
    assert 'sStartupControl' in definition(source, 'nsresult ConnectSource(')
    assert 'receiveDrained' in definition(source, 'nsresult GetAuthenticatedStartupBinding(')
    assert 'MACH_MSG_TYPE_COPY_SEND' in definition(host, '- (void)bootstrap')
    assert all(hashlib.sha256((a.root/x).read_bytes()).hexdigest()==v for x,v in inputs.items() if x!='oracle' and v)
    print('PASS explicit bridge/registration checks; no Gecko build/kernel authentication/native acceptance')
    return 0


if __name__ == '__main__':
    sys.exit(main())
