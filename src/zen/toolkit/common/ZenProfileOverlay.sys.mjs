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
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  listen: "resource:///modules/zen/ZenProfileChannel.sys.mjs",
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

async function ensureWorker(window, path, rect) {
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
      w.tabs = message.tabs;
      syncProxyTabs(window, w);
      Services.obs.notifyObservers(null, "zen-profile-tabs-changed");
      w.extensions = Array.isArray(message.extensions) ? message.extensions : [];
      drawExtensions(window);
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
    // ponytail: clean quit only; a host crash still orphans them (watch the host pid in the worker if that matters).
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

// A worker's permission prompt, drawn by the manager as a window-modal dialog.
// ponytail: up to 3 buttons (confirmEx limit); extra actions are dropped.
async function askForWorker(window, w, { key, message, actions }) {
  if (!Number.isInteger(key) || typeof message !== "string" || !Array.isArray(actions)) {
    return;
  }
  const labels = actions.slice(0, 3).map(String);
  const prompt = Services.prompt;
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
    null,
    false
  );
  w.channel.send({ type: "prompt-answer", key, index: result.get("buttonNumClicked") });
}

// The current worker's extension buttons, drawn in the manager's toolbar.
function closeWorkerPopup() {
  for (const w of workers.values()) {
    if (w.popupOpen) {
      w.popupOpen = false;
      w.channel?.send({ type: "extension-close" });
    }
  }
}

function drawExtensions(window) {
  const { document } = window;
  let box = document.getElementById("zen-profile-extensions");
  if (!box) {
    // The worker's popup window cannot see clicks in this process: any click
    // here (or switching away) closes it, like a native panel's rollup.
    window.addEventListener("mousedown", closeWorkerPopup, true);
    window.addEventListener("popupshowing", () => drawExtensions(window), true);
    box = document.createXULElement("hbox");
    box.id = "zen-profile-extensions";
    box.setAttribute("align", "center");
  }
  // Zen lists extensions in the site data panel, which is built lazily.
  const slot = document.getElementById("zen-site-data-new-addon-button-container");
  if (slot && box.nextElementSibling !== slot) {
    slot.before(box);
  }
  const list = visible && current ? current.extensions || [] : [];
  box.replaceChildren(
    ...list
      .filter(e => typeof e?.id === "string")
      .map(e => {
        const button = document.createXULElement("toolbarbutton");
        button.className = "subviewbutton toolbarbutton-1";
        button.setAttribute("zen-profile-extension", e.id);
        button.setAttribute("tooltiptext", String(e.title || e.id));
        button.setAttribute("label", String(e.title || e.id));
        if (typeof e.icon === "string" && e.icon.startsWith("data:image/")) {
          button.setAttribute("image", e.icon);
        }
        const worker = current;
        button.addEventListener("command", () => {
          // The worker opens its real popup under this button (screen CSS px).
          worker.channel.send({
            type: "extension",
            extension: e.id,
            anchor: { x: button.screenX, y: button.screenY },
          });
          button.closest("panel")?.hidePopup();
          worker.popupOpen = true;
          Services.zen.focusProfileOverlay();
        });
        return button;
      })
  );
}

// A worker's download, mirrored into the manager's own Downloads list so the
// regular panel/library shows progress and opens the file (same filesystem).
// Cancel in the manager is forwarded; the worker's report then confirms it.
// ponytail: no pause/retry; worker downloads restart only from the worker.
async function mirrorDownload(w, message) {
  const { key, source, target } = message;
  if (!Number.isInteger(key) || typeof source !== "string" || typeof target !== "string") {
    return;
  }
  let download = w.downloads.get(key);
  if (!download) {
    const pending = lazy.Downloads.createDownload({ source, target }).then(async d => {
      d.cancel = async () => w.channel.send({ type: "download-cancel", key });
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
        icon,
        applied: mirrored.get(tab)?.applied,
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

// Selecting a placeholder inserts its (about:blank) browser, and tabbrowser
// then retitles it "New Tab"; re-apply the worker's label/icon whenever that happens.
function applyMirror(window, tab) {
  const want = mirrored.get(tab);
  if (!want) {
    return;
  }
  if (tab.label !== want.label) {
    window.gBrowser._setTabLabel(tab, want.label);
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
  window.gBrowser.tabContainer.addEventListener("TabClose", forward("close"));
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
      if (!tab || !inBoundSpace(tab)) {
        return;
      }
      const url = request.QueryInterface(Ci.nsIChannel).originalURI.spec;
      if (tab.hasAttribute(PROXY)) {
        if (!BLANK.test(url)) {
          browser.stop();
          current?.channel.send({ type: "navigate", id: Number(tab.getAttribute(PROXY)), url });
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
    current?.channel.send({ type: "open", url: BLANK.test(url) ? "" : url });
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

export const ZenProfileOverlay = {
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
    visible = true;
    drawExtensions(window);
    syncProxyTabs(window, w);
    place(window);
    if (!resizeWindows.has(window)) {
      resizeWindows.add(window);
      // Keep the worker sized to our browser area (forwarded as a resize).
      window.addEventListener("resize", () => {
        if (visible) {
          place(window);
        }
      });
      // The native overlay sits above all chrome; step aside while the
      // urlbar's results (drawn in our document) overlap the browser area.
      window.gURLBar.controller.addListener({
        onViewOpen: () => Services.zen.hideProfileOverlay(),
        onViewClose: () => visible && place(window),
      });
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
