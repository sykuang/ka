/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_deleted_space_preserves_recoverable_history() {
  const originalTabs = new Set(gBrowser.tabs);
  const original = SessionStore.getWindowState(window).windows[0];
  const actions = structuredClone(SessionStore.lastClosedActions);
  let source;
  const spaces = structuredClone(gZenWorkspaces.getWorkspaces());
  const active = gZenWorkspaces.activeWorkspace;
  const space = await gZenWorkspaces.createAndSaveWorkspace(
    "Owned deletion history"
  );
  try {
    const tab = await BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "about:robots"
    );
    await BrowserTestUtils.loadURIString({
      browser: tab.linkedBrowser,
      uriString: "about:mozilla",
    });
    await TabStateFlusher.flush(tab.linkedBrowser);
    await gZenWorkspaces.changeWorkspace(active);
    await gZenWorkspaces.removeWorkspace(space.uuid);
    const data = SessionStore.getClosedTabData(window);
    const index = data.findIndex(
      item =>
        item.state.zenWorkspace == space.uuid &&
        item.state.entries.some(entry => entry.url == "about:mozilla")
    );
    Assert.ok(index >= 0, "Normal Space deletion retains real history");
    source = SessionStore.getCurrentState(true).windows.find(win =>
      win._closedTabs.some(item => item.closedId == data[index].closedId)
    );
    const result = SessionStore.undoCloseTab(window, index, window);
    Assert.equal(
      result,
      undefined,
      "Deleted Space is unresolved; execution preserves rather than consumes its history"
    );
    Assert.deepEqual(
      SessionStore.getClosedTabData(window),
      data,
      "Space deletion history is not discarded or rebound"
    );
    await gZenWorkspaces.saveWorkspace(space);
    const restored = SessionStore.undoCloseTab(window, index, window);
    await promiseTabRestored(restored);
    await TabStateFlusher.flush(restored.linkedBrowser);
    Assert.equal(
      restored.getAttribute("zen-workspace-id"),
      space.uuid,
      "Restoring the same local Space resolves the original ownership without rebinding"
    );
    Assert.deepEqual(
      JSON.parse(SessionStore.getTabState(restored)).entries.map(
        entry => entry.url
      ),
      ["about:robots", "about:mozilla"],
      "Complete real history remains recoverable after Space resolution"
    );
  } finally {
    try {
      gZenWorkspaces.propagateWorkspaces(spaces);
      await gZenWorkspaces.changeWorkspace(active);
      if (source) {
        source._closedTabs.splice(
          0,
          source._closedTabs.length,
          ...original._closedTabs
        );
        source.closedGroups.splice(
          0,
          source.closedGroups.length,
          ...original.closedGroups
        );
        source.lastClosedTabGroupId = original.lastClosedTabGroupId;
        source._lastClosedTabGroupCount = original._lastClosedTabGroupCount;
      }
      SessionStore.lastClosedActions.splice(
        0,
        SessionStore.lastClosedActions.length,
        ...actions
      );
    } finally {
      for (const tab of gBrowser.tabs) {
        if (!originalTabs.has(tab)) {
          BrowserTestUtils.removeTab(tab);
        }
      }
    }
  }
});

