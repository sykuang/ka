/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Single-window multi-Profile: a Space bound to another Gecko Profile is shown
// by running that Profile as a hidden worker and overlaying its compositor
// output on this window's browser area. Behind zen.profiles.single-window.enabled.
// ponytail: one live foreign worker at a time; switching profiles restarts it.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

let worker = null; // { path, process }
let quitObserved = false;

function profilePath(reference) {
  const dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  dir.persistentDescriptor = reference.persistentDescriptor;
  return dir.path;
}

async function ensureWorker(window, path, rect) {
  if (worker?.path === path) {
    return;
  }
  stop();
  const [service, token] = Services.zen.startProfileOverlay(window).split(" ");
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
    // Initial size; later host resizes are forwarded over the input RPC.
    ZEN_PROFILE_OVERLAY_SIZE: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
  });
  const process = await lazy.Subprocess.call({
    command: Services.dirsvc.get("XREExeF", Ci.nsIFile).path,
    arguments: ["-no-remote", "-profile", path],
    environment,
    stderr: "stdout",
  });
  // Drain the worker's output: an unread pipe would eventually block it.
  const debug = Services.env.exists("ZEN_PROFILE_OVERLAY_DEBUG");
  (async () => {
    let chunk;
    while ((chunk = await process.stdout.readString())) {
      if (debug) {
        dump(chunk);
      }
    }
  })();
  Services.zen.admitProfileOverlayWorker(process.pid);
  worker = { path, process };
  if (!quitObserved) {
    quitObserved = true;
    // The worker holds its profile lock; outliving us would block the next launch.
    // ponytail: clean quit only; a host crash still orphans it (watch the host pid in the worker if that matters).
    Services.obs.addObserver(stop, "quit-application");
  }
  process.wait().then(() => {
    if (worker?.process === process) {
      worker = null;
      Services.zen.hideProfileOverlay();
    }
  });
}

function stop() {
  worker?.process.kill();
  worker = null;
  visible = false;
  Services.zen.hideProfileOverlay();
}

let visible = false;
const resizeWindows = new WeakSet();

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
  boundProfile(uuid) {
    const descriptor = readBindings()[uuid];
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

  async show(window, reference) {
    const rect = browserRect(window);
    await ensureWorker(window, profilePath(reference), rect);
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
  },

  hide() {
    visible = false;
    Services.zen.hideProfileOverlay();
  },

  get workerPID() {
    return worker?.process.pid ?? 0;
  },
};
