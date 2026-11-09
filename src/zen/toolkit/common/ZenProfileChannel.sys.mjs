/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Manager <-> profile worker channel: newline-delimited JSON over a 0600 Unix
// socket. The worker's first message must carry the per-launch token. The
// worker reports its tabs; the manager sends browsing commands back.

const encoder = new TextEncoder();

// Page buttons in the urlbar whose state and clicks belong to the worker.
export const PAGE_BUTTONS = [
  "zen-site-data-icon-button",
  "reader-mode-button",
  "picture-in-picture-button",
  "translations-button",
  "urlbar-zoom-button",
  "star-button-box",
];

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI: "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  ExtensionParent: "resource://gre/modules/ExtensionParent.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

function wire(transport, onMessage, onClose) {
  const output = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(
    Ci.nsIBinaryOutputStream
  );
  output.setOutputStream(transport.openOutputStream(0, 0, 0));
  const input = transport.openInputStream(0, 0, 0);
  const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
    Ci.nsIBinaryInputStream
  );
  binary.setInputStream(input);
  const decoder = new TextDecoder();
  let pending = "";
  const pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(
    Ci.nsIInputStreamPump
  );
  pump.init(input, 0, 0, false);
  pump.asyncRead({
    onStartRequest() {},
    onStopRequest() {
      onClose?.();
    },
    onDataAvailable(request, stream, offset, count) {
      pending += decoder.decode(new Uint8Array(binary.readByteArray(count)), {
        stream: true,
      });
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          transport.close(Cr.NS_ERROR_FAILURE);
          return;
        }
        try {
          onMessage(message);
        } catch (e) {
          console.error("ZenProfileChannel: message handler failed", e);
        }
      }
    },
  });
  return {
    send(message) {
      const bytes = encoder.encode(JSON.stringify(message) + "\n");
      output.writeByteArray(bytes);
      output.flush();
    },
    close() {
      transport.close(Cr.NS_OK);
    },
  };
}

// Manager side. Returns { path, token, send, close }; onMessage only ever sees
// messages from the one worker that presented the token.
export function listen(onMessage) {
  const token = Services.uuid.generateUUID().toString().slice(1, -1);
  // Unix socket paths are short (104 bytes on macOS): keep it under /tmp.
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(`/tmp/zen-${Services.appinfo.processID}-${token.slice(0, 8)}.sock`);
  const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(
    Ci.nsIServerSocket
  );
  server.initWithFilename(file, 0o600, -1);
  let peer = null;
  server.asyncListen({
    onSocketAccepted(socket, transport) {
      if (peer) {
        transport.close(Cr.NS_ERROR_FAILURE);
        return;
      }
      let admitted = false;
      const connection = wire(
        transport,
        message => {
          if (!admitted) {
            if (message?.hello !== token) {
              connection.close();
              return;
            }
            admitted = true;
            peer = connection;
            return;
          }
          onMessage(message);
        },
        () => {
          if (peer === connection) {
            peer = null;
          }
        }
      );
    },
    onStopListening() {},
  });
  return {
    path: file.path,
    token,
    send(message) {
      peer?.send(message);
    },
    close() {
      peer?.close();
      server.close();
      try {
        file.remove(false);
      } catch {}
    },
  };
}

