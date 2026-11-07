// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

window.gZenOperatingSystemCommonUtils = {
  kZenOSToSmallName: {
    WINNT: "windows",
    Darwin: "macos",
    Linux: "linux",
  },

  get currentOperatingSystem() {
    let os = Services.appinfo.OS;
    return this.kZenOSToSmallName[os];
  },
};

// Certifies entry/delivery selection of one top-level producer, not an unseen
// preview interval, rendered pixels, or the document's OOPIF/media producers.
export async function requestProfileHostProducerAck(sourceWindow, sourceGeneration) {
  const decimal = (value, max = 18446744073709551615n) =>
    typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= max;
  if (!decimal(sourceGeneration) || !sourceWindow || sourceWindow.closed) {
    throw new Error("Invalid explicit source or generation");
  }
  const gBrowser = sourceWindow.gBrowser;
  const browser = gBrowser?.selectedBrowser;
  const tab = gBrowser?.selectedTab;
  const document = sourceWindow.document;
  const frameLoader = browser?.frameLoader;
  const remoteTab = frameLoader?.remoteTab;
  const browsingContext = browser?.browsingContext;
  const global = browsingContext?.currentWindowGlobal;
  const innerWindowId = global?.innerWindowId;
  const current = () =>
    !sourceWindow.closed && sourceWindow.document === document &&
    sourceWindow.gBrowser === gBrowser && gBrowser.selectedBrowser === browser &&
    gBrowser.selectedTab === tab && gBrowser.selectedBrowsers.length === 1 &&
    gBrowser.selectedBrowsers[0] === browser && tab?.linkedBrowser === browser &&
    tab.isConnected && browser?.isConnected && browser.ownerDocument === document &&
    browser.isRemoteBrowser && browser.frameLoader === frameLoader && !!remoteTab &&
    frameLoader.remoteTab === remoteTab && browser.browsingContext === browsingContext &&
    !!global && browsingContext.currentWindowGlobal === global &&
    global.innerWindowId === innerWindowId && !!innerWindowId &&
    browser.webProgress && !browser.webProgress.isLoadingDocument &&
    !tab.hasAttribute("pending") && !tab.hasAttribute("busy");
  if (!gBrowser || !frameLoader || !current()) {
    throw new Error("No unambiguous idle selected remote producer");
  }
  const deadline = sourceWindow.performance.now() + 5000;
  let invalidated = false;
  let rejectCancellation;
  const cancelled = new Promise((resolve, reject) => { rejectCancellation = reject; });
  // A synchronous native refusal can follow a synchronous invalidation event.
  cancelled.catch(() => {});
  const invalidate = () => {
    invalidated = true;
    rejectCancellation(new Error("Producer request invalidated or timed out"));
  };
  const targetEvent = event => { if (event.target === tab) invalidate(); };
  const progress = {
    onStateChange(target, webProgress, request, flags) {
      if (target === browser && webProgress?.isTopLevel &&
          (flags & Ci.nsIWebProgressListener.STATE_START)) invalidate();
    },
    onLocationChange(target, webProgress) {
      if (target === browser && webProgress?.isTopLevel) invalidate();
    },
  };
  const listeners = [
    [sourceWindow, "unload", invalidate],
    [sourceWindow, "close", invalidate],
    [gBrowser.tabContainer, "TabSelect", invalidate],
    [gBrowser.tabContainer, "TabClose", targetEvent],
    [gBrowser.tabContainer, "BeforeTabRemotenessChange", targetEvent],
  ];
  let installed = 0;
  let progressInstalled = false;
  let timer;
  try {
    for (const [target, type, listener] of listeners) {
      target.addEventListener(type, listener);
      installed++;
    }
    gBrowser.addTabsProgressListener(progress);
    progressInstalled = true;
    timer = sourceWindow.setTimeout(invalidate, 5000);
    if (invalidated || !current() || sourceWindow.performance.now() >= deadline) {
      throw new Error("Producer target changed or deadline expired");
    }
    const json = await Promise.race([
      Services.zen.requestProfileHostProducerAck(sourceWindow, browser, sourceGeneration),
      cancelled,
    ]);
    if (invalidated || !current() || sourceWindow.performance.now() >= deadline) {
      throw new Error("Producer target changed or deadline expired");
    }
    if (typeof json !== "string") throw new Error("Native receipt must be JSON text");
    const receipt = JSON.parse(json);
    const identities = ["sourceWidget", "sourceRoot", "sourceGeneration",
      "browsingContextId", "innerWindowId", "contentParentId", "tabId", "layersId",
      "pipelineId", "transactionId", "fwdTransactionId"];
    const integers = ["innerWidthDevicePx", "innerHeightDevicePx", "appUnitsPerDevPixel"];
    const scales = ["widgetDefaultScale", "desktopToDeviceScale"];
    const keys = ["version", "status", ...identities, "idNamespace", "epoch", ...integers, ...scales];
    if (!receipt || Array.isArray(receipt) || Object.keys(receipt).length !== keys.length ||
        keys.some(key => !Object.hasOwn(receipt, key)) || receipt.version !== 1 ||
        receipt.status !== "accepted-producer-only" ||
        identities.some(key => !decimal(receipt[key])) ||
        !decimal(receipt.idNamespace, 4294967295n) || !decimal(receipt.epoch, 4294967295n) ||
        receipt.sourceGeneration !== sourceGeneration || receipt.pipelineId !== receipt.layersId ||
        integers.some(key => !Number.isSafeInteger(receipt[key]) || receipt[key] <= 0 || receipt[key] > 2147483647) ||
        scales.some(key => typeof receipt[key] !== "number" || !Number.isFinite(receipt[key]) || receipt[key] <= 0)) {
      throw new Error("Invalid accepted-producer receipt");
    }
    return Object.freeze(receipt);
  } finally {
    if (timer !== undefined) sourceWindow.clearTimeout(timer);
    if (progressInstalled) gBrowser.removeTabsProgressListener(progress);
    for (const [target, type, listener] of listeners.slice(0, installed)) {
      target.removeEventListener(type, listener);
    }
  }
}

