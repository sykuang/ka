#!/usr/bin/env python3
"""Single-window overlay acceptance on the real Zen build.

A Zen window (Profile A) switches to a Space bound to Profile B. B must run as a
hidden worker and its page pixels must appear inside A's own window; switching
back to a local Space must show A's page again. Screenshots are of A's real
window (screencapture -l), not of any helper window.

Run after building: python3 scripts/test_zen_single_window_overlay.py
"""
import json
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import prototype_profile_hosting as probe  # noqa: E402

COLORS = {"A": "#d01010", "B": "#10a040"}
TYPED = {"A": "#e0c000", "B": "#c000e0"}  # page color after typing "zen"
EVENTS = []  # beacons from B's page: proves input reached B's own content


WINDOW_ID = r'''
import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
  print(w[kCGWindowNumber as String]!); break
}
'''


class Page(probe.Page):
    def do_GET(self):
        if self.path.startswith("/beacon?"):
            EVENTS.append(urllib.parse.unquote(self.path[8:]))
            self.send_response(204)
            self.end_headers()
            return
        name = self.path.strip("/") or "A"
        body = (f'<!doctype html><body style="margin:0;background:{COLORS.get(name, "#000")}">'
                f'<h1>PROFILE {name}</h1><input id=t style="position:absolute;left:100px;top:200px;width:300px;height:40px">'
                '<script>const b=v=>{document.title=v;if(v=="mousedown")document.body.style.background="#1040d0";if(v=="value=zen")document.body.style.background="'+TYPED.get(name,"#000")+'";new Image().src="/beacon?"+encodeURIComponent(v)};'
                'document.onmousedown=()=>b("mousedown");t.oninput=()=>b("value="+t.value);</script>').encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def activate(pid):
    subprocess.run(["swift", "-e", "import AppKit; _ = NSRunningApplication(processIdentifier: " + str(pid) + ")!.activate(options: [.activateAllWindows]); RunLoop.main.run(until: Date().addingTimeInterval(1))"], check=True)


def click(a, x, y):
    """Native click through AppKit routing (NSApp sendEvent), at chrome CSS coords."""
    probe.script(a, f"""
      const u = window.windowUtils, s = window.devicePixelRatio;
      const X = (window.mozInnerScreenX + {x}) * s, Y = (window.mozInnerScreenY + {y}) * s;
      u.sendNativeMouseEvent(X, Y, u.NATIVE_MOUSE_MESSAGE_BUTTON_DOWN, 0, 0, document.documentElement, null);
      u.sendNativeMouseEvent(X, Y, u.NATIVE_MOUSE_MESSAGE_BUTTON_UP, 0, 0, document.documentElement, null);
    """, chrome=True)
    time.sleep(0.5)


KEYCODES = {"z": 6, "e": 14, "n": 45}
KEYS = r'''
import CoreGraphics
let a = CommandLine.arguments
let pid = Int32(a[1])!
for code in a[2...] {
  for down in [true, false] {
    CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(UInt16(code)!), keyDown: down)!.postToPid(pid)
    usleep(40000)
  }
}
'''


def type_text(pid, text):
    """Real key events into the active app's key window (AppKit first responder)."""
    subprocess.run(["swift", "-e", KEYS, str(pid), *[str(KEYCODES[c]) for c in text]], check=True)


def capture(pid, out):
    wid = subprocess.run(["swift", "-e", WINDOW_ID, str(pid)], capture_output=True, text=True).stdout.strip()
    assert wid, "A window not on screen"
    subprocess.run(["screencapture", "-x", "-o", "-l", wid, str(out)], check=True)
    return out


def color_at(png, x, y):
    # sips cannot sample; use the built-in Python-free route via swift CoreGraphics.
    src = r'''
import AppKit
let img = NSBitmapImageRep(data: try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))!
let c = img.colorAt(x: Int(CommandLine.arguments[2])!, y: Int(CommandLine.arguments[3])!)!.usingColorSpace(.sRGB)!
print(Int(c.redComponent*255), Int(c.greenComponent*255), Int(c.blueComponent*255))
'''
    return tuple(map(int, subprocess.run(["swift", "-e", src, str(png), str(x), str(y)],
                                         capture_output=True, text=True, check=True).stdout.split()))


def near(rgb, hexcolor):
    # Window captures are color-managed (Display P3), so compare dominant channel.
    want = tuple(int(hexcolor[i:i + 2], 16) for i in (1, 3, 5))
    return max(range(3), key=lambda i: rgb[i]) == max(range(3), key=lambda i: want[i])


