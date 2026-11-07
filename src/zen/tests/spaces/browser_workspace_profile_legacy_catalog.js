/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { nsZenSessionManager, ZenSessionStore } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenSessionManager.sys.mjs"
);
const { BrowserWindowTracker } = ChromeUtils.importESModule(
  "resource:///modules/BrowserWindowTracker.sys.mjs"
);

add_task(async function test_local_disk_legacy_and_missing_catalog() {
  const unsynced = BrowserWindowTracker.openWindow({
    openerWindow: window,
    zenSyncedWindow: false,
  });
  let originalBytes;
  const path = PathUtils.join(PathUtils.profileDir, "zen-sessions.jsonlz4");
  const foreign = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
  foreign.append("legacy-catalog-owned-foreign");
  foreign.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  try {
    await TestUtils.waitForCondition(
      () =>
        unsynced.gZenWorkspaces && unsynced.gBrowserInit?.delayedStartupFinished
    );
    await unsynced.gZenWorkspaces.promiseInitialized;
    const tab = await BrowserTestUtils.openNewForegroundTab(
      unsynced.gBrowser,
      "about:license"
    );
    BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, "about:mozilla");
    await BrowserTestUtils.browserLoaded(
      tab.linkedBrowser,
      false,
      "about:mozilla"
    );
    await TabStateFlusher.flush(tab.linkedBrowser);
    const localWindow = structuredClone(
      SessionStore.getWindowState(unsynced).windows[0]
    );
    const history = JSON.parse(SessionStore.getTabState(tab));
    Assert.deepEqual(
      history.entries.map(entry => entry.url),
      ["about:license", "about:mozilla"],
      "Fixture uses real native two-entry history"
    );
    await ZenSessionStore.saveState(
      JSON.parse(SessionStore.getBrowserState()),
      false
    );
    originalBytes = await IOUtils.read(path);
    const current = await IOUtils.readJSON(path, { decompress: true });
    Assert.ok(
      !current.spaces.some(space => space.uuid === localWindow.spaces[0].uuid),
      "Natural unsynced UUID is not in shared sidebar"
    );
    const legacy = structuredClone(current);
    delete legacy.geckoProfileBindingVersion;
    for (const space of legacy.spaces) {
      delete space.geckoProfileReference;
    }
    for (const space of localWindow.spaces) {
      delete space.geckoProfileReference;
    }
    await IOUtils.writeJSON(path, legacy, { compress: true });
    const reader = new nsZenSessionManager();
    await reader.readFile();
    const state = {
      version: ["sessionrestore", 1],
      windows: [structuredClone(localWindow)],
    };
    Assert.ok(
      !reader.canRestoreState(state),
      "Public admission does not self-bind unknown UUIDs"
    );
    const migrated = reader.onFileRead(state);
    Assert.ok(
      reader.canRestoreState(migrated),
      "Trusted old local disk catalog migrates before admission"
    );
    Assert.equal(
      migrated.windows[0].spaces[0].uuid,
      localWindow.spaces[0].uuid,
      "Window-local UUID retained"
    );
    Assert.deepEqual(
      migrated.windows[0].tabs,
      localWindow.tabs,
      "Complete tabs/history retained"
    );
    Assert.ok(
      migrated.windows[0].spaces.every(space =>
        reader.isLocalProfileReference(space.geckoProfileReference)
      ),
      "Actual ProfD owns migrated Spaces"
    );

    const missing = structuredClone(localWindow);
    delete missing.spaces;
    const knownUuid = reader.getClonedSpaces()[0].uuid;
    missing.activeZenSpace = knownUuid;
    for (const savedTab of missing.tabs) {
      savedTab.zenWorkspace = knownUuid;
    }
    const resolved = reader.onFileRead({
      windows: [missing, structuredClone(missing)],
    });
    Assert.ok(
      reader.canRestoreState(resolved),
      "Missing catalog has known-local admission"
    );
    Assert.deepEqual(
      resolved.windows[0].spaces,
      reader.getClonedSpaces(),
      "Consumer receives validator's catalog IDs"
    );
    Assert.notStrictEqual(
      resolved.windows[0].spaces,
      resolved.windows[1].spaces,
      "Window catalogs are detached"
    );
    const sidebarBefore = structuredClone(reader.getSidebarData());
    resolved.windows[0].spaces[0].geckoProfileReference.version = 999;
    resolved.windows[0].spaces[0].theme.opacity = 0;
    Assert.deepEqual(
      reader.getSidebarData(),
      sidebarBefore,
      "Nested owner/theme cannot poison shared fallback"
    );
    Assert.deepEqual(
      resolved.windows[1].spaces,
      sidebarBefore.spaces,
      "Sibling catalog cannot be poisoned"
    );

    for (const version of [1, 2]) {
      const rejected = structuredClone(localWindow);
      rejected.spaces[0].geckoProfileReference = {
        version,
        persistentDescriptor:
          version === 1
            ? foreign.persistentDescriptor
            : reader.getCurrentProfileReference().persistentDescriptor,
      };
      const input = { windows: [rejected] };
      const before = structuredClone(input);
      const blocked = new nsZenSessionManager();
      await blocked.readFile();
      blocked.onFileRead(input);
      Assert.ok(
        blocked.isProfileBindingBlocked,
        "Explicit foreign/unknown owner remains rejected"
      );
      Assert.deepEqual(input, before, "Explicit descriptor is not rebound");
      Assert.ok(
        !blocked.canSaveSession,
        "Rejected catalog never enables writer"
      );
    }
  } finally {
    try {
      if (originalBytes) {
        await IOUtils.write(path, originalBytes);
      }
    } finally {
      try {
        await BrowserTestUtils.closeWindow(unsynced);
      } finally {
        foreign.remove(true);
      }
    }
  }
});
