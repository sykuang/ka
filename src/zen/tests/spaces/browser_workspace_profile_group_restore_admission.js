/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { SessionWindowUI } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionWindowUI.sys.mjs"
);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.groups.enabled", true],
      ["browser.tabs.groups.alternateMenu", true],
    ],
  });
});

add_task(
  async function test_restore_all_keeps_refused_whole_group_and_opens_next_local_tab() {
    const originalMainTabs = new Set(gBrowser.tabs);
    const originalMainSelected = gBrowser.selectedTab;
    const { RecentlyClosedTabsAndWindowsMenuUtils } =
      ChromeUtils.importESModule(
        "moz-src:///browser/components/sessionstore/RecentlyClosedTabsAndWindowsMenuUtils.sys.mjs"
      );
    const closed = structuredClone(
      SessionStore.getCurrentState(true)._closedWindows
    );
    const saved = structuredClone(SessionStore.savedGroups);
    const actions = structuredClone(SessionStore.lastClosedActions);
    let owned;
    let host;
    let member;
    let owner;
    await SpecialPowers.pushPrefEnv({
      set: [
        ["browser.sessionstore.closedTabsFromAllWindows", false],
        ["browser.sessionstore.closedTabsFromClosedWindows", false],
      ],
    });
    try {
      owned = await BrowserTestUtils.openNewBrowserWindow();
      await owned.gZenWorkspaces.promiseInitialized;
      const tab = await BrowserTestUtils.openNewForegroundTab(
        owned.gBrowser,
        "about:license"
      );
      await BrowserTestUtils.loadURIString({
        browser: tab.linkedBrowser,
        uriString: "about:mozilla",
      });
      await TabStateFlusher.flush(tab.linkedBrowser);
      await promiseRemoveTabAndSessionState(tab);
      const localRecord = SessionStore.getClosedTabData(owned).find(
        item => item.state.entries[0].url == "about:license"
      );
      const group = await makeHistoryGroup(owned);
      const removed = BrowserTestUtils.waitForEvent(group, "TabGroupRemoved");
      owned.gBrowser.removeTabGroup(group);
      await removed;
      await TabStateFlusher.flushWindow(owned);
      const source = SessionStore.getCurrentState(true).windows.find(win =>
        win.closedGroups.some(item => item.id == group.id)
      );
      const candidate = source.closedGroups.find(item => item.id == group.id);
      member = candidate.tabs[1];
      owner = member.state.zenWorkspace;
      const unknown = Services.uuid.generateUUID().toString();
      Assert.ok(
        !owned.gZenWorkspaces.getWorkspaceFromId(unknown),
        "Restore-all second group member is unresolved locally"
      );
      member.state.zenWorkspace = unknown;
      const data = SessionStore.getClosedTabData(owned);
      Assert.equal(
        data[0].state.groupId,
        group.id,
        "Real close ordering puts refused group before older local tab"
      );
      const beforeGroup = structuredClone(candidate);
      host = owned.document.createXULElement("vbox");
      owned.document.documentElement.appendChild(host);
      host.appendChild(
        RecentlyClosedTabsAndWindowsMenuUtils.getTabsFragment(
          owned,
          "toolbarbutton"
        )
      );
      const command = host.querySelector(".restoreallitem");
      Assert.ok(
        command,
        "Registered Restore All control generated from actual records"
      );
      command.click();
      await TestUtils.waitForTick();
      Assert.equal(
        source.closedGroups.find(item => item.id == group.id),
        candidate,
        "Restore All retains refused whole candidate identity"
      );
      Assert.deepEqual(
        candidate,
        beforeGroup,
        "Restore All does not partially consume a refused group through later index-zero callback"
      );
      Assert.ok(
        !SessionStore.getClosedTabData(owned).some(
          item => item.closedId == localRecord.closedId
        ),
        "Restore All consumes the next known local standalone, not a group member"
      );
      const restored = Array.from(owned.gBrowser.tabs).find(item =>
        JSON.parse(SessionStore.getTabState(item)).entries.some(
          entry => entry.url == "about:license"
        )
      );
      Assert.ok(restored, "Restore All opens the actual next local history");
      if (restored) {
        if (restored.hasAttribute("pending")) {
          const ready = promiseTabRestored(restored);
          owned.gBrowser.selectedTab = restored;
          await ready;
        }
        await TabStateFlusher.flush(restored.linkedBrowser);
        Assert.equal(
          restored.linkedBrowser.currentURI.spec,
          "about:mozilla",
          "Restore All loads the actual known local document"
        );
        Assert.deepEqual(
          JSON.parse(SessionStore.getTabState(restored)).entries.map(
            entry => entry.url
          ),
          ["about:license", "about:mozilla"],
          "Restore All preserves complete standalone native history"
        );
      }
    } finally {
      const restoreMetadata = () => {
        if (member) {
          member.state.zenWorkspace = owner;
        }
        const copy = structuredClone(closed);
        SessionStore.setWindowState(
          window,
          { windows: [], _closedWindows: closed },
          false
        );
        closed.splice(0, closed.length, ...copy);
        SessionStore.savedGroups.splice(
          0,
          SessionStore.savedGroups.length,
          ...saved
        );
        while (SessionStore.lastClosedActions.length > actions.length) {
          SessionStore.popLastClosedAction();
        }
      };
      try {
        host?.remove();
        restoreMetadata();
      } finally {
        try {
          if (owned && !owned.closed) {
            await BrowserTestUtils.closeWindow(owned);
          }
        } finally {
          try {
            gBrowser.selectedTab = originalMainSelected;
            for (const tab of Array.from(gBrowser.tabs)) {
              if (!originalMainTabs.has(tab)) {
                await BrowserTestUtils.removeTab(tab);
              }
            }
            await TabStateFlusher.flushWindow(window);
            await TestUtils.waitForTick();
          } finally {
            restoreMetadata();
            try {
              Assert.deepEqual(
                Array.from(gBrowser.tabs),
                Array.from(originalMainTabs),
                "Restore All fixture restores original main-window tab identities"
              );
            } finally {
              await SpecialPowers.popPrefEnv();
            }
          }
        }
      }
    }
  }
);