def main():
    probe.SCRATCH.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="zen-overlay-", dir=probe.SCRATCH))
    server = probe.http.server.ThreadingHTTPServer(("127.0.0.1", 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    profile_b = work / "B"
    profile_b.mkdir()
    (profile_b / "user.js").write_text("\n".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k, v in {
        "browser.startup.page": 1, "browser.startup.homepage": f"{base}/B",
        "browser.shell.checkDefaultBrowser": False, "zen.welcome-screen.seen": True,
        "browser.aboutwelcome.enabled": False, "datareporting.policy.dataSubmissionEnabled": False,
    }.items()))
    import importlib.util
    spec = importlib.util.spec_from_file_location("t", probe.TRANSPORT)
    assert spec and spec.loader
    transport = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(transport)
    result = {}
    with probe.backend("A", work, transport, headless=False, env_extra={"ZEN_PROFILE_OVERLAY_DEBUG": "1"}) as (a, caps):
        pid = caps["moz:processID"]
        probe.script(a, f"window.gBrowser.loadURI(Services.io.newURI('{base}/A'), "
                        "{triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});", chrome=True)
        time.sleep(3)
        rect = probe.script(a, "const r=document.getElementById('tabbrowser-tabbox').getBoundingClientRect();"
                               "return [r.x,r.y,r.width,r.height, window.devicePixelRatio];", chrome=True)
        x, y, w, h, scale = rect
        sample = (int((x + w / 2) * scale), int((y + h * 0.6) * scale))
        activate(pid)
        result["A_before"] = color_at(capture(pid, work / "a-before.png"), *sample)
        click(a, x + 250, y + 220)
        time.sleep(1)
        result["A_events"] = list(EVENTS)
        type_text(pid, "zen")
        time.sleep(1)
        result["A_title"] = probe.script(a, "return gBrowser.selectedBrowser.contentTitle;", chrome=True)
        result["A_after_click"] = color_at(capture(pid, work / "a-click.png"), *sample)
        EVENTS.clear()
        result["switch"] = probe.script(a, f"""
          Services.prefs.setBoolPref('zen.profiles.single-window.enabled', true);
          const dir = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
          dir.initWithPath({json.dumps(str(profile_b))});
          window.__zenLocal = gZenWorkspaces.activeWorkspace;
          const ws = {{uuid: '{{b-space}}', name: 'B', geckoProfileReference: {{version: 1, persistentDescriptor: dir.persistentDescriptor}}}};
          const done = arguments[0];
          gZenWorkspaces.changeWorkspace(ws).then(r => done(String(!!r)), e => done('ERR ' + e));
        """, chrome=True, asynchronous=True)
        deadline = time.monotonic() + 40
        frames = 0
        while time.monotonic() < deadline:
            frames = probe.script(a, "return Services.zen.profileOverlayFrames;", chrome=True)
            if frames > 5:
                break
            time.sleep(0.5)
        result["frames"] = frames
        time.sleep(2)
        shot = capture(pid, work / "b-overlay.png")
        result["B_overlay"] = color_at(shot, *sample)
        # Worker must draw content only: B's own sidebar would sit at the left edge.
        result["B_left_edge"] = color_at(shot, int((x + 12) * scale), int((y + h * 0.6) * scale))
        click(a, x + 250, y + 220)
        time.sleep(1)
        time.sleep(1)
        result["B_after_click"] = color_at(capture(pid, work / "b-click.png"), *sample)
        type_text(pid, "zen")
        time.sleep(2)
        result["B_after_type"] = color_at(capture(pid, work / "b-type.png"), *sample)
        result["B_events"] = list(EVENTS)
        # Grow the host: the worker must follow, or the new strip stays empty.
        probe.script(a, "window.resizeBy(160, 80);", chrome=True)
        time.sleep(2)
        nx, ny, nw, nh = probe.script(a, "const r=document.getElementById('tabbrowser-tabbox').getBoundingClientRect();"
                                         "return [r.x,r.y,r.width,r.height];", chrome=True)
        result["grown"] = [nw - w, nh - h]
        result["B_grown_corner"] = color_at(capture(pid, work / "b-grown.png"),
                                            int((nx + nw - 20) * scale), int((ny + nh - 20) * scale))
        result["A_focused_url"] = probe.script(a, "return gBrowser.currentURI.spec;", chrome=True)
        result["worker_pid"] = probe.script(a, "return ChromeUtils.importESModule('resource:///modules/zen/ZenProfileOverlay.sys.mjs').ZenProfileOverlay.workerPID;", chrome=True)
        probe.script(a, """const done=arguments[0];
          gZenWorkspaces.changeWorkspaceWithID(window.__zenLocal).then(()=>done(1), e=>done('ERR '+e));""",
                     chrome=True, asynchronous=True)
        time.sleep(2)
        result["A_after"] = color_at(capture(pid, work / "a-after.png"), *sample)
    server.shutdown()
    checks = {
        "A page visible before": near(result["A_before"], COLORS["A"]),
        "B frames received": result["frames"] > 5,
        "B page inside A window": near(result["B_overlay"], COLORS["B"]),
        "B draws no sidebar": near(result["B_left_edge"], COLORS["B"]),
        "click reaches B page": "mousedown" in result["B_events"],
        "typing reaches B input": "value=zen" in result["B_events"],
        "B follows host resize": result["grown"][0] > 100 and near(result["B_grown_corner"], TYPED["B"]),
        "A page back after switch": result["A_after"] == result["A_after_click"],
    }
    print(json.dumps({"result": result, "checks": checks, "work": str(work)}, indent=2))
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
