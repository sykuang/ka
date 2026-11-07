/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(
  async function test_background_pending_detach_refusal_and_loaded_success() {
    await SpecialPowers.pushPrefEnv({
      set: [
        ["browser.sessionstore.restore_on_demand", true],
        ["zen.window-sync.prefer-unsynced-windows", false],
        ["ui.prefersReducedMotion", 0],
      ],
    });
    Assert.ok(
      Services.prefs.getBoolPref("zen.tabs.dnd-open-blank-window", true),
      "Original normal detach preference is true"
    );
    const closedWindows = structuredClone(SessionStore.getClosedWindowData());
    const actions = structuredClone(SessionStore.lastClosedActions);
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
    };
    let source;
    let dest;
    let tab;
    let sourceStyle;
    let sourceFadein;
    let painted = false;
    const onPaint = () => {
      painted = true;
    };
    try {
      for (const pending of [true, false]) {
        source = await BrowserTestUtils.openNewBrowserWindow({
          zenSyncedWindow: false,
        });
        await source.gZenWorkspaces.promiseInitialized;
        await TestUtils.waitForCondition(
          () => !source.gReduceMotion,
          "Normal startup enables non-reduced-motion setting"
        );
        Assert.ok(!source.gReduceMotion, "Real non-reduced-motion branch");
        const space = source.gZenWorkspaces.getWorkspaceFromId(
          source.gZenWorkspaces.activeWorkspace
        );
        const profile = Services.dirsvc.get("ProfD", Ci.nsIFile);
        const owner = Cc["@mozilla.org/file/local;1"].createInstance(
          Ci.nsIFile
        );
        owner.persistentDescriptor =
          space.geckoProfileReference.persistentDescriptor;
        Assert.ok(owner.equals(profile), "Actual source owner is this ProfD");
        const keeper = await BrowserTestUtils.openNewForegroundTab(
          source.gBrowser,
          "about:blank#detach-keeper"
        );
        for (const initial of [...source.gBrowser.tabs]) {
          if (initial !== keeper) BrowserTestUtils.removeTab(initial);
        }
        tab = await BrowserTestUtils.openNewForegroundTab(
          source.gBrowser,
          "about:mozilla"
        );
        await BrowserTestUtils.loadURIString({
          browser: tab.linkedBrowser,
          uriString: "https://example.com/",
        });
        await TabStateFlusher.flush(tab.linkedBrowser);
        source.gBrowser.selectedTab = keeper;
        if (pending) {
          await source.gBrowser.prepareDiscardBrowser(tab);
          Assert.ok(
            source.gBrowser.discardBrowser(tab, true),
            "Normal remote background unload"
          );
          Assert.ok(
            tab.hasAttribute("pending"),
            "Actual pending source, no injected flag"
          );
        }
        SessionStore.setCustomTabValue(tab, "s2-owner", "normal-detach");
        tab.style.setProperty("max-width", "173px", "important");
        sourceStyle = tab.getAttribute("style");
        sourceFadein = tab.getAttribute("fadein");
        const before = JSON.parse(SessionStore.getTabState(tab));
        const tabs = [...source.gBrowser.tabs];
        const id = tab.id;
        Assert.equal(
          before.zenWorkspace,
          space.uuid,
          "Natural temporary binding from the actual producer"
        );
        if (pending)
          Assert.deepEqual(
            JSON.parse(SessionStore.getTabState(tab)),
            before,
            "No-op full-state reads are stable"
          );
        painted = false;
        dest = source.gBrowser.replaceTabsWithWindow(tab);
        Assert.ok(
          dest,
          "Normal background detach creates the real destination"
        );
        dest.addEventListener("MozAfterPaint", onPaint);
        Assert.equal(
          tab.style.maxWidth,
          "",
          "Actual producer entered source fade-out"
        );
        Assert.ok(
          !tab.hasAttribute("fadein"),
          "Actual producer removed fadein before startup"
        );
        Assert.strictEqual(
          source.gBrowser.selectedTab,
          keeper,
          "Command does not select background pending source"
        );
        await TestUtils.waitForCondition(
          () =>
            dest.closed ||
            (dest.gBrowserInit && !dest.gBrowserInit.isAdoptingTab()),
          "Normal paint/adoption intent settles"
        );
        info(
          "S2_SETTLEMENT " +
            JSON.stringify({
              pending,
              painted,
              closed: dest.closed,
              sourceConnected: tab.isConnected,
              sourceStyle: tab.getAttribute("style"),
              sourceFadein: tab.getAttribute("fadein"),
              intent: dest.gBrowserInit?.getTabToAdopt()?.id ?? null,
              targetSpaces: dest.closed
                ? null
                : dest.gZenWorkspaces.getWorkspaces().map(item => item.uuid),
              sourceSpace: space.uuid,
            })
        );
        Assert.ok(painted, "Consumer ran after a real MozAfterPaint");
        if (pending) {
          Assert.ok(
            tab.isConnected && !tab.closing,
            "Refusal preserves actual source identity"
          );
          Assert.equal(tab.id, id, "Source native identity is unchanged");
          Assert.strictEqual(
            source.gBrowser.selectedTab,
            keeper,
            "Refusal keeps original selection"
          );
          Assert.deepEqual(
            [...source.gBrowser.tabs],
            tabs,
            "Refusal keeps source tab order/identities"
          );
          Assert.equal(
            tab.getAttribute("style"),
            sourceStyle,
            "Refusal restores exact source style including max-width priority"
          );
          Assert.equal(
            tab.getAttribute("fadein"),
            sourceFadein,
            "Refusal restores exact original fadein visibility"
          );
          Assert.deepEqual(
            JSON.parse(SessionStore.getTabState(tab)),
            before,
            "Refusal keeps complete history/state/custom values"
          );
          Assert.equal(
            SessionStore.getCustomTabValue(tab, "s2-owner"),
            "normal-detach",
            "Custom value remains at source"
          );
          Assert.ok(
            dest.closed,
            "Refused partial destination is explicitly closed, not left as successful blank"
          );
          Assert.strictEqual(
            dest.gBrowserInit.getTabToAdopt(),
            tab,
            "Refused window did not mark adoption intent completed"
          );
        } else {
          Assert.ok(
            !dest.closed && !tab.isConnected,
            "Normal nonpending detach actually moves the document"
          );
          const moved = dest.gBrowser.selectedTab;
          Assert.equal(
            await SpecialPowers.spawn(
              moved.linkedBrowser,
              [],
              () => content.document.documentURI
            ),
            "https://example.com/",
            "Normal nonpending detach transfers actual document"
          );
          Assert.equal(
            SessionStore.getCustomTabValue(moved, "s2-owner"),
            "normal-detach",
            "Normal success keeps custom value"
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
            "Normal success preserves native back history"
          );
          Assert.equal(
            dest.gBrowserInit.getTabToAdopt(),
            null,
            "Successful adoption clears its intent"
          );
          await dest.gZenWorkspaces.promiseInitialized;
          Assert.ok(
            !dest.gZenWorkspaces.currentWindowIsSyncing,
            "Normal target remains unsynced"
          );
        }
        try {
          if (tab.isConnected) {
            if (sourceStyle === null) tab.removeAttribute("style");
            else tab.setAttribute("style", sourceStyle);
            if (sourceFadein === null) tab.removeAttribute("fadein");
            else tab.setAttribute("fadein", sourceFadein);
          }
          restoreMetadata();
        } finally {
          try {
            dest.removeEventListener("MozAfterPaint", onPaint);
            if (!dest.closed) await BrowserTestUtils.closeWindow(dest);
            dest = null;
          } finally {
            await BrowserTestUtils.closeWindow(source);
            source = null;
          }
        }
      }
    } finally {
      try {
        if (tab?.isConnected) {
          if (sourceStyle === null) tab.removeAttribute("style");
          else tab.setAttribute("style", sourceStyle);
          if (sourceFadein === null) tab.removeAttribute("fadein");
          else tab.setAttribute("fadein", sourceFadein);
        }
        restoreMetadata();
      } finally {
        try {
          dest?.removeEventListener("MozAfterPaint", onPaint);
          if (dest && !dest.closed) await BrowserTestUtils.closeWindow(dest);
        } finally {
          try {
            if (source && !source.closed)
              await BrowserTestUtils.closeWindow(source);
          } finally {
            restoreMetadata();
            await SpecialPowers.popPrefEnv();
          }
        }
      }
    }
  }
);
