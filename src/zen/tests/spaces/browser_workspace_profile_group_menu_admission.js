/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_live_group_menu_refusal_and_loaded_controls() {
  const { CustomizableUITestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/CustomizableUITestUtils.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.sessionstore.restore_on_demand", true],
      ["browser.tabs.groups.enabled", true],
      ["browser.tabs.groups.alternateMenu", true],
      ["zen.window-sync.prefer-unsynced-windows", false],
    ],
  });
  const dest = gZenWindowSync.firstSyncedWindow;
  const selected = dest.gBrowser.selectedTab;
  const originalTabs = new Set(dest.gBrowser.tabs);
  const closedWindows = structuredClone(SessionStore.getClosedWindowData());
  const actions = structuredClone(SessionStore.lastClosedActions);
  const live = SessionStore.getCurrentState(true).windows.find(data =>
    data.tabs.some(tab => tab.zenSyncId === selected.id)
  );
  const metadata = structuredClone(
    SessionStore.getWindowState(dest).windows[0]
  );
  const restoreMetadata = () => {
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
    live._closedTabs.splice(
      0,
      live._closedTabs.length,
      ...metadata._closedTabs
    );
    live.closedGroups.splice(
      0,
      live.closedGroups.length,
      ...metadata.closedGroups
    );
    live.lastClosedTabGroupId = metadata.lastClosedTabGroupId;
    live._lastClosedTabGroupCount = metadata._lastClosedTabGroupCount;
  };
  let source;
  let group;
  let groupFlags;
  const menu = dest.document.getElementById("open-tab-group-context-menu");
  const ui = new CustomizableUITestUtils(dest);
  try {
    await BrowserTestUtils.openNewForegroundTab(
      dest.gBrowser,
      "about:blank#menu-target"
    );
    for (const mode of ["pending", "loaded", "local-loaded"]) {
      source = await BrowserTestUtils.openNewBrowserWindow({
        zenSyncedWindow: false,
      });
      await source.gZenWorkspaces.promiseInitialized;
      const sourceSpace = source.gZenWorkspaces.getWorkspaceFromId(
        source.gZenWorkspaces.activeWorkspace
      );
      const destSpace = dest.gZenWorkspaces.getWorkspaceFromId(
        dest.gZenWorkspaces.activeWorkspace
      );
      for (const space of [sourceSpace, destSpace]) {
        const owner = Cc["@mozilla.org/file/local;1"].createInstance(
          Ci.nsIFile
        );
        owner.persistentDescriptor =
          space.geckoProfileReference.persistentDescriptor;
        Assert.ok(
          owner.equals(Services.dirsvc.get("ProfD", Ci.nsIFile)),
          "Real catalog owner is this ProfD"
        );
      }
      Assert.ok(
        !source.gZenWorkspaces.currentWindowIsSyncing &&
          dest.gZenWorkspaces.currentWindowIsSyncing,
        "Normal unsynced source and actual synced target"
      );
      Assert.ok(
        !dest.gZenWorkspaces.getWorkspaceFromId(sourceSpace.uuid),
        "Natural temporary UUID is absent at destination"
      );
      const keeper = await BrowserTestUtils.openNewForegroundTab(
        source.gBrowser,
        "about:blank#menu-keeper"
      );
      for (const tab of [...source.gBrowser.tabs]) {
        if (tab !== keeper) {
          BrowserTestUtils.removeTab(tab);
        }
      }
      const first = await BrowserTestUtils.openNewForegroundTab(
        source.gBrowser,
        "about:mozilla"
      );
      const url =
        mode === "local-loaded" ? "about:robots" : "https://example.com/";
      await BrowserTestUtils.loadURIString({
        browser: first.linkedBrowser,
        uriString: url,
      });
      const second = await BrowserTestUtils.openNewForegroundTab(
        source.gBrowser,
        "about:blank#menu-second"
      );
      group = source.gBrowser.addTabGroup([first, second], {
        label: "Live menu " + mode,
        insertBefore: first,
      });
      source.gBrowser.selectedTab = keeper;
      await TabStateFlusher.flush(first.linkedBrowser);
      await TabStateFlusher.flush(second.linkedBrowser);
      if (mode === "pending") {
        await source.gBrowser.prepareDiscardBrowser(first);
        Assert.ok(
          source.gBrowser.discardBrowser(first, true),
          "Real background remote discard"
        );
        Assert.ok(
          first.hasAttribute("pending"),
          "First member really is pending"
        );
      }
      SessionStore.setCustomTabValue(first, "menu-owner", mode);
      const states = [first, second].map(tab =>
        JSON.parse(SessionStore.getTabState(tab))
      );
      Assert.equal(
        states[0].zenWorkspace,
        sourceSpace.uuid,
        "Real source binding without UUID injection"
      );
      const members = [...group.tabs];
      const sourceTabs = [...source.gBrowser.tabs];
      const destTabs = [...dest.gBrowser.tabs];
      const destGroups = [...dest.gBrowser.tabGroups];
      const destSelection = dest.gBrowser.selectedTab;
      groupFlags = Object.getOwnPropertyDescriptors(group);
      const flags = {
        removed: group.removedByAdoption,
        save: group.saveOnWindowClose,
      };
      const attributes = [group, first, second].map(node =>
        [...node.attributes].map(attr => [attr.name, attr.value])
      );
      await ui.openMainMenu();
      const view = dest.PanelMultiView.getViewNode(
        dest.document,
        "appMenu-tabGroupsListView"
      );
      const shown = BrowserTestUtils.waitForEvent(view, "ViewShown");
      dest.PanelMultiView.getViewNode(
        dest.document,
        "appMenu-tab-groups-button"
      ).click();
      await shown;
      await view.querySelector("tab-groups-list").updateComplete;
      const row = view.querySelector(
        `[data-tab-group-id="${group.id}"]:not([data-saved])`
      );
      Assert.ok(
        row,
        "Actual TabGroupsList lists the normal unsynced live group"
      );
      Assert.strictEqual(
        dest.gBrowser.getTabGroupById(group.id),
        group,
        "Lookup returns source-owned real group"
      );
      const menuShown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
      EventUtils.synthesizeMouseAtCenter(
        row.querySelector(".tab-group-row-label"),
        { type: "contextmenu", button: 2 },
        dest
      );
      await menuShown;
      Assert.equal(
        menu.triggerNode.closest("[data-tab-group-id]").dataset.tabGroupId,
        group.id,
        "Registered contextmenu sets real descendant trigger ownership"
      );
      const command = menu.querySelector(
        "#open-tab-group-context-menu_moveToThisWindow"
      );
      Assert.ok(
        !command.disabled,
        "Normal menu enables Move Group to This Window"
      );
      Assert.strictEqual(
        source.gBrowser.selectedTab,
        keeper,
        "Listing and contextmenu do not select source pending member"
      );
      if (mode === "pending") {
        Assert.ok(
          first.hasAttribute("pending"),
          "Actual menu leaves first member pending before command"
        );
        Assert.deepEqual(
          [first, second].map(tab => JSON.parse(SessionStore.getTabState(tab))),
          states,
          "No-op full member state reads are stable through menu opening"
        );
      }
      const errors = [];
      const onError = event => {
        errors.push(event.message);
        event.preventDefault();
      };
      const effects = [];
      const onEffect = event => effects.push(event.type);
      const created = [];
      const onCreated = event => created.push(event.target);
      for (const name of ["TabSelect", "TabClose", "TabMove", "TabUngrouped"]) {
        source.addEventListener(name, onEffect);
      }
      dest.addEventListener("error", onError);
      dest.gBrowser.tabContainer.addEventListener("TabGroupCreate", onCreated);
      try {
        const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
        menu.activateItem(command);
        await hidden;
        await TestUtils.waitForTick();
      } finally {
        dest.removeEventListener("error", onError);
        dest.gBrowser.tabContainer.removeEventListener(
          "TabGroupCreate",
          onCreated
        );
        for (const name of [
          "TabSelect",
          "TabClose",
          "TabMove",
          "TabUngrouped",
        ]) {
          source.removeEventListener(name, onEffect);
        }
      }
      info(
        "MENU_CONSUMER " +
          JSON.stringify({
            mode,
            errors,
            effects,
            created: created.map(item => item.id),
            pending: first.hasAttribute("pending"),
            sourceClosed: source.closed,
          })
      );
      Assert.deepEqual(
        errors,
        [],
        "Real registered Move Group command must not dereference refused null"
      );
      if (mode === "pending") {
        Assert.ok(!source.closed, "Refusal does not close source window");
        Assert.strictEqual(
          first.group,
          group,
          "Refusal preserves actual source group"
        );
        Assert.deepEqual(
          [...group.tabs],
          members,
          "Refusal preserves member identities and order"
        );
        Assert.deepEqual(
          [...source.gBrowser.tabs],
          sourceTabs,
          "Refusal preserves source survivor and all tabs"
        );
        Assert.strictEqual(
          source.gBrowser.selectedTab,
          keeper,
          "Refusal does not select pending or move survivor"
        );
        Assert.strictEqual(
          dest.gBrowser.selectedTab,
          destSelection,
          "Refusal preserves target selection"
        );
        Assert.strictEqual(
          group.removedByAdoption,
          flags.removed,
          "Refusal preserves source adoption flag"
        );
        Assert.strictEqual(
          group.saveOnWindowClose,
          flags.save,
          "Refusal preserves source save flag"
        );
        Assert.deepEqual(
          [group, first, second].map(node =>
            [...node.attributes].map(attr => [attr.name, attr.value])
          ),
          attributes,
          "Refusal preserves group and frame attributes"
        );
        Assert.deepEqual(
          [first, second].map(tab => JSON.parse(SessionStore.getTabState(tab))),
          states,
          "Refusal preserves complete member history and custom values"
        );
        Assert.deepEqual(
          [...dest.gBrowser.tabs],
          destTabs,
          "No partial target tabs"
        );
        Assert.deepEqual(
          [...dest.gBrowser.tabGroups],
          destGroups,
          "No partial target groups"
        );
        Assert.deepEqual(
          effects,
          [],
          "Refusal emits no source select/delete/move/ungroup effects"
        );
        Assert.deepEqual(created, [], "Refusal does not claim a new group");
      } else {
        const adopted = created.find(item => item.id === group.id);
        Assert.ok(
          adopted &&
            adopted !== group &&
            adopted.ownerDocument === dest.document,
          "Actual adoption creates the returned target-owned group, not fake source success"
        );
        Assert.strictEqual(
          dest.gBrowser.selectedTab,
          adopted.tabs[0],
          "Caller selects actual adopted group's first member"
        );
        Assert.equal(adopted.tabs.length, 2, "Both actual members transferred");
        Assert.equal(
          SessionStore.getCustomTabValue(adopted.tabs[0], "menu-owner"),
          mode,
          "Actual transferred member retains custom value"
        );
        Assert.equal(
          await SpecialPowers.spawn(
            adopted.tabs[0].linkedBrowser,
            [],
            () => content.document.documentURI
          ),
          url,
          "Success transfers actual document"
        );
        const loaded = BrowserTestUtils.browserLoaded(
          adopted.tabs[0].linkedBrowser,
          false,
          "about:mozilla"
        );
        adopted.tabs[0].linkedBrowser.goBack();
        await loaded;
        Assert.equal(
          await SpecialPowers.spawn(
            adopted.tabs[0].linkedBrowser,
            [],
            () => content.document.documentURI
          ),
          "about:mozilla",
          "Success retains actual native back history"
        );
        Assert.ok(
          !first.isConnected &&
            !second.isConnected &&
            keeper.isConnected &&
            !source.closed,
          "Success moves members but leaves source survivor/window"
        );
      }
      if (dest.PanelUI.panel.state === "open") {
        await ui.hideMainMenu();
      }
      try {
        for (const key of ["removedByAdoption", "saveOnWindowClose"]) {
          if (groupFlags[key]) {
            Object.defineProperty(group, key, groupFlags[key]);
          } else {
            delete group[key];
          }
        }
        restoreMetadata();
      } finally {
        await BrowserTestUtils.closeWindow(source);
        source = null;
      }
    }
  } finally {
    try {
      menu.hidePopup();
      if (dest.PanelUI.panel.state === "open") {
        await ui.hideMainMenu();
      }
      if (group && groupFlags) {
        for (const key of ["removedByAdoption", "saveOnWindowClose"]) {
          if (groupFlags[key]) {
            Object.defineProperty(group, key, groupFlags[key]);
          } else {
            delete group[key];
          }
        }
      }
      restoreMetadata();
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
          dest.gBrowser.selectedTab = selected;
        } finally {
          restoreMetadata();
          await SpecialPowers.popPrefEnv();
        }
      }
    }
  }
});
