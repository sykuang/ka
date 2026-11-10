/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Single-window multi-Profile: a Space bound to another Gecko Profile is shown
// by running that Profile as a hidden worker and overlaying its compositor
// output on this window's browser area. Behind zen.profiles.single-window.enabled.
// Each Profile gets one worker that stays alive, so switching Spaces is
// instant and every bound Space's sidebar keeps updating.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  KaShortcuts: "resource:///modules/zen/KaShortcuts.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  listen: "resource:///modules/zen/ZenProfileChannel.sys.mjs",
  PAGE_BUTTONS: "resource:///modules/zen/ZenProfileChannel.sys.mjs",
});

const workers = new Map(); // profile path -> { path, process, channel, tabs, space }
let current = null; // the worker being shown
let quitObserved = false;

function profilePath(reference) {
  const dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  dir.persistentDescriptor = reference.persistentDescriptor;
  return dir.path;
}

function workerForSpace(uuid) {
  return [...workers.values()].find(w => uuid && w.space === uuid) ?? null;
}

// Pages use the manager's shortcut table with the page overrides applied.
function sendShortcuts(window, w) {
  const list = window.gZenKeyboardShortcutsManager?._currentShortcutList;
  if (list) {
    w.channel.send({
      type: "shortcuts",
      list: lazy.KaShortcuts.scopedList(window.gZenKeyboardShortcutsManager, "page").map(s => s.toJSONForm()),
    });
  }
}

let shortcutsObserved = false;
function observeShortcuts(window) {
  if (shortcutsObserved) {
    return;
  }
  shortcutsObserved = true;
  const resend = () =>
    // After the save that notified, so the list holds the change.
    Services.tm.dispatchToMainThread(() => {
      const win = Services.wm.getMostRecentBrowserWindow() ?? window;
      for (const w of workers.values()) {
        sendShortcuts(win, w);
      }
      win.gZenKeyboardShortcutsManager?.triggerShortcutRebuild();
    });
  Services.obs.addObserver(resend, "ka-shortcuts-changed");
  Services.prefs.addObserver("ka.shortcuts.", resend);
}

async function ensureWorker(window, path, rect) {
  observeShortcuts(window);
  const existing = workers.get(path);
  if (existing) {
    await existing.ready;
    Services.zen.admitProfileOverlayWorker(existing.process.pid);
    return existing;
  }
  const [service, token] = Services.zen.startProfileOverlay(window).split(" ");
  const w = { path, process: null, channel: null, tabs: [], space: null, downloads: new Map() };
  w.channel = lazy.listen(message => {
    if (message?.type === "tabs" && Array.isArray(message.tabs)) {
      if (!w.shortcutsSent) {
        w.shortcutsSent = true;
        sendShortcuts(window, w);
      }
      w.tabs = message.tabs;
      syncProxyTabs(window, w);
      Services.obs.notifyObservers(null, "zen-profile-tabs-changed");
      w.extensions = Array.isArray(message.extensions) ? message.extensions : [];
      w.shown = Array.isArray(message.shown) ? message.shown : [];
      showPageButtons(window);
      drawExtensions(window);
    } else if (message?.type === "new-window") {
      (w.window ?? window).OpenBrowserWindow({ private: !!message.private });
    } else if (message?.type === "extension-open" && current === w && typeof message.extension === "string") {
      // The extension asked for its popup (action.openPopup); open it as if
      // its button were clicked, under the pinned button or the site data one.
      const doc = w.window.document;
      const pinned = [...doc.querySelectorAll("#zen-profile-pinned-extensions > [zen-profile-extension]")].find(
        b => b.getAttribute("zen-profile-extension") === message.extension
      );
      if (pinned) {
        pinned.dispatchEvent(new w.window.CustomEvent("command"));
      } else {
        const r = doc.getElementById("zen-site-data-icon-button").getBoundingClientRect();
        w.channel.send({
          type: "extension",
          extension: message.extension,
          anchor: { x: w.window.mozInnerScreenX + r.x, y: w.window.mozInnerScreenY + r.y },
        });
        w.popupOpen = true;
        Services.zen.focusProfileOverlay();
      }
    } else if (message?.type === "cursor") {
      if (current === w) {
        Services.obs.notifyObservers(null, "zen-profile-overlay-cursor", String(message.cursor));
      }
    } else if (message?.type === "quit") {
      Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
    } else if (message?.type === "prompt") {
      askForWorker(window, w, message);
    } else if (message?.type === "download") {
      mirrorDownload(w, message);
    } else if (message?.type === "bookmarks" && Array.isArray(message.roots)) {
      w.bookmarks = message.roots;
      drawBookmarks(window);
    }
  });
  // Inherit our environment minus automation switches: a worker inheriting
  // MOZ_MARIONETTE would fight the host for its port and shut itself down.
  const environment = Object.fromEntries(
    Object.entries(lazy.Subprocess.getEnvironment()).filter(
      ([key]) => key !== "MOZ_MARIONETTE" && !key.startsWith("MOZ_REMOTE_")
    )
  );
  Object.assign(environment, {
    MOZ_APP_NO_DOCK: "1",
    ZEN_GECKO_LAYER_SERVICE: service,
    ZEN_GECKO_LAYER_TOKEN: token,
    ZEN_GECKO_LAYER_SLOT: "0",
    ZEN_GECKO_LAYER_HOST_PID: String(Services.appinfo.processID),
    ZEN_PROFILE_CHANNEL: `${w.channel.path} ${w.channel.token}`,
    // Initial size; later host resizes are forwarded over the input RPC.
    ZEN_PROFILE_OVERLAY_SIZE: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
  });
  workers.set(path, w);
  w.ready = lazy.Subprocess.call({
    command: Services.dirsvc.get("XREExeF", Ci.nsIFile).path,
    arguments: ["-no-remote", "-profile", path],
    environment,
    stderr: "stdout",
  });
  w.process = await w.ready;
  // Drain the worker's output: an unread pipe would eventually block it.
  const debug = Services.env.exists("ZEN_PROFILE_OVERLAY_DEBUG");
  (async () => {
    let chunk;
    while ((chunk = await w.process.stdout.readString())) {
      if (debug) {
        dump(chunk);
      }
    }
  })();
  Services.zen.admitProfileOverlayWorker(w.process.pid);
  if (!quitObserved) {
    quitObserved = true;
    // Workers hold their profile locks; outliving us would block the next launch.
    // A crash closes their channel, which ends them too.
    Services.obs.addObserver(stop, "quit-application");
  }
  w.process.wait().then(() => {
    w.channel.close();
    if (workers.get(path) === w) {
      workers.delete(path);
    }
    removeProxyTabs(window, w.space);
    if (current === w) {
      current = null;
      visible = false;
      Services.zen.hideProfileOverlay();
    }
  });
  return w;
}

