#!/usr/bin/env python3
"""Throwaway real-profile backend/hosting probe; NOT an Arc implementation.

Run: python3 scripts/prototype_profile_hosting.py
Native transport only: python3 scripts/prototype_profile_hosting.py --native-transport
Uses the existing Zen build, upstream Marionette transport, and disposable profiles.
Exit 0 means the backend probe passed, NOT that single-window hosting works.
"""

import contextlib
import argparse
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = Path(os.environ.get("HERMES_PROTOTYPE_SCRATCH", str(Path.home() / ".hermes/cache/scratch")))
BINARY = ROOT / "engine/obj-aarch64-apple-darwin/dist/Nightly.app/Contents/MacOS/zen"
TRANSPORT = ROOT / "engine/testing/marionette/client/marionette_driver/transport.py"
ADDON_ID = "profile-hosting-prototype@example.invalid"


def request(client, name, params):
    response = client.request(name, params)
    if response.error:
        raise RuntimeError(f"{name}: {response.error}")
    return response.result


def script(client, source, args=(), chrome=False, asynchronous=False):
    request(client, "Marionette:SetContext", {"value": "chrome" if chrome else "content"})
    result = request(client, "WebDriver:ExecuteAsyncScript" if asynchronous else "WebDriver:ExecuteScript", {
        "script": source, "args": list(args), "newSandbox": True,
        "sandbox": "default", "filename": "prototype_profile_hosting.py", "line": 1,
    })
    return result["value"]


class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'<!doctype html><title>Disposable Gecko profile probe</title><pre id="state">waiting</pre>'
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


@contextlib.contextmanager
def backend(name, work, transport, *, headless=True, env_extra=None):
    profile = work / name
    profile.mkdir(exist_ok=True)  # reuse = cold restart of the same profile
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    prefs = {
        "marionette.port": port,
        "marionette.enabled": True,
        "browser.shell.checkDefaultBrowser": False,
        "browser.startup.homepage": "about:blank",
        "browser.startup.page": 0,
        "browser.startup.firstrunSkipsHomepage": True,
        "browser.aboutwelcome.enabled": False,
        "zen.welcome-screen.seen": True,
        "datareporting.policy.dataSubmissionEnabled": False,
        "toolkit.telemetry.enabled": False,
        "extensions.update.enabled": False,
    }
    (profile / "user.js").write_text("\n".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k, v in prefs.items()))
    client = transport.TcpTransport("127.0.0.1", port, socket_timeout=20)
    with (work / f"{name}.log").open("w") as log:
        process = subprocess.Popen([
            str(BINARY), *(["--headless"] if headless else []), "--new-instance", "--no-remote",
            "--profile", str(profile), "--marionette", "--remote-allow-system-access", "about:blank",
        ], stdout=log, stderr=subprocess.STDOUT, env={**os.environ, "TMPDIR": str(work), "MOZ_CRASHREPORTER_DISABLE": "1", **(env_extra or {})})
        try:
            deadline = time.monotonic() + 50
            while True:
                if process.poll() is not None:
                    raise RuntimeError(f"Backend {name} exited {process.returncode}; see {log.name}")
                try:
                    client.connect()
                    break
                except OSError:
                    if time.monotonic() > deadline:
                        raise TimeoutError(f"Backend {name} did not start; see {log.name}")
                    time.sleep(0.1)
            session = request(client, "WebDriver:NewSession", {})
            assert Path(session["capabilities"]["moz:profile"]).resolve() == profile.resolve()
            yield client, session["capabilities"]
        finally:
            try:
                request(client, "Marionette:Quit", {"flags": ["eAttemptQuit"]})
            except (OSError, RuntimeError, AttributeError):
                pass
            client.close()
            try:
                process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def make_addon(path):
    manifest = {
        "manifest_version": 2, "name": "Disposable profile-hosting probe", "version": "0.1",
        "browser_specific_settings": {"gecko": {"id": ADDON_ID}},
        "permissions": ["storage", "http://127.0.0.1/*"],
        "background": {"scripts": ["background.js"], "persistent": True},
        "content_scripts": [{"matches": ["http://127.0.0.1/*"], "js": ["content.js"], "run_at": "document_idle"}],
    }
    background = '''
const nonce = crypto.randomUUID();
let counter = 0;
let heartbeat = 0;
setInterval(() => {
  heartbeat++;
  browser.storage.local.set({background: {nonce, heartbeat}});
}, 100);
browser.runtime.onMessage.addListener(async ({marker}, sender) => {
  const {sentinel: previous = null} = await browser.storage.local.get("sentinel");
  if (marker !== null) await browser.storage.local.set({sentinel: marker});
  const {sentinel = null, background = null} = await browser.storage.local.get(["sentinel", "background"]);
  return {extensionId: browser.runtime.id, nonce, counter: ++counter, heartbeat,
    previous, sentinel, background, cookieStoreId: sender.tab?.cookieStoreId ?? null,
    senderUrl: sender.url ?? null, senderTabId: sender.tab?.id ?? null};
});
'''
    content = '''
(async () => {
  try {
    const marker = new URL(location.href).searchParams.get("marker");
    if (marker !== null) document.cookie = `profile_probe=${marker}; Path=/; SameSite=Lax`;
    const result = await browser.runtime.sendMessage({marker});
    result.cookie = document.cookie;
    const bar = document.getElementById("bar");
    if (bar) bar.style.backgroundColor = result.sentinel === "A" ? "#ffb900" : result.sentinel === "B" ? "#00d7ff" : "#000000";
    document.getElementById("state").textContent = JSON.stringify(result);
  } catch (error) {
    document.getElementById("state").textContent = JSON.stringify({error: String(error)});
  }
})();
'''
    with zipfile.ZipFile(path, "w") as archive:
        for filename, text in {"manifest.json": json.dumps(manifest), "background.js": background, "content.js": content}.items():
            archive.writestr(filename, text)


