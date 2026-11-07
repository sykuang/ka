/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ZenSessionStore } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenSessionManager.sys.mjs"
);
const { BrowserWindowTracker } = ChromeUtils.importESModule(
  "resource:///modules/BrowserWindowTracker.sys.mjs"
);

async function assertFreshPrivateWindow(privateWindow) {
  const manager = privateWindow.gZenWorkspaces;
  await manager.promiseInitialized;
  Assert.equal(
    manager.getWorkspaces().length,
    1,
    "Fresh ephemeral catalog exists"
  );
  const space = manager.getWorkspaces()[0];
  Assert.ok(
    ZenSessionStore.isLocalProfileReference(space.geckoProfileReference),
    "Fresh Space belongs to the actual current ProfD"
  );
  Assert.equal(manager.activeWorkspace, space.uuid, "Fresh Space is active");
  Assert.ok(
    !ZenSessionStore.getClonedSpaces().some(
      shared => shared.uuid === space.uuid
    ),
    "Private catalog is independent of the shared sidebar"
  );
  for (const tab of privateWindow.gBrowser.tabs) {
    Assert.ok(tab.linkedBrowser, "Every private tab has a real browser");
  }
  const tab = await BrowserTestUtils.openNewForegroundTab(
    privateWindow.gBrowser,
    "about:robots#private-initialization-ephemeral"
  );
  await TabStateFlusher.flush(tab.linkedBrowser);
  const state = JSON.parse(SessionStore.getBrowserState());
  Assert.ok(
    state.windows.some(
      win =>
        win.isPrivate &&
        win.tabs.some(savedTab =>
          savedTab.entries.some(
            entry =>
              entry.url === "about:robots#private-initialization-ephemeral"
          )
        )
    ),
    "Real private content remains usable in the live browser state"
  );
}

async function assertIncomingPrivateRefused(privateWindow) {
  const manager = privateWindow.gZenWorkspaces;
  const directory = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
  directory.append("private-initialization-foreign");
  directory.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  try {
    const before = {
      tabs: Array.from(privateWindow.gBrowser.tabs),
      active: manager.activeWorkspace,
      spaces: structuredClone(manager.getWorkspaces()),
      sidebar: structuredClone(ZenSessionStore.getSidebarData()),
      global: SessionStore.getCustomGlobalValue("private-initialization"),
    };
    for (const version of [1, 2]) {
      const spaces = structuredClone(before.spaces);
      spaces[0].geckoProfileReference = {
        version,
        persistentDescriptor: directory.persistentDescriptor,
      };
      const winData = {
        isPrivate: true,
        spaces,
        tabs: [{ entries: [{ url: "about:robots" }] }],
      };
      const payload = {
        windows: [winData],
        global: { "private-initialization": "must-not-install" },
      };
      const original = structuredClone(payload);
      Assert.equal(
        manager.restoreWorkspacesFromSessionStore(winData),
        false,
        "Incoming foreign or unsupported private catalog is rejected"
      );
      SessionStore.setWindowState(privateWindow, payload, true);
      SessionStore.setBrowserState(JSON.stringify(payload));
      await new Promise(resolve => executeSoon(resolve));
      Assert.deepEqual(payload, original, "Rejected input is not rebound");
      Assert.deepEqual(
        Array.from(privateWindow.gBrowser.tabs),
        before.tabs,
        "Rejected import preserves private tabs"
      );
      Assert.equal(manager.activeWorkspace, before.active);
      Assert.deepEqual(manager.getWorkspaces(), before.spaces);
      Assert.deepEqual(ZenSessionStore.getSidebarData(), before.sidebar);
      Assert.equal(
        SessionStore.getCustomGlobalValue("private-initialization"),
        before.global,
        "Rejected import does not install global data"
      );
    }
  } finally {
    directory.remove(true);
  }
}

add_task(async function test_normal_fresh_private_initialization() {
  const privateWindow = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  try {
    await assertFreshPrivateWindow(privateWindow);
    await assertIncomingPrivateRefused(privateWindow);
  } finally {
    await BrowserTestUtils.closeWindow(privateWindow);
  }
});

add_task(async function test_fresh_private_after_unknown_startup_refusal() {
  const unsynced = BrowserWindowTracker.openWindow({
    openerWindow: window,
    zenSyncedWindow: false,
  });
  let privateWindow;
  let blocked = false;
  try {
    await TestUtils.waitForCondition(
      () =>
        unsynced.gZenWorkspaces &&
        unsynced.gBrowserInit?.delayedStartupFinished,
      "Owned unsynced window finishes delayed startup"
    );
    await unsynced.gZenWorkspaces.promiseInitialized;
    const legacyWindow = structuredClone(
      SessionStore.getWindowState(unsynced).windows[0]
    );
    Assert.ok(
      !ZenSessionStore.getClonedSpaces().some(
        space => space.uuid === legacyWindow.spaces[0].uuid
      ),
      "Real unsynced producer has an independent catalog"
    );
    for (const space of legacyWindow.spaces) {
      space.geckoProfileReference.version = 2;
    }
    const initialState = JSON.parse(SessionStore.getBrowserState());
    await ZenSessionStore.saveState(initialState, false);
    const path = PathUtils.join(PathUtils.profileDir, "zen-sessions.jsonlz4");
    const originalBytes = await IOUtils.read(path);
    // Use a genuine unsupported owner, not a legitimate local legacy catalog.
    ZenSessionStore.onFileRead({ windows: [legacyWindow] });
    blocked = true;
    Assert.ok(
      ZenSessionStore.isProfileBindingBlocked,
      "Unsupported owner restore is blocked"
    );
    Assert.ok(!ZenSessionStore.canSaveSession, "Shared writer remains blocked");
    privateWindow = await BrowserTestUtils.openNewBrowserWindow({
      private: true,
    });
    await assertFreshPrivateWindow(privateWindow);
    await assertIncomingPrivateRefused(privateWindow);
    Assert.ok(
      !ZenSessionStore.canRestoreWindow({}),
      "Incoming empty restore still refused"
    );
    Assert.equal(
      ZenSessionStore.saveState(
        JSON.parse(SessionStore.getBrowserState()),
        false
      ),
      false,
      "Private initialization never enables shared writes"
    );
    Assert.deepEqual(
      await IOUtils.read(path),
      originalBytes,
      "Shared disk bytes survive"
    );
    Assert.ok(ZenSessionStore.isProfileBindingBlocked);
  } finally {
    try {
      if (blocked) {
        await ZenSessionStore.readFile();
        ZenSessionStore.onFileRead({
          windows: [{ spaces: ZenSessionStore.getClonedSpaces(), tabs: [] }],
        });
      }
    } finally {
      try {
        if (privateWindow && !privateWindow.closed) {
          await BrowserTestUtils.closeWindow(privateWindow);
        }
      } finally {
        if (!unsynced.closed) {
          await BrowserTestUtils.closeWindow(unsynced);
        }
      }
    }
  }
});