// Worker side: report this window's tabs and obey manager commands.
export function serveWorker(window, spec) {
  // Zen leaves macOS arrow panels unpainted for NSPopover to fill, but this
  // worker's popups have no on-screen parent to anchor a popover to.
  Cc["@mozilla.org/content/style-sheet-service;1"]
    .getService(Ci.nsIStyleSheetService)
    .loadAndRegisterSheet(
      Services.io.newURI(
        "data:text/css," +
          encodeURIComponent(
            'panel[type="arrow"]:not(#feature-callout) { --panel-background-color: var(--arrowpanel-background) !important; } panel[type="arrow"]:not(#feature-callout)::part(content) { background-color: var(--arrowpanel-background) !important; }'
          )
      ),
      Ci.nsIStyleSheetService.AUTHOR_SHEET
    );
  const [path, token] = spec.split(" ");
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  const transport = Cc[
    "@mozilla.org/network/socket-transport-service;1"
  ].getService(Ci.nsISocketTransportService).createUnixDomainTransport(file);
  const { gBrowser } = window;
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = tab => {
    if (!ids.has(tab)) {
      ids.set(tab, nextId++);
    }
    return ids.get(tab);
  };
  const tabById = id => gBrowser.tabs.find(tab => idOf(tab) === id);
  // Moves this (never shown) window so that element sits at the manager's
  // copy of it (screen CSS px); popups anchored to it then land there.
  const moveUnder = (element, anchor) => {
    if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
      const box = element.getBoundingClientRect();
      window.moveTo(
        Math.round(anchor.x - (window.mozInnerScreenX - window.screenX) - box.x),
        Math.round(anchor.y - (window.mozInnerScreenY - window.screenY) - box.y)
      );
    }
  };

  let answerPrompt = () => {};
  const downloads = new Map(); // key -> Download, for manager commands
  const browserAction = id => {
    const extension = WebExtensionPolicy.getByID(id)?.extension;
    return extension && lazy.ExtensionParent.apiManager.global.browserActionFor?.(extension);
  };
  let managerGone = false;
  const channel = wire(transport, message => {
    if (message.type === "prompt-answer") {
      answerPrompt(message);
      return;
    }
    if (message.type === "bookmarks") {
      const { PlacesUtils } = window;
      const trim = node => ({
        title: node.title,
        uri: node.uri,
        separator: node.type === PlacesUtils.TYPE_X_MOZ_PLACE_SEPARATOR || undefined,
        children: node.children?.map(trim),
      });
      const { menuGuid, toolbarGuid, unfiledGuid } = PlacesUtils.bookmarks;
      Promise.all(
        [menuGuid, toolbarGuid, unfiledGuid].map(guid => PlacesUtils.promiseBookmarksTree(guid))
      ).then(([menu, toolbar, unfiled]) =>
        channel.send({
          type: "bookmarks",
          roots: [
            ...(trim(menu).children ?? []),
            { title: "Bookmarks Toolbar", children: trim(toolbar).children ?? [] },
            { title: "Other Bookmarks", children: trim(unfiled).children ?? [] },
          ],
        })
      );
      return;
    }
    if (message.type === "download-cancel") {
      downloads.get(message.key)?.cancel().catch(() => {});
      return;
    }
    if (message.type === "download-start") {
      downloads.get(message.key)?.start().catch(() => {});
      return;
    }
    const tab = tabById(message.id);
    switch (message.type) {
      case "addons":
        window.BrowserAddonUI.openAddonsMgr(message.view);
        break;
      case "essential": {
        let essential = gBrowser.tabs.find(
          t => lazy.SessionStore.getCustomTabValue(t, "ka-essential") === message.url
        );
        if (!essential) {
          essential = gBrowser.addTrustedTab(message.url);
          lazy.SessionStore.setCustomTabValue(essential, "ka-essential", message.url);
        }
        gBrowser.selectedTab = essential;
        break;
      }
      case "shortcuts":
        if (Array.isArray(message.list)) {
          window.gZenKeyboardShortcutsManager.adoptSharedList(message.list);
        }
        break;
      case "origin": {
        const box = gBrowser.selectedBrowser.getBoundingClientRect();
        if (Number.isFinite(message.x) && Number.isFinite(message.y)) {
          window.moveBy(
            Math.round(message.x - window.mozInnerScreenX - box.x),
            Math.round(message.y - window.mozInnerScreenY - box.y)
          );
          // Content caches its screen position; a hidden window's move does not refresh it.
          for (const browser of gBrowser.browsers) {
            browser.frameLoader?.requestUpdatePosition();
          }
        }
        break;
      }
      case "button": {
        const button = PAGE_BUTTONS.includes(message.id) && window.document.getElementById(message.id);
        if (button) {
          moveUnder(button, message.anchor);
          button.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
        }
        break;
      }
      case "tab":
        if (!tab) {
          break;
        }
        switch (message.action) {
          case "reload":
            gBrowser.reloadTab(tab);
            break;
          case "mute":
            tab.toggleMuteAudio();
            break;
          case "duplicate":
            gBrowser.duplicateTab(tab);
            break;
          case "unload":
            gBrowser.explicitUnloadTabs([tab]);
            break;
          case "bookmark":
            // ponytail: straight into Other Bookmarks; the edit dialog would
            // open in this hidden window.
            window.PlacesUtils.bookmarks.insert({
              parentGuid: window.PlacesUtils.bookmarks.unfiledGuid,
              url: tab.linkedBrowser.currentURI.spec,
              title: tab.label,
            });
            break;
        }
        break;
      case "rollup":
        for (const popup of window.document.querySelectorAll("panel, menupopup")) {
          if (popup.state === "open" || popup.state === "showing") {
            popup.hidePopup();
          }
        }
        break;
      case "shortcut":
        window.document.getElementById(message.action)?.doCommand();
        break;
      case "select":
        if (tab) {
          gBrowser.selectedTab = tab;
        }
        break;
      case "close":
        if (tab) {
          // Its "leave page?" prompt is drawn in its tab: show that tab first.
          if (tab.linkedBrowser.hasBeforeUnload) {
            gBrowser.selectedTab = tab;
          }
          gBrowser.removeTab(tab);
        }
        break;
      case "open":
        if (message.split) {
          const tab = gBrowser.addTrustedTab(message.url || "about:blank");
          window.gZenViewSplitter.splitTabs([gBrowser.selectedTab, tab], "vsep", 1);
          break;
        }
        window.openTrustedLinkIn(message.url || "about:blank", "tab");
        break;
      case "extension": {
        const action = browserAction(message.extension);
        const tab = gBrowser.selectedTab;
        if (!action) {
          break;
        }
        if (!action.action.getPopupUrl(tab)) {
          action.action.triggerClickOrPopup(tab, { button: 0, modifiers: [] });
          break;
        }
        // Real action popup, anchored to this (never shown) window's button:
        // the window is moved so that button sits where the manager drew its
        // copy, and the popup, a free-standing native window, lands under it.
        // The button must be on a toolbar; putting it there rebuilds Zen's
        // sidebar, which rolls up popups, so the popup opens a task later.
        const area = lazy.CustomizableUI.getPlacementOfWidget(action.id)?.area;
        const moved = !area || area === lazy.CustomizableUI.AREA_ADDONS;
        if (moved) {
          lazy.CustomizableUI.addWidgetToArea(action.id, lazy.CustomizableUI.AREA_NAVBAR);
        }
        const open = () => {
          const button = action.widget
            .forWindow(window)
            .node?.querySelector(".unified-extensions-item-action-button");
          if (!button) {
            return;
          }
          moveUnder(button, message.anchor);
          // Skips action.openPopup()'s focus check: this window is never active.
          button.dispatchEvent(new window.CustomEvent("command", { bubbles: true, cancelable: true }));
        };
        moved ? window.setTimeout(open, 0) : open();
        break;
      }
      case "extension-close":
        window.document.getElementById("customizationui-widget-panel")?.hidePopup();
        break;
      case "pin":
        if (tab && tab.pinned !== !!message.pinned) {
          message.pinned ? gBrowser.pinTab(tab) : gBrowser.unpinTab(tab);
        }
        break;
      case "move": {
        // Place after the tab that precedes it in the manager sidebar (none:
        // first of its pinned/unpinned group).
        const after = tabById(message.after);
        // (moveTabTo's tabIndex means "insert before the tab now at this index".)
        if (tab && after && after !== tab) {
          gBrowser.moveTabTo(tab, { tabIndex: gBrowser.tabs.indexOf(after) + 1 });
        } else if (tab && !message.after) {
          gBrowser.moveTabTo(tab, { tabIndex: tab.pinned ? 0 : gBrowser.pinnedTabCount });
        }
        break;
      }
      case "navigate":
        if (tab) {
          gBrowser.selectedTab = tab;
        }
        window.openTrustedLinkIn(message.url, "current");
        break;
    }
  }, () => {
    managerGone = true;
    // The manager went away (quit or crash): we only exist to serve it, and
    // lingering would keep this Profile locked for the next launch.
    Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
  });
  channel.send({ hello: token });
  // A worker window is never shown: new windows belong to the manager.
  window.OpenBrowserWindow = (options = {}) => {
    channel.send({ type: "new-window", private: !!options.private });
    return null;
  };
  Services.obs.addObserver((s, t, cursor) => channel.send({ type: "cursor", cursor }), "zen-profile-worker-cursor");
  // A quit sent to this process by app name (Dock scripts, launchers) means
  // quitting Ka: pass it to the manager, whose quit then ends us.
  Services.obs.addObserver(cancel => {
    if (!managerGone) {
      cancel.QueryInterface(Ci.nsISupportsPRBool).data = true;
      channel.send({ type: "quit" });
    }
  }, "quit-application-requested");

  // App-wide Zen panes live in the manager's Ka Settings; hide them here.
  Services.obs.addObserver(doc => {
    if (doc.documentURI?.startsWith("about:preferences")) {
      const style = doc.createElement("style");
      style.textContent =
        "#category-zen-looks, #category-zen-tabs-management, #category-zen-CKS, #category-zen-marketplace { display: none !important; }";
      doc.documentElement.append(style);
    }
  }, "document-element-inserted");

  // Permission prompts would open in this worker's hidden chrome; ask the
  // manager to show them instead and run the chosen action here.
  // ponytail: message, buttons and checkbox; no custom panel content.
  const prompts = new Map();
  let nextPrompt = 1;
  const { PopupNotifications } = window;
  const show = PopupNotifications.show.bind(PopupNotifications);
  PopupNotifications.show = (...args) => {
    const [browser, , message, , mainAction, secondaryActions, options] = args;
    // Firefox only shows notifications for tabs, and leaves dismissed ones
    // (e.g. password capture while typing) as an anchor icon; an extension
    // popup's login form must never turn into a dialog.
    const ask = mainAction && !options?.dismissed && gBrowser.getTabForBrowser(browser);
    if (ask) {
      // Only the manager's dialog asks; the worker's own panel stays closed.
      args[6] = { ...options, dismissed: true };
    }
    const notification = show(...args);
    if (notification && ask) {
      // A re-shown notification (same id, same tab) replaces the one already
      // being asked about; keep its dialog instead of opening another.
      const pending = [...prompts].find(
        ([, n]) => n.id === notification.id && n.browser === notification.browser
      );
      if (pending) {
        prompts.set(pending[0], notification);
        return notification;
      }
      const key = nextPrompt++;
      prompts.set(key, notification);
      const text = typeof message === "string" ? message : message?.textContent || "";
      channel.send({
        type: "prompt",
        key,
        message: text.replace("<>", options?.name ?? ""),
        actions: [mainAction, ...(secondaryActions || [])].map(action => action.label),
        checkbox: options?.checkbox?.label
          ? { label: options.checkbox.label, checked: !!options.checkbox.checked }
          : undefined,
      });
    }
    return notification;
  };
  answerPrompt = ({ key, index, checked }) => {
    const notification = prompts.get(key);
    prompts.delete(key);
    const action = [notification?.mainAction, ...(notification?.secondaryActions || [])][index];
    if (action) {
      // Panels fill their fields (e.g. the login to save) on "shown", which
      // a panel never shown here would skip; the action reads them back.
      notification.options.eventCallback?.call(notification, "shown");
      action.callback({ checkboxChecked: !!checked, source: "button" });
      PopupNotifications.remove(notification);
    }
  };

  const icons = new Map(); // worker icon URL -> data: URL ("" while loading)
  const iconData = url => {
    // Tab images are moz-remote-image:// wrappers bound to this process's
    // content; the real icon URL is its url= parameter.
    if (url?.startsWith("moz-remote-image:")) {
      url = new URL(url).searchParams.get("url");
    }
    if (!url || url.startsWith("data:")) {
      return url || "";
    }
    if (!icons.has(url)) {
      icons.set(url, "");
      lazy.NetUtil.asyncFetch(
        { uri: url, loadUsingSystemPrincipal: true },
        (stream, status, request) => {
          if (!Components.isSuccessCode(status)) {
            console.error("ZenProfileChannel: icon fetch failed", url, status);
            return;
          }
          // ponytail: 64 KB cap, ample for favicons.
          const bytes = lazy.NetUtil.readInputStreamToString(
            stream,
            Math.min(stream.available(), 65536)
          );
          const type = request.QueryInterface(Ci.nsIChannel).contentType || "image/png";
          icons.set(url, `data:${type};base64,${btoa(bytes)}`);
          report();
        }
      );
    }
    return icons.get(url);
  };
  let queued = false;
  const report = () => {
    if (queued) {
      return;
    }
    queued = true;
    window.setTimeout(() => {
      queued = false;
      const extensions = [];
      for (const policy of WebExtensionPolicy.getActiveExtensions()) {
        const action = policy.extension && browserAction(policy.id);
        if (!action || policy.isPrivileged) {
          continue;
        }
        const tab = gBrowser.selectedTab;
        const icons = action.action.getProperty(tab, "icon") || {};
        const size = Object.keys(icons).sort((a, b) => Math.abs(a - 32) - Math.abs(b - 32))[0];
        extensions.push({
          id: policy.id,
          title: action.action.getProperty(tab, "title") || policy.name,
          icon: iconData(icons[size]),
        });
      }
      channel.send({
        type: "tabs",
        extensions,
        shown: PAGE_BUTTONS.filter(id => window.document.getElementById(id)?.hidden === false),
        // Zen's own placeholder "empty tab" is chrome, not browsing state; a
        // Glance is drawn over its page's tab here, so it gets no placeholder.
        tabs: gBrowser.tabs
          .filter(tab => !tab.hasAttribute("zen-empty-tab") && !tab.hasAttribute("zen-glance-tab"))
          .map(tab => ({
          id: idOf(tab),
          label: tab.label,
          url: tab.linkedBrowser?.currentURI?.spec ?? "",
          // The worker's icon URLs (page-icon:, cached http) mean nothing to
          // the manager, so ship the bytes as a data: URL.
          icon: iconData(tab.image),
          selected: tab.selected,
          pinned: tab.pinned,
          essential: lazy.SessionStore.getCustomTabValue(tab, "ka-essential") || undefined,
          soundplaying: tab.soundPlaying,
          muted: tab.muted,
          busy: tab.hasAttribute("busy"),
          crashed: tab.hasAttribute("crashed"),
        })),
      });
    }, 50);
  };
  for (const type of [
    "TabOpen",
    "TabClose",
    "TabSelect",
    "TabAttrModified",
    "TabPinned",
    "TabUnpinned",
    "TabMove",
  ]) {
    gBrowser.tabContainer.addEventListener(type, report);
  }
  gBrowser.addTabsProgressListener({ onLocationChange: report });
  const buttonWatch = new window.MutationObserver(report);
  for (const id of PAGE_BUTTONS) {
    const button = window.document.getElementById(id);
    if (button) {
      buttonWatch.observe(button, { attributes: true, attributeFilter: ["hidden"] });
    }
  }
  lazy.ExtensionParent.apiManager.on("ready", report);
  lazy.ExtensionParent.apiManager.on("shutdown", report);

  // Downloads run here with no UI; the manager mirrors their state.
  const downloadKeys = new WeakMap();
  let nextDownload = 1;
  const sendDownload = download => {
    if (!downloadKeys.has(download)) {
      downloadKeys.set(download, nextDownload++);
      downloads.set(downloadKeys.get(download), download);
    }
    channel.send({
      type: "download",
      key: downloadKeys.get(download),
      source: download.source.url,
      target: download.target.path,
      currentBytes: download.currentBytes,
      totalBytes: download.hasProgress ? download.totalBytes : 0,
      succeeded: download.succeeded,
      canceled: download.canceled,
      failed: !!download.error,
      hasPartialData: download.hasPartialData,
    });
  };
  lazy.Downloads.getList(lazy.Downloads.ALL).then(list =>
    list.addView({ onDownloadAdded: sendDownload, onDownloadChanged: sendDownload })
  );
  report();
}