def install(client, archive):
    result = script(client, '''
const [path, done] = arguments;
const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
file.initWithPath(path);
AddonManager.installTemporaryAddon(file).then(addon => done({id: addon.id}), error => done({error: String(error)}));
''', [str(archive)], chrome=True, asynchronous=True)
    assert result == {"id": ADDON_ID}, result


def page_probe(client, url, marker=None):
    request(client, "Marionette:SetContext", {"value": "content"})
    request(client, "WebDriver:Navigate", {"url": url + (f"?marker={marker}" if marker else "")})
    result = script(client, '''
const done = arguments[arguments.length - 1];
const deadline = Date.now() + 10000;
function poll() {
  const text = document.getElementById("state")?.textContent;
  if (text && text !== "waiting") { done(JSON.parse(text)); return; }
  if (Date.now() > deadline) { done({error: "content/background message timed out"}); return; }
  setTimeout(poll, 30);
}
poll();
''', asynchronous=True)
    assert "error" not in result, result
    return result


def new_profile_tab(client):
    """Create a real tab without Marionette.openTab's implicit OS activation wait."""
    handle = script(client, """
const win = Services.wm.getMostRecentWindow("navigator:browser");
const {NavigableManager} = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
const {waitForInitialNavigationCompleted} = ChromeUtils.importESModule("chrome://remote/content/shared/Navigate.sys.mjs");
const done = arguments[arguments.length - 1];
const tab = win.gBrowser.addTrustedTab("about:blank", {skipAnimation: true});
waitForInitialNavigationCompleted(tab.linkedBrowser.browsingContext.webProgress, {unloadTimeout: 5000})
  .then(() => done(String(NavigableManager.getIdForBrowser(tab.linkedBrowser))), error => done({error: String(error)}));
""", chrome=True, asynchronous=True)
    if not isinstance(handle, str):
        raise RuntimeError(f"Initial profile tab navigation failed: {handle}")
    request(client, "Marionette:SetContext", {"value": "content"})
    return handle


