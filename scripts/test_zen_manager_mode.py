#!/usr/bin/env python3
"""Manager-mode acceptance on the real Zen build.

The manager profile only draws chrome: on a cold start its default Space must
show the default browsing profile (B) through the overlay, mirror B's tabs in
the sidebar, and keep no local browsing tab of its own.

Run after building: python3 scripts/test_zen_manager_mode.py
"""
import json
import os
import subprocess
import zipfile
import signal
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import prototype_profile_hosting as probe  # noqa: E402
from test_zen_single_window_overlay import COLORS, Page, activate, capture, color_at, near  # noqa: E402


POPUP_WINDOWS = """import CoreGraphics
for w in CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]] {
  if (w["kCGWindowLayer"] as? Int ?? 0) > 0, let b = w["kCGWindowBounds"] as? [String: Double] {
    print(w["kCGWindowOwnerPID"]!, b["X"]!, b["Y"]!, b["Width"]!, b["Height"]!)
  }
}
"""


def popup_windows(work, pid):
    """On-screen popup-level windows (x, y, w, h) owned by process pid."""
    script = work / "popups.swift"
    script.write_text(POPUP_WINDOWS)
    out = subprocess.run(["swift", str(script)], capture_output=True, text=True).stdout
    rows = [line.split() for line in out.splitlines()]
    return [[float(v) for v in r[1:]] for r in rows if len(r) == 5 and int(r[0]) == pid and float(r[4]) > 0]


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def main():
    probe.SCRATCH.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="zen-manager-", dir=probe.SCRATCH))
    server = probe.http.server.ThreadingHTTPServer(("127.0.0.1", 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    def browsing_profile(name):
        path = work / name
        path.mkdir()
        (path / "user.js").write_text("\n".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k, v in {
            "xpinstall.signatures.required": False, "extensions.autoDisableScopes": 0,
            "browser.download.dir": str(work / f"dl-{name}"), "browser.download.folderList": 2,
            "browser.download.useDownloadDir": True,
            "browser.startup.page": 1, "browser.startup.homepage": f"{base}/{name}",
            "browser.shell.checkDefaultBrowser": False, "zen.welcome-screen.seen": True,
            "browser.aboutwelcome.enabled": False, "datareporting.policy.dataSubmissionEnabled": False,
        }.items()))
        return path
    profile_b = browsing_profile("B")
    # A browser_action extension installed only in B (popup beacons back).
    (profile_b / "extensions").mkdir()
    with zipfile.ZipFile(profile_b / "extensions" / "zen-test@example.com.xpi", "w") as xpi:
        xpi.writestr("manifest.json", json.dumps({
            "manifest_version": 2, "name": "Zen Test", "version": "1.0",
            "browser_specific_settings": {"gecko": {"id": "zen-test@example.com"}},
            "browser_action": {"default_title": "Zen Test", "default_popup": "popup.html",
                               "default_icon": {"32": "icon.svg"}}}))
        xpi.writestr("icon.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#e08000"/></svg>')
        xpi.writestr("popup.html", '<!doctype html><body style="background:#e08000;width:240px;height:160px">POPUP<input id="q" autofocus><script src="popup.js"></script></body>')
        xpi.writestr("popup.js", f'new Image().src = "{base}/beacon?popup"; q.oninput = () => new Image().src = "{base}/beacon?typed=" + q.value;')
    profile_c = browsing_profile("C")
    import importlib.util
    spec = importlib.util.spec_from_file_location("t", probe.TRANSPORT)
    assert spec and spec.loader
    transport = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(transport)
    result = {}
    prefs = {"zen.profiles.single-window.enabled": True,
             # absolute path works as a macOS persistentDescriptor
             "zen.profiles.manager.default-profile": str(profile_b)}
    with probe.backend("M", work, transport, headless=False, prefs_extra=prefs,
                       env_extra={"ZEN_PROFILE_OVERLAY_DEBUG": "1"}) as (m, caps):
        pid = caps["moz:processID"]
        deadline = time.monotonic() + 40
        frames = 0
        while time.monotonic() < deadline:
            frames = probe.script(m, "return Services.zen.profileOverlayFrames;", chrome=True)
            if frames > 5:
                break
            time.sleep(0.5)
        result["frames"] = frames
        time.sleep(3)
        x, y, w, h, scale = probe.script(m, "const r=document.getElementById('tabbrowser-tabbox').getBoundingClientRect();"
                                            "return [r.x,r.y,r.width,r.height, window.devicePixelRatio];", chrome=True)
        activate(pid)
        result["color"] = color_at(capture(pid, work / "manager.png"), int((x + w / 2) * scale), int((y + h * 0.6) * scale))
        for _ in range(20):
            if "svg" in probe.script(m, "return gBrowser.tabs.filter(t => t.hasAttribute('zen-profile-proxy')).map(t => t.getAttribute('image') || '').join();", chrome=True):
                break
            time.sleep(0.5)
        result["remote"] = probe.script(m, "return ChromeUtils.importESModule('resource:///modules/zen/ZenProfileOverlay.sys.mjs').ZenProfileOverlay.tabs.map(t => [t.label, (t.icon||'').slice(0,30), t.selected]);", chrome=True)
        result["proxies"] = probe.script(m, "return gBrowser.tabs.filter(t => t.hasAttribute('zen-profile-proxy')).map(t => [t.getAttribute('zen-profile-proxy'), t.label, t.selected, (t.getAttribute('image')||'').slice(0,30)]);", chrome=True)
        result["icon"] = probe.script(m, """const t = gBrowser.tabs.find(t => t.hasAttribute('zen-profile-proxy') && t.selected);
          return t ? (t.getAttribute('image') || '').slice(0, 60) + ' | ' + t.label : 'no tab';""", chrome=True)
        # A second Profile: both workers stay live and switching is instant.
        ov = "ChromeUtils.importESModule('resource:///modules/zen/ZenProfileOverlay.sys.mjs').ZenProfileOverlay"
        b_pid = probe.script(m, f"return {ov}.workerPID;", chrome=True)
        sx, sy = int((x + w / 2) * scale), int((y + h * 0.6) * scale)
        probe.script(m, f"""const done = arguments[0]; (async () => {{
            window.__first = gZenWorkspaces.activeWorkspace;
            await gZenWorkspaces.createAndSaveWorkspace('Work C');
            window.__second = gZenWorkspaces.activeWorkspace;
            {ov}.bindSpace(window.__second, {json.dumps(str(profile_c))});
            await gZenWorkspaces.changeWorkspaceWithID(window.__first);
            await gZenWorkspaces.changeWorkspaceWithID(window.__second);
            done(1); }})().catch(e => done('ERR ' + e));""", chrome=True, asynchronous=True)
        for _ in range(60):
            if near(color_at(capture(pid, work / "c.png"), sx, sy), COLORS["C"]):
                break
            time.sleep(0.5)
        result["C_color"] = color_at(capture(pid, work / "c.png"), sx, sy)
        result["pids_on_C"] = probe.script(m, f"return [{ov}.workerPID, {ov}.workerPIDs];", chrome=True)
        probe.script(m, "const done = arguments[0]; gZenWorkspaces.changeWorkspaceWithID(window.__first).then(() => done(1));",
                     chrome=True, asynchronous=True)
        started = time.monotonic()
        while time.monotonic() - started < 10 and not near(color_at(capture(pid, work / "b2.png"), sx, sy), COLORS["B"]):
            time.sleep(0.2)
        result["back_to_B_seconds"] = round(time.monotonic() - started, 2)
        result["selected_after"] = probe.script(m, "return [gBrowser.selectedTab.label, gBrowser.selectedTab.getAttribute('zen-workspace-id') == window.__first, gBrowser.selectedTab.getAttribute('zen-profile-proxy'), gZenWorkspaces.activeWorkspace == window.__first];", chrome=True)
        result["pid_back_on_B"] = probe.script(m, f"return {ov}.workerPID;", chrome=True)
        result["proxies_by_space"] = probe.script(m, """return [window.__first, window.__second].map(s =>
          gZenWorkspaces.allStoredTabs.filter(t => t.hasAttribute('zen-profile-proxy') && t.getAttribute('zen-workspace-id') == s).length);""", chrome=True)
        result["tabs"] = probe.script(m, """return gZenWorkspaces.allStoredTabs.filter(t => t.getAttribute('zen-workspace-id') == window.__first)
          .map(t => [t.label, t.getAttribute('zen-profile-proxy'), t.hasAttribute('zen-empty-tab'), t.selected]);""", chrome=True)
        # Pin and reorder in the sidebar edit the worker's tab list.
        def b_tabs():
            for _ in range(20):
                t = probe.script(m, f"return {ov}.tabs;", chrome=True)
                if t:
                    return t
                time.sleep(0.3)
        probe.script(m, f"{ov}.command({{type: 'open', url: '{base}/A'}});", chrome=True)
        for _ in range(20):
            if any(t["url"].endswith("/A") for t in b_tabs()):
                break
            time.sleep(0.3)
        blank_id = next(t["id"] for t in b_tabs() if t["url"].endswith("/A"))
        probe.script(m, f"gBrowser.pinTab(gBrowser.tabs.find(t => t.getAttribute('zen-profile-proxy') == '{blank_id}'));", chrome=True)
        for _ in range(20):
            if any(t["id"] == blank_id and t["pinned"] for t in b_tabs()):
                break
            time.sleep(0.3)
        result["pinned_in_worker"] = any(t["id"] == blank_id and t["pinned"] for t in b_tabs())
        probe.script(m, f"gBrowser.unpinTab(gBrowser.tabs.find(t => t.getAttribute('zen-profile-proxy') == '{blank_id}'));", chrome=True)
        sidebar = "return gBrowser.tabs.filter(t => t.hasAttribute('zen-profile-proxy')).map(t => Number(t.getAttribute('zen-profile-proxy')));"
        for _ in range(20):
            order = [t["id"] for t in b_tabs()]
            if probe.script(m, sidebar, chrome=True) == order:
                break
            time.sleep(0.3)
        result["manager_order"] = probe.script(m, sidebar, chrome=True)
        result["move_probe"] = probe.script(m, f"""let moved = 0; gBrowser.tabContainer.addEventListener('TabMove', () => moved++, {{once: true}});
          const p = gBrowser.tabs.filter(t => t.hasAttribute('zen-profile-proxy'));
          const before = gBrowser.tabs.map(t => t.getAttribute('zen-profile-proxy'));
          try {{ gBrowser.moveTabTo(p[0], {{tabIndex: gBrowser.tabs.indexOf(p.at(-1)) + 1}}); }} catch (e) {{ return 'ERR ' + e; }}
          return [before, gBrowser.tabs.map(t => t.getAttribute('zen-profile-proxy')), moved];""", chrome=True)
        for _ in range(20):
            if [t["id"] for t in b_tabs()] == order[1:] + order[:1]:
                break
            time.sleep(0.3)
        result["order_before"] = order
        result["sidebar_after_move"] = probe.script(m, sidebar, chrome=True)
        result["order_after"] = [t["id"] for t in b_tabs()]
        # Permission prompts from the worker are drawn by the manager.
        from test_zen_single_window_overlay import EVENTS
        probe.script(m, f"{ov}.command({{type: 'navigate', url: '{base}/persist'}});", chrome=True)
        dialog = None
        for _ in range(30):
            try:
                dialog = probe.request(m, "WebDriver:GetAlertText", {})
                break
            except RuntimeError:
                time.sleep(0.3)
        result["prompt"] = [dialog.get("value") if isinstance(dialog, dict) else dialog]
        probe.request(m, "WebDriver:AcceptAlert", {})
        for _ in range(30):
            if any(e.startswith("persist=") for e in EVENTS):
                break
            time.sleep(0.3)
        result["persist"] = [e for e in EVENTS if e.startswith("persist=")]
        # B's extension: button drawn by the manager, action run in B.
        ext = None
        for _ in range(40):
            ext = probe.script(m, "const b = document.querySelector('[zen-profile-extension]'); return b && [b.getAttribute('zen-profile-extension'), (b.getAttribute('image') || '').slice(0, 30), !!b.closest('toolbar, #zen-sidebar-top-buttons')];", chrome=True)
            if ext:
                break
            time.sleep(0.5)
        result["extension_button"] = ext
        capture(pid, work / "extension.png")
        probe.script(m, "document.querySelector('[zen-profile-extension]')?.doCommand();", chrome=True)
        for _ in range(30):
            if "popup" in EVENTS:
                break
            time.sleep(0.3)
        result["popup_beacon"] = "popup" in EVENTS
        result["popup_tab"] = any(t["url"].startswith("moz-extension://") for t in b_tabs())
        time.sleep(1)
        subprocess.run(["screencapture", "-x", str(work / "popup.png")], check=False)
        result["popup_windows"] = popup_windows(work, b_pid)
        result["button_rect"] = probe.script(m, "const r = document.querySelector('[zen-profile-extension]').getBoundingClientRect(); return [window.mozInnerScreenX + r.x, window.mozInnerScreenY + r.y, r.width, r.height, window.devicePixelRatio];", chrome=True)
        subprocess.run(["osascript", "-e", 'tell application "System Events" to keystroke "zen"'], check=False)
        for _ in range(15):
            if "typed=zen" in EVENTS:
                break
            time.sleep(0.3)
        result["popup_typed"] = [e for e in EVENTS if e.startswith("typed=")]
        probe.script(m, "document.getElementById('tabbrowser-tabpanels').dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));", chrome=True)
        for _ in range(15):
            if not popup_windows(work, b_pid):
                break
            time.sleep(0.3)
        result["popup_closed_on_click"] = not popup_windows(work, b_pid)
        probe.script(m, "document.querySelector('[zen-profile-extension]')?.doCommand();", chrome=True)
        for _ in range(15):
            if popup_windows(work, b_pid):
                break
            time.sleep(0.3)
        result["popup_reopened"] = bool(popup_windows(work, b_pid))
        # Unbound/local Space must not show B's buttons.
        probe.script(m, "const done = arguments[0]; gZenWorkspaces.changeWorkspaceWithID(window.__second).then(() => done(1));", chrome=True, asynchronous=True)
        result["buttons_on_C"] = probe.script(m, "return document.querySelectorAll('[zen-profile-extension]').length;", chrome=True)
        for _ in range(15):
            if not popup_windows(work, b_pid):
                break
            time.sleep(0.3)
        result["popup_closed_on_switch"] = not popup_windows(work, b_pid)
        probe.script(m, "const done = arguments[0]; gZenWorkspaces.changeWorkspaceWithID(window.__first).then(() => done(1));", chrome=True, asynchronous=True)
        # A download in B lands on disk and in the manager's Downloads list.
        probe.script(m, f"{ov}.command({{type: 'navigate', url: '{base}/file.bin'}});", chrome=True)
        listed = []
        for _ in range(40):
            listed = probe.script(m, """const done = arguments[0]; ChromeUtils.importESModule('resource://gre/modules/Downloads.sys.mjs').Downloads
              .getList(ChromeUtils.importESModule('resource://gre/modules/Downloads.sys.mjs').Downloads.ALL).then(l => l.getAll()).then(all => done(all.filter(d => d.succeeded).map(d => d.target.path)));""", chrome=True, asynchronous=True)
            if listed:
                break
            time.sleep(0.5)
        result["download_listed"] = listed
        result["download_file"] = (work / "dl-B" / "zen-test.bin").read_bytes().decode() if (work / "dl-B" / "zen-test.bin").exists() else None
        # In-progress worker download: progress mirrored, cancel forwarded.
        probe.script(m, f"{ov}.command({{type: 'navigate', url: '{base}/slow.bin'}});", chrome=True)
        find = """const done = arguments[0]; const { Downloads } = ChromeUtils.importESModule('resource://gre/modules/Downloads.sys.mjs');
          Downloads.getList(Downloads.ALL).then(l => l.getAll()).then(all => { const d = all.find(d => d.target.path.endsWith('zen-slow.bin'));
          done(d ? [d.progress, d.hasProgress, d.stopped, d.canceled, d.succeeded] : null); });"""
        seen = []
        for _ in range(40):
            state = probe.script(m, find, chrome=True, asynchronous=True)
            if state:
                seen.append(state)
                if 10 <= state[0] < 90:
                    break
            time.sleep(0.25)
        result["slow_progress"] = seen
        probe.script(m, "DownloadsPanel.showPanel();", chrome=True)
        time.sleep(1)
        capture(pid, work / "downloads.png")
        probe.script(m, "DownloadsPanel.hidePanel();", chrome=True)
        probe.script(m, """const done = arguments[0]; const { Downloads } = ChromeUtils.importESModule('resource://gre/modules/Downloads.sys.mjs');
          Downloads.getList(Downloads.ALL).then(l => l.getAll()).then(all => all.find(d => d.target.path.endsWith('zen-slow.bin')).cancel()).then(() => done(1));""",
                     chrome=True, asynchronous=True)
        for _ in range(30):
            state = probe.script(m, find, chrome=True, asynchronous=True)
            if state and state[3]:
                break
            time.sleep(0.3)
        result["slow_after_cancel"] = state
        result["slow_file_complete"] = (work / "dl-B" / "zen-slow.bin").exists() and (work / "dl-B" / "zen-slow.bin").stat().st_size == 655360
        # Settings (Cmd+,) opens in the bound Space's worker and is selected there.
        probe.script(m, "const done = arguments[0]; gZenWorkspaces.changeWorkspaceWithID(window.__first).then(() => { gZenWorkspaces.selectEmptyTab(); openPreferences(); openPreferences(); openPreferences(\"search\"); done(1); });",
                     chrome=True, asynchronous=True)
        for _ in range(30):
            result["settings"] = probe.script(m, f"return {ov}.tabs.filter(t => t.selected).map(t => t.label);", chrome=True)
            if result["settings"] == ["Settings"]:
                break
            time.sleep(0.5)
        result["ka_settings_windows"] = probe.script(m, "const n = [...Services.wm.getEnumerator('Ka:Settings')]; n.forEach(w => w.close()); return n.length;", chrome=True)
        result["settings_worker_alive"] = alive(probe.script(m, f"return {ov}.workerPID;", chrome=True))
        # Manager crash: workers must not outlive it (they would lock their Profiles).
        live = result["pids_on_C"][1]
        os.kill(pid, signal.SIGKILL)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and any(alive(p) for p in live):
            time.sleep(0.5)
        result["orphans_after_crash"] = [p for p in live if alive(p)]
    server.shutdown()
    local = [t for t in result["tabs"] if not t[1] and not t[2]]
    checks = {
        "default profile shown on cold start": result["frames"] > 5 and near(result["color"], COLORS["B"]),
        "sidebar mirrors default profile tabs": any(t[1] and t[3] for t in result["tabs"]),
        "manager keeps no local browsing tab": local == [],
        "Cmd+, opens one Ka Settings window": result.get("ka_settings_windows") == 1,
        "settings open selected in the worker": result.get("settings") == ["Settings"] and result["settings_worker_alive"],
        "selected placeholder keeps worker title": result["icon"].endswith("/B"),
        "second Profile shown in its Space": near(result["C_color"], COLORS["C"]),
        "both workers live at once": len(result["pids_on_C"][1]) == 2 and b_pid in result["pids_on_C"][1] and result["pids_on_C"][0] != b_pid,
        "switching back selects B's tab": result["selected_after"][1:] == [True, result["selected_after"][2], True] and result["selected_after"][0].endswith("/B"),
        "switching back reuses B instantly": result["pid_back_on_B"] == b_pid and result["back_to_B_seconds"] < 2,
        "each Space keeps its own sidebar tabs": all(n > 0 for n in result["proxies_by_space"]),
        "sidebar pin pins worker tab": result["pinned_in_worker"],
        "sidebar follows worker order": result["manager_order"] == result["order_before"],
        "sidebar reorder moves worker tab": result["order_after"] == result["order_before"][1:] + result["order_before"][:1],
        "worker permission prompt shown by manager": bool(result["prompt"]) and "127.0.0.1" in (result["prompt"][0] or ""),
        "manager answer reaches the worker": result["persist"] == ["persist=true"],
        "extension button drawn by manager": bool(result["extension_button"]) and result["extension_button"][0] == "zen-test@example.com" and result["extension_button"][1].startswith("data:image/svg"),
        "extension popup runs in worker": result["popup_beacon"],
        "popup is a panel, not a tab": not result["popup_tab"],
        # A native window just under the manager's button (screen CSS px).
        "popup opens under its button": len(result["popup_windows"]) == 1
        and abs(result["popup_windows"][0][1] - (result["button_rect"][1] + result["button_rect"][3])) < 12
        and result["popup_windows"][0][0] <= result["button_rect"][0] + result["button_rect"][2]
        and result["popup_windows"][0][0] + result["popup_windows"][0][2] >= result["button_rect"][0],
        "typing reaches the popup": "typed=zen" in result["popup_typed"],
        "click in manager closes the popup": result["popup_closed_on_click"],
        "switching Space closes the popup": result["popup_reopened"] and result["popup_closed_on_switch"],
        "other Profile's Space hides the buttons": result["buttons_on_C"] == 0,
        "worker download saved": result["download_file"] == "zen-download-payload",
        "worker download listed in manager": result["download_listed"] == [str(work / "dl-B" / "zen-test.bin")],
        "download progress mirrored": any(p[1] and 0 < p[0] < 100 and not p[2] for p in result["slow_progress"]),
        "manager cancel cancels worker download": bool(result["slow_after_cancel"]) and result["slow_after_cancel"][2] and result["slow_after_cancel"][3] and not result["slow_file_complete"],
        "workers exit when the manager crashes": result["orphans_after_crash"] == [],
        "sidebar shows worker favicon": "data%3Aimage%2Fsvg" in result["icon"],
    }
    print(json.dumps({"result": result, "checks": checks, "work": str(work)}, indent=2))
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