add_task(async function test_supported_standalone_shapes_restore_history() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:robots"
  );
  try {
    await BrowserTestUtils.loadURIString({
      browser: tab.linkedBrowser,
      uriString: "about:mozilla",
    });
    await TabStateFlusher.flush(tab.linkedBrowser);
    const local = JSON.parse(SessionStore.getTabState(tab));
    for (const shape of [
      local,
      { ...local, zenWorkspace: undefined },
      { ...local, zenEssential: true, pinned: true },
    ]) {
      await promiseTabState(tab, shape);
      await TabStateFlusher.flush(tab.linkedBrowser);
      Assert.deepEqual(
        JSON.parse(SessionStore.getTabState(tab)).entries.map(
          entry => entry.url
        ),
        ["about:robots", "about:mozilla"],
        "Local, unscoped and essential standalone restore preserves real two-entry history"
      );
    }
  } finally {
    gBrowser.unpinTab(tab);
    BrowserTestUtils.removeTab(tab);
  }
  const privateWindow = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  try {
    await privateWindow.gZenWorkspaces.promiseInitialized;
    const privateTab = privateWindow.gBrowser.selectedTab;
    SessionStore.setTabState(privateTab, {
      entries: [{ url: "about:robots" }],
    });
    Assert.equal(
      JSON.parse(SessionStore.getTabState(privateTab)).entries[0].url,
      "about:robots",
      "Unscoped private restore state remains legal"
    );
  } finally {
    await BrowserTestUtils.closeWindow(privateWindow);
  }
  const disabledTab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:mozilla"
  );
  await SpecialPowers.pushPrefEnv({ set: [["zen.workspaces.enabled", false]] });
  try {
    try {
      SessionStore.setTabState(disabledTab, {
        entries: [{ url: "about:robots" }],
      });
      Assert.equal(
        JSON.parse(SessionStore.getTabState(disabledTab)).entries[0].url,
        "about:robots",
        "Disabled-workspace unscoped restore state remains legal"
      );
    } finally {
      BrowserTestUtils.removeTab(disabledTab);
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(
  async function test_closed_window_tab_sibling_preserves_unknown_history() {
    const originalTabs = new Set(gBrowser.tabs);
    const closed = structuredClone(
      SessionStore.getCurrentState(true)._closedWindows
    );
    const savedGroups = structuredClone(SessionStore.savedGroups);
    const actions = structuredClone(SessionStore.lastClosedActions);
    let owned;
    let candidate;
    let owner;
    try {
      owned = await BrowserTestUtils.openNewBrowserWindow();
      await owned.gZenWorkspaces.promiseInitialized;
      const tab = await BrowserTestUtils.openNewForegroundTab(
        owned.gBrowser,
        "about:robots"
      );
      await TabStateFlusher.flush(tab.linkedBrowser);
      await promiseRemoveTabAndSessionState(tab);
      const ownedClosedTabId = SessionStore.getClosedTabData(owned).find(item =>
        item.state.entries.some(entry => entry.url == "about:robots")
      ).closedId;
      const keeper = await BrowserTestUtils.openNewForegroundTab(
        owned.gBrowser,
        "about:mozilla"
      );
      owned.gBrowser.pinTab(keeper);
      await TabStateFlusher.flush(keeper.linkedBrowser);
      await BrowserTestUtils.closeWindow(owned);
      const source = SessionStore.getCurrentState(true)._closedWindows.find(
        win => win._closedTabs.some(item => item.closedId === ownedClosedTabId)
      );
      Assert.ok(
        source,
        "Normal owned window close retains its closed-tab body"
      );
      candidate = source._closedTabs.find(
        item => item.closedId === ownedClosedTabId
      );
      owner = candidate.state.zenWorkspace;
      const unknown = Services.uuid.generateUUID().toString();
      Assert.ok(
        !gZenWorkspaces.getWorkspaceFromId(unknown),
        "Closed-window candidate Space is unknown locally"
      );
      candidate.state.zenWorkspace = unknown;
      const selector = { sourceClosedId: source.closedId };
      SessionStore.getClosedTabData(selector);
      const before = structuredClone(
        SessionStore.getCurrentState(true)._closedWindows
      );
      const beforeActions = structuredClone(SessionStore.lastClosedActions);
      const tabs = Array.from(gBrowser.tabs);
      const selected = gBrowser.selectedTab;
      Assert.equal(
        SessionStore.undoClosedTabFromClosedWindow(
          selector,
          candidate.closedId,
          window
        ),
        undefined,
        "Closed-window undo sibling rejects before consumption"
      );
      Assert.deepEqual(
        SessionStore.getCurrentState(true)._closedWindows,
        before,
        "Complete closed-window history is preserved"
      );
      Assert.deepEqual(
        SessionStore.lastClosedActions,
        beforeActions,
        "Closed-window actions are preserved"
      );
      Assert.deepEqual(
        Array.from(gBrowser.tabs),
        tabs,
        "Sibling creates no tab"
      );
      Assert.equal(
        gBrowser.selectedTab,
        selected,
        "Sibling leaves selection unchanged"
      );
      candidate.state.zenWorkspace = owner;
      const restored = SessionStore.undoClosedTabFromClosedWindow(
        selector,
        candidate.closedId,
        window
      );
      await promiseTabRestored(restored);
      await TabStateFlusher.flush(restored.linkedBrowser);
      Assert.equal(
        JSON.parse(SessionStore.getTabState(restored)).entries[0].url,
        "about:robots",
        "Known local sibling restores actual history"
      );
    } finally {
      try {
        if (candidate) {
          candidate.state.zenWorkspace = owner;
        }
        const snapshot = structuredClone(closed);
        SessionStore.setWindowState(
          window,
          { windows: [], _closedWindows: closed },
          false
        );
        closed.splice(0, closed.length, ...snapshot);
        SessionStore.savedGroups.splice(
          0,
          SessionStore.savedGroups.length,
          ...savedGroups
        );
        SessionStore.lastClosedActions.splice(
          0,
          SessionStore.lastClosedActions.length,
          ...actions
        );
        Assert.deepEqual(
          SessionStore.getCurrentState(true)._closedWindows,
          snapshot,
          "Complete original metadata restored before fixture close"
        );
      } finally {
        try {
          if (owned && !owned.closed) {
            await BrowserTestUtils.closeWindow(owned);
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
);

add_task(async function test_closed_group_member_uses_same_undo_admission() {
  const originalTabs = new Set(gBrowser.tabs);
  const originalActions = structuredClone(SessionStore.lastClosedActions);
  const originalGroups = SessionStore.getClosedTabGroups(window);
  const original = SessionStore.getWindowState(window).windows[0];
  const originalSaved = structuredClone(SessionStore.savedGroups);
  let source;
  let candidate;
  let owner;
  try {
    const tab = await BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "about:robots"
    );
    const group = gBrowser.addTabGroup([tab], { insertBefore: tab });
    await TabStateFlusher.flush(tab.linkedBrowser);
    const removed = BrowserTestUtils.waitForEvent(group, "TabGroupRemoved");
    gBrowser.removeTabGroup(group);
    await removed;
    await TabStateFlusher.flushWindow(window);
    source = SessionStore.getCurrentState(true).windows.find(win =>
      win.closedGroups.some(item => item.id == group.id)
    );
    Assert.ok(
      source,
      "Normal group close produces schema-valid closed-group records"
    );
    candidate = source.closedGroups.find(item => item.id == group.id).tabs[0];
    owner = candidate.state.zenWorkspace;
    const unknown = Services.uuid.generateUUID().toString();
    Assert.ok(
      !gZenWorkspaces.getWorkspaceFromId(unknown),
      "Group member UUID is unknown locally"
    );
    candidate.state.zenWorkspace = unknown;
    const before = SessionStore.getClosedTabData(window);
    const index = before.findIndex(item => item.closedId == candidate.closedId);
    const groups = structuredClone(source.closedGroups);
    const actions = structuredClone(SessionStore.lastClosedActions);
    const tabs = Array.from(gBrowser.tabs);
    const selected = gBrowser.selectedTab;
    Assert.equal(
      SessionStore.undoCloseTab(window, index, window),
      undefined,
      "Unified group-member undo rejects before removal"
    );
    Assert.deepEqual(
      source.closedGroups,
      groups,
      "Rejected group member preserves the complete group"
    );
    Assert.deepEqual(
      SessionStore.lastClosedActions,
      actions,
      "Rejected group member preserves closed actions"
    );
    Assert.deepEqual(
      Array.from(gBrowser.tabs),
      tabs,
      "Rejected group member creates no tab"
    );
    Assert.equal(
      gBrowser.selectedTab,
      selected,
      "Rejected group member leaves selection unchanged"
    );
    candidate.state.zenWorkspace = owner;
    const restored = SessionStore.undoCloseTab(window, index, window);
    await promiseTabRestored(restored);
    await TabStateFlusher.flush(restored.linkedBrowser);
    Assert.equal(
      JSON.parse(SessionStore.getTabState(restored)).entries[0].url,
      "about:robots",
      "Known local group member restores real history"
    );
  } finally {
    try {
      if (candidate) {
        candidate.state.zenWorkspace = owner;
      }
      if (source) {
        source.closedGroups.splice(
          0,
          source.closedGroups.length,
          ...originalGroups
        );
        source.lastClosedTabGroupId = original.lastClosedTabGroupId;
        source._lastClosedTabGroupCount = original._lastClosedTabGroupCount;
        source._closedTabs.splice(
          0,
          source._closedTabs.length,
          ...original._closedTabs
        );
      }
      SessionStore.savedGroups.splice(
        0,
        SessionStore.savedGroups.length,
        ...originalSaved
      );
      SessionStore.lastClosedActions.splice(
        0,
        SessionStore.lastClosedActions.length,
        ...originalActions
      );
    } finally {
      for (const tab of gBrowser.tabs) {
        if (!originalTabs.has(tab)) {
          BrowserTestUtils.removeTab(tab);
        }
      }
    }
  }
});

add_task(async function test_selected_last_accessed_noop_reads_are_dynamic() {
  const selected = gBrowser.selectedTab;
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:mozilla"
  );
  try {
    await TabStateFlusher.flush(tab.linkedBrowser);
    const first = JSON.parse(SessionStore.getTabState(tab));
    Assert.equal(
      tab._lastAccessed,
      Infinity,
      "Selected tab stores Infinity, not the serialized read timestamp"
    );
    await TestUtils.waitForCondition(
      () => Date.now() > first.lastAccessed,
      "Clock advances without a restore operation"
    );
    const second = JSON.parse(SessionStore.getTabState(tab));
    Assert.greater(
      second.lastAccessed,
      first.lastAccessed,
      "No-op state reread advances only the dynamic timestamp"
    );
    Assert.equal(
      tab._lastAccessed,
      Infinity,
      "No-op reread does not mutate persistent last-access storage"
    );
    const firstTime = first.lastAccessed;
    const secondTime = second.lastAccessed;
    delete first.lastAccessed;
    delete second.lastAccessed;
    Assert.deepEqual(
      second,
      first,
      "Complete remaining state is unchanged by the no-op read"
    );
    Assert.equal(gBrowser.selectedTab, tab, "No-op leaves selection unchanged");
    info(
      "NOOP_LAST_ACCESSED " +
        JSON.stringify({
          first: firstTime,
          second: secondTime,
          persistent: "Infinity",
          unchangedOtherState: true,
        })
    );
  } finally {
    gBrowser.selectedTab = selected;
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_unknown_standalone_tab_preserves_existing_state() {
  const selected = gBrowser.selectedTab;
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:mozilla"
  );
  try {
    await TabStateFlusher.flush(tab.linkedBrowser);
    gBrowser.selectedTab = selected;
    const accessed = tab._lastAccessed;
    Assert.notEqual(
      accessed,
      Infinity,
      "Unselected owned target has a persistent timestamp"
    );
    const before = SessionStore.getTabState(tab);
    Assert.equal(
      SessionStore.getTabState(tab),
      before,
      "Unselected no-op reread preserves complete state including timestamp"
    );
    const unknown = Services.uuid.generateUUID().toString();
    Assert.ok(
      !gZenWorkspaces.getWorkspaceFromId(unknown),
      "Standalone UUID is not local"
    );
    const incoming = {
      entries: [{ url: "about:robots" }],
      zenWorkspace: unknown,
    };
    const input = structuredClone(incoming);
    SessionStore.setTabState(tab, incoming);
    Assert.deepEqual(
      incoming,
      input,
      "Rejected standalone input remains unchanged"
    );
    Assert.equal(
      SessionStore.getTabState(tab),
      before,
      "Standalone refusal preserves cache, history and attributes before reset"
    );
    Assert.equal(
      tab._lastAccessed,
      accessed,
      "Refusal preserves underlying last-access storage"
    );
    Assert.equal(
      gBrowser.selectedTab,
      selected,
      "Standalone refusal preserves original selection"
    );
    Assert.equal(
      tab.linkedBrowser.currentURI.spec,
      "about:mozilla",
      "Existing document is not replaced"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_unknown_closed_tab_preserves_record_before_undo() {
  const originalTabs = new Set(gBrowser.tabs);
  const originalClosed = SessionStore.getClosedTabData(window);
  const originalActions = structuredClone(SessionStore.lastClosedActions);
  let candidate;
  let source;
  let owner;
  try {
    const tab = await BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "about:robots"
    );
    await TabStateFlusher.flush(tab.linkedBrowser);
    await promiseRemoveTabAndSessionState(tab);
    const record = SessionStore.getClosedTabData(window).find(item =>
      item.state.entries.some(entry => entry.url == "about:robots")
    );
    Assert.ok(
      record,
      "Schema-valid record comes from normal tab close and final flush"
    );
    candidate = SessionStore.getCurrentState(true)
      .windows.flatMap(win => win._closedTabs)
      .find(item => item.closedId == record.closedId);
    Assert.ok(
      candidate,
      "Actual current-state API exposes the produced closed record"
    );
    source = SessionStore.getCurrentState(true).windows.find(win =>
      win._closedTabs.includes(candidate)
    );
    owner = candidate.state.zenWorkspace;
    const unknown = Services.uuid.generateUUID().toString();
    Assert.ok(
      !gZenWorkspaces.getWorkspaceFromId(unknown),
      "Unknown UUID absent from local catalog"
    );
    candidate.state.zenWorkspace = unknown;
    const before = SessionStore.getClosedTabData(window);
    const index = before.findIndex(item => item.closedId == record.closedId);
    Assert.equal(
      before[index].state.zenWorkspace,
      unknown,
      "Candidate resolver sees the unknown Space"
    );
    const actions = structuredClone(SessionStore.lastClosedActions);
    const tabs = Array.from(gBrowser.tabs);
    const selected = gBrowser.selectedTab;
    const history = tabs.map(
      item => JSON.parse(SessionStore.getTabState(item)).entries
    );
    const result = SessionStore.undoCloseTab(window, index, window);
    Assert.equal(
      result,
      undefined,
      "Unknown candidate refuses before tab creation"
    );
    Assert.deepEqual(
      SessionStore.getClosedTabData(window),
      before,
      "Unknown history preserved before consumption"
    );
    Assert.deepEqual(
      SessionStore.lastClosedActions,
      actions,
      "Closed actions preserved"
    );
    Assert.deepEqual(
      Array.from(gBrowser.tabs),
      tabs,
      "Existing tab identities preserved"
    );
    Assert.equal(gBrowser.selectedTab, selected, "Selection preserved");
    Assert.deepEqual(
      tabs.map(item => JSON.parse(SessionStore.getTabState(item)).entries),
      history,
      "Existing histories preserved"
    );
    SessionStore.forgetClosedTab(window, index);
    Assert.ok(
      !SessionStore.getClosedTabData(window).some(
        item => item.closedId == candidate.closedId
      ),
      "Explicit forget remains available for unresolved history"
    );
  } finally {
    if (candidate) {
      candidate.state.zenWorkspace = owner;
    }
    if (source) {
      source._closedTabs.splice(
        0,
        source._closedTabs.length,
        ...originalClosed
      );
    }
    SessionStore.lastClosedActions.splice(
      0,
      SessionStore.lastClosedActions.length,
      ...originalActions
    );
    for (const tab of gBrowser.tabs) {
      if (!originalTabs.has(tab)) {
        BrowserTestUtils.removeTab(tab);
      }
    }
  }
});
