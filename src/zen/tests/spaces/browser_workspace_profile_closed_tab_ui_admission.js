/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { SessionWindowUI } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionWindowUI.sys.mjs"
);
const { RecentlyClosedTabsAndWindowsMenuUtils } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/RecentlyClosedTabsAndWindowsMenuUtils.sys.mjs"
);

async function withClosedTabUIFixture(task) {
  const originalTabs = new Set(gBrowser.tabs);
  const selected = gBrowser.selectedTab;
  const closed = structuredClone(
    SessionStore.getCurrentState(true)._closedWindows
  );
  const saved = structuredClone(SessionStore.savedGroups);
  const actions = structuredClone(SessionStore.lastClosedActions);
  let win;
  let candidate;
  let owner;
  try {
    win = await BrowserTestUtils.openNewBrowserWindow();
    await win.gZenWorkspaces.promiseInitialized;
    const tab = await BrowserTestUtils.openNewForegroundTab(
      win.gBrowser,
      "about:robots"
    );
    await BrowserTestUtils.loadURIString({
      browser: tab.linkedBrowser,
      uriString: "about:mozilla",
    });
    await TabStateFlusher.flush(tab.linkedBrowser);
    await promiseRemoveTabAndSessionState(tab);
    const record = SessionStore.getClosedTabData(win)[0];
    candidate = SessionStore.getCurrentState(true)
      .windows.find(item =>
        item._closedTabs.some(entry => entry.closedId == record.closedId)
      )
      ._closedTabs.find(entry => entry.closedId == record.closedId);
    owner = candidate.state.zenWorkspace;
    const unknown = Services.uuid.generateUUID().toString();
    Assert.ok(
      !win.gZenWorkspaces.getWorkspaceFromId(unknown),
      "Fixture UUID is unknown locally"
    );
    candidate.state.zenWorkspace = unknown;
    Assert.equal(
      SessionStore.getClosedTabData(win)[0].state.zenWorkspace,
      unknown,
      "Actual consumer history sees the unresolved owner"
    );
    await task(win, candidate, owner);
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
        ...saved
      );
      SessionStore.lastClosedActions.splice(
        0,
        SessionStore.lastClosedActions.length,
        ...actions
      );
      Assert.deepEqual(
        SessionStore.getCurrentState(true)._closedWindows,
        snapshot,
        "Original closed-window metadata restored before fixture close"
      );
    } finally {
      try {
        if (win && !win.closed) {
          await BrowserTestUtils.closeWindow(win);
        }
      } finally {
        gBrowser.selectedTab = selected;
        for (const tab of Array.from(gBrowser.tabs)) {
          if (!originalTabs.has(tab)) {
            BrowserTestUtils.removeTab(tab);
          }
        }
      }
    }
  }
}