async function activateSavedGroupMenu(id, commandId) {
  const { CustomizableUITestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/CustomizableUITestUtils.sys.mjs"
  );
  const ui = new CustomizableUITestUtils(window);
  const menu = document.getElementById("saved-tab-group-context-menu");
  const errors = [];
  const onError = event => {
    errors.push(event.message);
    event.preventDefault();
  };
  window.addEventListener("error", onError);
  try {
    await ui.openMainMenu();
    const view = PanelMultiView.getViewNode(
      document,
      "appMenu-tabGroupsListView"
    );
    const shown = BrowserTestUtils.waitForEvent(view, "ViewShown");
    PanelMultiView.getViewNode(document, "appMenu-tab-groups-button").click();
    await shown;
    await view.querySelector("tab-groups-list").updateComplete;
    const row = view.querySelector(`[data-tab-group-id="${id}"][data-saved]`);
    Assert.ok(
      row,
      "Rendered saved group row is backed by real native producer"
    );
    const menuShown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    EventUtils.synthesizeMouseAtCenter(
      row.querySelector(".tab-group-row-label"),
      { type: "contextmenu", button: 2 },
      window
    );
    await menuShown;
    const command = menu.querySelector(
      `#saved-tab-group-context-menu_${commandId}`
    );
    Assert.ok(!command.disabled, "Real saved group context command enabled");
    const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
    menu.activateItem(command);
    await hidden;
    await TestUtils.waitForTick();
    Assert.deepEqual(
      errors,
      [],
      "Real saved group command handles refusal without cleanup or exception"
    );
  } finally {
    window.removeEventListener("error", onError);
    if (menu.state == "open") {
      menu.hidePopup();
    }
    await ui.hideMainMenu();
  }
}

