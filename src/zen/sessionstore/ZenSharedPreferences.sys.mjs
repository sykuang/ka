/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

let owner = null;

function eligible(win, manager = win.gZenWorkspaces) {
  return !win.closed && win.gZenWorkspaces === manager &&
    win.gBrowserInit.delayedStartupFinished &&
    !manager.privateWindowOrDisabled && manager.hasIndependentCatalogProjection;
}

function refuse() {
  const error = new Error("Shared preferences owner changed or unavailable");
  error.name = "ZenSharedPreferencesRefusal";
  throw error;
}

async function presentFailure(state, status, local) {
  if (!state || !current(state)) return;
  const [win, manager] = [...state.windows].find(([window, captured]) =>
    eligible(window, captured) && !state.privateBrowsing.isWindowPrivate(window));
  const kind = ["COMMITTED", "NOOP"].includes(status) ? "not-projected" :
    status === "UNKNOWN" ? "unknown" : "local-only";
  const [title, body] = await win.document.l10n.formatValues([
    { id: "zen-shared-preferences-title" },
    { id: `zen-shared-preferences-${kind}` },
  ]);
  // Localization yields: never deliver to a retired window or changed owner.
  if (!current(state) || state.windows.get(win) !== manager || !eligible(win, manager) ||
      state.privateBrowsing.isWindowPrivate(win)) return;
  await Services.prompt.asyncConfirmEx(
    win.browsingContext, Services.prompt.MODAL_TYPE_WINDOW, title, body,
    Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_OK,
    null, null, null, null, false
  );
}

function report(state, status, local = "UNCHANGED") {
  // No pref values, profile paths or request bodies in diagnostics.
  const result = { status, local, durable: ["COMMITTED", "NOOP"].includes(status)
    ? "CONFIRMED" : status === "UNKNOWN" ? "UNCERTAIN" : "NOT_COMMITTED" };
  Services.obs.notifyObservers(null, "zen-shared-preferences-result", JSON.stringify(result));
  if (["REFUSED", "UNKNOWN"].includes(status)) {
    console.error("Zen shared preferences:", status, local, result.durable);
  }
  if (["REFUSED", "UNKNOWN"].includes(status) || local === "NOT_PROJECTED") {
    // Presentation does not own transport retirement or replay an operation.
    presentFailure(state, status, local).catch(error => Cu.reportError(error));
  }
  return result;
}

function sameProjection(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const keys = Object.keys(left);
  return Array.isArray(left) === Array.isArray(right) && keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && sameProjection(left[key], right[key]));
}

function current(state, catalog = null) {
  const marker = state.store.independentCatalogConsent;
  const root = state.service.getZenCatalogProfileDirectory();
  const profD = Services.dirsvc.get("ProfD", Ci.nsIFile);
  return owner === state && [...state.windows].some(([win, manager]) =>
    eligible(win, manager) && !state.privateBrowsing.isWindowPrivate(win)) &&
    marker !== null && state.consent !== null && marker.zenCatalogId === state.consent.zenCatalogId &&
    marker.zenCatalogRevision >= state.consent.zenCatalogRevision &&
    (!catalog || catalog.zenCatalogId === marker.zenCatalogId &&
      catalog.zenCatalogRevision >= marker.zenCatalogRevision) &&
    !state.privateBrowsing.permanentPrivateBrowsing && !state.service.isListOutdated &&
    root !== null && state.manager.equals(root) && !root.isSymlink() && root.isDirectory() &&
    state.profD.equals(profD) && profD.persistentDescriptor === state.descriptor &&
    !profD.isSymlink() && profD.isDirectory();
}

function admitCatalog(state, catalog) {
  if (!catalog || !current(state, catalog) ||
      state.catalog && (catalog.zenCatalogId !== state.catalog.zenCatalogId ||
        catalog.zenCatalogRevision < state.catalog.zenCatalogRevision ||
        catalog.zenCatalogRevision === state.catalog.zenCatalogRevision &&
          !sameProjection(catalog, state.catalog))) refuse();
  // Retain every admitted observation, including the Client's final preflight.
  state.catalog = catalog;
  return catalog;
}

async function read(state) {
  if (!current(state)) refuse();
  let catalog;
  try {
    catalog = await state.reader.readLocalProjection();
  } catch (error) {
    // Only expected schema/native/I/O failures belong to startup fallback.
    if (["NotFoundError", "NotReadableError", "OperationError", "NS_ERROR_FILE_NOT_FOUND", "SyntaxError"].includes(error.name) ||
        error.name === "TypeError" && ["Invalid Zen catalog metadata",
          "Unregistered Zen catalog browsing profile"].includes(error.message)) {
      refuse();
    }
    throw error;
  }
  // Reader validates the entire map before any preference is touched.
  return admitCatalog(state, catalog);
}