// A worker's permission prompt, drawn by the manager as a window-modal dialog
// (a list to pick from when it has more actions than a dialog has buttons).
async function askForWorker(window, w, { key, message, actions, checkbox }) {
  if (!Number.isInteger(key) || typeof message !== "string" || !Array.isArray(actions)) {
    return;
  }
  const prompt = Services.prompt;
  if (actions.length > 3) {
    const result = await prompt.asyncSelect(
      window.browsingContext,
      prompt.MODAL_TYPE_WINDOW,
      "",
      message,
      actions.map(String)
    );
    const index = result.getProperty("ok") ? result.getProperty("selected") : -1;
    w.channel.send({ type: "prompt-answer", key, index });
    return;
  }
  const labels = actions.map(String);
  let flags = 0;
  labels.forEach((label, i) => {
    flags += prompt[`BUTTON_POS_${i}`] * prompt.BUTTON_TITLE_IS_STRING;
  });
  const result = await prompt.asyncConfirmEx(
    window.browsingContext,
    prompt.MODAL_TYPE_WINDOW,
    "",
    message,
    flags,
    labels[0] ?? null,
    labels[1] ?? null,
    labels[2] ?? null,
    typeof checkbox?.label === "string" ? checkbox.label : null,
    !!checkbox?.checked
  );
  w.channel.send({
    type: "prompt-answer",
    key,
    index: result.get("buttonNumClicked"),
    checked: result.get("checked"),
  });
}

// The current worker's extension buttons, drawn in the manager's toolbar.
function closeWorkerPopup() {
  for (const w of workers.values()) {
    if (w.popupOpen) {
      w.popupOpen = false;
      w.channel?.send({ type: "rollup" });
    }
  }
}

// Every manager window shows the current worker's extensions.
function drawExtensions() {
  for (const window of Services.wm.getEnumerator("navigator:browser")) {
    drawExtensionsIn(window);
  }
}