add_task(
  async function test_saved_group_preserves_live_and_closed_window_references() {
    const originalTabs = new Set(gBrowser.tabs);
    const selected = gBrowser.selectedTab;
    const original = SessionStore.getWindowState(window).windows[0];
    const closedWindows = structuredClone(
      SessionStore.getCurrentState(true)._closedWindows
    );
    const savedGroups = structuredClone(SessionStore.savedGroups);
    const actions = structuredClone(SessionStore.lastClosedActions);
    let owned;
    let member;
    let owner;
    try {
      for (const fromClosedWindow of [false, true]) {
        owned = await BrowserTestUtils.openNewBrowserWindow();
        await owned.gZenWorkspaces.promiseInitialized;
        const blank = owned.gBrowser.selectedTab;
        for (const tab of Array.from(owned.gBrowser.tabs)) {
          if (tab !== blank) {
            await BrowserTestUtils.removeTab(tab);
          }
        }
        const group = await makeHistoryGroup(owned);
        if (fromClosedWindow) {
          await TabStateFlusher.flushWindow(owned);
          await BrowserTestUtils.closeWindow(owned);
        } else {
          group.save();
          const removed = BrowserTestUtils.waitForEvent(
            group,
            "TabGroupRemoved"
          );
          owned.gBrowser.removeTabGroup(group);
          await removed;
          await TabStateFlusher.flushWindow(owned);
        }
        const candidate = SessionStore.getSavedTabGroup(group.id);
        Assert.ok(
          candidate,
          "Actual native save producer supplies live saved group"
        );
        Assert.equal(
          candidate.tabs.length,
          2,
          "Real saved wrapper contains both native members"
        );
        const closedSource = SessionStore.getCurrentState(
          true
        )._closedWindows.find(win => win.closedId == candidate.windowClosedId);
        Assert.equal(
          !!closedSource,
          fromClosedWindow,
          "Real window-close reference branch selected"
        );
        member = candidate.tabs[1];
        owner = member.state.zenWorkspace;
        const unknown = Services.uuid.generateUUID().toString();
        Assert.ok(
          !gZenWorkspaces.getWorkspaceFromId(unknown),
          "Unknown saved member absent from actual catalog"
        );
        member.state.zenWorkspace = unknown;
        const globalSaved = structuredClone(SessionStore.savedGroups);
        const windows = structuredClone(
          SessionStore.getCurrentState(true)._closedWindows
        );
        const before = snapshotGroupDestination(window);
        if (!fromClosedWindow) {
          const sourceBefore = snapshotGroupDestination(owned);
          Assert.equal(
            owned.gBrowser.visibleTabs.length,
            1,
            "Actual blank-removal UI condition has one visible tab"
          );
          Assert.ok(
            owned.gBrowser.selectedTab.isEmpty,
            "Actual UI blank is empty"
          );
          let uiResult;
          let uiError;
          try {
            uiResult = SessionWindowUI.undoCloseTab(owned);
          } catch (caught) {
            uiError = caught;
          }
          Assert.equal(
            uiError,
            undefined,
            "Saved-group UI does not throw on refusal"
          );
          Assert.equal(
            uiResult,
            undefined,
            "Saved-group UI refuses without blank cleanup"
          );
          assertGroupDestination(owned, sourceBefore);
          Assert.deepEqual(
            SessionStore.savedGroups,
            globalSaved,
            "Blank UI retains the complete saved payload"
          );
        }
        let result;
        let error;
        try {
          result = SessionStore.openSavedTabGroup(group.id, window);
        } catch (caught) {
          error = caught;
        }
        Assert.equal(
          error,
          undefined,
          "Saved group refusal is not exception-driven cancellation"
        );
        Assert.equal(
          result,
          undefined,
          "Saved group refuses before any member or reference removal"
        );
        assertGroupDestination(window, before);
        Assert.equal(
          SessionStore.getSavedTabGroup(group.id),
          candidate,
          "Exact saved candidate identity retained"
        );
        Assert.deepEqual(
          SessionStore.savedGroups,
          globalSaved,
          "Entire global saved group payload retained without retargeting"
        );
        Assert.deepEqual(
          SessionStore.getCurrentState(true)._closedWindows,
          windows,
          "Complete closed-window records and saved group reference retained"
        );
        for (const command of SessionStore.getSavedTabGroup(group.id)
          ? ["openInThisWindow", "openInNewWindow"]
          : []) {
          await activateSavedGroupMenu(group.id, command);
          assertGroupDestination(window, before);
          Assert.deepEqual(
            SessionStore.savedGroups,
            globalSaved,
            "Registered menu preserves every saved member"
          );
          Assert.deepEqual(
            SessionStore.getCurrentState(true)._closedWindows,
            windows,
            "Registered menu preserves closed source reference"
          );
        }
        if (!result && !error) {
          member.state.zenWorkspace = owner;
          await activateSavedGroupMenu(group.id, "openInThisWindow");
          await assertRestoredHistoryGroup(gBrowser.getTabGroupById(group.id));
          Assert.ok(
            !SessionStore.getSavedTabGroup(group.id),
            "Successful known local group consumed only after admission"
          );
          if (closedSource) {
            Assert.ok(
              !closedSource.groups.some(item => item.id == group.id),
              "Successful known local open removes source reference"
            );
          }
        }
        if (!owned.closed) {
          await BrowserTestUtils.closeWindow(owned);
        }
      }
    } finally {
      const restoreMetadata = () => {
        gBrowser.selectedTab = selected;
        if (member) {
          member.state.zenWorkspace = owner;
        }
        const copy = structuredClone(closedWindows);
        SessionStore.setWindowState(
          window,
          { windows: [], _closedWindows: closedWindows },
          false
        );
        closedWindows.splice(0, closedWindows.length, ...copy);
        SessionStore.savedGroups.splice(
          0,
          SessionStore.savedGroups.length,
          ...savedGroups
        );
        while (SessionStore.lastClosedActions.length > actions.length) {
          SessionStore.popLastClosedAction();
        }
        const live = SessionStore.getCurrentState(true).windows.find(win =>
          win.tabs.some(tab =>
            original.tabs.some(old => old.zenSyncId == tab.zenSyncId)
          )
        );
        if (live) {
          live._closedTabs.splice(
            0,
            live._closedTabs.length,
            ...original._closedTabs
          );
          live.closedGroups.splice(
            0,
            live.closedGroups.length,
            ...original.closedGroups
          );
          live.lastClosedTabGroupId = original.lastClosedTabGroupId;
          live._lastClosedTabGroupCount = original._lastClosedTabGroupCount;
        }
      };
      try {
        restoreMetadata();
      } finally {
        try {
          if (owned && !owned.closed) {
            await BrowserTestUtils.closeWindow(owned);
          }
        } finally {
          try {
            for (const tab of Array.from(gBrowser.tabs)) {
              if (!originalTabs.has(tab)) {
                await BrowserTestUtils.removeTab(tab);
              }
            }
          } finally {
            await TabStateFlusher.flushWindow(window);
            await TestUtils.waitForTick();
            restoreMetadata();
            Assert.deepEqual(
              Array.from(gBrowser.tabs),
              Array.from(originalTabs),
              "Saved-group fixture restores original tab identities"
            );
            Assert.deepEqual(
              SessionStore.getCurrentState(true)._closedWindows,
              closedWindows,
              "Cleanup restores original closed-window references"
            );
            Assert.deepEqual(
              SessionStore.savedGroups,
              savedGroups,
              "Cleanup restores original global saved groups"
            );
            Assert.deepEqual(
              SessionStore.lastClosedActions,
              actions,
              "Cleanup restores original closed actions"
            );
          }
        }
      }
    }
  }
);