export class nsZenMultiWindowFeature {
  constructor() {}

  static get browsers() {
    return Services.wm.getEnumerator("navigator:browser");
  }

  static get currentBrowser() {
    return Services.wm.getMostRecentWindow("navigator:browser");
  }

  static get isActiveWindow() {
    return nsZenMultiWindowFeature.currentBrowser === window;
  }

  windowIsActive(browser) {
    return browser === nsZenMultiWindowFeature.currentBrowser;
  }

  async foreachWindowAsActive(callback) {
    if (!nsZenMultiWindowFeature.isActiveWindow) {
      return;
    }
    await this.forEachWindow(callback);
  }

  async forEachWindow(callback) {
    for (const browser of nsZenMultiWindowFeature.browsers) {
      try {
        if (browser.closed) {
          continue;
        }
        await callback(browser);
      } catch (e) {
        console.error(e);
      }
    }
  }

  forEachWindowSync(callback) {
    for (const browser of nsZenMultiWindowFeature.browsers) {
      try {
        if (browser.closed) {
          continue;
        }
        callback(browser);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

export class nsZenDOMOperatedFeature {
  constructor() {
    var initBound = this.init.bind(this);
    document.addEventListener("DOMContentLoaded", initBound, { once: true });
  }
}

export class nsZenPreloadedFeature {
  constructor() {
    var initBound = this.init.bind(this);
    document.addEventListener("MozBeforeInitialXULLayout", initBound, {
      once: true,
    });
  }
}

window.gZenCommonActions = {
  copyCurrentURLToClipboard() {
    const [currentUrl, ClipboardHelper] = gURLBar.zenStrippedURI;
    let displaySpec = currentUrl.displaySpec;

    try {
      if (
        Services.prefs.getBoolPref("browser.urlbar.decodeURLsOnCopy", false) &&
        !currentUrl.schemeIs("data")
      ) {
        displaySpec = decodeURI(displaySpec);
      }
    } catch (e) {}

    ClipboardHelper.copyString(displaySpec);

    let button;
    /* eslint-disable mozilla/valid-services */
    if (Services.zen.canShare() && displaySpec.startsWith("http")) {
      button = {
        id: "zen-copy-current-url-button",
        command: event => {
          const buttonRect = event.target.getBoundingClientRect();
          /* eslint-disable mozilla/valid-services */
          Services.zen.share(
            currentUrl,
            "",
            "",
            buttonRect.left,
            window.innerHeight - buttonRect.bottom,
            buttonRect.width,
            buttonRect.height
          );
        },
      };
    }
    gZenUIManager.showToast("zen-copy-current-url-confirmation", {
      button,
      timeout: 3000,
    });
  },

  copyCurrentURLAsMarkdownToClipboard() {
    const [currentUrl, ClipboardHelper] = gURLBar.zenStrippedURI;
    const tabTitle = gBrowser.selectedTab.label;
    let displaySpec = currentUrl.displaySpec;

    try {
      if (
        Services.prefs.getBoolPref("browser.urlbar.decodeURLsOnCopy", false) &&
        !currentUrl.schemeIs("data")
      ) {
        displaySpec = decodeURI(displaySpec);
      }
    } catch (e) {}

    const markdownLink = `[${tabTitle}](${displaySpec})`;
    ClipboardHelper.copyString(markdownLink);

    gZenUIManager.showToast("zen-copy-current-url-as-markdown-confirmation", {
      timeout: 3000,
    });
  },

  throttle(f, delay) {
    let timer = 0;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => f.apply(this, args), delay);
    };
  },

  /**
   * Determines if a tab should be closed when navigating back with no history.
   * Only tabs with an owner that are not pinned and not empty are eligible.
   * Respects the user preference zen.tabs.close-on-back-with-no-history.
   *
   * @returns {boolean} True if the tab should be closed on back
   */
  shouldCloseTabOnBack() {
    if (
      !Services.prefs.getBoolPref(
        "zen.tabs.close-on-back-with-no-history",
        true
      )
    ) {
      return false;
    }
    const tab = gBrowser.selectedTab;
    return Boolean(
      tab.owner && !tab.pinned && !tab.hasAttribute("zen-empty-tab")
    );
  },
};