function drawExtensionsIn(window) {
  const { document } = window;
  let box = document.getElementById("zen-profile-extensions");
  if (!box) {
    // The worker's popup window cannot see clicks in this process: any click
    // here (or switching away) closes it, like a native panel's rollup.
    window.addEventListener("mousedown", closeWorkerPopup, true);
    window.addEventListener("popupshowing", () => drawExtensionsIn(window), true);
    window.windowUtils.loadSheetUsingURIString(
      "data:text/css," +
        encodeURIComponent(
          "#zen-profile-pinned-extensions > button { position: relative; appearance: none; border: 0; background: none; padding: 4px; border-radius: 6px; } #zen-profile-pinned-extensions > button:hover { background: var(--toolbarbutton-hover-background); } #zen-profile-pinned-extensions img { width: 16px; height: 16px; display: block; } #zen-profile-pinned-extensions span { position: absolute; right: -2px; bottom: -1px; font: 600 9px/12px sans-serif; padding: 0 3px; border-radius: 6px; background-color: var(--ka-badge-bg, #d90000); color: var(--ka-badge-fg, #fff); } [zen-profile-extension] .toolbarbutton-badge { background-color: var(--ka-badge-bg, #d90000) !important; color: var(--ka-badge-fg, #fff) !important; }"
        ),
      window.windowUtils.AUTHOR_SHEET
    );
    box = document.createXULElement("hbox");
    box.id = "zen-profile-extensions";
    box.setAttribute("align", "center");
  }
  // Zen lists extensions in the site data panel, which is built lazily.
  const slot = document.getElementById("zen-site-data-new-addon-button-container");
  if (slot && box.nextElementSibling !== slot) {
    slot.before(box);
  }
  // Pinned ones sit in the urlbar, beside the site data button.
  let pinnedBox = document.getElementById("zen-profile-pinned-extensions");
  if (!pinnedBox) {
    pinnedBox = document.createXULElement("hbox");
    pinnedBox.id = "zen-profile-pinned-extensions";
    pinnedBox.setAttribute("align", "center");
  }
  const siteData = document.getElementById("zen-site-data-icon-button")?.parentNode;
  if (siteData && pinnedBox.nextElementSibling !== siteData) {
    siteData.before(pinnedBox);
    pinnedBox.style.order = window.getComputedStyle(siteData).order;
  }
  const list = (visible && current ? current.extensions || [] : []).filter(e => typeof e?.id === "string");
  const make = e => {
    const button = e.pinned
      ? document.createElementNS("http://www.w3.org/1999/xhtml", "button")
      : document.createXULElement("toolbarbutton", { is: "toolbarbutton-badged" });
    if (e.pinned) {
      const img = document.createElementNS("http://www.w3.org/1999/xhtml", "img");
      img.src = typeof e.icon === "string" && e.icon.startsWith("data:image/") ? e.icon : "";
      button.append(img);
      if (e.badge) {
        const badge = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
        badge.textContent = String(e.badge);
        button.append(badge);
      }
      button.title = String(e.title || e.id);
      button.addEventListener("mousedown", ev => ev.stopPropagation(), true);
      button.addEventListener("click", ev => {
        ev.stopPropagation();
        button.dispatchEvent(new window.CustomEvent("command"));
      });
    } else {
      button.className = "subviewbutton toolbarbutton-1";
    }
    if (e.badge) {
      button.setAttribute("badge", String(e.badge));
      const rgba = c => (Array.isArray(c) ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] ?? 255) / 255})` : "");
      button.style.setProperty("--ka-badge-bg", rgba(e.badgeColor));
      button.style.setProperty("--ka-badge-fg", rgba(e.badgeTextColor));
    }
    button.setAttribute("zen-profile-extension", e.id);
    button.setAttribute("tooltiptext", String(e.title || e.id));
    button.setAttribute("label", String(e.title || e.id));
    if (typeof e.icon === "string" && e.icon.startsWith("data:image/")) {
      button.setAttribute("image", e.icon);
    }
    const worker = current;
    button.addEventListener("contextmenu", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      const menu = document.createXULElement("menupopup");
      const item = document.createXULElement("menuitem");
      item.setAttribute("label", e.pinned ? "Unpin from Toolbar" : "Pin to Toolbar");
      item.addEventListener("command", () =>
        worker.channel.send({ type: "extension-pin", extension: e.id, pinned: !e.pinned })
      );
      menu.append(item);
      menu.addEventListener("popuphidden", () => menu.remove());
      document.getElementById("mainPopupSet").append(menu);
      menu.openPopupAtScreen(ev.screenX, ev.screenY, true);
    });
    button.addEventListener("command", () => {
      // The worker opens its real popup under this button (screen CSS px).
      worker.channel.send({
        type: "extension",
        extension: e.id,
        anchor: {
          x: window.mozInnerScreenX + button.getBoundingClientRect().x,
          y: window.mozInnerScreenY + button.getBoundingClientRect().y,
        },
      });
      button.closest("panel")?.hidePopup();
      worker.popupOpen = true;
      Services.zen.focusProfileOverlay();
    });
    return button;
  };
  box.replaceChildren(...list.filter(e => !e.pinned).map(make));
  pinnedBox.replaceChildren(...list.filter(e => e.pinned).map(make));
}

// A worker's download, mirrored into the manager's own Downloads list so the
// regular panel/library shows progress and opens the file (same filesystem).
// Cancel/pause and resume/retry in the manager are forwarded; the worker's
// report then confirms them.
async function mirrorDownload(w, message) {
  const { key, source, target } = message;
  if (!Number.isInteger(key) || typeof source !== "string" || typeof target !== "string") {
    return;
  }
  let download = w.downloads.get(key);
  if (!download) {
    const pending = lazy.Downloads.createDownload({ source, target }).then(async d => {
      d.cancel = async () => w.channel.send({ type: "download-cancel", key });
      d.start = async () => w.channel.send({ type: "download-start", key });
      d.tryToKeepPartialData = true;
      const list = await lazy.Downloads.getList(lazy.Downloads.ALL);
      await list.add(d);
      return d;
    });
    w.downloads.set(key, pending);
    download = pending;
  }
  download = await download;
  const total = Number(message.totalBytes) || 0;
  download.currentBytes = Number(message.currentBytes) || 0;
  download.totalBytes = total;
  download.hasProgress = total > 0;
  download.progress = total > 0 ? Math.floor((download.currentBytes / total) * 100) : 0;
  download.succeeded = !!message.succeeded;
  download.canceled = !!message.canceled;
  download.error = message.failed ? new lazy.Downloads.Error({ message: "Failed in its profile" }) : null;
  download.stopped = download.succeeded || download.canceled || !!message.failed;
  download.hasPartialData = !!message.hasPartialData;
  download.target.exists = download.succeeded;
  download._notifyChange();
}

// The Bookmarks menu shows the bound Profile's bookmarks (it has the data);
// choosing one opens it there.
function drawBookmarks(window) {
  const popup = window.document.getElementById("bookmarksMenuPopup");
  if (!popup) {
    return;
  }
  popup.querySelectorAll(".ka-bookmarks").forEach(node => node.remove());
  if (!visible || !current?.bookmarks) {
    return;
  }
  const doc = window.document;
  const build = (parent, nodes) => {
    for (const node of nodes) {
      if (node.separator) {
        parent.append(doc.createXULElement("menuseparator"));
      } else if (node.children) {
        if (!node.children.length) {
          continue;
        }
        const menu = doc.createXULElement("menu");
        menu.setAttribute("label", node.title || "Folder");
        menu.className = "menu-iconic bookmark-item";
        menu.setAttribute("container", "true");
        const sub = doc.createXULElement("menupopup");
        build(sub, node.children);
        menu.append(sub);
        parent.append(menu);
      } else if (node.uri) {
        const item = doc.createXULElement("menuitem");
        item.setAttribute("label", node.title || node.uri);
        item.className = "menuitem-iconic bookmark-item";
        item.setAttribute("image", `page-icon:${node.uri}`);
        item.addEventListener("command", () =>
          current?.channel.send({ type: "open", url: node.uri })
        );
        parent.append(item);
      }
    }
  };
  const section = doc.createDocumentFragment();
  section.append(doc.createXULElement("menuseparator"));
  build(section, current.bookmarks);
  for (const node of section.children) {
    node.classList.add("ka-bookmarks");
  }
  popup.append(section);
}

const bookmarkWindows = new WeakSet();
function watchBookmarks(window) {
  const popup = window.document.getElementById("bookmarksMenuPopup");
  if (!popup || bookmarkWindows.has(window)) {
    return;
  }
  bookmarkWindows.add(window);
  popup.addEventListener("popupshowing", event => {
    if (event.target === popup) {
      drawBookmarks(window);
      current?.channel.send({ type: "bookmarks" });
    }
  });
}

function stop() {
  for (const w of workers.values()) {
    w.process?.kill();
    w.channel.close();
  }
  workers.clear();
  current = null;
  visible = false;
  Services.zen.hideProfileOverlay();
}

let visible = false;
let echoing = false; // true while we mirror worker state (do not send it back)
const resizeWindows = new WeakSet();
const PROXY = "zen-profile-proxy";

// The manager draws the worker's tabs as lazy placeholder tabs in the bound
// Space, so the regular sidebar renders them; user actions on a placeholder
// are forwarded to the worker. Placeholders never load anything themselves.
// gBrowser.tabs only covers the active Space; placeholders live in all of them.
function proxies(window, space) {
  return [...window.document.querySelectorAll(`tab[${PROXY}]`)].filter(
    tab => tab.linkedBrowser && tab.getAttribute("zen-workspace-id") === space
  );
}

function syncProxyTabs(window, w) {
  if (!w.space) {
    return;
  }
  const { gBrowser } = window;
  echoing = true;
  try {
    const byId = new Map(proxies(window, w.space).map(tab => [Number(tab.getAttribute(PROXY)), tab]));
    let selected = null;
    const ordered = [];
    for (const remote of w.tabs) {
      if (remote.essential) {
        // Shown through the manager's own Essential tab, not a placeholder.
        if (remote.selected && visible && current === w && !essentialUrl(gBrowser.selectedTab)) {
          selected = gBrowser.tabs.find(t => essentialUrl(t) === remote.essential) ?? null;
        }
        continue;
      }
      let tab = byId.get(remote.id);
      byId.delete(remote.id);
      if (!tab) {
        tab = gBrowser.addTrustedTab("about:blank", {
          createLazyBrowser: true,
          inBackground: true,
          skipAnimation: true,
          zenWorkspaceId: w.space,
        });
        tab.setAttribute(PROXY, String(remote.id));
        tab.toggleMuteAudio = () => tabAction(tab, "mute");
      }
      // addTrustedTab files new tabs under the active Space's strip even with
      // zenWorkspaceId; place it in its own Space (no-op when already there).
      window.gZenWorkspaces.moveTabToWorkspace(tab, w.space);
      const icon =
        typeof remote.icon === "string" && remote.icon.startsWith("data:image/")
          ? remote.icon
          : "";
      if (!!remote.pinned !== tab.pinned) {
        remote.pinned ? gBrowser.pinTab(tab) : gBrowser.unpinTab(tab);
      }
      mirrored.set(tab, {
        label: remote.label || remote.url,
        url: remote.url,
        icon,
        applied: mirrored.get(tab)?.applied,
        state: STATES.filter(name => remote[name]),
      });
      applyMirror(window, tab);
      if (remote.selected) {
        selected = tab;
      }
      ordered.push(tab);
    }
    // Keep the sidebar in the worker's order (pinned and unpinned tabs live in
    // separate strips, so order each group on its own).
    for (const pinned of [true, false]) {
      const want = ordered.filter(t => t.pinned === pinned);
      want.forEach((tab, i) => {
        const have = proxies(window, w.space).filter(t => t.pinned === pinned);
        if (have[i] !== tab) {
          have[i].before(tab);
        }
      });
    }
    gBrowser.tabContainer._invalidateCachedTabs();
    for (const stale of byId.values()) {
      gBrowser.removeTab(stale, { animate: false, skipPermitUnload: true });
    }
    if (selected && visible && current === w) {
      gBrowser.selectedTab = selected;
    }
  } finally {
    echoing = false;
  }
}

const mirrored = new WeakMap(); // placeholder -> { label, icon } from the worker
const STATES = ["soundplaying", "muted", "busy", "crashed"];

// Essentials are shared by all Spaces; in a bound Space one opens in the
// Space's worker, keyed by its pinned URL.
function essentialUrl(tab) {
  return tab?.hasAttribute("zen-essential")
    ? tab._zenPinnedInitialState?.entry?.url || tab.linkedBrowser?.currentURI?.spec
    : null;
}

function openEssential(window, tab) {
  const url = essentialUrl(tab);
  if (!url || echoing || !visible || !current?.space || window.gZenWorkspaces.activeWorkspace !== current.space) {
    return false;
  }
  current.channel.send({ type: "essential", url });
  return true;
}

function tabAction(tab, action) {
  workerForSpace(tab.getAttribute("zen-workspace-id"))?.channel.send({
    type: "tab",
    id: Number(tab.getAttribute(PROXY)),
    action,
  });
}

// Tab context menu items that act on a tab's page run in its worker.
const TAB_MENU = {
  context_reloadTab: "reload",
  context_reloadSelectedTabs: "reload",
  context_duplicateTab: "duplicate",
  context_duplicateTabs: "duplicate",
  context_unloadTab: "unload",
  context_bookmarkTab: "bookmark",
  context_bookmarkSelectedTabs: "bookmark",
};

function routeTabMenu(window) {
  window.document.getElementById("tabContextMenu")?.addEventListener(
    "command",
    event => {
      const context = window.TabContextMenu.contextTab;
      const action = TAB_MENU[event.target.id];
      if (!context?.hasAttribute(PROXY)) {
        return;
      }
      if (event.target.id === "context_undoCloseTab") {
        workerForSpace(context.getAttribute("zen-workspace-id"))?.channel.send({
          type: "shortcut",
          action: "History:RestoreLastClosedTabOrWindowOrSession",
        });
      } else if (!action) {
        return;
      }
      event.stopPropagation();
      const tabs = context.multiselected ? window.gBrowser.selectedTabs : [context];
      for (const tab of action ? tabs.filter(t => t.hasAttribute(PROXY)) : []) {
        tabAction(tab, action);
      }
    },
    true
  );
}

// Site data (permissions, security, extensions), reader view and PiP act on
// the worker's page: show its buttons' state, and click its own button, whose
// panel then opens under ours.
function showPageButtons(window) {
  if (!visible || !current || !window.gBrowser.selectedTab.hasAttribute(PROXY)) {
    return;
  }
  for (const id of lazy.PAGE_BUTTONS.slice(1)) {
    const button = window.document.getElementById(id);
    if (button) {
      button.hidden = !current.shown?.includes(id);
    }
  }
}

function routePageButtons(window) {
  window.addEventListener(
    "click",
    event => {
      const button = event.target.closest?.(lazy.PAGE_BUTTONS.map(id => `#${id}`).join(","));
      if (!button || !current || !window.gBrowser.selectedTab.hasAttribute(PROXY)) {
        return;
      }
      event.stopPropagation();
      current.channel.send({ type: "button", id: button.id, anchor: { x: button.screenX, y: button.screenY } });
      current.popupOpen = true;
      Services.zen.focusProfileOverlay();
    },
    true
  );
}

