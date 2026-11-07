#!/usr/bin/env python3
"""Offline source-role contracts and extracted-body checks; never native UI.

Node executes the real tracker method with inert Gecko API boundaries. C++
executes real window-feature policy and Cocoa role branches with inert property
and selector adapters. No AppKit, Gecko build, native window or paint evidence.
Use --root for an owned baseline/canonical fixture with the same oracle.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
NODE = "/Users/kenkuang/.local/share/mise/installs/node/22.22.0/bin/node"
SCRATCH = "/Users/kenkuang/.hermes/cache/scratch"


def definition(text, signature):
    start = text.index(signature)
    opening = text.index("{", start + len(signature))
    depth = 0
    for token in re.finditer(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|//[^\n]*|/\*[\s\S]*?\*/|[{}]', text[opening:]):
        if token.group() == "{":
            depth += 1
        elif token.group() == "}":
            depth -= 1
            if depth == 0:
                return text[start:opening + token.end()]
    raise AssertionError("Unclosed definition: " + signature)


def body(text, signature):
    result = definition(text, signature)
    return result[result.index("{") + 1:-1]


def read(path):
    return (ROOT / path).read_text()


def run(command, **kwargs):
    result = subprocess.run(command, text=True, capture_output=True,
                            env={**os.environ, "TMPDIR": SCRATCH}, **kwargs)
    print("COMMAND", command, "WAIT", result.returncode, flush=True)
    print(result.stdout + result.stderr, flush=True)
    assert result.returncode == 0, "extracted-body check failed"


class SourceRole(unittest.TestCase):
    def test_tracker_per_call_and_ordinary_positive(self):
        method = definition(read("engine/browser/modules/BrowserWindowTracker.sys.mjs"), "  openWindow(options = {})")
        script = r'''
const assert = require('node:assert/strict');
let calls=[], registered=[], listeners=[];
const Services={ww:{openWindow(...args){calls.push(args);return {addEventListener(...args){listeners.push(args)}}}},prefs:{getBoolPref(){return false}}};
const AppConstants={BROWSER_CHROME_URL:'chrome://browser/content/browser.xhtml',platform:'macosx'};
const Ci={nsISupportsString:{}};
const Cc={'@mozilla.org/supports-string;1':{createInstance(){return {data:null}}}};
const lazy={AIWindow:{handleAIWindowOptions(o){return o.args??null}},PrivateBrowsingUtils:{enabled:true,permanentPrivateBrowsing:false},BrowserHandler:{defaultArgs:'about:home'}};
const tracker={registerOpeningWindow(w,p){registered.push([w,p])}, __METHOD__};
tracker.openWindow();
const ordinary=calls.at(-1);
assert.equal(ordinary[3],'chrome,dialog=no,all,non-private,suppressanimation');
assert.equal(ordinary[4].data,'about:home');
const args={owned:true};
tracker.openWindow({profileHostSource:true,remote:true,fission:true,args});
assert.ok(calls.at(-1)[3].split(',').includes('profilehostsource'), 'explicit per-call source feature reaches native creation');
assert.equal(calls.at(-1)[4],args);
assert.ok(calls.at(-1)[3].includes(',remote,fission'));
tracker.openWindow();
assert.equal(calls.at(-1)[3],ordinary[3], 'role must not leak to next window');
tracker.openWindow({profileHostSource:false,private:true,remote:false,fission:false});
assert.equal(calls.at(-1)[3],'chrome,dialog=no,all,private,non-remote,non-fission,suppressanimation');
assert.equal(calls.at(-1)[4].data,'about:privatebrowsing');
assert.equal(listeners.length,4);
for (const [event,callback,options] of listeners) {assert.equal(event,'MozAfterPaint');assert.equal(typeof callback,'function');assert.equal(options.once,true)}
assert.equal(registered.length,4);
console.log('PASS actual tracker: ordinary, per-call, no leak, remote/fission, real paint listener');
'''.replace("__METHOD__", method.strip())
        run([NODE, "-e", script])

    def test_privileged_propagation_and_teardown_contract(self):
        idl = read("engine/toolkit/components/browser/nsIWebBrowserChrome.idl")
        bits = re.findall(r'const unsigned long (CHROME_\w+)\s*=\s*1 << (\d+)', idl)
        role = dict(bits).get("CHROME_PROFILE_HOST_SOURCE")
        self.assertIsNotNone(role, "API-contract RED: missing privileged role bit")
        self.assertEqual(sum(bit == role for _, bit in bits), 1)
        self.assertNotIn("CHROME_PROFILE_HOST_SOURCE", idl.split("CHROME_ALL =", 1)[1].split(";", 1)[0])
        watcher = read("engine/toolkit/components/windowwatcher/nsWindowWatcher.cpp")
        self.assertNotIn("profilehostsource", definition(watcher, "uint32_t nsWindowWatcher::CalculateChromeFlagsForContent("))
        self.assertIn('bool mProfileHostSource = false;', read("engine/widget/InitData.h"))
        shell = definition(read("engine/xpfe/appshell/nsAppShellService.cpp"), "nsresult nsAppShellService::JustCreateTopWindow(")
        self.assertLess(shell.index("widgetInitData.mProfileHostSource = true"), shell.index("window->Initialize("))
        for token in ["aIsHiddenWindow", "CHROME_OPENAS_DIALOG", "CHROME_DEPENDENT", "CHROME_MODAL", "CHROME_OPENAS_CHROME", "BackgroundTasks::IsBackgroundTaskMode()", "gfxPlatform::IsHeadless()"]:
            self.assertIn(token, shell)
        app = read("engine/xpfe/appshell/AppWindow.cpp")
        init = definition(app, "nsresult AppWindow::Initialize(")
        self.assertLess(init.index("InitWindow("), init.index("SetForceAppWindowActive(true"))
        self.assertLess(init.index("SetForceAppWindowActive(true"), init.index("MaybeDispatchInitialFocusEvent"))
        self.assertIn("PauseOrResumeCompositor(false)", init)
        destroy = definition(app, "NS_IMETHODIMP AppWindow::Destroy()")
        self.assertLess(destroy.index("SetForceAppWindowActive(false"), destroy.index("mDocShell->Destroy()"))
        native = read("engine/widget/cocoa/nsCocoaWindow.mm")
        create = definition(native, "nsresult nsCocoaWindow::Create(nsIWidget* aParent, const DesktopIntRect& aRect,")
        self.assertLess(create.index("mProfileHostSource = aInitData.mProfileHostSource"), create.index("CreateNativeWindow("))
        self.assertIn("NativeLayerRootCA::CreateForCALayer(mChildView.rootCALayer)", create)
        backing = definition(native, "nsresult nsCocoaWindow::CreateNativeWindow(")
        self.assertIn("profileHostSource:YES", backing)
        self.assertIn("defer:NO", backing)
        self.assertIn("NSWindowStyleMaskTitled", backing)
        initializer = definition(native, "- (id)initWithContentRect:(NSRect)aContentRect\n                styleMask:(NSUInteger)aStyle\n                  backing:(NSBackingStoreType)aBufferingType\n                    defer:(BOOL)aFlag\n        profileHostSource:(BOOL)aProfileHostSource")
        self.assertLess(initializer.index("mProfileHostSource = aProfileHostSource"), initializer.index("[self initWithContentRect:"))
        visible = definition(native, "- (BOOL)isVisibleOrBeingShown")
        self.assertIn("if (mProfileHostSource) return mProfileHostSourceShown;", visible)
        self.assertIn("mWindow.isVisibleOrBeingShown", definition(native, "void nsCocoaWindow::Invalidate("))
        self.assertIn("mWindow.isVisibleOrBeingShown", definition(native, "bool nsCocoaWindow::IsVisible() const"))
        self.assertIn("Show(false)", definition(native, "void nsCocoaWindow::DestroyNativeWindow()"))
        self.assertIn("@property(nonatomic, readonly) BOOL profileHostSource;", read("engine/widget/cocoa/nsCocoaWindow.h"))
        for signature in ["void nsCocoaWindow::HideWindowChrome(", "void nsCocoaWindow::QueueTransition(", "void nsCocoaWindow::SetFocus(", "nsresult nsCocoaWindow::DoMakeFullScreen(", "/* virtual */ bool nsCocoaWindow::PrepareForFullscreenTransition("]:
            self.assertIn("mProfileHostSource", definition(native, signature))
        for signature in ["- (BOOL)canBecomeKeyWindow", "- (BOOL)canBecomeMainWindow", "- (void)miniaturize:", "- (void)deminiaturize:", "- (void)toggleFullScreen:", "- (void)makeKeyWindow", "- (void)makeMainWindow"]:
            self.assertIn("mProfileHostSource", definition(native, signature))
        bridge = read("src/zen/toolkit/common/cocoa/ZenProfileHost.mm")
        start = definition(bridge, "nsresult StartSource(")
        self.assertLess(start.index("IsProfileHostSource()"), start.index("bootstrap_look_up("))
        self.assertIn("WorkerBootstrap(parentPID, uint32_t(getppid()), token)", start)
        self.assertIn("cocoa->IsProfileHostSource()", definition(bridge[bridge.index("@implementation ZenProfileSource"):], "- (BOOL)valid"))
        self.assertIn("Destroyed()", definition(read("engine/widget/cocoa/nsCocoaWindow.h"), "  bool IsProfileHostSource() const"))
        self.assertNotIn("SetForceAppWindowActive", start)
        print("PASS propagation contracts (not compilation/native behavior)")

    def test_extracted_policy_and_cocoa_branches(self):
        native = read("engine/widget/cocoa/nsCocoaWindow.mm")
        self.assertIn("if (mProfileHostSource)", body(native, "void nsCocoaWindow::Show(bool aState)"), "API-contract RED: missing early Show branch")
        show = body(native, "void nsCocoaWindow::Show(bool aState)")
        role = definition(show, "if (mProfileHostSource)")
        role = role.replace("[mChildView markLayerForDisplay]", "markLayerForDisplay()")
        order = definition(body(native, "- (void)orderWindow:"), "if (mProfileHostSource")
        visible = re.search(r'if \(mProfileHostSource\)[^;]+;', body(native, "- (BOOL)isVisibleOrBeingShown")).group()
        watcher = read("engine/toolkit/components/windowwatcher/nsWindowWatcher.cpp")
        policy = body(watcher, "uint32_t nsWindowWatcher::CalculateChromeFlagsForSystem(")
        content = body(watcher, "uint32_t nsWindowWatcher::CalculateChromeFlagsForContent(")
        popup = body(watcher, "bool nsWindowWatcher::ShouldOpenPopup(")
        shell = definition(body(read("engine/xpfe/appshell/nsAppShellService.cpp"), "nsresult nsAppShellService::JustCreateTopWindow("), "if (aChromeMask & nsIWebBrowserChrome::CHROME_PROFILE_HOST_SOURCE)")
        getter = body(read("engine/widget/cocoa/nsCocoaWindow.h"), "  bool IsProfileHostSource() const")
        native_guards = "\n".join("void guard%d(bool mProfileHostSource,int& effects){%s effects++;}" % (i, re.search(r'if \(mProfileHostSource\)[^;]+;', body(native, signature)).group()) for i, signature in enumerate(["- (void)makeKeyWindow", "- (void)makeMainWindow", "- (void)miniaturize:", "- (void)deminiaturize:", "- (void)toggleFullScreen:", "void nsCocoaWindow::QueueTransition(", "void nsCocoaWindow::SetFocus(", "void nsCocoaWindow::HideWindowChrome(", "void nsCocoaWindow::SetSizeMode("]))
        base = native.split("@implementation BaseWindow", 1)[1].split("@end", 1)[0]
        self.assertIn("- (BOOL)canBecomeKeyWindow", base, "API-contract RED: source activation eligibility")
        activation = "\n".join("bool eligible%d(bool mProfileHostSource,bool ordinary){%s}" % (i, body(base, "- (BOOL)" + name).replace("[super " + name + "]", "ordinary")) for i, name in enumerate(["canBecomeKeyWindow", "canBecomeMainWindow"]))
        idl = read("engine/toolkit/components/browser/nsIWebBrowserChrome.idl")
        constants = "\n".join("static constexpr uint32_t %s=1u<<%s;" % pair for pair in re.findall(r'const unsigned long (CHROME_\w+)\s*=\s*1 << (\d+)', idl))
        code = r'''
#include <cassert>
#include <cstdint>
#include <map>
#include <string>
#define XP_MACOSX
#define MOZ_BACKGROUNDTASKS
#define MOZ_ASSERT(...) ((void)0)
struct nsIWebBrowserChrome { __CONSTANTS__ __COMPOSITES__ };
bool BrowserTabsRemoteAutostart(){return true;} bool FissionAutostart(){return true;}
struct WindowFeatures { std::map<std::string,bool> values; bool IsEmpty()const{return values.empty();} bool Exists(const char* k)const{return values.count(k);} bool GetBool(const char* k)const{return values.at(k);} bool GetBoolWithDefault(const char* k,bool d,bool* presence=nullptr)const{auto i=values.find(k); if(i==values.end()) return d; if(presence)*presence=true; return i->second;} };
bool ShouldOpenPopup(const WindowFeatures& aFeatures){__POPUP__}
uint32_t contentPolicy(const WindowFeatures& aFeatures,bool aCalledFromJS,bool* aIsPopupRequested){__CONTENT__}
uint32_t policy(const WindowFeatures& aFeatures,bool aDialog,bool aChromeURL){__POLICY__}
bool headless=false,background=false;
struct gfxPlatform {static bool IsHeadless(){return headless;}};
struct BackgroundTasks {static bool IsBackgroundTaskMode(){return background;}};
constexpr int NS_OK=0,NS_ERROR_INVALID_ARG=1,NS_ERROR_NOT_AVAILABLE=2;
int admit(uint32_t aChromeMask,bool aIsHiddenWindow){__SHELL__ return NS_OK;}
constexpr int NSWindowOut=0, NSWindowAbove=1, NSWindowBelow=-1;
struct Window {bool profileHostSourceShown=false,profileHostSource=false,present=true;operator bool()const{return present;}};
struct Widget {bool mProfileHostSource=false,mWasShown=false,dead=false;Window mWindow;int paints=0,occlusions=0;bool Destroyed()const{return dead;}bool isSource()const{__GETTER__}void markLayerForDisplay(){paints++;}void DispatchOcclusionEvent(){occlusions++;}void show(bool aState){__SHOW__} };
void order(bool mProfileHostSource,int aPlace,int& orders){__ORDER__ orders++;}
bool visible(bool mProfileHostSource,bool mProfileHostSourceShown,bool ordinary){__VISIBLE__ return ordinary;}
__GUARDS__
__ACTIVATION__
int main(){
 WindowFeatures source{{{"chrome",true},{"dialog",false},{"profilehostsource",true}}};
 const auto bit=nsIWebBrowserChrome::CHROME_PROFILE_HOST_SOURCE;
 assert(policy(source,false,true)&bit);assert(!(policy(source,false,false)&bit));
 WindowFeatures normal{{{"chrome",true},{"dialog",false}}};assert(!(policy(normal,false,true)&bit));
 for(bool calledFromJS:{false,true})for(bool pip:{false,true}){bool popup=false;source.values["pictureinpicture"]=pip;assert(!(contentPolicy(source,calledFromJS,&popup)&bit));}
 auto mask=nsIWebBrowserChrome::CHROME_ALL|nsIWebBrowserChrome::CHROME_OPENAS_CHROME|bit;
 assert(admit(mask,false)==NS_OK);assert(admit(mask,true)==NS_ERROR_INVALID_ARG);
 assert(admit(mask&~nsIWebBrowserChrome::CHROME_TITLEBAR,false)==NS_ERROR_INVALID_ARG);
 assert(admit(mask&~nsIWebBrowserChrome::CHROME_OPENAS_CHROME,false)==NS_ERROR_INVALID_ARG);
 for(auto extra:{nsIWebBrowserChrome::CHROME_OPENAS_DIALOG,nsIWebBrowserChrome::CHROME_MODAL,nsIWebBrowserChrome::CHROME_DEPENDENT,nsIWebBrowserChrome::CHROME_ALERT,nsIWebBrowserChrome::CHROME_DOCUMENT_PIP,nsIWebBrowserChrome::CHROME_MEDIA_PIP})assert(admit(mask|extra,false)==NS_ERROR_INVALID_ARG);
 headless=true;assert(admit(mask,false)==NS_ERROR_INVALID_ARG);assert(admit(mask&~bit,false)==NS_OK);headless=false;
 background=true;assert(admit(mask,false)==NS_ERROR_NOT_AVAILABLE);assert(admit(mask&~bit,false)==NS_OK);background=false;
 for(bool remote:{false,true})for(bool fission:{false,true}) { source.values["remote"]=remote;source.values["non-remote"]=!remote;source.values["fission"]=fission;source.values["non-fission"]=!fission;auto flags=policy(source,false,true);assert(bool(flags&nsIWebBrowserChrome::CHROME_REMOTE_WINDOW)==remote);assert(bool(flags&nsIWebBrowserChrome::CHROME_FISSION_WINDOW)==fission); }
 Widget w;w.mProfileHostSource=true;assert(!w.mWindow.profileHostSourceShown);w.show(true);assert(w.mWindow.profileHostSourceShown&&w.mWasShown&&w.paints==1);w.show(false);assert(!w.mWindow.profileHostSourceShown&&w.paints==1);w.show(true);assert(w.mWindow.profileHostSourceShown&&w.paints==2);
 int orders=0;order(true,NSWindowAbove,orders);order(true,NSWindowBelow,orders);assert(orders==0);order(true,NSWindowOut,orders);assert(orders==1);order(false,NSWindowAbove,orders);assert(orders==2);
 for(bool logical:{false,true})for(bool ordinary:{false,true}){assert(visible(true,logical,ordinary)==logical);assert(visible(false,logical,ordinary)==ordinary);}
 assert(!w.isSource());w.mWindow.profileHostSource=true;assert(w.isSource());w.dead=true;assert(!w.isSource());w.dead=false;w.mWindow.present=false;assert(!w.isSource());w.mWindow.present=true;w.mProfileHostSource=false;assert(!w.isSource());
 for(auto guard:{guard0,guard1,guard2,guard3,guard4,guard5,guard6,guard7,guard8}){int effects=0;guard(true,effects);assert(effects==0);guard(false,effects);assert(effects==1);}
 for(auto eligible:{eligible0,eligible1})for(bool ordinary:{false,true}){assert(!eligible(true,ordinary));assert(eligible(false,ordinary)==ordinary);}
}
'''
        composites = "\n".join("static constexpr uint32_t %s=%s;" % (name, re.search(r'const unsigned long ' + name + r'\s*=([^;]+);', idl).group(1)) for name in ["CHROME_ALL", "CHROME_MINIMAL_POPUP", "CHROME_DOCUMENT_PICTURE_IN_PICTURE_FLAGS"])
        for key, value in [("CONSTANTS", constants), ("COMPOSITES", composites), ("POLICY", policy), ("CONTENT", content), ("POPUP", popup), ("SHELL", shell), ("GETTER", getter), ("GUARDS", native_guards), ("ACTIVATION", activation), ("SHOW", role), ("ORDER", order), ("VISIBLE", visible)]:
            code = code.replace("__" + key + "__", value)
        with tempfile.TemporaryDirectory(prefix="zen-source-role-", dir=SCRATCH) as tmp:
            path = Path(tmp) / "check.cpp"
            path.write_text(code)
            run(["/usr/bin/clang++", "-std=c++17", "-Wall", "-Werror", str(path), "-o", str(Path(tmp) / "check")])
            run([str(Path(tmp) / "check")])
        print("PASS inert extracted C++ policy/Cocoa branches; no native objects")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    options, remaining = parser.parse_known_args()
    ROOT = options.root
    unittest.main(argv=[__file__, *remaining], verbosity=2)
