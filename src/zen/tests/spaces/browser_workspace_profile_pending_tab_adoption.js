/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_normal_unsynced_pending_move_preserves_history() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.sessionstore.restore_on_demand", true],
      ["zen.window-sync.prefer-unsynced-windows", false],
    ],
  });
  const dest = gZenWindowSync.firstSyncedWindow;
  const originalTabs = new Set(dest.gBrowser.tabs);
  const originalSelected = dest.gBrowser.selectedTab;
  const originalActive = dest.gZenWorkspaces.activeWorkspace;
  const closedWindows = structuredClone(SessionStore.getClosedWindowData());
  const actions = structuredClone(SessionStore.lastClosedActions);
  const originalWindow = structuredClone(
    SessionStore.getWindowState(dest).windows[0]
  );
  const liveWindow = SessionStore.getCurrentState(true).windows.find(data =>
    data.tabs.some(tab => tab.zenSyncId === dest.gBrowser.selectedTab.id)
  );
  let source;
  try {
    source = await BrowserTestUtils.openNewBrowserWindow({
      zenSyncedWindow: false,
    });
    await source.gZenWorkspaces.promiseInitialized;
    const sourceSpace = source.gZenWorkspaces.getWorkspaceFromId(
      source.gZenWorkspaces.activeWorkspace
    );
    const destSpace = dest.gZenWorkspaces.getWorkspaceFromId(originalActive);
    const profile = Services.dirsvc.get("ProfD", Ci.nsIFile);
    for (const space of [sourceSpace, destSpace]) {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.persistentDescriptor =
        space.geckoProfileReference.persistentDescriptor;
      Assert.ok(
        file.equals(profile),
        "Actual window catalog owner is this ProfD"
      );
    }
    Assert.ok(
      !source.gZenWorkspaces.currentWindowIsSyncing,
      "Normal unsynced source"
    );
    Assert.ok(
      dest.gZenWorkspaces.currentWindowIsSyncing,
      "Normal synced destination"
    );
    Assert.ok(
      !dest.gZenWorkspaces.getWorkspaceFromId(sourceSpace.uuid),
      "Temporary source Space is genuinely absent in destination"
    );
    const keeper = await BrowserTestUtils.openNewForegroundTab(
      source.gBrowser,
      "about:blank#keeper"
    );
    for (const initialTab of [...source.gBrowser.tabs]) {
      if (initialTab !== keeper) {
        BrowserTestUtils.removeTab(initialTab);
      }
    }
    const tab = await BrowserTestUtils.openNewForegroundTab(
      source.gBrowser,
      "about:robots"
    );
    await BrowserTestUtils.loadURIString({
      browser: tab.linkedBrowser,
      uriString: "about:mozilla",
    });
    info(
      "B2_ABOUT_UNLOAD_CONTROL " +
        JSON.stringify({
          remote: tab.linkedBrowser.isRemoteBrowser,
          url: tab.linkedBrowser.currentURI.spec,
        })
    );
    await BrowserTestUtils.loadURIString({
      browser: tab.linkedBrowser,
      uriString: "https://example.com/",
    });
    await TabStateFlusher.flush(tab.linkedBrowser);
    source.gBrowser.selectedTab = keeper;
    source.gBrowser.moveTabTo(keeper, { tabIndex: Infinity });
    await source.gBrowser.prepareDiscardBrowser(tab);
    Assert.ok(
      source.gBrowser.discardBrowser(tab, true),
      "Normal unload succeeds"
    );
    Assert.ok(tab.hasAttribute("pending"), "Real background tab is pending");
    SessionStore.setCustomTabValue(tab, "b2-owner", "normal-move");
    const before = JSON.parse(SessionStore.getTabState(tab));
    Assert.deepEqual(
      before.entries.map(entry => entry.url),
      ["about:robots", "about:mozilla", "https://example.com/"],
      "Producer has both real history entries"
    );
    const id = tab.id;
    info(
      "B2_BEFORE " +
        JSON.stringify({
          sourceWindow: source.browsingContext.id,
          destWindow: dest.browsingContext.id,
          parentPID: Services.appinfo.processID,
          sourceId: id,
          sourceSpace: sourceSpace.uuid,
          tabSpace: tab.getAttribute("zen-workspace-id"),
          stateSpace: before.zenWorkspace,
          order: source.gZenWorkspaces.allStoredTabs.map(t => ({
            id: t.id,
            pending: t.hasAttribute("pending"),
            selected: t.selected,
          })),
          swapSource: dest.gBrowser.swapBrowsersAndCloseOther
            .toString()
            .slice(0, 100),
          destSpace: destSpace.uuid,
          profile: profile.persistentDescriptor,
          pending: tab.hasAttribute("pending"),
          sourceSync: source.gZenWorkspaces.currentWindowIsSyncing,
          destSync: dest.gZenWorkspaces.currentWindowIsSyncing,
          sourceSelected: keeper.id,
          destSelected: originalSelected.id,
          entries: before.entries,
        })
    );
    Assert.equal(
      before.zenWorkspace,
      sourceSpace.uuid,
      "Producer carries actual temporary source binding"
    );
    const onOpen = event =>
      info(
        "B2_ADOPT_OPEN " +
          JSON.stringify({
            sourceId: event.detail?.adoptedTab?.id,
            pending: event.detail?.adoptedTab?.hasAttribute("pending"),
            sourceSpace:
              event.detail?.adoptedTab?.getAttribute("zen-workspace-id"),
          })
      );
    dest.gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
    let result;
    try {
      result = await gZenWindowSync.moveTabsToSyncedWorkspace(
        source,
        destSpace.uuid
      );
    } finally {
      dest.gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
    }
    await TestUtils.waitForTick();
    const moved = [...dest.gBrowser.tabs].find(
      item =>
        !originalTabs.has(item) &&
        (item.hasAttribute("discarded") ||
          JSON.parse(SessionStore.getTabState(item)).entries.some(
            entry => entry.url === "https://example.com/"
          ))
    );
    const preserved = tab.isConnected && !tab.closing && !source.closed;
    const after = moved ? JSON.parse(SessionStore.getTabState(moved)) : null;
    info(
      "B2_AFTER " +
        JSON.stringify({
          result: result ?? null,
          sourcePreserved: preserved,
          sourceClosing: tab.closing,
          sourceClosed: source.closed,
          destId: moved?.id,
          destWorkspace: moved?.getAttribute("zen-workspace-id"),
          entries: after?.entries,
        })
    );
    Assert.ok(
      preserved ||
        (after &&
          JSON.stringify(after.entries) === JSON.stringify(before.entries)),
      "Normal move must not delete source and leave blank destination"
    );
    Assert.strictEqual(result, true, "WindowSync returns completed success");
    const movedKeeper = [...dest.gBrowser.tabs].find(
      item =>
        !originalTabs.has(item) &&
        item.linkedBrowser.currentURI.spec === "about:blank#keeper"
    );
    Assert.ok(
      movedKeeper,
      "Selected non-pending neighbor uses actual docshell transfer and retains its page"
    );
    Assert.ok(moved, "Known local destination supports normal pending move");
    if (moved) {
      Assert.equal(
        SessionStore.getCustomTabValue(moved, "b2-owner"),
        "normal-move",
        "Successful pending transfer retains custom tab values"
      );
      const restoring = SessionStore.getInternalObjectState(
        moved.linkedBrowser
      );
      const admitted =
        !!restoring ||
        moved.linkedBrowser.currentURI.spec === "https://example.com/";
      Assert.ok(
        admitted,
        "Actual consumer registered a restore, not only an asynchronously copied cache"
      );
      Assert.deepEqual(
        after.entries,
        before.entries,
        "Successful move retains complete original entries"
      );
      Assert.equal(
        after.index,
        before.index,
        "Successful move retains history index"
      );
      Assert.equal(
        after.zenWorkspace,
        destSpace.uuid,
        "Snapshot lands in explicitly requested local Space"
      );
      if (admitted) {
        await TestUtils.waitForCondition(
          () =>
            moved.linkedBrowser.browsingContext?.currentWindowGlobal
              ?.documentURI.spec === "https://example.com/",
          "Restored destination document is ready"
        );
        Assert.equal(
          await SpecialPowers.spawn(
            moved.linkedBrowser,
            [],
            () => content.document.documentURI
          ),
          "https://example.com/",
          "Real restored document, not just URI/cache"
        );
        let loaded = BrowserTestUtils.browserLoaded(
          moved.linkedBrowser,
          false,
          "about:mozilla"
        );
        moved.linkedBrowser.goBack();
        await loaded;
        Assert.equal(
          moved.linkedBrowser.currentURI.spec,
          "about:mozilla",
          "Real native back navigation retains prior entry"
        );
        loaded = BrowserTestUtils.browserLoaded(
          moved.linkedBrowser,
          false,
          "https://example.com/"
        );
        moved.linkedBrowser.goForward();
        await loaded;
        Assert.equal(
          moved.linkedBrowser.currentURI.spec,
          "https://example.com/",
          "Real native forward navigation retains original current entry"
        );
      }
    }
  } finally {
    try {
      if (source && !source.closed) {
        await BrowserTestUtils.closeWindow(source);
      }
    } finally {
      try {
        for (const tab of [...dest.gBrowser.tabs]) {
          if (!originalTabs.has(tab)) {
            BrowserTestUtils.removeTab(tab);
          }
        }
        await dest.gZenWorkspaces.changeWorkspaceWithID(originalActive);
        dest.gBrowser.selectedTab = originalSelected;
      } finally {
        const state = SessionStore.getCurrentState(true);
        state._closedWindows.splice(
          0,
          state._closedWindows.length,
          ...closedWindows
        );
        SessionStore.lastClosedActions.splice(
          0,
          SessionStore.lastClosedActions.length,
          ...actions
        );
        liveWindow._closedTabs.splice(
          0,
          liveWindow._closedTabs.length,
          ...originalWindow._closedTabs
        );
        liveWindow.closedGroups.splice(
          0,
          liveWindow.closedGroups.length,
          ...originalWindow.closedGroups
        );
        liveWindow.lastClosedTabGroupId = originalWindow.lastClosedTabGroupId;
        liveWindow._lastClosedTabGroupCount =
          originalWindow._lastClosedTabGroupCount;
        await SpecialPowers.popPrefEnv();
      }
    }
  }
});

