/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ZenSessionStore } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenSessionManager.sys.mjs"
);
const { BrowserWindowTracker } = ChromeUtils.importESModule(
  "resource:///modules/BrowserWindowTracker.sys.mjs"
);

async function rootWindowReady(win) {
  await TestUtils.waitForCondition(
    () => win.gBrowserInit?.delayedStartupFinished && win.gZenWorkspaces,
    "Normal owned window finishes delayed startup"
  );
  let ready = false;
  win.gZenWorkspaces.promiseInitialized.then(() => (ready = true));
  try {
    await TestUtils.waitForCondition(() => ready, "Space promise resolves");
  } catch {
    ok(false, "Normal owned window must complete its Space promise");
  }
  return ready;
}

add_task(async function test_normal_new_window_root_admission() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.window-sync.enabled", true],
      ["zen.window-sync.sync-only-pinned-tabs", false],
    ],
  });
  const primaryTabs = new Set(gBrowser.tabs);
  const primarySelected = gBrowser.selectedTab;
  const primarySpace = gZenWorkspaces.activeWorkspace;
  const initialSpaces = structuredClone(gZenWorkspaces.getWorkspaces());
  const initialGlobal = structuredClone(
    SessionStore.getCurrentState(true).global || {}
  );
  const key = "new-window-root-owned-global";
  const fixtures = [];
  const ownerReferences = [];
  const directory = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
  directory.append("new-window-root-owned-foreign");
  directory.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  const open = options => {
    const win = BrowserWindowTracker.openWindow({
      openerWindow: window,
      zenSyncedWindow: true,
      ...options,
    });
    fixtures.push(win);
    return win;
  };
  try {
    const owner = open();
    Assert.ok(await rootWindowReady(owner), "Owned source is ready");
    const first = owner.gZenWorkspaces.getWorkspaces()[0];
    const second = await owner.gZenWorkspaces.createAndSaveWorkspace(
      "Root admission owned second Space"
    );
    await owner.gZenWorkspaces.changeWorkspace(first);
    const historyTab = await BrowserTestUtils.openNewForegroundTab(
      owner.gBrowser,
      "about:license"
    );
    BrowserTestUtils.startLoadingURIString(
      historyTab.linkedBrowser,
      "about:mozilla"
    );
    await BrowserTestUtils.browserLoaded(
      historyTab.linkedBrowser,
      false,
      "about:mozilla"
    );
    await TabStateFlusher.flush(historyTab.linkedBrowser);
    await owner.gZenWorkspaces.changeWorkspace(second);
    const secondTab = await BrowserTestUtils.openNewForegroundTab(
      owner.gBrowser,
      "about:robots"
    );
    await TabStateFlusher.flush(secondTab.linkedBrowser);
    await owner.gZenWorkspaces.changeWorkspace(first);
    owner.gBrowser.selectedTab = historyTab;
    const history = JSON.parse(SessionStore.getTabState(historyTab));
    Assert.deepEqual(
      history.entries.map(entry => entry.url),
      ["about:license", "about:mozilla"],
      "Source has real two-document native history"
    );
    await ZenSessionStore.saveState(SessionStore.getCurrentState(true));
    for (const space of owner.gZenWorkspaces.getWorkspaces()) {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.persistentDescriptor =
        space.geckoProfileReference.persistentDescriptor;
      Assert.ok(
        file.equals(Services.dirsvc.get("ProfD", Ci.nsIFile)),
        "Actual ProfD owns normally saved Space"
      );
    }

    SessionStore.setCustomGlobalValue(key, "keep-local-root-global");
    const globalBeforePositive = structuredClone(
      SessionStore.getCurrentState(true).global
    );
    const sourceContext = historyTab.linkedBrowser.browsingContext;
    const positive = open();
    Assert.ok(
      await rootWindowReady(positive),
      "Normal local cloned window is ready"
    );
    is(
      SessionStore.getCustomGlobalValue(key),
      "keep-local-root-global",
      "Local new-window root preserves existing global sentinel"
    );
    is(
      JSON.stringify(SessionStore.getCurrentState(true).global),
      JSON.stringify(globalBeforePositive),
      "Local root preserves complete global state"
    );
    Assert.deepEqual(
      positive.gZenWorkspaces.getWorkspaces().map(space => space.uuid),
      owner.gZenWorkspaces.getWorkspaces().map(space => space.uuid),
      "Local root retains both Space IDs"
    );
    const cloned = Array.from(positive.gBrowser.tabs).find(
      tab => tab.getAttribute("id") === historyTab.getAttribute("id")
    );
    Assert.ok(cloned, "Local root restores actual history tab");
    positive.gBrowser.selectedTab = cloned;
    await SimpleTest.promiseFocus(positive);
    await TestUtils.waitForCondition(
      () =>
        cloned._zenContentsVisible &&
        cloned.linkedBrowser.browsingContext === sourceContext,
      "Normal synced selection completes the real docshell handoff"
    );
    await TestUtils.waitForCondition(
      () => cloned.linkedBrowser.currentURI.spec === "about:mozilla",
      "Local cloned document loads"
    );
    await TabStateFlusher.flush(cloned.linkedBrowser);
    Assert.deepEqual(
      JSON.parse(SessionStore.getTabState(cloned)).entries.map(
        entry => entry.url
      ),
      history.entries.map(entry => entry.url),
      "Local cloned native history is complete"
    );
    const loaded = BrowserTestUtils.waitForContentEvent(
      cloned.linkedBrowser,
      "pageshow",
      false,
      event => event.target.documentURI === "about:license"
    );
    cloned.linkedBrowser.goBack();
    await loaded;
    await TestUtils.waitForCondition(
      () =>
        cloned.linkedBrowser.currentURI.spec === "about:license" &&
        !cloned.linkedBrowser.isLoadingDocument,
      "Native back commits the original document"
    );
    Assert.equal(
      await SpecialPowers.spawn(
        cloned.linkedBrowser,
        [],
        () => content.document.documentURI
      ),
      "about:license",
      "Native back loads the original actual document"
    );
    await BrowserTestUtils.closeWindow(positive);
    fixtures.splice(fixtures.indexOf(positive), 1);

    for (const reference of [
      { version: 1, persistentDescriptor: directory.persistentDescriptor },
      {
        version: 2,
        persistentDescriptor: Services.dirsvc.get("ProfD", Ci.nsIFile)
          .persistentDescriptor,
      },
    ]) {
      await TabStateFlusher.flushWindow(owner);
      await TabStateFlusher.flushWindow(window);
      SessionStore.setCustomGlobalValue(key, "keep-local-root-global");
      const sources = [window, owner];
      const before = sources.map(win => ({
        win,
        tabs: Array.from(win.gBrowser.tabs),
        selected: win.gBrowser.selectedTab,
        active: win.gZenWorkspaces.activeWorkspace,
        spaces: structuredClone(win.gZenWorkspaces.getWorkspaces()),
      }));
      const original = structuredClone(SessionStore.getCurrentState(true));
      const actions = structuredClone(SessionStore.lastClosedActions);
      const saved = structuredClone(SessionStore.savedGroups);
      const sourceHistory = JSON.parse(
        SessionStore.getTabState(historyTab)
      ).entries;
      for (const win of sources) {
        const live = win.gZenWorkspaces.getWorkspaceFromId(first.uuid);
        Assert.strictEqual(
          live,
          win.gZenWorkspaces
            .getWorkspaces()
            .find(space => space.uuid === first.uuid),
          "Normal getter exposes existing live Space record"
        );
        ownerReferences.push([
          live,
          structuredClone(
            before
              .find(snapshot => snapshot.win === win)
              .spaces.find(space => space.uuid === first.uuid)
              .geckoProfileReference
          ),
        ]);
        live.geckoProfileReference = structuredClone(reference);
      }
      const candidate = structuredClone(SessionStore.getCurrentState(true));
      Assert.ok(
        !ZenSessionStore.canRestoreState(candidate),
        "Actual collected root rejects mutated existing owner"
      );
      const rejected = open();
      await rootWindowReady(rejected);
      is(
        SessionStore.getCustomGlobalValue(key),
        original.global[key],
        "Rejected actual root preserves original global before deferred effects"
      );
      Assert.deepEqual(
        SessionStore.getCurrentState(true).global,
        original.global,
        "Rejected root preserves complete original global"
      );
      Assert.deepEqual(
        SessionStore.getCurrentState(true)._closedWindows,
        original._closedWindows,
        "Rejected root preserves original closed records"
      );
      Assert.deepEqual(
        SessionStore.lastClosedActions,
        actions,
        "Rejected root preserves closed actions"
      );
      Assert.deepEqual(
        SessionStore.savedGroups,
        saved,
        "Rejected root preserves saved groups"
      );
      Assert.ok(
        !SessionStore.getCurrentState(true).deferredInitialState,
        "Rejected root leaves no pending deferred producer state"
      );
      for (const snapshot of before) {
        const candidateWindow = candidate.windows.find(win =>
          win.spaces?.some(space => space.uuid === first.uuid)
        );
        Assert.deepEqual(
          SessionStore.getWindowState(snapshot.win).windows[0].spaces,
          candidateWindow.spaces,
          "Rejected root preserves separately captured post-mutation catalog"
        );
      }
      for (const snapshot of before) {
        Assert.ok(
          snapshot.tabs.every(tab =>
            Array.from(snapshot.win.gBrowser.tabs).includes(tab)
          ),
          "Rejected root preserves every original source tab identity"
        );
        Assert.ok(
          Array.from(snapshot.win.gBrowser.tabs)
            .filter(tab => !snapshot.tabs.includes(tab))
            .every(tab => tab.linkedBrowser.currentURI.spec === "about:blank"),
          "Normal window opening may add only safe blank source tabs"
        );
        Assert.equal(
          snapshot.win.gBrowser.selectedTab,
          snapshot.selected,
          "Rejected root preserves original source selection"
        );
        Assert.equal(
          snapshot.win.gZenWorkspaces.activeWorkspace,
          snapshot.active,
          "Rejected root preserves original active Space"
        );
      }
      Assert.deepEqual(
        JSON.parse(SessionStore.getTabState(historyTab)).entries,
        sourceHistory,
        "Rejected root preserves original complete history"
      );
      if (rejected.gZenWorkspaces.getWorkspaces().length) {
        Assert.ok(
          rejected.gZenWorkspaces
            .getWorkspaces()
            .every(space =>
              ZenSessionStore.isLocalProfileReference(
                space.geckoProfileReference
              )
            ),
          "Already opened rejected window has only safe-local owners"
        );
      }
      Assert.ok(
        Array.from(rejected.gBrowser.tabs).every(
          tab =>
            !["about:mozilla", "about:license", "about:robots"].includes(
              tab.linkedBrowser.currentURI.spec
            )
        ),
        "Rejected root renders no source documents"
      );
      for (const [live, originalReference] of ownerReferences.splice(0)) {
        live.geckoProfileReference = originalReference;
      }
      for (const snapshot of before) {
        Assert.deepEqual(
          snapshot.win.gZenWorkspaces.getWorkspaces(),
          snapshot.spaces,
          "Original immutable owner metadata restored before fixture close"
        );
      }
      await BrowserTestUtils.closeWindow(rejected);
      fixtures.splice(fixtures.indexOf(rejected), 1);
    }

    for (const options of [{ zenSyncedWindow: false }, { private: true }]) {
      const fresh = open(options);
      Assert.ok(
        await rootWindowReady(fresh),
        "Normal fresh unsynced/private window stays ready"
      );
      Assert.ok(
        fresh.gZenWorkspaces
          .getWorkspaces()
          .every(space =>
            ZenSessionStore.isLocalProfileReference(space.geckoProfileReference)
          ),
        "Fresh catalog uses actual local ProfD"
      );
      Assert.ok(
        !fresh.gZenWorkspaces
          .getWorkspaces()
          .some(
            space => space.uuid === first.uuid || space.uuid === second.uuid
          ),
        "Fresh catalog does not reuse shared Space IDs"
      );
      await BrowserTestUtils.closeWindow(fresh);
      fixtures.splice(fixtures.indexOf(fresh), 1);
    }
  } finally {
    try {
      for (const [live, originalReference] of ownerReferences) {
        live.geckoProfileReference = originalReference;
      }
      for (const [live, originalReference] of ownerReferences) {
        Assert.deepEqual(
          live.geckoProfileReference,
          originalReference,
          "Cleanup restores immutable original owner before close"
        );
      }
    } finally {
      try {
        for (const win of fixtures.reverse()) {
          if (!win.closed) {
            await BrowserTestUtils.closeWindow(win);
          }
        }
      } finally {
        try {
          for (const space of gZenWorkspaces.getWorkspaces()) {
            if (!initialSpaces.some(original => original.uuid === space.uuid)) {
              await gZenWorkspaces.removeWorkspace(space.uuid);
            }
          }
          await gZenWorkspaces.changeWorkspaceWithID(primarySpace);
          for (const tab of Array.from(gBrowser.tabs)) {
            if (!primaryTabs.has(tab)) {
              BrowserTestUtils.removeTab(tab);
            }
          }
          gBrowser.selectedTab = primarySelected;
          for (const name of Object.keys(
            SessionStore.getCurrentState(true).global || {}
          )) {
            SessionStore.deleteCustomGlobalValue(name);
          }
          for (const [name, value] of Object.entries(initialGlobal)) {
            SessionStore.setCustomGlobalValue(name, value);
          }
          Assert.deepEqual(
            Array.from(gBrowser.tabs),
            Array.from(primaryTabs),
            "Cleanup preserves original primary tabs only"
          );
        } finally {
          directory.remove(true);
          Assert.ok(!directory.exists(), "Owned foreign directory removed");
        }
      }
    }
  }
});