// Selecting a placeholder inserts its (about:blank) browser, and tabbrowser
// then retitles it "New Tab"; re-apply the worker's label/icon whenever that happens.
// Shortcuts act on whichever side owns their target: the manager owns the
// window, sidebar, Spaces and tab list; the worker owns the page. Keys typed
// into the page reach the manager first only for the manager's shortcuts.
const MANAGER_SHORTCUT =
  /^(focusURLBar|key_search2?|zen-compact-mode-.*|zen-workspace-.*|key_newNavigator(Tab)?|key_privatebrowsing|key_close(Window)?|zen-toggle-pin-tab|key_select(Tab\d|LastTab)|ka-select-(next|previous)-tab|zen-close-all-unpinned-tabs|key_preferencesCmdMac|key_quitApplication|key_hide(This|Other)AppsCmdMac|key_hideThisAppCmdMac|key_minimizeWindow|showAllHistoryKb|key_gotoHistory|zen-library-toggle|key_openDownloads|key_openAddons|key_enterFullScreen|manBookmarkKb|key_showAllTabs|zen-new-empty-split-view)$/;
const WORKER_ACTION =
  /^(Browser:(Reload|ReloadSkipCache|Back|Forward|SavePage|Stop|Screenshot|AddBookmarkAs)|cmd_find(Again|Previous|Selection)?|cmd_fullZoom(Enlarge|Reduce|Reset)|cmd_print|View:Page(Source|Info)|cmd_zenCopyCurrentURL(Markdown)?|History:RestoreLastClosedTabOrWindowOrSession|cmd_toggleMute|cmd_zenSplitView(Grid|Vertical|Horizontal|Unsplit)|cmd_zenSplitFocus\d)$/;

