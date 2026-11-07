/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ZenSessionStore } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenSessionManager.sys.mjs"
);

add_task(async function test_collected_spaces_do_not_alias_window_metadata() {
  const state = structuredClone(SessionStore.getCurrentState(true));
  await ZenSessionStore.saveState(state);
  const sidebar = ZenSessionStore.getSidebarData();
  const spaces = structuredClone(sidebar.spaces);
  try {
    state.windows[0].spaces[0].geckoProfileReference.persistentDescriptor =
      "invalid-collected-owner";
    state.windows[0].spaces[0].theme.opacity = 0.123;
    Assert.deepEqual(
      sidebar.spaces,
      spaces,
      "Collected sidebar isolates nested owner and theme from window metadata"
    );
  } finally {
    state.windows[0].spaces = spaces;
    await ZenSessionStore.saveState(state);
  }
});

add_task(async function test_admitted_closed_window_alias_before_undo() {
  let owned;
  let reopened;
  let directory;
  let closed;
  let savedGroups;
  const key = "closed-window-admission";
  const originalGlobal = SessionStore.getCustomGlobalValue(key);
  const originalTabs = new Set(gBrowser.tabs);
  async function cleanup() {
    try {
      if (owned && !owned.closed && closed) {
        const snapshot = structuredClone(closed);
        SessionStore.setWindowState(
          owned,
          { windows: [], _closedWindows: closed },
          false
        );
        closed.splice(0, closed.length, ...snapshot);
        SessionStore.savedGroups.splice(
          0,
          SessionStore.savedGroups.length,
          ...savedGroups
        );
        Assert.deepEqual(
          SessionStore.getCurrentState(true)._closedWindows,
          snapshot,
          "Original complete closed metadata restored before closing fixtures"
        );
      }
      if (originalGlobal) {
        SessionStore.setCustomGlobalValue(key, originalGlobal);
      } else {
        SessionStore.deleteCustomGlobalValue(key);
      }
    } finally {
      try {
        if (reopened && !reopened.closed) {
          await BrowserTestUtils.closeWindow(reopened);
        }
      } finally {
        try {
          if (owned && !owned.closed) {
            await BrowserTestUtils.closeWindow(owned);
          }
        } finally {
          try {
            if (directory?.exists()) {
              directory.remove(true);
            }
          } finally {
            for (const tab of gBrowser.tabs) {
              if (!originalTabs.has(tab)) {
                BrowserTestUtils.removeTab(tab);
              }
            }
          }
        }
      }
    }
  }
  registerCleanupFunction(cleanup);
  try {
    directory = Services.dirsvc.get("TmpD", Ci.nsIFile).clone();
    directory.append("zen-closed-window-owner");
    directory.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
    owned = await BrowserTestUtils.openNewBrowserWindow();
    await owned.gZenWorkspaces.promiseInitialized;
    closed = structuredClone(SessionStore.getCurrentState(true)._closedWindows);
    savedGroups = structuredClone(SessionStore.savedGroups);
    SessionStore.setCustomGlobalValue(key, "original-local-global");
    const sentinel = await BrowserTestUtils.openNewForegroundTab(
      owned.gBrowser,
      "about:robots"
    );
    await TabStateFlusher.flush(sentinel.linkedBrowser);
    owned.gBrowser.pinTab(sentinel);
    const local = SessionStore.getWindowState(owned).windows[0];
    local.tabs = local.tabs.filter(tab =>
      tab.entries.some(entry => entry.url == "about:robots")
    );
    Assert.equal(
      local.tabs.length,
      1,
      "Fixture serializes the real sentinel tab"
    );
    local.selected = 1;
    local._closedTabs = [];
    local.closedGroups = [];
    local.groups = [];
    local.closedAt = Date.now();
    const positive = structuredClone(local);
    const saved = {
      id: Services.uuid.generateUUID().toString(),
      name: "Owned admission saved group",
      color: "blue",
      collapsed: false,
      saved: true,
      closedAt: Date.now(),
      tabs: [{ state: structuredClone(local.tabs[0]), pos: 0 }],
      splitViews: [],
    };
    SessionStore.savedGroups.push(saved);
    local.groups = [saved];
    Assert.ok(ZenSessionStore.canRestoreWindow(local), "Fixture begins local");
    SessionStore.setWindowState(
      owned,
      { windows: [], _closedWindows: [local] },
      false
    );
    Assert.equal(
      SessionStore.getCurrentState(true)._closedWindows[0],
      local,
      "Actual object-taking API retains the admitted caller alias"
    );
    local.spaces[0].geckoProfileReference = {
      version: 1,
      persistentDescriptor: directory.persistentDescriptor,
    };
    Assert.ok(
      !ZenSessionStore.canRestoreWindow(
        SessionStore.getCurrentState(true)._closedWindows[0]
      ),
      "Installed record is foreign after alias mutation"
    );
    const before = structuredClone(
      SessionStore.getCurrentState(true)._closedWindows
    );
    const actions = structuredClone(SessionStore.lastClosedActions);
    const groups = structuredClone(SessionStore.savedGroups);
    const tabs = Array.from(owned.gBrowser.tabs);
    const selected = owned.gBrowser.selectedTab;
    const primaryTabs = Array.from(gBrowser.tabs);
    const primarySelected = gBrowser.selectedTab;
    let opened = 0;
    const observer = () => opened++;
    Services.obs.addObserver(observer, "domwindowopened");
    try {
      reopened = SessionStore.undoCloseWindow(0);
      Assert.equal(
        reopened,
        undefined,
        "Foreign undo refuses before opening a window"
      );
      Assert.deepEqual(
        SessionStore.getCurrentState(true)._closedWindows,
        before,
        "Foreign undo preserves complete closed records before consumption"
      );
      Assert.deepEqual(
        SessionStore.lastClosedActions,
        actions,
        "Closed actions unchanged"
      );
      Assert.deepEqual(
        SessionStore.savedGroups,
        groups,
        "Saved groups unchanged"
      );
      Assert.deepEqual(
        Array.from(owned.gBrowser.tabs),
        tabs,
        "Owned tabs unchanged"
      );
      Assert.equal(
        owned.gBrowser.selectedTab,
        selected,
        "Owned selection unchanged"
      );
      Assert.deepEqual(
        Array.from(gBrowser.tabs),
        primaryTabs,
        "Primary tabs unchanged"
      );
      Assert.equal(
        gBrowser.selectedTab,
        primarySelected,
        "Primary selection unchanged"
      );
      Assert.equal(
        SessionStore.getCustomGlobalValue(key),
        "original-local-global",
        "Global unchanged"
      );
      Assert.equal(opened, 0, "No new window opened by rejected undo");
    } finally {
      Services.obs.removeObserver(observer, "domwindowopened");
    }
    // Continue the positive control even on the pre-fix assertion failure.
    if (reopened) {
      await BrowserTestUtils.waitForEvent(reopened, "load");
      await BrowserTestUtils.closeWindow(reopened);
      reopened = null;
    }
    SessionStore.setWindowState(
      owned,
      { windows: [], _closedWindows: [positive] },
      false
    );
    const clone = SessionStore.getClosedWindowData();
    clone[0].spaces[0].geckoProfileReference = {
      version: 1,
      persistentDescriptor: directory.persistentDescriptor,
    };
    Assert.ok(
      ZenSessionStore.canRestoreWindow(
        SessionStore.getCurrentState(true)._closedWindows[0]
      ),
      "Mutating getClosedWindowData clone does not poison the internal record"
    );
    const restored = TestUtils.topicObserved(
      "sessionstore-single-window-restored"
    );
    reopened = SessionStore.undoCloseWindow(0);
    await restored;
    await reopened.gZenWorkspaces.promiseInitialized;

    await TestUtils.waitForCondition(
      () =>
        Array.from(reopened.gBrowser.tabs).some(
          tab => tab.linkedBrowser.currentURI.spec == "about:robots"
        ),
      "Local undo restores sentinel"
    );
    Assert.ok(
      Array.from(reopened.gBrowser.tabs).some(
        tab => tab.linkedBrowser.currentURI.spec == "about:robots"
      ),
      "Local undo loads sentinel"
    );
    await BrowserTestUtils.closeWindow(reopened);
    reopened = null;

    const automatic = structuredClone(positive);
    automatic.groups = [saved];
    SessionStore.setWindowState(
      owned,
      { windows: [], _closedWindows: [automatic] },
      false
    );
    automatic.spaces[0].geckoProfileReference = {
      version: 1,
      persistentDescriptor: directory.persistentDescriptor,
    };
    const automaticBefore = structuredClone(
      SessionStore.getCurrentState(true)._closedWindows
    );
    const automaticActions = structuredClone(SessionStore.lastClosedActions);
    const automaticGroups = structuredClone(SessionStore.savedGroups);
    const automaticTabs = Array.from(owned.gBrowser.tabs);
    const automaticSelected = owned.gBrowser.selectedTab;
    const automaticPrimaryTabs = Array.from(gBrowser.tabs);
    const automaticPrimarySelected = gBrowser.selectedTab;
    const restoredEvents = [];
    const onOpened = subject =>
      subject.addEventListener(
        "SSWindowRestored",
        () => restoredEvents.push(subject),
        { once: true }
      );
    Services.obs.addObserver(onOpened, "domwindowopened");
    registerCleanupFunction(() => {
      try {
        Services.obs.removeObserver(onOpened, "domwindowopened");
      } catch {}
    });
    // Controlled sibling branch: the harness primary must remain open.
    Services.obs.notifyObservers(null, "browser-lastwindow-close-granted");
    const automaticRestored = TestUtils.topicObserved(
      "sessionstore-single-window-restored"
    );
    reopened = await BrowserTestUtils.openNewBrowserWindow();
    await automaticRestored;
    Services.obs.removeObserver(onOpened, "domwindowopened");
    Assert.ok(
      restoredEvents.includes(reopened),
      "Rejected automatic restore emits SSWindowRestored for the new window"
    );
    let initialized = false;
    reopened.gZenWorkspaces.promiseInitialized.then(() => (initialized = true));
    await new Promise(resolve => executeSoon(resolve));
    Assert.ok(
      initialized,
      "Rejected automatic restore completes Space initialization"
    );
    Assert.ok(
      reopened.gBrowserInit.delayedStartupFinished,
      "Rejected automatic restore completes normal new-window startup"
    );
    Assert.deepEqual(
      SessionStore.getCurrentState(true)._closedWindows,
      automaticBefore,
      "Automatic rejection preserves the complete record without removal or replacement"
    );
    Assert.equal(
      SessionStore.getCurrentState(true)._closedWindows[0],
      automatic,
      "Rejected automatic candidate keeps its identity"
    );
    Assert.deepEqual(
      SessionStore.lastClosedActions,
      automaticActions,
      "Automatic closed actions unchanged"
    );
    Assert.deepEqual(
      SessionStore.savedGroups,
      automaticGroups,
      "Automatic saved groups unchanged"
    );
    Assert.ok(
      automaticTabs.every(tab => Array.from(owned.gBrowser.tabs).includes(tab)),
      "Automatic rejection preserves all existing owned tab identities"
    );
    Assert.ok(
      Array.from(owned.gBrowser.tabs)
        .filter(tab => !automaticTabs.includes(tab))
        .every(tab => tab.linkedBrowser.currentURI.spec == "about:blank"),
      "Normal new-window initialization adds only blank tabs to the synced owner"
    );
    Assert.equal(
      owned.gBrowser.selectedTab,
      automaticSelected,
      "Automatic rejection leaves existing selection unchanged"
    );
    Assert.ok(
      automaticPrimaryTabs.every(tab =>
        Array.from(gBrowser.tabs).includes(tab)
      ),
      "Automatic rejection preserves all existing primary tab identities"
    );
    Assert.ok(
      Array.from(gBrowser.tabs)
        .filter(tab => !automaticPrimaryTabs.includes(tab))
        .every(tab => tab.linkedBrowser.currentURI.spec == "about:blank"),
      "Normal new-window initialization adds only blank tabs to the synced primary"
    );
    Assert.equal(
      gBrowser.selectedTab,
      automaticPrimarySelected,
      "Automatic primary selection unchanged"
    );
    Assert.equal(
      SessionStore.getCustomGlobalValue(key),
      "original-local-global",
      "Automatic global unchanged"
    );
    await BrowserTestUtils.closeWindow(reopened);
    reopened = null;

    SessionStore.setWindowState(
      owned,
      { windows: [], _closedWindows: [structuredClone(positive)] },
      false
    );
    Services.obs.notifyObservers(null, "browser-lastwindow-close-granted");
    const localAutomaticRestored = TestUtils.topicObserved(
      "sessionstore-single-window-restored"
    );
    reopened = await BrowserTestUtils.openNewBrowserWindow();
    await localAutomaticRestored;
    await reopened.gZenWorkspaces.promiseInitialized;
    await TestUtils.waitForCondition(
      () =>
        Array.from(reopened.gBrowser.tabs).some(
          tab => tab.linkedBrowser.currentURI.spec == "about:robots"
        ),
      "Controlled local automatic reopen restores sentinel"
    );
    Assert.ok(
      Array.from(reopened.gBrowser.tabs).some(
        tab => tab.linkedBrowser.currentURI.spec == "about:robots"
      ),
      "Local automatic reopen loads sentinel"
    );
  } finally {
    await cleanup();
  }
});
