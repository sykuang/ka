#!/usr/bin/env python3
"""Manager-mode acceptance on the real Zen build.

The manager profile only draws chrome: on a cold start its default Space must
show the default browsing profile (B) through the overlay, mirror B's tabs in
the sidebar, and keep no local browsing tab of its own.

Run after building: python3 scripts/test_zen_manager_mode.py
"""
import json
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import prototype_profile_hosting as probe  # noqa: E402
from test_zen_single_window_overlay import COLORS, Page, activate, capture, color_at, near  # noqa: E402


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
            "browser.startup.page": 1, "browser.startup.homepage": f"{base}/{name}",
            "browser.shell.checkDefaultBrowser": False, "zen.welcome-screen.seen": True,
            "browser.aboutwelcome.enabled": False, "datareporting.policy.dataSubmissionEnabled": False,
        }.items()))
        return path
    profile_b = browsing_profile("B")
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
    server.shutdown()
    local = [t for t in result["tabs"] if not t[1] and not t[2]]
    checks = {
        "default profile shown on cold start": result["frames"] > 5 and near(result["color"], COLORS["B"]),
        "sidebar mirrors default profile tabs": any(t[1] and t[3] for t in result["tabs"]),
        "manager keeps no local browsing tab": local == [],
        "selected placeholder keeps worker title": result["icon"].endswith("/B"),
        "second Profile shown in its Space": near(result["C_color"], COLORS["C"]),
        "both workers live at once": len(result["pids_on_C"][1]) == 2 and b_pid in result["pids_on_C"][1] and result["pids_on_C"][0] != b_pid,
        "switching back selects B's tab": result["selected_after"][1:] == [True, result["selected_after"][2], True] and result["selected_after"][0].endswith("/B"),
        "switching back reuses B instantly": result["pid_back_on_B"] == b_pid and result["back_to_B_seconds"] < 2,
        "each Space keeps its own sidebar tabs": all(n > 0 for n in result["proxies_by_space"]),
        "sidebar shows worker favicon": "data%3Aimage%2Fsvg" in result["icon"],
    }
    print(json.dumps({"result": result, "checks": checks, "work": str(work)}, indent=2))
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