function findShortcut(window, mods, base, chars, vk) {
  const manager = window.gZenKeyboardShortcutsManager;
  return (manager ? lazy.KaShortcuts.scopedList(manager, "page") : undefined)?.find(
    s =>
      !s.isEmpty() &&
      !s.isDisabled() &&
      s.getModifiers().toString() === mods &&
      (s.getKeyCode() ? s.getKeyCode() === vk : [base, chars].includes(s.getKeyName()))
  );
}

// The next URL picked in the new-tab bar opens as a split in the worker; an
// empty split pane would wait on the worker's own, never shown, URL bar.
let splitNext = false;

function splitInWorker(window) {
  if (!window.gBrowser.selectedTab.hasAttribute(PROXY)) {
    return false;
  }
  splitNext = true;
  window.BrowserCommands.openTab();
  return true;
}

// History lives in the worker; show it there in a Firefox View tab.
function workerHistory(window) {
  if (!current || !window.gBrowser.selectedTab.hasAttribute(PROXY)) {
    return false;
  }
  current.channel.send({ type: "open", url: "about:firefoxview#history" });
  return true;
}

function managerOverride(window, s) {
  switch (s.getAction()) {
    case "cmd_zenNewEmptySplit":
      return splitInWorker(window);
    case "Browser:ShowAllHistory":
      return workerHistory(window);
  }
  return s.getID() === "key_gotoHistory" && workerHistory(window);
}

function routeShortcuts(window) {
  window.addEventListener("ZenURLBarClosed", event => {
    if (!event.detail?.onElementPicked) {
      splitNext = false;
    }
  });
  Services.obs.addObserver((subject, topic, data) => {
    // Every window registers this; only the one holding the overlay answers.
    if (window.closed || current?.window !== window) {
      return;
    }
    const [mods, base, chars, vk] = JSON.parse(data);
    const s = findShortcut(window, mods, base, chars, vk);
    if (s && MANAGER_SHORTCUT.test(s.getID())) {
      // Hand keyboard focus back to the manager (hiding the overlay does),
      // or the urlbar these shortcuts open closes again on blur.
      Services.zen.hideProfileOverlay();
      place(window);
      if (!managerOverride(window, s)) {
        window.document.getElementById(s.getID())?.doCommand();
      }
      subject.QueryInterface(Ci.nsISupportsPRBool).data = true;
    }
  }, "zen-profile-overlay-key");
  window.addEventListener(
    "keydown",
    event => {
      if (!window.gBrowser.selectedTab.hasAttribute(PROXY)) {
        return;
      }
      const mods = [
        event.ctrlKey && "control",
        event.metaKey && "accel",
        event.shiftKey && "shift",
        event.altKey && "alt",
      ].filter(Boolean).join(",");
      const vk = Object.keys(window.KeyboardEvent).find(
        k => k.startsWith("DOM_VK_") && window.KeyboardEvent[k] === event.keyCode
      )?.slice(4);
      const base = event.code.replace(/^(Key|Digit)/, "").toLowerCase();
      const s = findShortcut(window, mods, base, event.key.toLowerCase(), vk);
      if (s && managerOverride(window, s)) {
        event.preventDefault();
        event.stopPropagation();
      } else if (s && WORKER_ACTION.test(s.getAction())) {
        event.preventDefault();
        event.stopPropagation();
        workerForSpace(window.gBrowser.selectedTab.getAttribute("zen-workspace-id"))?.channel.send({
          type: "shortcut",
          action: s.getAction(),
        });
      }
    },
    true
  );
}

// Proxy tabs hold about:blank; show the worker's URL in the urlbar instead.
function showURL(window, tab) {
  const url = mirrored.get(tab)?.url;
  if (!url || tab !== window.gBrowser.selectedTab || window.gURLBar.focused) {
    return;
  }
  try {
    window.gURLBar.setURI({ uri: Services.io.newURI(url) });
  } catch (e) {}
}

function applyMirror(window, tab) {
  const want = mirrored.get(tab);
  if (!want) {
    return;
  }
  if (tab.label !== want.label) {
    window.gBrowser._setTabLabel(tab, want.label);
  }
  showURL(window, tab);
  for (const name of STATES) {
    tab.toggleAttribute(name, want.state.includes(name));
  }
  // tabbrowser wraps icons (moz-remote-image:), so remember what we applied.
  if (want.icon && want.applied !== want.icon) {
    want.applied = want.icon;
    window.gBrowser.setIcon(tab, want.icon);
  }
}

function removeProxyTabs(window, space) {
  echoing = true;
  try {
    for (const tab of proxies(window, space)) {
      window.gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
    }
  } finally {
    echoing = false;
  }
}