async function makeHistoryGroup(win) {
  const tabs = [];
  for (const first of ["about:robots", "about:about"]) {
    const tab = await BrowserTestUtils.openNewForegroundTab(
      win.gBrowser,
      first
    );
    await BrowserTestUtils.loadURIString({
      browser: tab.linkedBrowser,
      uriString: "about:mozilla",
    });
    await TabStateFlusher.flush(tab.linkedBrowser);
    Assert.deepEqual(
      JSON.parse(SessionStore.getTabState(tab)).entries.map(entry => entry.url),
      [first, "about:mozilla"],
      "Native producer has two actually loaded history entries"
    );
    tabs.push(tab);
  }
  return win.gBrowser.addTabGroup(tabs, {
    insertBefore: tabs[0],
    label: "Owned history group",
    color: "blue",
  });
}

function snapshotGroupDestination(win) {
  const tabs = Array.from(win.gBrowser.tabs);
  return {
    tabs,
    groups: Array.from(win.gBrowser.tabGroups),
    selected: win.gBrowser.selectedTab,
    history: tabs.map(tab => JSON.parse(SessionStore.getTabState(tab)).entries),
    actions: structuredClone(SessionStore.lastClosedActions),
  };
}

function assertGroupDestination(win, before) {
  Assert.deepEqual(
    Array.from(win.gBrowser.tabs),
    before.tabs,
    "No partial member creation"
  );
  Assert.deepEqual(
    Array.from(win.gBrowser.tabGroups),
    before.groups,
    "No partial group creation"
  );
  Assert.equal(
    win.gBrowser.selectedTab,
    before.selected,
    "Selection identity preserved"
  );
  if (before.tabs.every(tab => win.gBrowser.tabs.includes(tab))) {
    Assert.deepEqual(
      before.tabs.map(tab => JSON.parse(SessionStore.getTabState(tab)).entries),
      before.history,
      "Existing native histories preserved"
    );
  } else {
    Assert.ok(
      false,
      "Existing native histories preserved; old source removed an original tab"
    );
  }
  Assert.deepEqual(
    SessionStore.lastClosedActions,
    before.actions,
    "Closed actions preserved"
  );
}

