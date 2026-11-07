/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_group_label_drop_refusal_and_loaded_controls() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.sessionstore.restore_on_demand", true],
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
  let dragSession;
  try {
    const target = await BrowserTestUtils.openNewForegroundTab(
      dest.gBrowser,
      "about:blank#group-drop"
    );
    for (const mode of ["pending", "loaded", "selected-loaded"]) {
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
      const profile = Services.dirsvc.get("ProfD", Ci.nsIFile);
      for (const space of [sourceSpace, destSpace]) {
        const owner = Cc["@mozilla.org/file/local;1"].createInstance(
          Ci.nsIFile
        );
        owner.persistentDescriptor =
          space.geckoProfileReference.persistentDescriptor;
        Assert.ok(
          owner.equals(profile),
          "Actual catalog owner equals this ProfD"
        );
      }
      Assert.ok(
        !source.gZenWorkspaces.currentWindowIsSyncing &&
          dest.gZenWorkspaces.currentWindowIsSyncing,
        "Normal unsynced to synced route"
      );
      Assert.ok(
        !dest.gZenWorkspaces.getWorkspaceFromId(sourceSpace.uuid),
        "Natural temporary source UUID is absent at target"
      );
      const keeper = await BrowserTestUtils.openNewForegroundTab(
        source.gBrowser,
        "about:blank#group-keeper"
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
      await BrowserTestUtils.loadURIString({
        browser: first.linkedBrowser,
        uriString: "https://example.com/",
      });
      const second = await BrowserTestUtils.openNewForegroundTab(
        source.gBrowser,
        "about:blank#second-member"
      );
      group = source.gBrowser.addTabGroup([first, second], {
        label: "Normal group drop",
        insertBefore: first,
      });
      Assert.ok(
        source.gBrowser.isTabGroupLabel(group.labelElement),
        "Real native group label producer"
      );
      Assert.ok(
        !group.hasAttribute("split-view-group"),
        "Not a fabricated split wrapper"
      );
      source.gBrowser.selectedTab = mode === "selected-loaded" ? first : keeper;
      await TabStateFlusher.flush(first.linkedBrowser);
      if (mode === "pending") {
        await source.gBrowser.prepareDiscardBrowser(first);
        Assert.ok(
          source.gBrowser.discardBrowser(first, true),
          "Normal background remote unload"
        );
        Assert.ok(
          first.hasAttribute("pending"),
          "First member is genuinely pending"
        );
      }
      SessionStore.setCustomTabValue(first, "s1-owner", mode);
      const before = JSON.parse(SessionStore.getTabState(first));
      groupFlags = Object.getOwnPropertyDescriptors(group);
      const flags = {
        removed: group.removedByAdoption,
        save: group.saveOnWindowClose,
      };
      const members = [...group.tabs];
      const sourceSelection = source.gBrowser.selectedTab;
      const destTabs = [...dest.gBrowser.tabs];
      Assert.equal(
        before.zenWorkspace,
        sourceSpace.uuid,
        "Actual producer binding, no UUID injection"
      );
      if (mode === "pending") {
        Assert.deepEqual(
          JSON.parse(SessionStore.getTabState(first)),
          before,
          "No-op full-state reads are stable"
        );
      }
      EventUtils.startDragSession(source, "move");
      dragSession = source.windowUtils.dragSession;
      const [result, dt] = EventUtils.synthesizeDragOver(
        group.labelElement,
        target,
        null,
        "move",
        source,
        dest
      );
      Assert.ok(
        group.labelElement._dragData,
        "Real registered dragstart produced drag metadata"
      );
      const handler = dest.gBrowser.tabContainer.tabDragAndDrop;
      const event = {
        dataTransfer: dt,
        target,
        screenX: target.screenX + 2,
        screenY: target.screenY + 2,
        stopPropagation() {},
      };
      Assert.equal(
        handler.getDropEffectForTabDrag(event),
        "move",
        "Normal cross-window producer is admitted"
      );
      let exception = null;
      try {
        handler.handle_drop(event);
      } catch (error) {
        exception = String(error);
      }
      dragSession.endDragSession(true);
      dragSession = null;
      info(
        "S1_CONSUMER " +
          JSON.stringify({
            mode,
            result,
            exception,
            sourceSpace: sourceSpace.uuid,
            sourceConnected: first.isConnected,
            removed: group.removedByAdoption,
            save: group.saveOnWindowClose,
            selected: source.gBrowser.selectedTab?.id,
          })
      );
      Assert.equal(
        exception,
        null,
        "Registered group-label drop must not dereference null"
      );
      if (mode === "pending") {
        Assert.strictEqual(
          first.group,
          group,
          "Refused source retains actual group identity"
        );
        Assert.deepEqual(
          [...group.tabs],
          members,
          "Refused source retains exact member identities/order"
        );
        Assert.strictEqual(
          group.removedByAdoption,
          flags.removed,
          "Refused source restores exact adoption flag"
        );
        Assert.strictEqual(
          group.saveOnWindowClose,
          flags.save,
          "Refused source restores save-on-close flag"
        );
        Assert.strictEqual(
          source.gBrowser.selectedTab,
          sourceSelection,
          "Background refusal preserves keeper selection"
        );
        Assert.deepEqual(
          JSON.parse(SessionStore.getTabState(first)),
          before,
          "Refusal preserves complete pending state/custom values"
        );
        Assert.deepEqual(
          [...dest.gBrowser.tabs],
          destTabs,
          "First refusal creates no partial target tabs/group"
        );
        Assert.ok(
          !group.collapsedByDrag && !group.collapsed,
          "Refused group is visible after drag settlement"
        );
        Assert.equal(
          SessionStore.getCustomTabValue(first, "s1-owner"),
          mode,
          "Custom values stay at source"
        );
      } else {
        const moved = [...dest.gBrowser.tabs].find(
          tab =>
            !destTabs.includes(tab) &&
            SessionStore.getCustomTabValue(tab, "s1-owner") === mode
        );
        Assert.ok(moved, "Normal loaded/local group adoption succeeds");
        if (moved) {
          Assert.equal(
            await SpecialPowers.spawn(
              moved.linkedBrowser,
              [],
              () => content.document.documentURI
            ),
            "https://example.com/",
            "Loaded positive transfers actual document"
          );
          const loaded = BrowserTestUtils.browserLoaded(
            moved.linkedBrowser,
            false,
            "about:mozilla"
          );
          moved.linkedBrowser.goBack();
          await loaded;
          Assert.equal(
            moved.linkedBrowser.currentURI.spec,
            "about:mozilla",
            "Loaded positive retains native history"
          );
          Assert.equal(
            moved.group.tabs.length,
            2,
            "Both actual members land in a target group"
          );
        }
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
      for (const tab of [...dest.gBrowser.tabs]) {
        if (!originalTabs.has(tab) && tab !== target) {
          BrowserTestUtils.removeTab(tab);
        }
      }
    }
  } finally {
    try {
      dragSession?.endDragSession(true);
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

add_task(async function test_native_factory_and_split_refusal_consumers() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.sessionstore.restore_on_demand", true],
      ["browser.tabs.splitview.hasUsed", true],
      ["zen.window-sync.prefer-unsynced-windows", false],
    ],
  });
  const dest = gZenWindowSync.firstSyncedWindow;
  const originalTabs = new Set(dest.gBrowser.tabs);
  const originalGroups = new Set(dest.gBrowser.tabGroups);
  const originalSplits = new Set(
    dest.gBrowser.tabContainer.querySelectorAll("tab-split-view-wrapper")
  );
  const selected = dest.gBrowser.selectedTab;
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
  let first;
  let removed;
  let wrapper;
  let wrapperRemoved;
  let wrapperSave;
  try {
    for (const route of [
      "adopt-group",
      "adopt-split",
      "group-factory",
      "split-factory",
    ]) {
      for (const pending of [true, false, "late"]) {
        source = await BrowserTestUtils.openNewBrowserWindow({
          zenSyncedWindow: false,
        });
        await source.gZenWorkspaces.promiseInitialized;
        const keeper = await BrowserTestUtils.openNewForegroundTab(
          source.gBrowser,
          "about:blank#native-keeper"
        );
        first = await BrowserTestUtils.openNewForegroundTab(
          source.gBrowser,
          "about:mozilla"
        );
        await BrowserTestUtils.loadURIString({
          browser: first.linkedBrowser,
          uriString: "https://example.com/",
        });
        const second = await BrowserTestUtils.openNewForegroundTab(
          source.gBrowser,
          "about:blank#native-member"
        );
        source.gBrowser.selectedTab = keeper;
        wrapper = null;
        if (route === "adopt-group") {
          wrapper = source.gBrowser.addTabGroup([first, second], {
            insertBefore: first,
          });
        }
        if (route === "adopt-split") {
          wrapper = source.gBrowser.addTabSplitView([first, second], {
            insertBefore: first,
          });
          Assert.ok(
            source.gBrowser.isSplitViewWrapper(wrapper),
            "Actual native split factory, not a fake group attribute"
          );
          Assert.deepEqual(
            [...wrapper.tabs],
            [first, second],
            "Actual native wrapper contains its produced members"
          );
        }
        await TabStateFlusher.flush(first.linkedBrowser);
        if (pending === true) {
          await source.gBrowser.prepareDiscardBrowser(first);
          Assert.ok(
            source.gBrowser.discardBrowser(first, true),
            "Native consumer receives normally unloaded background source"
          );
        } else if (pending === "late") {
          await source.gBrowser.prepareDiscardBrowser(first);
        }
        SessionStore.setCustomTabValue(first, "native-owner", route);
        SessionStore.setCustomTabValue(first, "native-extra", "original-extra");
        const before = JSON.parse(SessionStore.getTabState(first));
        const originalCustomData = Object.freeze(
          structuredClone(before.extData)
        );
        let pendingSnapshot = null;
        if (pending === "late") {
          Assert.ok(
            !first.hasAttribute("pending"),
            "Prepared source is still loaded"
          );
        }
        wrapperRemoved =
          wrapper &&
          Object.getOwnPropertyDescriptor(wrapper, "removedByAdoption");
        wrapperSave = wrapper?.saveOnWindowClose;
        removed = Object.getOwnPropertyDescriptor(first, "removedByAdoption");
        const destTabs = [...dest.gBrowser.tabs];
        const destGroups = [...dest.gBrowser.tabGroups];
        const destSplits = [
          ...dest.gBrowser.tabContainer.querySelectorAll(
            "tab-split-view-wrapper"
          ),
        ];
        let result = null;
        let exception = null;
        let lateDiscards = 0;
        const onOpen = event => {
          if (event.detail?.adoptedTab !== first) return;
          if (pending === "late" || pending === false) {
            Assert.equal(
              SessionStore.getCustomTabValue(first, "native-owner"),
              "",
              "Real TabOpen already moved the source custom map"
            );
            Assert.deepEqual(
              JSON.parse(SessionStore.getTabState(event.target)).extData,
              originalCustomData,
              "Real TabOpen transfers the full original map to its actual target"
            );
            SessionStore.setCustomTabValue(
              event.target,
              "native-owner",
              route + "-target"
            );
            SessionStore.setCustomTabValue(
              event.target,
              "native-target",
              "new-target-value"
            );
          }
          if (pending === "late") {
            Assert.ok(
              source.gBrowser.discardBrowser(first, true),
              "Controlled TabOpen schedule uses real discard, not an injected pending flag"
            );
            pendingSnapshot = JSON.parse(SessionStore.getTabState(first));
            Assert.ok(
              first.hasAttribute("pending"),
              "Real discard makes source pending before recheck"
            );
            info(
              "R3_FIRST_EFFECT " +
                JSON.stringify({
                  route,
                  originalCustomData,
                  pendingCustomData: pendingSnapshot.extData || null,
                })
            );
            lateDiscards++;
          }
        };
        dest.gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
        try {
          result =
            route === "adopt-group"
              ? dest.gBrowser.adoptTabGroup(wrapper, {
                  tabIndex: dest.gBrowser.tabs.length,
                })
              : route === "adopt-split"
                ? dest.gBrowser.adoptSplitView(wrapper, {
                    tabIndex: dest.gBrowser.tabs.length,
                  })
                : route === "group-factory"
                  ? dest.gBrowser.addTabGroup([first, second], {
                      insertBefore: dest.gBrowser.tabs.at(-1),
                    })
                  : dest.gBrowser.addTabSplitView([first, second], {
                      insertBefore: dest.gBrowser.tabs.at(-1),
                    });
        } catch (error) {
          exception = String(error);
        } finally {
          dest.gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
        }
        if (pending === "late")
          Assert.equal(
            lateDiscards,
            1,
            "Real member return reached recheck once after preflight"
          );
        info(
          "NATIVE_CONSUMER " +
            JSON.stringify({
              route,
              pending,
              exception,
              success: !!result,
              sourceConnected: first.isConnected,
              removed: first.removedByAdoption,
              targetGroups: dest.gBrowser.tabGroups.length,
              targetSplits: dest.gBrowser.tabContainer.querySelectorAll(
                "tab-split-view-wrapper"
              ).length,
            })
        );
        Assert.equal(
          exception,
          null,
          "Actual native dependent consumer must not dereference refusal"
        );
        if (pending) {
          Assert.equal(
            result,
            null,
            "Actual native consumer propagates explicit refusal"
          );
          Assert.ok(
            first.isConnected && !first.closing,
            "Native refusal preserves actual source"
          );
          Assert.strictEqual(
            source.gBrowser.selectedTab,
            keeper,
            "Native refusal preserves background keeper selection"
          );
          Assert.deepEqual(
            JSON.parse(SessionStore.getTabState(first)),
            pendingSnapshot
              ? { ...pendingSnapshot, extData: originalCustomData }
              : before,
            "Native refusal preserves full pending state"
          );
          Assert.equal(
            SessionStore.getCustomTabValue(first, "native-owner"),
            route,
            "Native refusal restores original pre-TabOpen sentinel"
          );
          Assert.deepEqual(
            JSON.parse(SessionStore.getTabState(first)).extData,
            originalCustomData,
            "Native refusal preserves immutable original full custom map"
          );
          Assert.deepEqual(
            Object.getOwnPropertyDescriptor(first, "removedByAdoption"),
            removed,
            "Native refusal preserves exact source adoption flag"
          );
          Assert.deepEqual(
            [...dest.gBrowser.tabs],
            destTabs,
            "Native first-refusal has no partial target tabs"
          );
          Assert.deepEqual(
            [...dest.gBrowser.tabGroups],
            destGroups,
            "Native first-refusal cleans partial group factory"
          );
          Assert.deepEqual(
            [
              ...dest.gBrowser.tabContainer.querySelectorAll(
                "tab-split-view-wrapper"
              ),
            ],
            destSplits,
            "Native first-refusal cleans partial split factory"
          );
          if (wrapper) {
            Assert.deepEqual(
              [...wrapper.tabs],
              [first, second],
              "Refused native wrapper retains exact members"
            );
            Assert.deepEqual(
              Object.getOwnPropertyDescriptor(wrapper, "removedByAdoption"),
              wrapperRemoved,
              "Refused group/wrapper preserves exact adoption flag"
            );
            Assert.strictEqual(
              wrapper.saveOnWindowClose,
              wrapperSave,
              "Refused group preserves save-on-close flag after member recheck"
            );
          }
        } else {
          Assert.ok(
            result,
            "Actual native consumer still supports loaded local source"
          );
          if (result) {
            const moved = result.tabs[0];
            Assert.equal(
              await SpecialPowers.spawn(
                moved.linkedBrowser,
                [],
                () => content.document.documentURI
              ),
              "https://example.com/",
              "Native positive transfers real document"
            );
            Assert.equal(
              SessionStore.getCustomTabValue(moved, "native-owner"),
              route + "-target",
              "Loaded success retains a legitimate TabOpen target update"
            );
            Assert.equal(
              SessionStore.getCustomTabValue(moved, "native-extra"),
              "original-extra",
              "Loaded success retains the other original custom value"
            );
            Assert.equal(
              SessionStore.getCustomTabValue(moved, "native-target"),
              "new-target-value",
              "Loaded success retains a new TabOpen target key"
            );
            const back = BrowserTestUtils.browserLoaded(
              moved.linkedBrowser,
              false,
              "about:mozilla"
            );
            moved.linkedBrowser.goBack();
            await back;
            Assert.equal(
              moved.linkedBrowser.currentURI.spec,
              "about:mozilla",
              "Native loaded control retains actual back history"
            );
            const forward = BrowserTestUtils.browserLoaded(
              moved.linkedBrowser,
              false,
              "https://example.com/"
            );
            moved.linkedBrowser.goForward();
            await forward;
            Assert.equal(
              await SpecialPowers.spawn(
                moved.linkedBrowser,
                [],
                () => content.document.documentURI
              ),
              "https://example.com/",
              "Native loaded control retains actual forward document"
            );
            Assert.equal(
              result.tabs.length,
              2,
              "Native positive retains both members"
            );
          }
        }
        try {
          if (wrapper) {
            if (wrapperRemoved)
              Object.defineProperty(
                wrapper,
                "removedByAdoption",
                wrapperRemoved
              );
            else delete wrapper.removedByAdoption;
            if (route === "adopt-group")
              wrapper.saveOnWindowClose = wrapperSave;
          }
          if (removed)
            Object.defineProperty(first, "removedByAdoption", removed);
          else delete first.removedByAdoption;
          restoreMetadata();
        } finally {
          await BrowserTestUtils.closeWindow(source);
          source = null;
        }
        for (const tab of [...dest.gBrowser.tabs]) {
          if (!originalTabs.has(tab)) BrowserTestUtils.removeTab(tab);
        }
        for (const wrapper of [
          ...dest.gBrowser.tabContainer.querySelectorAll(
            "tab-split-view-wrapper"
          ),
        ]) {
          if (!originalSplits.has(wrapper)) wrapper.remove();
        }
        for (const group of [...dest.gBrowser.tabGroups]) {
          if (!originalGroups.has(group)) group.remove();
        }
      }
    }
  } finally {
    try {
      if (wrapper) {
        if (wrapperRemoved)
          Object.defineProperty(wrapper, "removedByAdoption", wrapperRemoved);
        else delete wrapper.removedByAdoption;
        if (wrapperSave !== undefined) wrapper.saveOnWindowClose = wrapperSave;
      }
      if (first) {
        if (removed) Object.defineProperty(first, "removedByAdoption", removed);
        else delete first.removedByAdoption;
      }
      restoreMetadata();
    } finally {
      try {
        if (source && !source.closed)
          await BrowserTestUtils.closeWindow(source);
      } finally {
        try {
          for (const tab of [...dest.gBrowser.tabs]) {
            if (!originalTabs.has(tab)) BrowserTestUtils.removeTab(tab);
          }
          for (const wrapper of [
            ...dest.gBrowser.tabContainer.querySelectorAll(
              "tab-split-view-wrapper"
            ),
          ]) {
            if (!originalSplits.has(wrapper)) wrapper.remove();
          }
          for (const group of [...dest.gBrowser.tabGroups]) {
            if (!originalGroups.has(group)) group.remove();
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