const proxyWindows = new WeakSet();
function watchProxyTabs(window) {
  if (proxyWindows.has(window)) {
    return;
  }
  proxyWindows.add(window);
  const forward = type => event => {
    const id = Number(event.target.getAttribute(PROXY));
    if (!echoing && id) {
      workerForSpace(event.target.getAttribute("zen-workspace-id"))?.channel.send({ type, id });
    }
  };
  window.gBrowser.tabContainer.addEventListener("TabSelect", forward("select"));
  window.gBrowser.tabContainer.addEventListener("TabSelect", e => {
    showURL(window, e.target);
    openEssential(window, e.target);
  });
  window.gBrowser.tabContainer.addEventListener("TabClose", forward("close"));
  // A placeholder dragged to another Space leaves its profile: the page is
  // reopened there (in that Space's worker if it is bound) and closed here.
  new window.MutationObserver(records => {
    for (const { target: tab, oldValue } of records) {
      const to = tab.getAttribute("zen-workspace-id");
      const owner = workerForSpace(oldValue);
      if (echoing || !tab.hasAttribute(PROXY) || !owner || oldValue === to) {
        continue;
      }
      const id = Number(tab.getAttribute(PROXY));
      const url = owner.tabs.find(t => t.id === id)?.url;
      owner.channel.send({ type: "close", id });
      echoing = true;
      try {
        if (url) {
          const moved = window.gBrowser.addTrustedTab(url);
          window.gZenWorkspaces.moveTabToWorkspace(moved, to);
          if (window.gBrowser.selectedTab === tab) {
            window.gBrowser.selectedTab = moved;
          }
        }
        window.gBrowser.removeTab(tab, { animate: false });
      } finally {
        echoing = false;
      }
    }
  }).observe(window.gBrowser.tabContainer, {
    subtree: true,
    attributeFilter: ["zen-workspace-id"],
    attributeOldValue: true,
  });
  // Pinning and reordering in the sidebar are the user's edits of the worker's
  // tab list; the worker's report then confirms the order.
  const space = tab => tab.getAttribute("zen-workspace-id");
  const edit = message => event => {
    const tab = event.target;
    if (echoing || !tab.hasAttribute(PROXY)) {
      return;
    }
    workerForSpace(space(tab))?.channel.send({
      id: Number(tab.getAttribute(PROXY)),
      ...message(tab),
    });
  };
  window.gBrowser.tabContainer.addEventListener("TabPinned", edit(() => ({ type: "pin", pinned: true })));
  window.gBrowser.tabContainer.addEventListener("TabUnpinned", edit(() => ({ type: "pin", pinned: false })));
  window.gBrowser.tabContainer.addEventListener(
    "TabMove",
    edit(tab => {
      const list = window.gBrowser.tabs.filter(
        t => t.hasAttribute(PROXY) && space(t) === space(tab) && t.pinned === tab.pinned
      );
      const previous = list[list.indexOf(tab) - 1];
      return { type: "move", after: previous ? Number(previous.getAttribute(PROXY)) : 0 };
    })
  );
  window.gBrowser.tabContainer.addEventListener("TabAttrModified", event => {
    if (event.target.hasAttribute(PROXY)) {
      applyMirror(window, event.target);
    }
  });
  // Loads in the bound Space belong to the worker: a placeholder's navigation
  // (URL bar) becomes "navigate", any other tab there (Cmd+T, links from other
  // apps) is handed over as "open" and dropped here.
  window.gBrowser.addTabsProgressListener({
    onStateChange(browser, webProgress, request, flags) {
      const start = Ci.nsIWebProgressListener.STATE_START;
      const document = Ci.nsIWebProgressListener.STATE_IS_DOCUMENT;
      if (!webProgress.isTopLevel || (flags & (start | document)) !== (start | document)) {
        return;
      }
      const tab = window.gBrowser.getTabForBrowser(browser);
      if (essentialUrl(tab) && openEssential(window, tab)) {
        browser.stop();
        return;
      }
      if (!tab || !inBoundSpace(tab)) {
        return;
      }
      const url = request.QueryInterface(Ci.nsIChannel).originalURI.spec;
      if (tab.hasAttribute(PROXY)) {
        if (!BLANK.test(url)) {
          browser.stop();
          current?.channel.send(
            splitNext
              ? { type: "open", url, split: true }
              : { type: "navigate", id: Number(tab.getAttribute(PROXY)), url }
          );
          splitNext = false;
        }
        return;
      }
      browser.stop();
      adopt(window, tab, url);
    },
  });
}

const BLANK = /^about:(blank|newtab|home)$/;

function inBoundSpace(tab) {
  return (
    visible &&
    !echoing &&
    current?.space &&
    tab.getAttribute("zen-workspace-id") === current.space &&
    !tab.hasAttribute("zen-empty-tab") &&
    !tab.hasAttribute("zen-essential")
  );
}

// Hand a local tab in the bound Space to the worker and drop it here.
// A blank leftover (e.g. restored at startup) is just dropped.
function adopt(window, tab, url, { keepBlank = true } = {}) {
  if (!BLANK.test(url) || keepBlank) {
    current?.channel.send({ type: "open", url: BLANK.test(url) ? "" : url, split: splitNext });
    splitNext = false;
  }
  // Move the selection onto the worker's tab first, so removing this one never
  // leaves an un-inserted placeholder selected.
  if (current) {
    syncProxyTabs(window, current);
  }
  echoing = true;
  try {
    window.gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
  } finally {
    echoing = false;
  }
}

function browserRect(window) {
  return window.document
    .getElementById("tabbrowser-tabbox")
    .getBoundingClientRect();
}

function place(window) {
  const rect = browserRect(window);
  Services.zen.showProfileOverlay(window, rect.x, rect.y, rect.width, rect.height);
}

function profileFor(service, descriptor) {
  return [...service.profiles].find(
    profile => profile.rootDir.persistentDescriptor === descriptor
  );
}

const BINDINGS_PREF = "zen.profiles.single-window.bindings";

