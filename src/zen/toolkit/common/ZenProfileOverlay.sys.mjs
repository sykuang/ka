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
  const w = { path, process: null, channel: null, tabs: [], space: null };
  w.channel = lazy.listen(message => {
    if (message?.type === "tabs" && Array.isArray(message.tabs)) {
      w.tabs = message.tabs;
      syncProxyTabs(window, w);
      Services.obs.notifyObservers(null, "zen-profile-tabs-changed");
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
      mirrored.set(tab, {
        label: remote.label || remote.url,
        icon,
        applied: mirrored.get(tab)?.applied,
      });
      applyMirror(window, tab);
      if (remote.selected) {
        selected = tab;
      }
    }
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
    const descriptor =
      readBindings()[uuid] ||
      (uuid && Services.prefs.getStringPref("zen.profiles.manager.default-profile", ""));
    return typeof descriptor === "string" && descriptor
      ? { version: 1, persistentDescriptor: descriptor }
      : null;
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
    const profile = service.createProfile(null, name);
    service.flush();
    return profile.rootDir.persistentDescriptor;
  },

  get enabled() {
    return (
      AppConstants.platform === "macosx" &&
      Services.prefs.getBoolPref("zen.profiles.single-window.enabled", false)
    );
  },

  async show(window, reference, spaceUuid = null) {
    const rect = browserRect(window);
    watchProxyTabs(window);
    const w = await ensureWorker(window, profilePath(reference), rect);
    // ponytail: a Profile mirrors into one Space; binding it to a second Space
    // moves the sidebar copy there. Split per-Space tab sets if Arc parity needs it.
    if (w.space && w.space !== spaceUuid) {
      removeProxyTabs(window, w.space);
    }
    w.space = spaceUuid;
    current = w;
    visible = true;
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
