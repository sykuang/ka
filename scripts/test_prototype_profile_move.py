#!/usr/bin/env python3
"""A -> B -> A webpage-move acceptance, including the real single-window host.

Run after rebuilding Gecko with the local layer hook: python3 scripts/test_prototype_profile_move.py
Backend-only diagnostic: python3 scripts/test_prototype_profile_move.py --backend-only
"""
import argparse
import contextlib
import importlib.util
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

import prototype_profile_hosting as probe


class ProfileMove(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        probe.SCRATCH.mkdir(parents=True, exist_ok=True)
        self.work = Path(tempfile.mkdtemp(prefix="zen-profile-move-", dir=probe.SCRATCH))
        self.stack.callback(shutil.rmtree, self.work)
        spec = importlib.util.spec_from_file_location("upstream_transport", probe.TRANSPORT)
        assert spec is not None and spec.loader is not None
        transport = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(transport)
        self.a, _ = self.stack.enter_context(probe.backend("A", self.work, transport))
        self.b, _ = self.stack.enter_context(probe.backend("B", self.work, transport))
        archive = self.work / "same-probe.xpi"
        probe.make_addon(archive)
        for client in (self.a, self.b):
            probe.install(client, archive)
        server = probe.http.server.ThreadingHTTPServer(("127.0.0.1", 0), probe.Page)
        self.stack.callback(server.server_close)
        self.stack.callback(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{server.server_port}/move-page"
        self.state_a = probe.page_probe(self.a, self.url, "A")
        self.state_b = probe.page_probe(self.b, self.url, "B")
        probe.page_probe(self.a, self.url)
        # Preserve a control tab so closing the moved tab cannot quit its parent.
        self.source = self.call(self.a, "GetWindowHandle")["value"]
        probe.new_profile_tab(self.a)
        probe.select_profile_tab(self.a, self.source)

    def call(self, client, name, params=None):
        probe.request(client, "Marionette:SetContext", {"value": "content"})
        return probe.request(client, "WebDriver:" + name, params or {})

    def test_roundtrip_reloads_in_destination_profile(self):
        self.assertTrue(callable(getattr(probe, "reopen_profile_page", None)), "No real cross-profile page mover implemented")
        before = [probe.window_identity(c)["windowCount"] for c in (self.a, self.b)]
        probe.script(self.a, 'document.documentElement.setAttribute("data-unsaved-source", "A-only");')
        moved = probe.reopen_profile_page(self.a, self.b)
        self.assertEqual(moved["url"], self.url)
        self.assertEqual(moved["probe"]["cookie"], "profile_probe=B")
        self.assertEqual(moved["probe"]["sentinel"], "B")
        self.assertEqual(moved["probe"]["nonce"], self.state_b["nonce"])
        self.assertNotEqual(moved["probe"]["nonce"], self.state_a["nonce"])
        self.assertNotIn(self.source, self.call(self.a, "GetWindowHandles"))
        self.assertIsNone(probe.script(self.b, 'return document.documentElement.getAttribute("data-unsaved-source");'))
        returned = probe.reopen_profile_page(self.b, self.a)
        self.assertEqual(returned["url"], self.url)
        self.assertEqual(returned["probe"]["cookie"], "profile_probe=A")
        self.assertEqual(returned["probe"]["sentinel"], "A")
        self.assertEqual(returned["probe"]["nonce"], self.state_a["nonce"])
        self.assertNotIn(moved["destination_handle"], self.call(self.b, "GetWindowHandles"))
        self.assertEqual([probe.window_identity(c)["windowCount"] for c in (self.a, self.b)], before)
        self.assertIsNone(probe.script(self.a, 'return document.documentElement.getAttribute("data-unsaved-source");'))

    def test_destination_failure_keeps_source_and_removes_partial_target(self):
        before = self.call(self.b, "GetWindowHandles")
        removed = probe.script(self.b, '''
const done = arguments[arguments.length - 1];
const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
AddonManager.getAddonByID(arguments[0]).then(addon => addon.uninstall()).then(() => done(true), error => done({error: String(error)}));
''', [probe.ADDON_ID], chrome=True, asynchronous=True)
        self.assertIs(removed, True)
        self.call(self.b, "SetTimeouts", {"script": 1500})
        probe.script(self.a, 'document.documentElement.setAttribute("data-unsaved-source", "keep-me");')
        with self.assertRaisesRegex(RuntimeError, "script timeout"):
            probe.reopen_profile_page(self.a, self.b)
        self.assertIn(self.source, self.call(self.a, "GetWindowHandles"))
        self.assertEqual(probe.script(self.a, "return location.href;"), self.url)
        self.assertEqual(probe.script(self.a, 'return document.documentElement.getAttribute("data-unsaved-source");'), "keep-me")
        self.assertEqual(probe.script(self.a, "return document.cookie;"), "profile_probe=A")
        self.assertEqual(self.call(self.b, "GetWindowHandles"), before)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend-only", action="store_true")
    args = parser.parse_args()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ProfileMove))
    if not result.wasSuccessful():
        raise SystemExit(1)
    # Runnable contract check: the native gate must never regain an automation input/focus fallback.
    original_request = probe.request
    import prototype_gecko_hosting as native
    try:
        forbidden = ["PerformActions", "ReleaseActions", "ElementSendKeys", "ElementClick", "ElementClear", "SendAlertText"]
        cases = [("WebDriver:" + name, {}) for name in forbidden]
        cases += [("WebDriver:NewWindow", {"type": "tab", "focus": False})]
        cases += [("WebDriver:SwitchToWindow", params) for params in ({"focus": True}, {})]
        for name, params in cases:
            try:
                native.native_observer_request(None, name, params)
            except AssertionError:
                continue
            raise AssertionError(f"Native observer unexpectedly allowed {name}")
    finally:
        probe.request = original_request
    print("Native observer input/focus exclusion contract PASS", flush=True)
    if not args.backend_only:
        subprocess.run([sys.executable, str(probe.ROOT / 'scripts/prototype_gecko_hosting.py'), '--profiles', '2'], check=True)