function readBindings() {
  try {
    const value = JSON.parse(Services.prefs.getStringPref(BINDINGS_PREF, "{}"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

const l10n = () => new Localization(["browser/zen-workspaces.ftl"], true);

// Arc: a Space's Profile is chosen from the Space menu; Default unbinds.
function populateProfileMenu(window, popup, uuid) {
  const { document } = window;
  const bound = ZenProfileOverlay.boundProfile(uuid)?.persistentDescriptor;
  const item = (label, descriptor, l10nId) => {
    const menuitem = document.createXULElement("menuitem");
    if (l10nId) {
      document.l10n.setAttributes(menuitem, l10nId);
    } else {
      menuitem.setAttribute("label", label);
    }
    if (descriptor !== null) {
      menuitem.setAttribute("type", "checkbox");
      menuitem.setAttribute("zen-gecko-profile", descriptor);
      if (descriptor === (bound ?? "")) {
        menuitem.setAttribute("checked", "true");
      }
    } else {
      menuitem.setAttribute("zen-gecko-profile-new", "true");
    }
    return menuitem;
  };
  popup.replaceChildren(
    item(l10n().formatValueSync("zen-workspace-default-profile"), ""),
    ...ZenProfileOverlay.otherProfiles().map(profile => item(profile.name, profile.descriptor)),
    document.createXULElement("menuseparator"),
    item(null, null, "zen-workspaces-gecko-profile-new")
  );
}

async function bindProfile(window, menuitem, uuid) {
  let descriptor = menuitem.getAttribute("zen-gecko-profile");
  if (menuitem.hasAttribute("zen-gecko-profile-new")) {
    const name = { value: "" };
    if (
      !Services.prompt.prompt(window, menuitem.label, menuitem.label, name, null, {}) ||
      !name.value.trim()
    ) {
      return;
    }
    descriptor = ZenProfileOverlay.createProfile(name.value.trim());
  }
  ZenProfileOverlay.bindSpace(uuid, descriptor);
  const spaces = window.gZenWorkspaces;
  if (uuid === spaces.activeWorkspace) {
    await spaces.changeWorkspace(spaces.getActiveWorkspaceFromCache(), {
      alwaysChange: true,
    });
  }
}

export const ZenProfileOverlay = {
  // From gZenWorkspaces.addPopupListeners; spaceUuid() is the Space the
  // context menu is for.
  initWindow(window, spaceUuid) {
    const { document } = window;
    // Ka's Set Profile replaces Zen's per-Space container picker.
    window.windowUtils.loadSheetUsingURIString(
      "data:text/css,%23context_zenWorkspacesOpenInContainerTab%7Bdisplay:none!important%7D",
      window.windowUtils.AUTHOR_SHEET
    );
    if (this.enabled) {
      // Cmd+, and the app menu open Ka Settings; a named pane is per-Profile.
      const openPreferences = window.openPreferences;
      window.openPreferences = (pane, ...rest) =>
        pane ? openPreferences(pane, ...rest) : this.openSettings(window);
    }
    const menu = document.createXULElement("menu");
    menu.id = "context_zenWorkspaceGeckoProfile";
    document.l10n.setAttributes(menu, "zen-workspaces-panel-context-gecko-profile");
    menu.hidden = true;
    menu.append(document.createXULElement("menupopup"));
    document.getElementById("context_zenWorkspacesSeparator").before(menu);
    menu.addEventListener("popupshowing", event =>
      populateProfileMenu(window, event.target, spaceUuid())
    );
    menu.addEventListener("command", event => bindProfile(window, event.target, spaceUuid()));
    document.getElementById("zenWorkspaceMoreActions").addEventListener("popupshowing", event => {
      if (event.target.id === "zenWorkspaceMoreActions") {
        menu.hidden = !this.enabled || window.gZenWorkspaces.privateWindowOrDisabled;
      }
    });
  },

  async onSpaceChange(window, workspace) {
    if (!this.enabled) {
      return;
    }
    const bound = this.boundProfile(workspace?.uuid);
    if (bound) {
      await this.show(window, bound, workspace.uuid);
    } else {
      this.hide();
    }
  },

  // Space uuid -> other Gecko Profile. Kept in a pref, not the session: the
  // session store fails closed on Spaces it does not own.
  // Manager mode: this window only draws chrome; Spaces without a binding
  // browse in zen.profiles.manager.default-profile instead of here.
  boundProfile(uuid) {
    const descriptor = readBindings()[uuid] || (uuid && this.defaultProfile());
    return typeof descriptor === "string" && descriptor
      ? { version: 1, persistentDescriptor: descriptor }
      : null;
  },

  // First run: the manager never browses, so it creates the Profile that
  // unbound Spaces browse in. Only for an installed profile: one started with
  // -profile <dir> (tests) is not in profiles.ini and browses locally.
  defaultProfile() {
    const pref = "zen.profiles.manager.default-profile";
    let descriptor = Services.prefs.getStringPref(pref, "");
    const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
      Ci.nsIToolkitProfileService
    );
    if (!descriptor && this.enabled && service.currentProfile) {
      descriptor = this.createProfile("Personal");
      Services.prefs.setStringPref(pref, descriptor);
    }
    return descriptor;
  },

  bindSpace(uuid, descriptor) {
    const bindings = readBindings();
    if (descriptor) {
      bindings[uuid] = descriptor;
    } else {
      delete bindings[uuid];
    }
    Services.prefs.setStringPref(BINDINGS_PREF, JSON.stringify(bindings));
  },

  // Other profiles of this installation, as { name, descriptor }.
  otherProfiles() {
    const current = Services.dirsvc.get("ProfD", Ci.nsIFile);
    const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
      Ci.nsIToolkitProfileService
    );
    return [...service.profiles]
      .filter(profile => !profile.rootDir.equals(current))
      .map(profile => ({
        name: profile.name,
        descriptor: profile.rootDir.persistentDescriptor,
      }));
  },

  createProfile(name) {
    const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
      Ci.nsIToolkitProfileService
    );
    const profile = service.createProfile(null, name, "zen-space");
    service.flush();
    return profile.rootDir.persistentDescriptor;
  },

  renameProfile(descriptor, name) {
    const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
      Ci.nsIToolkitProfileService
    );
    profileFor(service, descriptor).name = name;
    service.flush();
  },

  // Spaces bound to (or defaulting to) descriptor move to moveTo; the worker
  // is stopped before its directory goes.
  async deleteProfile(descriptor, moveTo) {
    const bindings = readBindings();
    for (const uuid of Object.keys(bindings)) {
      if (bindings[uuid] === descriptor) {
        bindings[uuid] = moveTo;
      }
    }
    Services.prefs.setStringPref(BINDINGS_PREF, JSON.stringify(bindings));
    const defaultPref = "zen.profiles.manager.default-profile";
    if (Services.prefs.getStringPref(defaultPref, "") === descriptor) {
      Services.prefs.setStringPref(defaultPref, moveTo);
    }
    const w = workers.get(profilePath({ persistentDescriptor: descriptor }));
    if (w) {
      if (current === w) {
        this.hide();
      }
      w.process?.kill();
      await w.process?.wait();
    }
    const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
      Ci.nsIToolkitProfileService
    );
    profileFor(service, descriptor).remove(true);
    service.flush();
  },

  openSettings(window) {
    const open = Services.wm.getMostRecentWindow("Ka:Settings");
    if (open) {
      open.focus();
      return;
    }
    window.openDialog(
      "chrome://browser/content/zen-components/windows/ka-settings.xhtml",
      "KaSettings",
      "chrome,titlebar,resizable,centerscreen,dialog=no"
    );
  },

  get enabled() {
    // A worker shares the app's default prefs but is never a manager itself.
    return (
      AppConstants.platform === "macosx" &&
      Services.prefs.getBoolPref("zen.profiles.single-window.enabled", false) &&
      !Services.env.exists("ZEN_GECKO_LAYER_SERVICE")
    );
  },

  async show(window, reference, spaceUuid = null) {
    const rect = browserRect(window);
    watchProxyTabs(window);
    watchBookmarks(window);
    const w = await ensureWorker(window, profilePath(reference), rect);
    // ponytail: a Profile mirrors into one Space; binding it to a second Space
    // moves the sidebar copy there. Split per-Space tab sets if Arc parity needs it.
    if (w.space && w.space !== spaceUuid) {
      removeProxyTabs(window, w.space);
    }
    w.space = spaceUuid;
    if (current !== w) {
      closeWorkerPopup();
    }
    current = w;
    w.window = window;
    visible = true;
    drawExtensions(window);
    syncProxyTabs(window, w);
    place(window);
    if (!resizeWindows.has(window)) {
      resizeWindows.add(window);
      // ponytail: one overlay, moved to whichever window is focused; per-window
      // overlays if two windows must show bound Spaces side by side.
      // Deferred: activation can happen inside the old window's key handling
      // (⌘N), and moving the overlay out from under it there crashes.
      window.addEventListener("activate", () => Services.tm.dispatchToMainThread(() => {
        if (window.closed) {
          return;
        }
        const uuid = window.gZenWorkspaces.activeWorkspace;
        const bound = this.boundProfile(uuid);
        if (bound && (current?.space !== uuid || !visible)) {
          this.show(window, bound, uuid);
        } else if (bound) {
          place(window);
        }
      }));
      // Keep the worker sized to our browser area (forwarded as a resize).
      window.addEventListener("resize", () => {
        if (visible) {
          place(window);
        }
      });
      // Customize mode lives in the browser area, under the overlay.
      window.addEventListener("customizationstarting", () => Services.zen.hideProfileOverlay());
      window.addEventListener("aftercustomization", () => {
        if (visible && current?.window === window) {
          place(window);
        }
      });
      // The native overlay sits above all chrome; cut the urlbar's results
      // (drawn in our document) out of it while they are open.
      const urlbar = window.document.getElementById("urlbar");
      const hole = () => {
        const r = urlbar.getBoundingClientRect();
        Services.zen.setProfileOverlayHole(r.x, r.y, r.width, r.height);
      };
      // The floating urlbar keeps moving and growing after it opens.
      const follow = new window.ResizeObserver(hole);
      window.gURLBar.controller.addListener({
        onViewOpen: () => {
          hole();
          follow.observe(urlbar);
          window.requestAnimationFrame(hole);
        },
        onViewClose: () => {
          follow.disconnect();
          Services.zen.setProfileOverlayHole(0, 0, 0, 0);
        },
      });
      Services.obs.addObserver(() => window.gURLBar.view.close(), "zen-profile-overlay-mousedown");
      // Keep the worker's (never shown) window right under the overlay, so
      // the page's own popups (context menu, <select>, pickers) open in place.
      const align = () => {
        if (current?.window !== window) {
          return;
        }
        const r = browserRect(window);
        current?.channel.send({ type: "origin", x: window.mozInnerScreenX + r.x, y: window.mozInnerScreenY + r.y });
      };
      Services.obs.addObserver(align, "zen-profile-overlay-mouseenter");
      Services.obs.addObserver(align, "zen-profile-overlay-mousedown");
      routeShortcuts(window);
      routeTabMenu(window);
      routePageButtons(window);
      // Extensions belong to the worker's Profile: manage them there.
      const openAddonsMgr = window.BrowserAddonUI.openAddonsMgr.bind(window.BrowserAddonUI);
      window.BrowserAddonUI.openAddonsMgr = (view, options) => {
        if (current && window.gBrowser.selectedTab.hasAttribute(PROXY)) {
          current.channel.send({ type: "addons", view });
          return Promise.resolve(null);
        }
        return openAddonsMgr(view, options);
      };
      Services.obs.addObserver(() => {
        for (const worker of workers.values()) {
          worker.channel.send({ type: "rollup" });
        }
      }, "zen-profile-overlay-app-left");
      new window.ResizeObserver(() => window.gURLBar.view.isOpen && hole()).observe(urlbar);
    }
    visible = true;
    for (const tab of window.gBrowser.tabs.filter(
      t => inBoundSpace(t) && !t.hasAttribute(PROXY)
    )) {
      adopt(window, tab, tab.linkedBrowser.currentURI.spec, { keepBlank: false });
    }
  },

  reselect(window) {
    if (visible && current) {
      syncProxyTabs(window, current);
    }
  },

  hide() {
    visible = false;
    closeWorkerPopup();
    const box = Services.wm.getMostRecentBrowserWindow()?.document.getElementById("zen-profile-extensions");
    box?.replaceChildren();
    Services.zen.hideProfileOverlay();
  },

  // The bound profile's tabs, as last reported by its worker.
  get tabs() {
    return current?.tabs ?? [];
  },

  // Browsing command for the worker: {type: "select"|"close", id} or
  // {type: "open"|"navigate", url}.
  command(message) {
    current?.channel.send(message);
  },

  get workerPID() {
    return current?.process?.pid ?? 0;
  },

  // pids of all live workers (one per Profile in use).
  get workerPIDs() {
    return [...workers.values()].map(w => w.process?.pid).filter(Boolean);
  },
};