async function assertRestoredHistoryGroup(group) {
  Assert.ok(group, "Known local whole group opens");
  Assert.equal(group.tabs.length, 2, "Both native members restored");
  for (const [index, tab] of Array.from(group.tabs).entries()) {
    if (tab.hasAttribute("pending")) {
      const restored = promiseTabRestored(tab);
      tab.documentGlobal.gBrowser.selectedTab = tab;
      await restored;
    }
    await TabStateFlusher.flush(tab.linkedBrowser);
    Assert.equal(
      tab.linkedBrowser.currentURI.spec,
      "about:mozilla",
      "Actual restored document loaded"
    );
    Assert.deepEqual(
      JSON.parse(SessionStore.getTabState(tab)).entries.map(entry => entry.url),
      [index ? "about:about" : "about:robots", "about:mozilla"],
      "Both complete native histories restored"
    );
  }
}

add_task(
  async function test_whole_closed_group_admits_every_member_before_effects() {
    const originalTabs = new Set(gBrowser.tabs);
    const selected = gBrowser.selectedTab;
    const original = SessionStore.getWindowState(window).windows[0];
    const saved = structuredClone(SessionStore.savedGroups);
    const actions = structuredClone(SessionStore.lastClosedActions);
    let source;
    let candidate;
    let member;
    let owner;
    try {
      const group = await makeHistoryGroup(window);
      const removed = BrowserTestUtils.waitForEvent(group, "TabGroupRemoved");
      gBrowser.removeTabGroup(group);
      await removed;
      await TabStateFlusher.flushWindow(window);
      source = SessionStore.getCurrentState(true).windows.find(win =>
        win.closedGroups.some(item => item.id == group.id)
      );
      candidate = source.closedGroups.find(item => item.id == group.id);
      Assert.equal(
        candidate.tabs.length,
        2,
        "Normal native close yields complete schema-valid candidate"
      );
      member = candidate.tabs[1];
      owner = member.state.zenWorkspace;
      const unknown = Services.uuid.generateUUID().toString();
      Assert.ok(
        !gZenWorkspaces.getWorkspaceFromId(unknown),
        "Second member UUID absent from actual destination catalog"
      );
      member.state.zenWorkspace = unknown;
      SessionStore.getClosedTabData(window);
      const closed = structuredClone(source.closedGroups);
      const closedTabs = structuredClone(source._closedTabs);
      const lastGroup = source.lastClosedTabGroupId;
      const count = source._lastClosedTabGroupCount;
      const before = snapshotGroupDestination(window);
      const result = SessionStore.undoCloseTabGroup(window, group.id, window);
      Assert.equal(
        result,
        undefined,
        "Whole group refuses before first member creation or forget"
      );
      assertGroupDestination(window, before);
      Assert.equal(
        source.closedGroups.find(item => item.id == group.id),
        candidate,
        "Exact whole candidate identity retained"
      );
      Assert.deepEqual(
        source.closedGroups,
        closed,
        "All members and complete closed group history retained"
      );
      Assert.deepEqual(
        source._closedTabs,
        closedTabs,
        "Other closed tabs retained"
      );
      Assert.equal(
        source.lastClosedTabGroupId,
        lastGroup,
        "Last group action identity retained"
      );
      Assert.equal(
        source._lastClosedTabGroupCount,
        count,
        "Last group count retained"
      );
      Assert.deepEqual(
        SessionStore.savedGroups,
        saved,
        "Global saved groups unchanged"
      );
      for (const call of [
        () => SessionWindowUI.undoCloseTab(window),
        () => SessionWindowUI.restoreLastClosedTabOrWindowOrSession(window),
      ]) {
        let error;
        try {
          call();
        } catch (caught) {
          error = caught;
        }
        Assert.equal(
          error,
          undefined,
          "Whole group UI caller handles refusal without dereferencing missing group"
        );
        assertGroupDestination(window, before);
        Assert.deepEqual(
          source.closedGroups,
          closed,
          "Whole group UI and shortcut retain the candidate"
        );
      }
      if (!result) {
        member.state.zenWorkspace = owner;
        await assertRestoredHistoryGroup(
          SessionStore.undoCloseTabGroup(window, group.id, window)
        );
      }
    } finally {
      const restoreMetadata = () => {
        gBrowser.selectedTab = selected;
        if (member) {
          member.state.zenWorkspace = owner;
        }
        if (source) {
          source.closedGroups.splice(
            0,
            source.closedGroups.length,
            ...original.closedGroups
          );
          source._closedTabs.splice(
            0,
            source._closedTabs.length,
            ...original._closedTabs
          );
          source.lastClosedTabGroupId = original.lastClosedTabGroupId;
          source._lastClosedTabGroupCount = original._lastClosedTabGroupCount;
        }
        SessionStore.savedGroups.splice(
          0,
          SessionStore.savedGroups.length,
          ...saved
        );
        while (SessionStore.lastClosedActions.length > actions.length) {
          SessionStore.popLastClosedAction();
        }
      };
      try {
        restoreMetadata();
      } finally {
        try {
          for (const tab of Array.from(gBrowser.tabs)) {
            if (!originalTabs.has(tab)) {
              await BrowserTestUtils.removeTab(tab);
            }
          }
        } finally {
          await TabStateFlusher.flushWindow(window);
          await TestUtils.waitForTick();
          restoreMetadata();
          Assert.deepEqual(
            Array.from(gBrowser.tabs),
            Array.from(originalTabs),
            "Closed-group fixture restores original tab identities"
          );
          Assert.deepEqual(
            source.closedGroups,
            original.closedGroups,
            "Cleanup restores original closed groups"
          );
          Assert.deepEqual(
            source._closedTabs,
            original._closedTabs,
            "Cleanup restores original closed tabs"
          );
          Assert.deepEqual(
            SessionStore.savedGroups,
            saved,
            "Cleanup restores original global saved groups"
          );
          Assert.deepEqual(
            SessionStore.lastClosedActions,
            actions,
            "Cleanup restores original closed actions"
          );
        }
      }
    }
  }
);