function project(state, catalog) {
  if (!current(state, catalog)) refuse();
  const values = state.reader.validateZenSharedPreferences(catalog.sharedPreferences ?? {});
  const entries = Object.entries(values).filter(([key]) => !state.edits.has(key));
  // A locked setting refuses the complete projection, never unlocks policy.
  if (entries.some(([key]) => Services.prefs.prefIsLocked(key))) refuse();
  state.applying = true;
  try {
    for (const [key, value] of entries) {
      if (!current(state, catalog)) refuse();
      if (value === null) {
        if (Services.prefs.prefHasUserValue(key)) Services.prefs.clearUserPref(key);
      } else if (typeof value === "boolean") {
        if (Services.prefs.getPrefType(key) !== Services.prefs.PREF_BOOL ||
            Services.prefs.getBoolPref(key) !== value) Services.prefs.setBoolPref(key, value);
      } else if (Services.prefs.getPrefType(key) !== Services.prefs.PREF_STRING ||
                 Services.prefs.getStringPref(key) !== value) {
        Services.prefs.setStringPref(key, value);
      }
    }
  } finally {
    state.applying = false;
  }
  state.catalog = catalog;
}

function cleanup(state) {
  if (state.windows.size) return;
  for (const key of Object.keys(state.reader.ZEN_SHARED_PREFERENCES)) {
    Services.prefs.removeObserver(key, state.observer);
  }
  state.observing = false;
  // Never retire a dispatched operation or uncertain transport lifetime.
  if (!state.work && !state.uncertain && owner === state) owner = null;
}

function schedule(state) {
  if (state.work) return state.work;
  state.work = Promise.resolve().then(async () => {
    let committed = null;
    try {
      if (state.refresh) {
        state.refresh = false;
        project(state, await read(state));
      }
      while (state.edits.size && !state.uncertain) {
        if (!current(state)) refuse();
        // Fresh CAS for each explicit change; never replay a stale request.
        const catalog = await read(state);
        const [key, value] = state.edits.entries().next().value;
        if (Services.prefs.prefIsLocked(key)) refuse();
        const request = {
          zenCatalogOperation: "preference",
          zenCatalogId: catalog.zenCatalogId,
          zenCatalogRevision: catalog.zenCatalogRevision,
          zenCatalogRequestId: Services.uuid.generateUUID().toString(),
          preference: { key, value },
        };
        // Keep the intent while awaiting: hydration cannot overwrite a newer UI edit.
        const reply = await state.client.requestZenCatalogCommit(request, prior => {
          // Match Reader's local view, not full authority against a local subset.
          admitCatalog(state, { ...prior, spaces: prior.spaces.filter(
            space => space.geckoProfileReference.persistentDescriptor === state.descriptor
          ) });
          return true;
        });
        if (reply.status === "UNKNOWN") {
          state.uncertain = request;
          report(state, "UNKNOWN", "LOCAL_ONLY");
          break;
        }
        if (!["COMMITTED", "NOOP"].includes(reply.status)) refuse();
        committed = reply.status;
        if (!current(state)) {
          state.edits.clear();
          report(state, reply.status, "NOT_PROJECTED");
          break;
        }
        const fresh = await read(state);
        if (fresh.zenCatalogId !== reply.catalog.zenCatalogId ||
            fresh.zenCatalogRevision !== reply.catalog.zenCatalogRevision ||
            fresh.zenCatalogRequestId !== reply.catalog.zenCatalogRequestId ||
            fresh.sharedPreferences?.[key] !== value) {
          // Commit is known; later authority changes are not a rollback.
          state.uncertain = request;
          report(state, reply.status, "NOT_PROJECTED");
          break;
        }
        if (state.edits.get(key) === value) state.edits.delete(key);
        project(state, fresh);
        report(state, reply.status, "PROJECTED");
        committed = null;
      }
      return { status: state.uncertain ? "UNKNOWN" : "READY" };
    } catch (error) {
      // Failed intents are retired before any callback can enqueue a new edit.
      const local = state.edits.size ? "LOCAL_ONLY" : "UNCHANGED";
      state.edits.clear();
      state.refresh = false;
      if (error.name !== "ZenSharedPreferencesRefusal") throw error;
      // Direct native UI writes already happened: refusal leaves them local,
      // not a fabricated rollback or durable success. No automatic retry.
      return committed ? report(state, committed, "NOT_PROJECTED") : report(state, "REFUSED", local);
    }
  }).finally(() => {
    state.work = null;
    cleanup(state);
    if (state.windows.size && !state.uncertain && (state.edits.size || state.refresh)) {
      schedule(state).catch(error => Cu.reportError(error));
    }
  });
  return state.work;
}