def select_profile_tab(client, handle):
    """Select the Gecko tab, not OS window focus; configure the observer separately."""
    selected = script(client, """
const win = Services.wm.getMostRecentWindow("navigator:browser");
const {NavigableManager} = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
const tab = Array.from(win.gBrowser.tabs).find(tab => String(NavigableManager.getIdForBrowser(tab.linkedBrowser)) === arguments[0]);
if (!tab) throw new Error("Unknown profile tab");
win.gBrowser.selectedTab = tab;
return String(NavigableManager.getIdForBrowser(win.gBrowser.selectedBrowser));
""", [handle], chrome=True)
    assert selected == handle
    request(client, "Marionette:SetContext", {"value": "content"})
    request(client, "WebDriver:SwitchToWindow", {"handle": handle, "focus": False})


def reopen_profile_page(source, destination):
    """GET-only diagnostic transfer, not single-window hosting or session copying."""
    request(source, "Marionette:SetContext", {"value": "content"})
    request(destination, "Marionette:SetContext", {"value": "content"})
    source_handle = request(source, "WebDriver:GetWindowHandle", {})["value"]
    url = script(source, "return location.href;")
    previous = request(destination, "WebDriver:GetWindowHandle", {})["value"]
    target = new_profile_tab(destination)
    try:
        select_profile_tab(destination, target)
        observed = page_probe(destination, url)
    except Exception:
        try:
            select_profile_tab(destination, target)
            request(destination, "WebDriver:CloseWindow", {})
            select_profile_tab(destination, previous)
        except (OSError, RuntimeError):
            pass
        raise
    select_profile_tab(source, source_handle)
    remaining = request(source, "WebDriver:CloseWindow", {})
    if remaining:
        select_profile_tab(source, remaining[0])
    return {"url": url, "source_handle": source_handle,
            "destination_handle": target, "probe": observed}


def window_identity(client):
    return script(client, '''
const win = Services.wm.getMostRecentWindow("navigator:browser");
return {pid: Services.appinfo.processID, profile: PathUtils.profileDir,
  windowCount: Array.from(Services.wm.getEnumerator("navigator:browser")).length,
  browsingContextId: win.gBrowser.selectedBrowser.browsingContext.id,
  ownedContext: !!win.gBrowser.selectedBrowser.browsingContext};
''', chrome=True)


def compile_native_host(work, source):
    build_env = dict(os.environ)
    build_env.pop("SDKROOT", None)
    build_env["TMPDIR"] = str(work)
    driver = "clang++" if source.suffix == ".mm" else "clang"
    compiler = Path(subprocess.check_output(["/usr/bin/xcrun", "--find", driver], text=True).strip())
    developer = compiler.parents[4]
    if developer.name == "Developer":
        build_env["DEVELOPER_DIR"] = str(developer)
    sdk = subprocess.check_output(["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"], env=build_env, text=True).strip()
    binary = work / "native-host"
    command = [str(compiler), "-isysroot", sdk, "-fobjc-arc", "-Wall", "-Wextra", "-Werror",
               "-Wno-deprecated-declarations", "-framework", "Cocoa", "-framework", "QuartzCore",
               "-framework", "IOSurface", str(source), "-o", str(binary)]
    if source.name == "prototype_gecko_layer_host.m":
        command.extend(["-framework", "ScreenCaptureKit", "-framework", "Carbon"])
    if source.name == "native-text-ocr.m":
        command.extend(["-framework", "Vision"])
    with (work / "build.log").open("w") as log:
        subprocess.run(command, env=build_env, stdout=log, stderr=subprocess.STDOUT, check=True)
    return binary