add_task(async function test_cross_window_whole_closed_group_shortcut() {
  const { ZenSessionStore } = ChromeUtils.importESModule(
    "resource:///modules/zen/ZenSessionManager.sys.mjs"
  );
  const mainTabs = new Set(gBrowser.tabs);
  const mainSelected = gBrowser.selectedTab;
  const originalClosed = structuredClone(
    SessionStore.getCurrentState(true)._closedWindows
  );
  const originalSaved = structuredClone(SessionStore.savedGroups);
  const originalActions = structuredClone(SessionStore.lastClosedActions);
  let a;
  let b;
  let directory;
  let changedSpace;
  let originalReference;
  const restoreMetadata = () => {
    const state = SessionStore.getCurrentState(true);
    state._closedWindows.splice(
      0,
      state._closedWindows.length,
      ...structuredClone(originalClosed)
    );
    SessionStore.savedGroups.splice(
      0,
      SessionStore.savedGroups.length,
      ...structuredClone(originalSaved)
    );
    while (SessionStore.lastClosedActions.length > originalActions.length) {
      SessionStore.popLastClosedAction();
    }
  };
  try {
    directory = Services.dirsvc.get("TmpD", Ci.nsIFile);
    directory.append("zen-c1-foreign-owner");
    directory.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
    for (const mode of ["positive", "wrong-owner", "member-refusal"]) {
      b = await BrowserTestUtils.openNewBrowserWindow({
        zenSyncedWindow: false,
      });
      await b.gZenWorkspaces.promiseInitialized;
      let blank = b.gBrowser.selectedTab;
      for (const tab of Array.from(b.gBrowser.tabs)) {
        if (tab !== blank) {
          await BrowserTestUtils.removeTab(tab);
        }
      }
      a = await BrowserTestUtils.openNewBrowserWindow({
        zenSyncedWindow: false,
      });
      await a.gZenWorkspaces.promiseInitialized;
      if (mode != "member-refusal") {
        await a.gZenWorkspaces.propagateWorkspaces(
          structuredClone([
            ...a.gZenWorkspaces.getWorkspaces(),
            ...b.gZenWorkspaces.getWorkspaces(),
          ])
        );
        await a.gZenWorkspaces.changeWorkspaceWithID(
          b.gZenWorkspaces.activeWorkspace
        );
      }
      Assert.ok(
        a.__SSi && b.__SSi && a.__SSi != b.__SSi,
        "C1 has two distinct normally tracked open windows"
      );
      const group = await makeHistoryGroup(a);
      const removed = BrowserTestUtils.waitForEvent(group, "TabGroupRemoved");
      a.gBrowser.removeTabGroup(group);
      await removed;
      await TabStateFlusher.flushWindow(a);
      const source = SessionStore.getCurrentState(true).windows.find(win =>
        win.closedGroups.some(item => item.id == group.id)
      );
      const candidate = source.closedGroups.find(item => item.id == group.id);
      Assert.equal(
        candidate.tabs.length,
        2,
        "C1 normal close produces both complete members"
      );
      Assert.equal(
        SessionStore.getLastClosedTabGroupId(a),
        group.id,
        "C1 source last group resolves A"
      );
      Assert.ok(
        !SessionStore.getSavedTabGroup(group.id),
        "C1 takes unsaved closed-group branch"
      );
      Assert.ok(
        !SessionStore.getWindowState(b).windows[0].closedGroups.some(
          item => item.id == group.id
        ),
        "C1 group exists only in A, not B"
      );
      const action = SessionStore.lastClosedActions.at(-1);
      Assert.equal(
        action.type,
        SessionStore.LAST_ACTION_CLOSED_TAB,
        "C1 latest action comes from real tab close"
      );
      Assert.equal(
        SessionStore.getWindowForTabClosedId(action.closedId),
        a,
        "C1 real latest closedId resolves A"
      );
      const spaces = b.gZenWorkspaces.getWorkspaces();
      const profile = Services.dirsvc.get("ProfD", Ci.nsIFile);
      for (const space of spaces) {
        const owner = Cc["@mozilla.org/file/local;1"].createInstance(
          Ci.nsIFile
        );
        owner.persistentDescriptor =
          space.geckoProfileReference.persistentDescriptor;
        Assert.ok(
          owner.equals(profile),
          "C1 actual destination catalog belongs to ProfD"
        );
      }
      if (mode == "member-refusal") {
        Assert.ok(
          !spaces.some(
            space => space.uuid == candidate.tabs[1].state.zenWorkspace
          ),
          "C1 native unsynced source member is naturally absent at B"
        );
        candidate.tabs[0].state.zenWorkspace = b.gZenWorkspaces.activeWorkspace;
        Assert.ok(
          ZenSessionStore.canRestoreWindow({
            spaces,
            tabs: [candidate.tabs[0].state],
          }),
          "C1 first member resolves an actual known local B Space"
        );
      } else {
        Assert.ok(
          ZenSessionStore.canRestoreWindow({
            spaces,
            tabs: candidate.tabs.map(tab => tab.state),
          }),
          "C1 both native members begin admitted by actual B catalog"
        );
      }
      if (mode == "wrong-owner") {
        changedSpace = b.gZenWorkspaces.getWorkspaceFromId(
          candidate.tabs[1].state.zenWorkspace
        );
        originalReference = changedSpace.geckoProfileReference;
        changedSpace.geckoProfileReference = {
          ...originalReference,
          persistentDescriptor: directory.persistentDescriptor,
        };
      }
      const admitted = ZenSessionStore.canRestoreWindow({
        spaces: b.gZenWorkspaces.getWorkspaces(),
        tabs: candidate.tabs.map(tab => tab.state),
      });
      Assert.equal(
        admitted,
        mode == "positive",
        "C1 actual destination admission matches native fixture mode"
      );
      SessionStore.getClosedTabData(a);
      b.gBrowser.selectedTab = blank;
      for (const tab of Array.from(b.gBrowser.tabs)) {
        if (tab !== blank) {
          Assert.ok(
            tab.isEmpty,
            "C1 extra synced destination tab is only a blank"
          );
          await BrowserTestUtils.removeTab(tab);
        }
      }
      await TabStateFlusher.flushWindow(b);
      Assert.equal(
        SessionStore.getWindowForTabClosedId(
          SessionStore.lastClosedActions.at(-1).closedId
        ),
        a,
        "C1 latest action still resolves A after destination blank preparation"
      );
      const closedGroups = structuredClone(source.closedGroups);
      const closedTabs = structuredClone(source._closedTabs);
      const closedMemberIds = candidate.tabs.map(tab => tab.closedId);
      Assert.equal(
        closedMemberIds.length,
        2,
        "C1 original member action IDs captured before restore"
      );
      const lastGroup = source.lastClosedTabGroupId;
      const lastCount = source._lastClosedTabGroupCount;
      const sourceBefore = snapshotGroupDestination(a);
      const targetBefore = snapshotGroupDestination(b);
      Assert.equal(
        b.gBrowser.visibleTabs.length,
        1,
        "C1 B exercises real one-blank UI cleanup condition"
      );
      Assert.ok(blank.isEmpty, "C1 B blank is genuinely empty");
      const calls =
        mode == "positive"
          ? [() => SessionWindowUI.restoreLastClosedTabOrWindowOrSession(b)]
          : [
              () => SessionWindowUI.restoreLastClosedTabOrWindowOrSession(b),
              () => SessionWindowUI.undoCloseTab(b, undefined, a.__SSi),
            ];
      for (const call of calls) {
        let error;
        let result;
        try {
          result = call();
        } catch (caught) {
          error = String(caught);
        }
        Assert.equal(
          error,
          undefined,
          `C1 ${mode} shared caller must use resolved source without lookup exception`
        );
        if (mode != "positive") {
          Assert.equal(result, undefined, "C1 refusal returns undefined");
          assertGroupDestination(a, sourceBefore);
          assertGroupDestination(b, targetBefore);
          Assert.equal(
            source.closedGroups.find(item => item.id == group.id),
            candidate,
            "C1 exact source candidate identity retained"
          );
          Assert.deepEqual(
            source.closedGroups,
            closedGroups,
            "C1 entire source group data and all member histories retained"
          );
          Assert.deepEqual(
            source._closedTabs,
            closedTabs,
            "C1 other source closed tabs retained"
          );
          Assert.equal(
            source.lastClosedTabGroupId,
            lastGroup,
            "C1 source last-group identity retained"
          );
          Assert.equal(
            source._lastClosedTabGroupCount,
            lastCount,
            "C1 source last-group count retained"
          );
          Assert.deepEqual(
            SessionStore.savedGroups,
            originalSaved,
            "C1 global saved groups retained"
          );
        } else {
          const restored = b.gBrowser.tabGroups.find(
            item => item.id === group.id
          );
          Assert.ok(
            restored,
            "C1 shortcut restores whole native group from A into B"
          );
          if (restored && !error) {
            Assert.equal(
              restored.ownerDocument.defaultView,
              b,
              "C1 restored group belongs to destination B"
            );
            await assertRestoredHistoryGroup(restored);
            Assert.equal(
              restored.label,
              group.label,
              "C1 native group label preserved"
            );
            Assert.equal(
              restored.color,
              group.color,
              "C1 native group color preserved"
            );
            Assert.ok(
              !b.gBrowser.tabs.includes(blank),
              "C1 success removes B blank only after group restore"
            );
            Assert.ok(
              !source.closedGroups.includes(candidate),
              "C1 success consumes A candidate"
            );
            const remainingActions = SessionStore.lastClosedActions;
            Assert.ok(
              !remainingActions.some(item =>
                closedMemberIds.includes(item.closedId)
              ),
              "C1 success consumes actual member close actions"
            );
          }
        }
      }
      if (changedSpace) {
        changedSpace.geckoProfileReference = originalReference;
        changedSpace = null;
      }
      try {
        await BrowserTestUtils.closeWindow(a);
      } finally {
        await BrowserTestUtils.closeWindow(b);
      }
      a = b = null;
      restoreMetadata();
    }
  } finally {
    if (changedSpace) {
      changedSpace.geckoProfileReference = originalReference;
    }
    try {
      if (a && !a.closed) {
        await BrowserTestUtils.closeWindow(a);
      }
    } finally {
      try {
        if (b && !b.closed) {
          await BrowserTestUtils.closeWindow(b);
        }
      } finally {
        try {
          gBrowser.selectedTab = mainSelected;
          for (const tab of Array.from(gBrowser.tabs)) {
            if (!mainTabs.has(tab)) {
              await BrowserTestUtils.removeTab(tab);
            }
          }
          await TabStateFlusher.flushWindow(window);
          await TestUtils.waitForTick();
        } finally {
          try {
            restoreMetadata();
            Assert.deepEqual(
              Array.from(gBrowser.tabs),
              Array.from(mainTabs),
              "C1 cleanup restores original main tab identities"
            );
            Assert.equal(
              gBrowser.selectedTab,
              mainSelected,
              "C1 cleanup restores original main selection"
            );
            Assert.deepEqual(
              SessionStore.getCurrentState(true)._closedWindows,
              originalClosed,
              "C1 cleanup restores full closed-window data"
            );
            Assert.deepEqual(
              SessionStore.savedGroups,
              originalSaved,
              "C1 cleanup restores full saved group data"
            );
            Assert.deepEqual(
              SessionStore.lastClosedActions,
              originalActions,
              "C1 cleanup restores full actions"
            );
          } finally {
            if (directory?.exists()) {
              directory.remove(true);
            }
          }
        }
      }
    }
  }
});