add_task(async function test_refusal_precedes_source_teardown_and_propagates() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.sessionstore.restore_on_demand", true],
      ["zen.window-sync.prefer-unsynced-windows", false],
    ],
  });
  const dest = gZenWindowSync.firstSyncedWindow;
  const originalTabs = [...dest.gBrowser.tabs];
  const selected = dest.gBrowser.selectedTab;
  const active = dest.gZenWorkspaces.activeWorkspace;
  const closedWindows = structuredClone(SessionStore.getClosedWindowData());
  const actions = structuredClone(SessionStore.lastClosedActions);
  const originalWindow = structuredClone(
    SessionStore.getWindowState(dest).windows[0]
  );
  const liveWindow = SessionStore.getCurrentState(true).windows.find(data =>
    data.tabs.some(tab => tab.zenSyncId === dest.gBrowser.selectedTab.id)
  );
  let source;
  let space;
  let owner;
  try {
    source = await BrowserTestUtils.openNewBrowserWindow({
      zenSyncedWindow: false,
    });
    await source.gZenWorkspaces.promiseInitialized;
    space = source.gZenWorkspaces.getWorkspaceFromId(
      source.gZenWorkspaces.activeWorkspace
    );
    owner = space.geckoProfileReference;
    const keeper = source.gBrowser.selectedTab;
    const tab = await BrowserTestUtils.openNewForegroundTab(
      source.gBrowser,
      "https://example.com/?first"
    );
    await BrowserTestUtils.loadURIString({
      browser: tab.linkedBrowser,
      uriString: "https://example.com/?second",
    });
    source.gBrowser.selectedTab = keeper;
    source.gBrowser.moveTabTo(keeper, { tabIndex: Infinity });
    await source.gBrowser.prepareDiscardBrowser(tab);
    Assert.ok(
      source.gBrowser.discardBrowser(tab, true),
      "Refusal control uses normal real pending history"
    );
    SessionStore.setCustomTabValue(tab, "b2-owner", "source-owned-value");
    const before = SessionStore.getTabState(tab);
    const lastAccessed = tab._lastAccessed;
    Assert.equal(
      SessionStore.getTabState(tab),
      before,
      "No-op complete source snapshot is stable"
    );
    let sourceCloses = 0;
    const onClose = () => sourceCloses++;
    tab.addEventListener("TabClose", onClose);
    let partial;
    let rejectAfterOpen = false;
    const onOpen = event => {
      if (event.detail?.adoptedTab === tab) {
        partial = event.target;
        if (rejectAfterOpen) {
          space.geckoProfileReference = { ...owner, version: 999 };
        }
      }
    };
    dest.gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
    try {
      Assert.strictEqual(
        dest.gBrowser.adoptTab(tab, { tabIndex: Infinity }),
        null,
        "Unresolved destination binding returns null from actual adopt caller"
      );
      Assert.strictEqual(
        partial,
        undefined,
        "Admission rejects before TabOpen can move source custom values"
      );
      Assert.ok(
        tab.isConnected && !tab.closing && !source.closed,
        "Refusal keeps original source identity and window"
      );
      Assert.equal(
        sourceCloses,
        0,
        "No source TabClose / beginRemoveTab side effect"
      );
      Assert.equal(
        tab._endRemoveArgs,
        undefined,
        "No source teardown lifecycle established"
      );
      Assert.equal(
        SessionStore.getTabState(tab),
        before,
        "Refusal preserves complete source state including history/time/binding"
      );
      Assert.equal(
        tab._lastAccessed,
        lastAccessed,
        "Underlying timestamp preserved"
      );
      Assert.deepEqual(
        [...dest.gBrowser.tabs],
        originalTabs,
        "No partial destination survives"
      );
      Assert.strictEqual(
        dest.gBrowser.selectedTab,
        selected,
        "Destination selection preserved"
      );
      if (!tab.isConnected || tab.closing || source.closed) {
        return;
      }
      rejectAfterOpen = true;
      try {
        Assert.strictEqual(
          dest.gBrowser.adoptTab(tab, { tabIndex: Infinity, spaceId: active }),
          null,
          "Controlled owner refusal after partial destination creation propagates null"
        );
        Assert.ok(
          partial && !partial.isConnected,
          "Late admission refusal removes the actual partial destination"
        );
        Assert.equal(
          sourceCloses,
          0,
          "Late admission refusal never begins source teardown"
        );
        Assert.ok(
          tab.isConnected && !tab.closing && !source.closed,
          "Late admission refusal preserves source identity/window"
        );
        Assert.equal(
          SessionStore.getTabState(tab),
          before,
          "Late refusal returns custom values moved by TabOpen and preserves complete source"
        );
        info(
          "B2_PARTIAL_REFUSAL " +
            JSON.stringify({
              sourceCloses,
              sourceClosing: tab.closing,
              partialRemoved: !partial.isConnected,
              customValue: SessionStore.getCustomTabValue(tab, "b2-owner"),
            })
        );
      } finally {
        rejectAfterOpen = false;
        space.geckoProfileReference = owner;
      }
      for (const [name, options] of [
        ["private", { private: true }],
        [
          "fission",
          { fission: !source.gFissionBrowser, zenSyncedWindow: false },
        ],
      ]) {
        const control = await BrowserTestUtils.openNewBrowserWindow(options);
        try {
          Assert.ok(
            name === "private"
              ? control.gZenWorkspaces.isPrivateWindow
              : control.gFissionBrowser !== source.gFissionBrowser,
            "Actual " + name + " mismatch control"
          );
          const tabs = [...control.gBrowser.tabs];
          Assert.strictEqual(
            control.gBrowser.adoptTab(tab),
            null,
            name + " mismatch propagates null"
          );
          Assert.deepEqual(
            [...control.gBrowser.tabs],
            tabs,
            name + " removes partial destination"
          );
          Assert.equal(
            SessionStore.getTabState(tab),
            before,
            name + " preserves complete source state"
          );
          Assert.equal(sourceCloses, 0, name + " has no source teardown");
        } finally {
          await BrowserTestUtils.closeWindow(control);
        }
      }
      const nonRemote = dest.gBrowser.addTrustedTab("about:mozilla");
      try {
        Assert.ok(
          !nonRemote.linkedBrowser.isRemoteBrowser &&
            tab.linkedBrowser.isRemoteBrowser,
          "Actual chrome/content remoteness mismatch"
        );
        const targetState = SessionStore.getTabState(nonRemote);
        Assert.strictEqual(
          dest.gBrowser.swapBrowsersAndCloseOther(nonRemote, tab),
          false,
          "Shared swap propagates remoteness refusal"
        );
        Assert.equal(
          SessionStore.getTabState(tab),
          before,
          "Remoteness refusal preserves complete source"
        );
        Assert.equal(
          SessionStore.getTabState(nonRemote),
          targetState,
          "Remoteness refusal preserves target"
        );
        Assert.equal(
          sourceCloses,
          0,
          "Remoteness refusal has no source teardown"
        );
      } finally {
        BrowserTestUtils.removeTab(nonRemote);
      }
      // Safety fixture: source owner becomes unsupported; its tab binding is never rewritten.
      space.geckoProfileReference = { ...owner, version: 999 };
      partial = null;
      const result = await gZenWindowSync.moveTabsToSyncedWorkspace(
        source,
        active
      );
      Assert.strictEqual(
        result,
        false,
        "WindowSync propagates shared adoption refusal"
      );
      Assert.strictEqual(
        partial,
        null,
        "WindowSync owner refusal creates no partial destination"
      );
      Assert.ok(
        tab.isConnected && !tab.closing && !source.closed,
        "WindowSync failure does not close source/window"
      );
      Assert.equal(
        sourceCloses,
        0,
        "WindowSync does not begin source teardown"
      );
      Assert.equal(
        SessionStore.getTabState(tab),
        before,
        "Explicit target cannot retarget unsupported actual source owner"
      );
      Assert.deepEqual(
        [...dest.gBrowser.tabs],
        originalTabs,
        "Failed WindowSync does not continue workspace placement"
      );
      Assert.strictEqual(
        source.gBrowser.selectedTab,
        keeper,
        "Failed WindowSync preserves source keeper selection"
      );
      Assert.equal(
        dest.gZenWorkspaces.activeWorkspace,
        active,
        "Failed WindowSync preserves active destination Space"
      );
      info(
        "B2_REFUSAL " +
          JSON.stringify({
            result,
            sourceCloses,
            sourceClosing: tab.closing,
            sourceClosed: source.closed,
            partialRemoved: !partial?.isConnected,
            sourceState: JSON.parse(SessionStore.getTabState(tab)),
            sourceOwnerVersion: space.geckoProfileReference.version,
          })
      );
    } finally {
      tab.removeEventListener("TabClose", onClose);
      dest.gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
      space.geckoProfileReference = owner;
    }
  } finally {
    try {
      if (space && owner) {
        space.geckoProfileReference = owner;
      }
      if (source && !source.closed) {
        await BrowserTestUtils.closeWindow(source);
      }
    } finally {
      try {
        for (const tab of [...dest.gBrowser.tabs]) {
          if (!originalTabs.includes(tab)) {
            BrowserTestUtils.removeTab(tab);
          }
        }
        dest.gBrowser.selectedTab = selected;
        await dest.gZenWorkspaces.changeWorkspaceWithID(active);
      } finally {
        const state = SessionStore.getCurrentState(true);
        state._closedWindows.splice(
          0,
          state._closedWindows.length,
          ...closedWindows
        );
        SessionStore.lastClosedActions.splice(
          0,
          SessionStore.lastClosedActions.length,
          ...actions
        );
        liveWindow._closedTabs.splice(
          0,
          liveWindow._closedTabs.length,
          ...originalWindow._closedTabs
        );
        liveWindow.closedGroups.splice(
          0,
          liveWindow.closedGroups.length,
          ...originalWindow.closedGroups
        );
        liveWindow.lastClosedTabGroupId = originalWindow.lastClosedTabGroupId;
        liveWindow._lastClosedTabGroupCount =
          originalWindow._lastClosedTabGroupCount;
        await SpecialPowers.popPrefEnv();
      }
    }
  }
});