add_task(async function test_middle_click_refusal_preserves_selected_group() {
  await withClosedTabUIFixture(async (win, candidate, owner) => {
    const browser = win.gBrowser;
    const selected = await BrowserTestUtils.openNewForegroundTab(
      browser,
      "about:robots"
    );
    const group = browser.addTabGroup([selected], { insertBefore: selected });
    const tail = await BrowserTestUtils.openNewForegroundTab(
      browser,
      "about:mozilla"
    );
    browser.moveTabToEnd(tail);
    browser.selectedTab = selected;
    Assert.equal(
      selected.group,
      group,
      "Surviving selected local tab is grouped"
    );
    Assert.notEqual(
      browser.tabs.at(-1),
      selected,
      "Surviving selected tab is not last"
    );
    const host = win.document.createXULElement("vbox");
    win.document.documentElement.appendChild(host);
    try {
      host.appendChild(
        RecentlyClosedTabsAndWindowsMenuUtils.getTabsFragment(
          win,
          "toolbarbutton"
        )
      );
      const entry = host.querySelector(
        'toolbarbutton[source-window-id][value="0"]'
      );
      Assert.ok(
        entry,
        "Real History fragment creates the registered middle-click entry"
      );
      const tabs = Array.from(browser.tabs);
      const document =
        selected.linkedBrowser.browsingContext.currentWindowGlobal;
      const history = tabs.map(
        tab => JSON.parse(SessionStore.getTabState(tab)).entries
      );
      const closed = SessionStore.getClosedTabData(win);
      const actions = structuredClone(SessionStore.lastClosedActions);
      entry.dispatchEvent(
        new win.MouseEvent("click", { button: 1, bubbles: true, view: win })
      );
      Assert.deepEqual(
        Array.from(browser.tabs),
        tabs,
        "Rejected History middle click preserves exact tab order and identities"
      );
      Assert.equal(
        selected.group,
        group,
        "Rejected History middle click preserves selected tab group"
      );
      Assert.equal(
        browser.selectedTab,
        selected,
        "Rejected History middle click preserves selection"
      );
      Assert.equal(
        selected.linkedBrowser.browsingContext.currentWindowGlobal,
        document,
        "Rejected middle click preserves the loaded document"
      );
      Assert.deepEqual(
        tabs.map(tab => JSON.parse(SessionStore.getTabState(tab)).entries),
        history,
        "Rejected middle click preserves surviving histories"
      );
      Assert.deepEqual(
        SessionStore.getClosedTabData(win),
        closed,
        "Rejected middle click preserves the actual closed record"
      );
      Assert.deepEqual(
        SessionStore.lastClosedActions,
        actions,
        "Rejected middle click preserves closed actions"
      );
      candidate.state.zenWorkspace = owner;
      entry.dispatchEvent(
        new win.MouseEvent("click", { button: 1, bubbles: true, view: win })
      );
      const restored = browser.selectedTab;
      Assert.ok(
        !tabs.includes(restored),
        "Known local middle click selects a genuinely restored tab"
      );
      await promiseTabRestored(restored);
      await TabStateFlusher.flush(restored.linkedBrowser);
      Assert.equal(
        browser.tabs.at(-1),
        restored,
        "Successful middle click moves the restored tab to the end"
      );
      Assert.equal(
        selected.group,
        group,
        "Successful middle click leaves the previous selected tab grouped"
      );
      Assert.ok(
        browser.tabs.indexOf(selected) < browser.tabs.indexOf(tail),
        "Successful middle click does not move the previous selected tab"
      );
      Assert.deepEqual(
        JSON.parse(SessionStore.getTabState(restored)).entries.map(
          entry => entry.url
        ),
        ["about:robots", "about:mozilla"],
        "Known local middle click restores actual two-entry history"
      );
    } finally {
      host.remove();
    }
  });
});

add_task(async function test_ui_refusal_preserves_loaded_blank() {
  await withClosedTabUIFixture(async (win, candidate, owner) => {
    const browser = win.gBrowser;
    const blank = await BrowserTestUtils.openNewForegroundTab(
      browser,
      "about:blank"
    );
    for (const tab of Array.from(browser.tabs)) {
      if (tab != blank) {
        BrowserTestUtils.removeTab(tab);
      }
    }
    await TabStateFlusher.flush(blank.linkedBrowser);
    Assert.equal(
      browser.visibleTabs.length,
      1,
      "The real blank is the only visible tab"
    );
    Assert.ok(
      !blank.hasAttribute("zen-empty-tab") && blank.isEmpty,
      "Loaded ordinary blank meets the UI removal condition"
    );
    const document = blank.linkedBrowser.browsingContext.currentWindowGlobal;
    const before = SessionStore.getClosedTabData(win);
    const actions = structuredClone(SessionStore.lastClosedActions);
    Assert.equal(
      SessionWindowUI.undoCloseTab(win, 0),
      undefined,
      "Normal UI undo propagates refusal"
    );
    Assert.ok(
      blank.isConnected && browser.tabs.includes(blank),
      "Rejected UI undo preserves the original blank tab identity"
    );
    Assert.equal(
      browser.selectedTab,
      blank,
      "Refusal preserves original blank selection"
    );
    Assert.equal(
      blank.linkedBrowser.browsingContext.currentWindowGlobal,
      document,
      "Refusal preserves the loaded document"
    );
    Assert.deepEqual(
      SessionStore.getClosedTabData(win),
      before,
      "Refusal preserves actual closed history"
    );
    Assert.deepEqual(
      SessionStore.lastClosedActions,
      actions,
      "Refusal preserves closed actions"
    );
    candidate.state.zenWorkspace = owner;
    const restored = SessionWindowUI.undoCloseTab(win, 0);
    await promiseTabRestored(restored);
    await TabStateFlusher.flush(restored.linkedBrowser);
    Assert.ok(
      !blank.isConnected,
      "Successful UI undo still removes its unnecessary blank"
    );
    Assert.equal(
      browser.selectedTab,
      restored,
      "Successful UI undo selects the returned tab"
    );
    Assert.deepEqual(
      JSON.parse(SessionStore.getTabState(restored)).entries.map(
        entry => entry.url
      ),
      ["about:robots", "about:mozilla"],
      "Successful UI undo restores real two-entry history"
    );
  });
});