def native_transport(interactive):
    if sys.platform != "darwin":
        raise SystemExit("The native transport probe requires macOS.")
    SCRATCH.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="zen-native-transport-", dir=SCRATCH))
    binary = compile_native_host(work, ROOT / "scripts/prototype_native_layer_host.m")
    print(f"NATIVE TRANSPORT ONLY (synthetic workers, NOT Gecko). Artifacts: {work}", flush=True)
    command = [str(binary)] + (["--interactive"] if interactive else [])
    completed = subprocess.run(command, capture_output=True, text=True, timeout=None if interactive else 20)
    (work / "result.log").write_text(completed.stdout + completed.stderr)
    print(completed.stdout, end="")
    if completed.stderr:
        print(completed.stderr, file=sys.stderr, end="")
    completed.check_returncode()
    if not interactive:
        result = json.loads(completed.stdout)
        assert result["native_transport_probe"] == "PASS"
        assert result["gecko_connected"] is False and result["synthetic_surfaces"] is True
        assert len(set(result["worker_pids"])) == 2
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-transport", action="store_true", help="Build/run synthetic IOSurface Mach-port transport, NOT Gecko hosting")
    parser.add_argument("--interactive", action="store_true", help="Keep native transport window open until closed")
    args = parser.parse_args()
    if args.native_transport:
        native_transport(args.interactive)
        return
    if args.interactive:
        parser.error("--interactive requires --native-transport")
    if not BINARY.is_file():
        raise SystemExit(f"Build Zen first; missing {BINARY}")
    SCRATCH.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="zen-profile-hosting-", dir=SCRATCH))
    print(f"PROTOTYPE artifacts: {work}", flush=True)
    spec = importlib.util.spec_from_file_location("upstream_marionette_transport", TRANSPORT)
    assert spec is not None and spec.loader is not None
    transport = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(transport)
    archive = work / "probe.xpi"
    make_addon(archive)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    result = {"prototype": True, "single_window_hosting": "NOT_IMPLEMENTED", "backend_probe": "NOT_RUN"}
    try:
        with backend("A", work, transport) as (a, caps_a), backend("B", work, transport) as (b, caps_b):
            assert caps_a["moz:processID"] != caps_b["moz:processID"]
            install(a, archive)
            install(b, archive)
            url = f"http://127.0.0.1:{server.server_port}/probe"
            a1 = page_probe(a, url, "A")
            b1 = page_probe(b, url, "B")
            b2 = page_probe(b, url)
            a2 = page_probe(a, url)
            assert a1["extensionId"] == b1["extensionId"] == ADDON_ID
            assert a1["previous"] is None and b1["previous"] is None
            assert a1["nonce"] != b1["nonce"]
            assert a1["counter"] == b1["counter"] == 1
            assert a2["counter"] == b2["counter"] == 2
            assert a2["nonce"] == a1["nonce"] and b2["nonce"] == b1["nonce"]
            assert a2["sentinel"] == "A" and b2["sentinel"] == "B"
            assert a2["cookie"] == "profile_probe=A" and b2["cookie"] == "profile_probe=B"
            assert a2["heartbeat"] > a1["heartbeat"]
            assert a2["background"] is not None
            assert a2["background"]["nonce"] == a1["nonce"]
            identity_a, identity_b = window_identity(a), window_identity(b)
            foreign_context = script(a, '''
const candidate = BrowsingContext.get(arguments[0]);
return {found: !!candidate, isOwnSelectedContext: candidate === Services.wm.getMostRecentWindow("navigator:browser").gBrowser.selectedBrowser.browsingContext};
''', [identity_b["browsingContextId"]], chrome=True)
            result.update({
                "backend_probe": "PASS", "addon_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                "same_exact_xpi_both_profiles": True,
                "observations": {"A_first": a1, "B_first": b1, "A_again": a2, "B_again": b2},
                "backends": {"A": identity_a, "B": identity_b},
                "foreign_context_lookup_from_A": foreign_context,
                "context_ids_collide": identity_a["browsingContextId"] == identity_b["browsingContextId"],
                "hosting_note": "Two independent headless parent processes. No rendering/input bridge implemented; no claim of single-window operation. Foreign BrowsingContext lookup alone cannot transfer a tab or native view.",
            })
    except Exception as error:
        result["backend_probe"] = "FAIL"
        result["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        server.shutdown()
        server.server_close()
        for name in ("A", "B"):
            shutil.rmtree(work / name, ignore_errors=True)
        result["disposable_profiles_removed"] = all(not (work / name).exists() for name in ("A", "B"))
        (work / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