/**
 * Incremental adoption only: no first-profile seeding and no empty/default write.
 * Absent keys keep each profile's local value. Explicit reset is a null tombstone
 * clearing user values, not copying one profile's default into the authority.
 * ponytail: focus refresh, not live delivery; UNKNOWN blocks writes for this
 * module lifetime because the existing client exposes no owned-exit handle.
 */
export async function attachZenSharedPreferences(win) {
  if (!eligible(win)) return { status: "INACTIVE" };
  const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
  );
  if (PrivateBrowsingUtils.permanentPrivateBrowsing || PrivateBrowsingUtils.isWindowPrivate(win)) {
    return { status: "INACTIVE" };
  }
  if (!owner) {
    const reader = ChromeUtils.importESModule("resource:///modules/zen/ZenIndependentCatalogReader.sys.mjs");
    const client = ChromeUtils.importESModule("resource:///modules/zen/ZenIndependentCatalogClient.sys.mjs");
    const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(Ci.nsIToolkitProfileService);
    const manager = service.getZenCatalogProfileDirectory();
    if (!manager || service.isListOutdated) return report(null, "REFUSED");
    const profD = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
    const { ZenSessionStore: store } = ChromeUtils.importESModule(
      "resource:///modules/zen/ZenSessionManager.sys.mjs"
    );
    owner = { reader, client, store, consent: store.independentCatalogConsent,
      service, manager: manager.clone(), profD,
      descriptor: profD.persistentDescriptor, privateBrowsing: PrivateBrowsingUtils,
      windows: new Map(), edits: new Map(), catalog: null, work: null,
      applying: false, observing: false, uncertain: null, refresh: true };
    const state = owner;
    state.observer = { observe(_subject, topic, key) {
      if (topic !== "nsPref:changed" || state.applying ||
          !Object.hasOwn(reader.ZEN_SHARED_PREFERENCES, key)) return;
      if (!current(state)) {
        report(state, "REFUSED", "LOCAL_ONLY");
        return;
      }
      const type = reader.ZEN_SHARED_PREFERENCES[key] === "boolean" ?
        Services.prefs.PREF_BOOL : Services.prefs.PREF_STRING;
      if (Services.prefs.prefHasUserValue(key) && Services.prefs.getPrefType(key) !== type) {
        report(state, "REFUSED", "LOCAL_ONLY");
        return;
      }
      const value = !Services.prefs.prefHasUserValue(key) ? null :
        reader.ZEN_SHARED_PREFERENCES[key] === "boolean" ? Services.prefs.getBoolPref(key) : Services.prefs.getStringPref(key);
      try {
        reader.validateZenSharedPreferences({ [key]: value });
      } catch (error) {
        if (error.name !== "TypeError" || error.message !== "Invalid Zen catalog metadata") throw error;
        report(state, "REFUSED", "LOCAL_ONLY");
        return;
      }
      state.edits.set(key, value);
      if (state.uncertain) {
        report(state, "UNKNOWN", "LOCAL_ONLY");
        return;
      }
      schedule(state).catch(error => Cu.reportError(error));
    } };
  }
  const state = owner;
  if (state.windows.has(win)) return state.work || { status: "READY" };
  state.windows.set(win, win.gZenWorkspaces);
  const focus = () => {
    if (!current(state)) return;
    // Do not race a commit with a refresh or retire uncertain ownership.
    if (state.work) return;
    state.refresh = true;
    schedule(state).catch(error => Cu.reportError(error));
  };
  const unload = () => {
    state.windows.delete(win);
    win.removeEventListener("focus", focus);
    win.removeEventListener("unload", unload);
    cleanup(state);
  };
  win.addEventListener("focus", focus);
  win.addEventListener("unload", unload);
  if (!state.observing) {
    for (const key of Object.keys(state.reader.ZEN_SHARED_PREFERENCES)) {
      Services.prefs.addObserver(key, state.observer);
    }
    state.observing = true;
  }
  state.refresh = true;
  return schedule(state);
}
