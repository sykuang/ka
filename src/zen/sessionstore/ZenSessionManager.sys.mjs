/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { JSONFile } from "resource://gre/modules/JSONFile.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  readLocalProjection:
    "resource:///modules/zen/ZenIndependentCatalogReader.sys.mjs",
  readCatalogMetadata:
    "resource:///modules/zen/ZenIndependentCatalogReader.sys.mjs",
  requestZenCatalogCommit:
    "resource:///modules/zen/ZenIndependentCatalogClient.sys.mjs",
  validateZenCatalogMetadata:
    "resource:///modules/zen/ZenIndependentCatalogReader.sys.mjs",
  ZenLiveFoldersManager:
    "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore:
    "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  SessionStartup:
    "moz-src:///browser/components/sessionstore/SessionStartup.sys.mjs",
  TabStateFlusher:
    "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
  gWindowSyncEnabled: "resource:///modules/zen/ZenWindowSync.sys.mjs",
  gSyncOnlyPinnedTabs: "resource:///modules/zen/ZenWindowSync.sys.mjs",
  DeferredTask: "resource://gre/modules/DeferredTask.sys.mjs",
});

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "gShouldLog",
  "zen.session-store.log",
  true
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "gMaxSessionBackups",
  "zen.session-store.max-backups",
  20
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "gBackupHourSpan",
  "zen.session-store.backup-hour-span",
  3
);

const SHOULD_BACKUP_FILE = Services.prefs.getBoolPref(
  "zen.session-store.backup-file",
  true
);
const FILE_NAME = "zen-sessions.jsonlz4";

const LAST_BUILD_ID_PREF = "zen.session-store.last-build-id";

// 'browser.startup.page' preference value to resume the previous session.
const BROWSER_STARTUP_RESUME_SESSION = 3;

// The amount of time (in milliseconds) to wait for our backup regeneration
// debouncer to kick off a regeneration.
const REGENERATION_DEBOUNCE_RATE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Class representing the sidebar object stored in the session file.
 * This object holds all the data related to tabs, groups, folders
 * and split view state.
 */
class nsZenSidebarObject {
  #sidebar = {};

  get data() {
    return Cu.cloneInto(this.#sidebar, {});
  }

  get dataWithoutCloning() {
    return this.#sidebar;
  }

  set data(data) {
    if (typeof data !== "object") {
      throw new Error("Sidebar data must be an object");
    }
    this.#sidebar = data;
  }
}

export class nsZenSessionManager {
  /**
   * The JSON file instance used to read/write session data.
   *
   * @type {JSONFile}
   */
  #file = null;
  /**
   * The sidebar object holding tabs, groups, folders and split view data.
   *
   * @type {nsZenSidebarObject}
   */
  #sidebarObject = new nsZenSidebarObject();
  /**
   * A deferred task to create backups of the session file.
   */
  #deferredBackupTask = null;
  #profileBindingBlocked = false;
  #startupAdmissionComplete = false;
  #legacyLocalCatalog = false;
  #fileReadComplete = false;
  #independentProjection = null;
  #independentActivation = null;
  #sessionSavePromise = Promise.resolve();

  get hasIndependentCatalogProjection() {
    return this.#independentProjection !== null;
  }

  get independentCatalogConsent() {
    const marker = this.#independentProjection?.marker;
    return marker ? Object.freeze({
      zenCatalogId: marker.zenCatalogId,
      zenCatalogRevision: marker.zenCatalogRevision,
    }) : null;
  }

  get canMutateWorkspaceMetadata() {
    // Ordinary fresh startup still needs local default creation.
    return (
      this.#independentProjection === null &&
      !this.#profileBindingBlocked &&
      !this.#independentActivation
    );
  }

  get independentCatalogBusy() {
    return !!this.#independentActivation?.running;
  }

  #cloneActivationSeed(win) {
    const reference = this.getCurrentProfileReference();
    const spaces = win.gZenWorkspaces.getWorkspaces().map(space => {
      if (
        !this.isLocalProfileReference(space.geckoProfileReference) ||
        space.geckoProfileReference.persistentDescriptor !==
          reference.persistentDescriptor
      ) {
        throw new TypeError("Activation seed has a different owner");
      }
      return {
        uuid: space.uuid,
        name: space.name,
        theme: space.theme,
        containerTabId: space.containerTabId,
        geckoProfileReference: reference,
        ...(Object.hasOwn(space, "icon") ? { icon: space.icon } : {}),
      };
    });
    return Cu.cloneInto(spaces, {});
  }

  #catalogOwnerSnapshot(profD, descriptor, catalog = null, previous = null, beforeRegistration = false) {
    const directory = root => {
      if (!root || root.isSymlink() || !root.isDirectory()) {
        throw new TypeError("Invalid catalog owner directory");
      }
    };
    const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
      Ci.nsIToolkitProfileService
    );
    const manager = service.getZenCatalogProfileDirectory();
    if (beforeRegistration) {
      if (manager !== null || catalog !== null) {
        throw new TypeError("Expected first catalog registration");
      }
    } else {
      directory(manager);
    }
    const currentProfD = Services.dirsvc.get("ProfD", Ci.nsIFile);
    directory(profD);
    directory(currentProfD);
    if (
      service.isListOutdated ||
      !profD.equals(currentProfD) ||
      currentProfD.persistentDescriptor !== descriptor ||
      (previous && (previous.manager === null ? manager !== null : !previous.manager.equals(manager)))
    ) {
      throw new TypeError("Stale catalog owner");
    }
    const references = new Map([
      [descriptor, { version: 1, persistentDescriptor: descriptor }],
    ]);
    for (const space of catalog?.spaces || []) {
      const reference = space.geckoProfileReference;
      if (!reference || reference.version !== 1 ||
          typeof reference.persistentDescriptor !== "string" ||
          !reference.persistentDescriptor) {
        throw new TypeError("Invalid catalog owner reference");
      }
      references.set(reference.persistentDescriptor, reference);
    }
    const roots = new Map();
    const selections = new Map();
    const fields = ["name", "path", "isRelative", "storeIDPresent", "storeID",
                    "showSelectorPresent", "showSelector"];
    // ponytail: sequential qualified selections, not an atomic pair or a lock.
    for (const [key, reference] of references) {
      const authority = {}, local = {}, name = {}, path = {}, isRelative = {};
      const storeIDPresent = {}, storeID = {}, showSelectorPresent = {}, showSelector = {};
      const outputs = [authority, local, name, path, isRelative,
        storeIDPresent, storeID, showSelectorPresent, showSelector];
      const root = beforeRegistration
        ? service.getCurrentProfileHostSelection(...outputs)
        : service.getRegisteredProfileHostSelection(key, ...outputs);
      const selection = {
        root, authority: authority.value, local: local.value,
        name: name.value, path: path.value, isRelative: isRelative.value,
        storeIDPresent: storeIDPresent.value, storeID: storeID.value,
        showSelectorPresent: showSelectorPresent.value, showSelector: showSelector.value,
      };
      for (const file of [root, selection.local, selection.authority]) {
        directory(file);
      }
      const old = previous && previous.selections.get(key);
      if (!this.isLocalProfileReference(reference, root) ||
          root.persistentDescriptor !== key ||
          (key === descriptor && (!root.equals(currentProfD) ||
            !selection.local.equals(Services.dirsvc.get("ProfLD", Ci.nsIFile)))) ||
          !["name", "path", "isRelative", "storeID", "showSelector"].every(
            field => typeof selection[field] === "string") ||
          !selection.path || !["0", "1"].includes(selection.isRelative) ||
          typeof selection.storeIDPresent !== "boolean" ||
          typeof selection.showSelectorPresent !== "boolean" ||
          (!selection.storeIDPresent && selection.storeID !== "") ||
          (!selection.showSelectorPresent && selection.showSelector !== "") ||
          (old && (!["root", "local", "authority"].every(
                     field => old[field].equals(selection[field])) ||
                   fields.some(field => old[field] !== selection[field])))) {
        throw new TypeError("Catalog owner selection changed");
      }
      // Native qualification owns ancestry, including volume roots and legal
      // own root/local nesting. Do not substitute nsIFile.contains here.
      for (const other of selections.values()) {
        if (!other.authority.equals(selection.authority) ||
            [root, selection.local].some(file =>
              [other.root, other.local].some(known => file.equals(known)))) {
          throw new TypeError("Catalog owner mapping changed");
        }
      }
      roots.set(key, root.clone());
      selections.set(key, {
        ...selection,
        root: root.clone(), local: selection.local.clone(), authority: selection.authority.clone(),
      });
    }
    const verifiedManager = service.getZenCatalogProfileDirectory();
    if (service.isListOutdated ||
        (manager === null ? verifiedManager !== null : !manager.equals(verifiedManager))) {
      throw new TypeError("Stale catalog owner registry");
    }
    return { manager: manager?.clone() ?? null, roots, selections };
  }

  #sameCatalogMetadata(left, right) {
    if (left === right) {
      return true;
    }
    if (left === null || right === null ||
        typeof left !== "object" || typeof right !== "object") {
      return false;
    }
    const keys = Object.keys(left);
    return Array.isArray(left) === Array.isArray(right) &&
      keys.length === Object.keys(right).length &&
      keys.every(key => Object.hasOwn(right, key) &&
        this.#sameCatalogMetadata(left[key], right[key]));
  }

  #admitAttachedTabs(state, spaces) {
    return (
      this.canRestoreState(state) &&
      state.windows.every(
        win =>
          !this.#isSyncingWindow(win) ||
          (win.tabs || []).every(tab =>
            tab.zenWorkspace
              ? spaces.some(space => space.uuid === tab.zenWorkspace)
              : spaces.length > 0 || this.#isBlankTabData(tab)
          )
      )
    );
  }

  /** Explicit popup consent; one process-wide slot also retains uncertain commits. */
  async activateIndependentCatalog(win, confirm) {
    const previous = this.#independentActivation;
    if (
      !this.#startupAdmissionComplete ||
      this.#profileBindingBlocked ||
      this.#independentProjection ||
      !lazy.gWindowSyncEnabled ||
      lazy.PrivateBrowsingUtils.permanentPrivateBrowsing ||
      win.closed ||
      win.gZenWorkspaces.privateWindowOrDisabled ||
      win.gZenWorkspaces.creatingWorkspaceId ||
      !win.gBrowserInit.delayedStartupFinished ||
      previous?.running
    ) {
      return { status: "REFUSED" };
    }
    const pending = {
      phase: "running",
      running: true,
      requestId: previous?.requestId,
      catalogId: previous?.catalogId,
    };
    this.#independentActivation = pending;
    let profD, descriptor, original, ownership, admittedCatalog;
    let beforeRegistration = false;
    const current = () =>
      this.#independentActivation === pending &&
      this.#startupAdmissionComplete &&
      !this.#profileBindingBlocked &&
      !win.closed &&
      !win.gZenWorkspaces.privateWindowOrDisabled &&
      lazy.gWindowSyncEnabled &&
      !lazy.PrivateBrowsingUtils.permanentPrivateBrowsing &&
      profD.equals(Services.dirsvc.get("ProfD", Ci.nsIFile)) &&
      Services.dirsvc.get("ProfD", Ci.nsIFile).persistentDescriptor === descriptor &&
      JSON.stringify(win.gZenWorkspaces.getWorkspaces()) === original;
    const recheck = () => {
      if (!current()) {
        throw new TypeError("Stale catalog confirmation");
      }
      if (ownership) {
        this.#catalogOwnerSnapshot(
          profD, descriptor, admittedCatalog, ownership, beforeRegistration
        );
      }
    };
    try {
      profD = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
      descriptor = profD.persistentDescriptor;
      original = JSON.stringify(win.gZenWorkspaces.getWorkspaces());
      const preview = await lazy.readCatalogMetadata();
      recheck();
      beforeRegistration = preview === null;
      admittedCatalog = preview;
      ownership = this.#catalogOwnerSnapshot(
        profD, descriptor, admittedCatalog, null, beforeRegistration
      );
      if (
        previous &&
        (!preview ||
          (pending.requestId &&
            preview.zenCatalogRequestId !== pending.requestId) ||
          (pending.catalogId && preview.zenCatalogId !== pending.catalogId))
      ) {
        throw new TypeError(
          "Uncertain commit not confirmed by fresh authority"
        );
      }
      if (!(await confirm(preview === null ? "activate" : "join", recheck))) {
        return { status: "CANCELLED" };
      }
      recheck();
      const fresh = await lazy.readCatalogMetadata();
      recheck();
      if (
        (fresh === null) !== (preview === null) ||
        (preview &&
          (fresh.zenCatalogId !== preview.zenCatalogId ||
            fresh.zenCatalogRevision !== preview.zenCatalogRevision ||
            fresh.zenCatalogRequestId !== preview.zenCatalogRequestId))
      ) {
        throw new TypeError("Catalog changed during confirmation");
      }
      if (!this.#sameCatalogMetadata(fresh, admittedCatalog)) {
        throw new TypeError("Catalog metadata changed during confirmation");
      }
      if (fresh === null) {
        const spaces = this.#cloneActivationSeed(win);
        recheck();
        pending.requestId = Services.uuid.generateUUID().toString();
        const reply = await lazy.requestZenCatalogCommit({
          zenCatalogOperation: "activate",
          zenCatalogRequestId: pending.requestId,
          zenCatalogRevision: 0,
          spaces,
        }, prior => {
          recheck();
          return prior === null;
        });
        if (reply.status === "UNKNOWN") {
          pending.phase = "uncertain";
          return { status: "UNKNOWN" };
        }
        if (reply.status !== "COMMITTED") {
          return { status: "REFUSED" };
        }
        pending.catalogId = reply.catalog.zenCatalogId;
        pending.phase = "partial";
        // Client's confirmed first-registration adoption changes ONLY manager
        // existence. Preserve every detached raw owner/authority/local baseline.
        const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
          Ci.nsIToolkitProfileService
        );
        const manager = service.getZenCatalogProfileDirectory();
        if (!manager) {
          throw new TypeError("Missing confirmed catalog registration");
        }
        ownership = { ...ownership, manager: manager.clone() };
        beforeRegistration = false;
        recheck();
      } else {
        pending.catalogId = fresh.zenCatalogId;
      }
      const projection = await lazy.readLocalProjection();
      recheck();
      if (
        !projection ||
        projection.zenCatalogId !== pending.catalogId ||
        (pending.requestId &&
          projection.zenCatalogRequestId !== pending.requestId)
      ) {
        throw new TypeError("Catalog readback changed");
      }
      const snapshot = await this.#persistIndependentCatalogProjection(
        projection, pending, recheck
      );
      recheck();
      if (!profD.exists() || !profD.isDirectory()) {
        throw new TypeError("Local catalog owner disappeared");
      }
      this.#catalogOwnerSnapshot(profD, descriptor, admittedCatalog, ownership);
      // Keep the complete admitted catalog for referenced-owner re-admission.
      const catalog = await lazy.readCatalogMetadata();
      recheck();
      const admitted = catalog && {
        ...catalog,
        spaces: catalog.spaces.filter(
          space =>
            space.geckoProfileReference.persistentDescriptor === descriptor
        ),
      };
      if (JSON.stringify(admitted) !== JSON.stringify(projection)) {
        throw new TypeError("Catalog changed during local persistence");
      }
      const latest = Cu.cloneInto(lazy.SessionStore.getCurrentState(true), {});
      if (!this.#admitAttachedTabs(latest, projection.spaces)) {
        throw new TypeError("Local tabs changed during attach");
      }
      recheck();
      this.#catalogOwnerSnapshot(profD, descriptor, catalog, ownership);
      this.#independentProjection = {
        spaces: Cu.cloneInto(projection.spaces, {}),
        marker: Cu.cloneInto(snapshot.zenIndependentCatalog, {}),
      };
      this.#sidebar = snapshot;
      this.#independentActivation = null;
      return { status: "ATTACHED", spaces: this.getClonedSpaces() };
    } catch (error) {
      Cu.reportError(error);
      return {
        status:
          pending.phase === "partial"
            ? "PARTIAL"
            : previous
              ? "UNKNOWN"
              : "REFUSED",
      };
    } finally {
      pending.running = false;
      if (this.#independentActivation === pending && pending.fileData) {
        this.#file.data = pending.fileData;
        delete pending.fileData;
      }
      if (
        this.#independentActivation === pending &&
        !["partial", "uncertain"].includes(pending.phase)
      ) {
        this.#independentActivation = previous || null;
      }
    }
  }

  get canCreateIndependentCatalogSpace() {
    return (
      this.#startupAdmissionComplete &&
      !this.#profileBindingBlocked &&
      !!this.#independentProjection &&
      !this.#independentActivation &&
      lazy.gWindowSyncEnabled &&
      !lazy.PrivateBrowsingUtils.permanentPrivateBrowsing
    );
  }

  renameIndependentCatalogSpace(win, uuid, name) {
    return this.#upsertIndependentCatalogSpace(win, uuid, name);
  }

  createIndependentCatalogSpace(win, draft, isCurrent) {
    if (!this.canCreateIndependentCatalogSpace || typeof isCurrent !== "function") {
      return Promise.resolve({ status: "REFUSED" });
    }
    return this.#upsertIndependentCatalogSpace(
      win, draft?.uuid, draft?.name, Cu.cloneInto(draft, {}), isCurrent
    );
  }

  /** The activation slot owns upsert uncertainty and fresh local adoption. */
  async #upsertIndependentCatalogSpace(win, uuid, name, draft = null, isCurrent = null) {
    const creating = draft !== null;
    const operation = creating ? "create" : "rename";
    const eligible = manager =>
      creating && manager === win.gZenWorkspaces
        ? manager.ownerWindow === win && !win.closed &&
          !manager.privateWindowOrDisabled &&
          win.gBrowserInit.delayedStartupFinished &&
          manager.creatingWorkspaceId === uuid && isCurrent()
        : manager.canRenameIndependentCatalogSpace;
    const previous = this.#independentActivation;
    if (
      !this.#startupAdmissionComplete ||
      this.#profileBindingBlocked ||
      !this.#independentProjection ||
      !lazy.gWindowSyncEnabled ||
      lazy.PrivateBrowsingUtils.permanentPrivateBrowsing ||
      !eligible(win.gZenWorkspaces) ||
      previous?.running ||
      typeof name !== "string" ||
      !name.trim() ||
      (previous &&
        (previous.operation !== operation ||
          previous.uuid !== uuid ||
          previous.name !== name))
    ) {
      return { status: "REFUSED" };
    }
    const pending = previous || {
      operation,
      uuid,
      name,
      phase: "running",
    };
    pending.running = true;
    this.#independentActivation = pending;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    let profD, descriptor, ownership, catalog, projection;
    const originalProjection = this.#independentProjection;
    const marker = Cu.cloneInto(originalProjection.marker, {});
    // SessionStore recollects live Space names and a fresh session.lastUpdate.
    // Metadata is checked against each manager; keep the browsing state separate.
    const localState = () => {
      const state = lazy.SessionStore.getCurrentState(true);
      const liveWindows = [...Services.wm.getEnumerator("navigator:browser")];
      return JSON.stringify(
        state.windows.map(record => {
          const { spaces, ...data } = record;
          // Match the actual SessionStore record, not window-enumerator order.
          const window = liveWindows.find(
            window => lazy.SessionStore._windows?.[window.__SSi] === record
          );
          if (window?.gZenWorkspaces) {
            // collectWindowData uses this order and omits only Firefox View.
            const tabs = window.gZenWorkspaces.allStoredTabs.filter(
              tab => tab !== window.FirefoxViewHandler.tab
            );
            data.tabs = data.tabs.map((entry, index) => {
              const tab = tabs[index];
              if (tab?.selected && tab._lastAccessed === Infinity) {
                const { TabStateCache } = ChromeUtils.importESModule(
                  "moz-src:///browser/components/sessionstore/TabStateCache.sys.mjs"
                );
                // Cached/restoring timestamps override the getter; retain them.
                if (
                  !Object.hasOwn(
                    TabStateCache.get(tab.linkedBrowser.permanentKey) || {},
                    "lastAccessed"
                  )
                ) {
                  return { ...entry, lastAccessed: "selected" };
                }
              }
              return entry;
            });
          }
          return data;
        })
      );
    };
    let originalState, windows, managers;
    let publishing = false;
    const recheck = () => {
      const currentWindows = [
        ...Services.wm.getEnumerator("navigator:browser"),
      ].filter(
        window =>
          !window.closed &&
          window.gZenWorkspaces &&
          !window.gZenWorkspaces.privateWindowOrDisabled
      );
      if (
        this.#independentActivation !== pending ||
        !this.#startupAdmissionComplete ||
        this.#profileBindingBlocked ||
        (creating && !isCurrent()) ||
        !lazy.gWindowSyncEnabled ||
        lazy.PrivateBrowsingUtils.permanentPrivateBrowsing ||
        (!publishing &&
          (this.#independentProjection !== originalProjection ||
            !same(this.#independentProjection.marker, marker))) ||
        localState() !== originalState ||
        !windows.includes(win) ||
        currentWindows.length !== windows.length ||
        currentWindows.some((window, index) => window !== windows[index]) ||
        managers.some(
          ({ window, manager, spaces, active }) =>
            window.gZenWorkspaces !== manager ||
            manager.ownerWindow !== window ||
            !eligible(manager) ||
            manager.activeWorkspace !== active ||
            (!same(manager.getWorkspaces(), spaces) &&
              !(
                publishing &&
                same(manager.getWorkspaces(), this.getClonedSpaces(spaces))
              ))
        )
      ) {
        throw new TypeError("Stale independent rename");
      }
      this.#catalogOwnerSnapshot(profD, descriptor, catalog, ownership);
    };
    try {
      originalState = localState();
      windows = [...Services.wm.getEnumerator("navigator:browser")].filter(
        window =>
          !window.closed &&
          window.gZenWorkspaces &&
          !window.gZenWorkspaces.privateWindowOrDisabled
      );
      managers = windows.map(window => ({
        window,
        manager: window.gZenWorkspaces,
        spaces: Cu.cloneInto(window.gZenWorkspaces.getWorkspaces(), {}),
        active: window.gZenWorkspaces.activeWorkspace,
      }));
      profD = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
      descriptor = profD.persistentDescriptor;
      ownership = this.#catalogOwnerSnapshot(profD, descriptor);
      recheck();
      const fresh = await lazy.readCatalogMetadata();
      recheck();
      if (!fresh || fresh.zenCatalogId !== marker.zenCatalogId) {
        throw new TypeError("Independent rename catalog changed");
      }
      catalog = fresh;
      ownership = this.#catalogOwnerSnapshot(
        profD,
        descriptor,
        catalog,
        ownership
      );
      const target = fresh.spaces.find(space => space.uuid === uuid);
      if (creating) {
        if (target || draft.geckoProfileReference?.persistentDescriptor !== descriptor ||
            !this.isLocalProfileReference(draft.geckoProfileReference)) {
          throw new TypeError("Create requires a new current-owner Space");
        }
        lazy.validateZenCatalogMetadata({ ...fresh, spaces: [...fresh.spaces, draft] });
      } else if (
        !target ||
        target.geckoProfileReference.persistentDescriptor !== descriptor ||
        !this.#independentProjection.spaces.some(space => space.uuid === uuid)
      ) {
        throw new TypeError("Rename requires an existing local Space");
      }
      if (previous) {
        if (!same(fresh, pending.expected)) {
          throw new TypeError("Uncertain rename identity not reconciled");
        }
        pending.phase = "partial";
      } else {
        const replacement = creating ? draft : { ...Cu.cloneInto(target, {}), name };
        pending.requestId = Services.uuid.generateUUID().toString();
        pending.outcome = same(replacement, target) ? "NOOP" : "COMMITTED";
        pending.expected = Cu.cloneInto(fresh, {});
        if (pending.outcome === "COMMITTED") {
          pending.expected.zenCatalogRevision++;
          pending.expected.zenCatalogRequestId = pending.requestId;
          pending.expected.spaces = creating
            ? [...Cu.cloneInto(fresh.spaces, {}), replacement]
            : fresh.spaces.map(space =>
                space.uuid === uuid ? replacement : Cu.cloneInto(space, {})
              );
        }
        recheck();
        pending.phase = "uncertain";
        const reply = await lazy.requestZenCatalogCommit({
          zenCatalogOperation: "upsert",
          zenCatalogRequestId: pending.requestId,
          zenCatalogRevision: fresh.zenCatalogRevision,
          zenCatalogId: fresh.zenCatalogId,
          space: replacement,
        }, prior => {
          recheck();
          return this.#sameCatalogMetadata(prior, catalog);
        });
        if (reply.status === "REFUSED") {
          pending.phase = "running";
          recheck();
          return { status: "REFUSED" };
        }
        if (reply.status === "UNKNOWN") {
          recheck();
          return { status: "UNKNOWN" };
        }
        pending.phase = "partial";
        recheck();
        if (
          reply.status !== pending.outcome ||
          !same(reply.catalog, pending.expected)
        ) {
          throw new TypeError("Independent rename effect mismatch");
        }
      }
      catalog = await lazy.readCatalogMetadata();
      recheck();
      if (!same(catalog, pending.expected)) {
        throw new TypeError("Independent rename readback changed");
      }
      projection = await lazy.readLocalProjection();
      recheck();
      const local = {
        ...catalog,
        spaces: catalog.spaces.filter(
          space =>
            space.geckoProfileReference.persistentDescriptor === descriptor
        ),
      };
      if (!same(projection, local)) {
        throw new TypeError("Independent rename projection changed");
      }
      const snapshot = await this.#persistIndependentCatalogProjection(
        projection,
        pending,
        recheck
      );
      recheck();
      catalog = await lazy.readCatalogMetadata();
      recheck();
      if (
        !same(catalog, pending.expected) ||
        !this.#admitAttachedTabs(
          Cu.cloneInto(lazy.SessionStore.getCurrentState(true), {}),
          projection.spaces
        )
      ) {
        throw new TypeError("Independent rename changed during persistence");
      }
      // Last read is followed by synchronous owner/generation admission, not another lease await.
      recheck();
      this.#independentProjection = {
        spaces: Cu.cloneInto(projection.spaces, {}),
        marker: Cu.cloneInto(snapshot.zenIndependentCatalog, {}),
      };
      this.#sidebar = snapshot;
      publishing = true;
      for (const { manager } of managers) {
        recheck();
        await manager.applyIndependentCatalogProjection(recheck);
        recheck();
      }
      this.#independentActivation = null;
      return { status: pending.outcome };
    } catch (error) {
      Cu.reportError(error);
      return {
        status:
          pending.phase === "partial"
            ? "PARTIAL"
            : pending.phase === "uncertain"
              ? "UNKNOWN"
              : "REFUSED",
      };
    } finally {
      pending.running = false;
      if (this.#independentActivation === pending) {
        if (Object.hasOwn(pending, "fileData")) {
          this.#file.data = pending.fileData;
          delete pending.fileData;
        }
        if (!["partial", "uncertain"].includes(pending.phase)) {
          this.#independentActivation = null;
        }
      }
    }
  }

  async #persistIndependentCatalogProjection(projection, pending, recheck) {
    this.#file._saver.disarm();
    await Promise.all([
      this.#file._saver._runningPromise,
      this.#sessionSavePromise,
    ]);
    recheck();
    // Validate the original browsing root before substituting any metadata.
    const state = Cu.cloneInto(lazy.SessionStore.getCurrentState(true), {});
    if (!this.#admitAttachedTabs(state, projection.spaces)) {
      throw new TypeError("Local tabs cannot attach to catalog");
    }
    const windows = state.windows.filter(data => this.#isSyncingWindow(data));
    if (!windows.length) {
      throw new TypeError("No local browsing snapshot");
    }
    const snapshot = this.#collectWindowData(windows, false);
    snapshot.spaces = Cu.cloneInto(projection.spaces, {});
    snapshot.activeZenSpace = windows[0].activeZenSpace;
    snapshot.selected = windows[0].selected;
    snapshot.zenIndependentCatalog = {
      version: 1,
      zenCatalogId: projection.zenCatalogId,
      zenCatalogRevision: projection.zenCatalogRevision,
    };
    // A joined authority is never rolled back if local persistence fails.
    pending.phase = "partial";
    recheck();
    pending.fileData = this.#file.data;
    this.#file.data = snapshot;
    await this.#file._save();
    recheck();
    const disk = await IOUtils.readJSON(this.#storeFilePath, {
      decompress: true,
    });
    recheck();
    if (JSON.stringify(disk) !== JSON.stringify(snapshot)) {
      throw new Error("Local catalog marker readback failed");
    }
    return snapshot;
  }

  #hasIndependentCatalogFields(data) {
    return Object.keys(data).some(
      key => key === "zenIndependentCatalog" || key.startsWith("zenCatalog")
    );
  }

  #isSyncingWindow(win, windowSyncEnabled = lazy.gWindowSyncEnabled) {
    return windowSyncEnabled && !win.isPrivate && this.#isWindowSaveable(win);
  }

  #projectState(state) {
    // Closed/deferred/LastSession records are inactive history, not the live
    // sidebar. Keep their UUIDs and metadata; restore admission still applies.
    for (const win of state?.windows || []) {
      if (this.#isSyncingWindow(win)) {
        win.spaces = this.getClonedSpaces(win.spaces);
      }
    }
    return state;
  }

  get canSaveSession() {
    return (
      this.#startupAdmissionComplete &&
      !this.#profileBindingBlocked &&
      !this.#independentActivation
    );
  }

  get isProfileBindingBlocked() {
    return this.#profileBindingBlocked;
  }

  getCurrentProfileReference() {
    return {
      version: 1,
      persistentDescriptor: Services.dirsvc.get("ProfD", Ci.nsIFile)
        .persistentDescriptor,
    };
  }

  isLocalProfileReference(reference, profileRoot) {
    if (
      !reference ||
      reference.version !== 1 ||
      typeof reference.persistentDescriptor !== "string" ||
      !reference.persistentDescriptor
    ) {
      return false;
    }
    try {
      const directory = Cc["@mozilla.org/file/local;1"].createInstance(
        Ci.nsIFile
      );
      directory.persistentDescriptor = reference.persistentDescriptor;
      if (arguments.length > 1 && !(profileRoot instanceof Ci.nsIFile)) {
        return false;
      }
      return directory.equals(
        arguments.length > 1
          ? profileRoot
          : Services.dirsvc.get("ProfD", Ci.nsIFile)
      );
    } catch {
      return false;
    }
  }

  canRestoreState(state) {
    return (
      !!state &&
      typeof state === "object" &&
      !Array.isArray(state) &&
      (!("geckoProfileBindingVersion" in state) ||
        state.geckoProfileBindingVersion === 1) &&
      ["windows", "_closedWindows"].every(
        key =>
          !(key in state) ||
          (Array.isArray(state[key]) &&
            state[key].every(win => this.canRestoreWindow(win)))
      ) &&
      ["lastSessionState", "deferredInitialState"].every(
        key => !(key in state) || this.canRestoreState(state[key])
      )
    );
  }

  canRestoreWindow(winData, context) {
    // Explicit contexts are captured inputs, not permission to borrow this owner.
    const explicit = arguments.length > 1;
    if (
      explicit &&
      (!context ||
        typeof context !== "object" ||
        Array.isArray(context) ||
        ![
          "profileRoot",
          "sidebar",
          "profileBindingBlocked",
          "independentProjection",
          "windowSyncEnabled",
        ].every(key => Object.hasOwn(context, key)) ||
        !(context.profileRoot instanceof Ci.nsIFile) ||
        typeof context.profileBindingBlocked !== "boolean" ||
        typeof context.windowSyncEnabled !== "boolean" ||
        !context.sidebar ||
        !Array.isArray(context.sidebar.tabs) ||
        ![context.sidebar, context.independentProjection].every(
          data =>
            data === null ||
            (!!data &&
              typeof data === "object" &&
              !Array.isArray(data) &&
              Array.isArray(data.spaces) &&
              data.spaces.every(
                space =>
                  !!space &&
                  typeof space === "object" &&
                  !Array.isArray(space) &&
                  typeof space.uuid === "string" &&
                  !!space.uuid &&
                  this.isLocalProfileReference(
                    space.geckoProfileReference,
                    context.profileRoot
                  )
              ))
        ))
    ) {
      return false;
    }
    if (
      (explicit ? context.profileBindingBlocked : this.#profileBindingBlocked) ||
      !winData ||
      typeof winData !== "object" ||
      Array.isArray(winData)
    ) {
      return false;
    }
    const spaces =
      "spaces" in winData
        ? winData.spaces
        : ((explicit ? context.sidebar : this.#sidebarWithoutCloning).spaces ?? []);
    return (
      Array.isArray(spaces) &&
      spaces.every(space =>
        explicit
          ? this.isLocalProfileReference(
              space?.geckoProfileReference,
              context.profileRoot
            )
          : this.isLocalProfileReference(space?.geckoProfileReference)
      ) &&
      (!("tabs" in winData) || Array.isArray(winData.tabs)) &&
      (winData.tabs || []).every(tab => {
        if (
          !(!!tab &&
            typeof tab === "object" &&
            !Array.isArray(tab) &&
            (!tab.zenWorkspace ||
              spaces.some(space => space.uuid === tab.zenWorkspace)))
        ) {
          return false;
        }
        const projection = explicit
          ? context.independentProjection
          : this.#independentProjection;
        return (
          !projection ||
          !(explicit
            ? this.#isSyncingWindow(winData, context.windowSyncEnabled)
            : this.#isSyncingWindow(winData)) ||
          (tab.zenWorkspace
            ? projection.spaces.some(space => space.uuid === tab.zenWorkspace)
            : projection.spaces.length > 0 || this.#isBlankTabData(tab))
        );
      })
    );
  }

  /**
   * Read only the explicit local primary. Two OS opens: the decoder verifies
   * its own raw buffer, not a lock or an atomic session/sidecar generation.
   */
  async readLocalSidecarFromRoot(
    profileRoot,
    { maxFileBytes, maxDecompressedBytes }
  ) {
    if (!(profileRoot instanceof Ci.nsIFile)) {
      throw new TypeError("An explicit local sidecar root is required");
    }
    const root = profileRoot.path;
    if (typeof root !== "string" || !root || !PathUtils.isAbsolute(root)) {
      throw new TypeError("An absolute local sidecar root is required");
    }
    if (![maxFileBytes, maxDecompressedBytes].every(
      cap => Number.isInteger(cap) && cap > 0 && cap <= 0xffffffff
    )) {
      throw new TypeError("Explicit positive uint32 sidecar budgets are required");
    }
    const path = PathUtils.join(root, FILE_NAME);
    const raw = await IOUtils.read(path, { maxFileBytes });
    const rawLength = raw.length;
    const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
      Ci.nsICryptoHash
    );
    hash.init(Ci.nsICryptoHash.SHA256);
    hash.update(raw, rawLength);
    const rawSHA256 = Array.from(hash.finish(false), byte =>
      byte.charCodeAt(0).toString(16).padStart(2, "0")
    ).join("");
    const parsed = await IOUtils.readJSON(path, {
      decompress: true,
      maxFileBytes,
      maxDecompressedBytes,
      expectedSHA256: rawSHA256,
    });
    return { root, path, parsed, rawSHA256, rawLength };
  }

  /**
   * Current local-v1 known envelope and ALL live candidates only. True means
   * read/retain, not whole-schema certification or restore/save permission.
   * Inactive/unknown records remain opaque; ordinary restore guards still apply.
   */
  qualifySessionData(completeDoc, context) {
    const record = value => !!value && typeof value === "object" && !Array.isArray(value);
    const fields = (data, keys, type) => keys.every(key =>
      !(key in data) || (type === "number"
        ? Number.isFinite(data[key]) : typeof data[key] === type)
    );
    if (!record(context) || ![
      "profileRoot", "sidebar", "profileBindingBlocked",
      "independentProjection", "windowSyncEnabled",
    ].every(key => Object.hasOwn(context, key)) ||
        !(context.profileRoot instanceof Ci.nsIFile) ||
        typeof context.profileBindingBlocked !== "boolean" ||
        typeof context.windowSyncEnabled !== "boolean" ||
        context.profileBindingBlocked || context.independentProjection !== null) {
      return false;
    }
    const sidecar = context.sidebar;
    if (!record(sidecar) ||
        !Object.hasOwn(sidecar, "geckoProfileBindingVersion") ||
        sidecar.geckoProfileBindingVersion !== 1 ||
        Object.hasOwn(sidecar, "version") ||
        this.#hasIndependentCatalogFields(sidecar) ||
        !Number.isFinite(sidecar.lastCollected) ||
        !Object.hasOwn(sidecar, "spaces") ||
        !Object.hasOwn(sidecar, "tabs") ||
        !Array.isArray(sidecar.spaces) || !sidecar.spaces.length ||
        !record(completeDoc) || !Object.hasOwn(completeDoc, "version") ||
        !Array.isArray(completeDoc.version) || completeDoc.version.length !== 2 ||
        completeDoc.version[0] !== "sessionrestore" || completeDoc.version[1] !== 1 ||
        ("geckoProfileBindingVersion" in completeDoc && completeDoc.geckoProfileBindingVersion !== 1) ||
        this.#hasIndependentCatalogFields(completeDoc) ||
        !Object.hasOwn(completeDoc, "windows") ||
        !Array.isArray(completeDoc.windows) || !completeDoc.windows.length ||
        !["_closedWindows", "savedGroups", "cookies"].every(key =>
          !(key in completeDoc) || Array.isArray(completeDoc[key])) ||
        !["lastSessionState", "deferredInitialState", "session", "global"].every(key =>
          !(key in completeDoc) || record(completeDoc[key]))) {
      return false;
    }
    const liveShape = win => {
      if (!record(win) || this.#hasIndependentCatalogFields(win) ||
          !Array.isArray(win.tabs) ||
          !fields(win, ["isPrivate", "isPopup", "isTaskbarTab", "isZenUnsynced"], "boolean") ||
          !fields(win, ["selected"], "number") ||
          !["_closedTabs", "closedGroups"].every(key => !(key in win) || Array.isArray(win[key]))) {
        return false;
      }
      // Only absence falls back. Explicit undefined/null/[] is never repaired.
      const spaces = "spaces" in win ? win.spaces : sidecar.spaces;
      if (!Array.isArray(spaces) || !spaces.every(space =>
        record(space) && typeof space.uuid === "string" && !!space.uuid &&
        typeof space.name === "string" &&
        fields(space, ["containerTabId"], "number") &&
        fields(space, ["hasCollapsedPinnedTabs"], "boolean") &&
        (!("theme" in space) || space.theme === null || record(space.theme)) &&
        this.isLocalProfileReference(space.geckoProfileReference, context.profileRoot)
      ) || new Set(spaces.map(space => space.uuid)).size !== spaces.length ||
          !win.tabs.every(tab => record(tab) &&
            (!("entries" in tab) || (Array.isArray(tab.entries) && tab.entries.every(entry =>
              record(entry) && typeof entry.url === "string"))) &&
            fields(tab, ["index", "lastAccessed", "userContextId", "splitViewId"], "number") &&
            ["index", "userContextId", "splitViewId"].every(key =>
              !(key in tab) || Number.isInteger(tab[key])) &&
            fields(tab, ["hidden", "pinned", "zenEssential", "zenIsEmpty"], "boolean") &&
            fields(tab, ["groupId"], "string") &&
            ["zenWorkspace", "zenSyncId"].every(key =>
              !(key in tab) || tab[key] === null || typeof tab[key] === "string"))) {
        return false;
      }
      for (const key of ["groups", "folders", "splitViewData", "splitViews"]) {
        if (!(key in win)) {
          continue;
        }
        if (!Array.isArray(win[key])) {
          return false;
        }
        const ids = new Set();
        for (const item of win[key]) {
          if (!record(item)) {
            return false;
          }
          const id = key === "splitViewData" ? item.groupId : item.id;
          if ((key === "splitViews" ? !Number.isInteger(id) : typeof id !== "string" || !id) || ids.has(id)) {
            return false;
          }
          ids.add(id);
          if (key === "splitViews") {
            if (!Number.isInteger(item.numberOfTabs) || item.numberOfTabs < 1) {
              return false;
            }
          } else if (key === "splitViewData") {
            // Current Zen tree only; legacy no-tree layouts are unsupported.
            if (!fields(item, ["gridType"], "string") ||
                !Array.isArray(item.tabs) || !item.tabs.every(tab => typeof tab === "string")) {
              return false;
            }
            const pending = [item.layoutTree], seen = new Set();
            while (pending.length) {
              const node = pending.pop();
              if (!record(node) || seen.has(node) || !fields(node, ["sizeInParent"], "number")) {
                return false;
              }
              seen.add(node);
              if (node.type === "leaf") {
                if (typeof node.tabId !== "string" || !node.tabId) {
                  return false;
                }
              } else if (node.type === "splitter" &&
                         ["row", "column"].includes(node.direction) &&
                         Array.isArray(node.children) && node.children.length) {
                for (const child of node.children) {
                  pending.push(child);
                }
              } else {
                return false;
              }
            }
          } else {
            if (!fields(item, ["name", "color"], "string") ||
                !fields(item, ["collapsed", "saveOnWindowClose", "pinned", "essential", "splitView", "splitViewGroup", "isLiveFolder"], "boolean")) {
              return false;
            }
            if (key === "folders" && (
              !Array.isArray(item.emptyTabIds) || !item.emptyTabIds.every(id => typeof id === "string") ||
              (item.workspaceId && !spaces.some(space => space.uuid === item.workspaceId)) ||
              ("workspaceId" in item && item.workspaceId !== null && typeof item.workspaceId !== "string") ||
              ("parentId" in item && item.parentId !== null && typeof item.parentId !== "string") ||
              ("prevSiblingInfo" in item && item.prevSiblingInfo !== null &&
                (!record(item.prevSiblingInfo) || !["start", "tab", "group"].includes(item.prevSiblingInfo.type) ||
                 (item.prevSiblingInfo.id !== null && typeof item.prevSiblingInfo.id !== "string"))))) {
              return false;
            }
          }
        }
      }
      return true;
    };
    return liveShape(sidecar) && completeDoc.windows.every(liveShape) &&
      this.canRestoreWindow(sidecar, context) &&
      completeDoc.windows.every(win => this.canRestoreWindow(win, context));
  }

  init() {
    this.log("Initializing session manager");
    let backupTo = null;
    if (SHOULD_BACKUP_FILE) {
      backupTo = PathUtils.join(this.#backupFolderPath, "recovery.baklz4");
    }
    this.#file = new JSONFile({
      path: this.#storeFilePath,
      compression: "lz4",
      backupTo,
      useSizeHints: Services.prefs.getBoolPref(
        "zen.session-store.use-size-hints",
        true
      ),
    });
    this.log("Session file path:", this.#file.path);
    this.#deferredBackupTask = new lazy.DeferredTask(async () => {
      await this.#createBackupsIfNeeded();
    }, REGENERATION_DEBOUNCE_RATE_MS);
  }

  log(...args) {
    if (lazy.gShouldLog) {
      // eslint-disable-next-line no-console
      console.debug("ZenSessionManager:", ...args);
    }
  }

  get #storeFilePath() {
    return PathUtils.join(PathUtils.profileDir, FILE_NAME);
  }

  get #backupFolderPath() {
    return PathUtils.join(PathUtils.profileDir, "zen-sessions-backup");
  }

  #checkReadError(error, allowSyntaxError = true) {
    if (
      lazy.gWindowSyncEnabled &&
      !lazy.PrivateBrowsingUtils.permanentPrivateBrowsing &&
      !(allowSyntaxError && error instanceof SyntaxError) &&
      !(DOMException.isInstance(error) && error.name === "NotFoundError")
    ) {
      // Unknown read failures are not recovery permission or primary consent.
      this.#profileBindingBlocked = true;
      throw error;
    }
  }

  async #getBackupRecoveryOrder() {
    // Also add the most recent backup file to the recovery order
    let backupFiles = [PathUtils.join(this.#backupFolderPath, "clean.jsonlz4")];
    let prefix = PathUtils.join(this.#backupFolderPath, "zen-sessions-");
    try {
      let files = await IOUtils.getChildren(this.#backupFolderPath);
      files = files
        .filter(file => file.startsWith(prefix))
        .sort()
        .reverse();
      if (files.length) {
        backupFiles.push(files[0]);
      }
    } catch (e) {
      this.#checkReadError(e, false);
    }
    return backupFiles;
  }

  /**
   * Gets the spaces data from the Places database for migration.
   * This is only called once during the first run after updating
   * to a version that uses the new session manager.
   */
  async #getDataFromDBForMigration() {
    try {
      const { PlacesUtils } = ChromeUtils.importESModule(
        "resource://gre/modules/PlacesUtils.sys.mjs"
      );
      const db = await PlacesUtils.promiseDBConnection();
      let data = {};
      let rows = [];
      try {
        rows = await db.execute(
          "SELECT * FROM zen_workspaces ORDER BY created_at ASC"
        );
        data.spaces = rows.map(row => ({
          uuid: row.getResultByName("uuid"),
          name: row.getResultByName("name"),
          icon: row.getResultByName("icon"),
          containerTabId: row.getResultByName("container_id") ?? 0,
          position: row.getResultByName("position"),
          geckoProfileReference: this.getCurrentProfileReference(),
          theme: row.getResultByName("theme_type")
            ? {
                type: row.getResultByName("theme_type"),
                gradientColors: JSON.parse(row.getResultByName("theme_colors")),
                opacity: row.getResultByName("theme_opacity"),
                rotation: row.getResultByName("theme_rotation"),
                texture: row.getResultByName("theme_texture"),
              }
            : null,
        }));
      } catch (e) {
        /* ignore errors reading spaces data, as it is not critical and we want to migrate even if we fail to read it */
        console.error(
          "Failed to read spaces data from database during migration",
          e
        );
      }
      try {
        rows = await db.execute("SELECT * FROM zen_pins ORDER BY position ASC");
        data.pins = rows.map(row => ({
          uuid: row.getResultByName("uuid"),
          title: row.getResultByName("title"),
          url: row.getResultByName("url"),
          containerTabId: row.getResultByName("container_id"),
          workspaceUuid: row.getResultByName("workspace_uuid"),
          position: row.getResultByName("position"),
          isEssential: Boolean(row.getResultByName("is_essential")),
          isGroup: Boolean(row.getResultByName("is_group")),
          parentUuid: row.getResultByName("folder_parent_uuid"),
          editedTitle: Boolean(row.getResultByName("edited_title")),
          folderIcon: row.getResultByName("folder_icon"),
          isFolderCollapsed: Boolean(
            row.getResultByName("is_folder_collapsed")
          ),
        }));
      } catch (e) {
        /* ignore errors reading pins data, as it is not critical and we want to migrate even if we fail to read it */
        console.error(
          "Failed to read pins data from database during migration",
          e
        );
      }
      try {
        data.recoveryData = await IOUtils.readJSON(
          PathUtils.join(
            Services.dirsvc.get("ProfD", Ci.nsIFile).path,
            "sessionstore-backups",
            "recovery.jsonlz4"
          ),
          { decompress: true }
        );
        this.log("Recovered recovery data from sessionstore-backups");
      } catch {
        /* ignore errors reading recovery data */
      }
      if (!data.recoveryData) {
        try {
          data.recoveryData = await IOUtils.readJSON(
            PathUtils.join(
              Services.dirsvc.get("ProfD", Ci.nsIFile).path,
              "sessionstore-backups",
              "recovery.jsonlz4"
            ),
            { decompress: true }
          );
          this.log("Recovered recovery data from sessionstore-backups");
        } catch {
          /* ignore errors reading recovery data */
        }
      }
      this._migrationData = data;
    } catch (e) {
      /* ignore errors during migration */
      console.error(e);
    }
  }

  async #readDataFromFile() {
    if (lazy.gWindowSyncEnabled && !lazy.PrivateBrowsingUtils.permanentPrivateBrowsing) {
      // JSONFile.load can move/copy primary bytes before returning. Independent
      // consent must come from a direct, read-only primary read, never recovery.
      let primary;
      try {
        primary = await IOUtils.readJSON(this.#storeFilePath, { decompress: true });
      } catch (e) {
        this.#checkReadError(e);
        // Missing/invalid JSON primary: inspect only the existing local recovery
        // candidates before allowing the ordinary JSONFile recovery route.
      }
      if (primary && typeof primary === "object" && !Array.isArray(primary)) {
        this.#file.data = primary;
        if (this.#hasIndependentCatalogFields(primary)) {
          this._dataFromFile = primary;
          return;
        }
      } else {
        const backups = [
          ...(SHOULD_BACKUP_FILE
            ? [PathUtils.join(this.#backupFolderPath, "recovery.baklz4")]
            : []),
          ...(await this.#getBackupRecoveryOrder()),
        ];
        for (const backup of backups) {
          try {
            const data = await IOUtils.readJSON(backup, { decompress: true });
            if (data && typeof data === "object" && this.#hasIndependentCatalogFields(data)) {
              this.#profileBindingBlocked = true;
              return;
            }
          } catch (e) {
            this.#checkReadError(e);
            // Missing/invalid JSON backups are not consent sources.
          }
        }
      }
    }
    try {
      await this.#file.load();
      this._dataFromFile = this.#file.data;
      if (this.#hasIndependentCatalogFields(this._dataFromFile)) {
        return;
      }
      if (
        !this._dataFromFile?.spaces?.length &&
        !Object.hasOwn(this._dataFromFile, "geckoProfileBindingVersion") &&
        !Object.hasOwn(this._dataFromFile, "version")
      ) {
        // Go to the catch block to try to recover from backup files
        // if the file is empty or has invalid data, as it can happen if the app
        // crashes while writing the session file.
        throw new Error("No data in session file");
      }
    } catch {
      for (const backupFile of await this.#getBackupRecoveryOrder()) {
        try {
          let data = await IOUtils.readJSON(backupFile, { decompress: true });
          if (
            lazy.gWindowSyncEnabled &&
            !lazy.PrivateBrowsingUtils.permanentPrivateBrowsing &&
            data && this.#hasIndependentCatalogFields(data)
          ) {
            this.#profileBindingBlocked = true;
            return;
          }
          this.log(`Recovered data from backup file ${backupFile}`);
          if (!data?.spaces?.length) {
            continue;
          }
          this._dataFromFile = data;
          break;
        } catch (e) {
          this.#checkReadError(e);
          console.error(`Failed to read backup file ${backupFile}`, e);
        }
      }
    }
  }

  /**
   * Reads the session file and populates the sidebar object.
   * This should be only called once at startup.
   *
   * @see SessionFileInternal.read
   */
  async readFile() {
    this.#startupAdmissionComplete = false;
    this.#fileReadComplete = false;
    this.#independentProjection = null;
    this.init();
    try {
      this.log("Reading Zen session file from disk");
      await this.#readDataFromFile();
    } catch (e) {
      console.error("ZenSessionManager: Failed to read session file", e);
    }
    if (this.#profileBindingBlocked) {
      this.#fileReadComplete = true;
      delete this._dataFromFile;
      return;
    }
    const data = this._dataFromFile || {};
    if (
      this.#hasIndependentCatalogFields(data) &&
      lazy.gWindowSyncEnabled &&
      !lazy.PrivateBrowsingUtils.permanentPrivateBrowsing
    ) {
      this.#profileBindingBlocked = false;
      try {
        const marker = data.zenIndependentCatalog;
        if (
          !Object.hasOwn(data, "zenIndependentCatalog") ||
          !marker ||
          typeof marker !== "object" ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(marker)) ||
          Reflect.ownKeys(marker).length !== 3 ||
          !["version", "zenCatalogId", "zenCatalogRevision"].every(
            key => Object.hasOwn(marker, key)
          ) ||
          marker.version !== 1 ||
          Object.keys(data).some(key => key.startsWith("zenCatalog")) ||
          data.geckoProfileBindingVersion !== 1 ||
          Object.hasOwn(data, "version") ||
          !this.canRestoreWindow(data)
        ) {
          throw new TypeError("Invalid independent catalog consent or local state");
        }
        lazy.validateZenCatalogMetadata({
          zenCatalogVersion: marker.version,
          zenCatalogId: marker.zenCatalogId,
          zenCatalogRevision: marker.zenCatalogRevision,
          zenCatalogRequestId: marker.zenCatalogId,
          spaces: [],
        });
        const projection = await lazy.readLocalProjection();
        if (!projection || projection.zenCatalogId !== marker.zenCatalogId) {
          throw new TypeError("Independent catalog unavailable or changed identity");
        }
        this.#independentProjection = {
          spaces: Cu.cloneInto(projection.spaces, {}),
          marker: {
            version: 1,
            zenCatalogId: projection.zenCatalogId,
            zenCatalogRevision: projection.zenCatalogRevision,
          },
        };
        const projected = {
          ...Cu.cloneInto(data, {}),
          spaces: this.getClonedSpaces(data.spaces),
        };
        if (!this.canRestoreWindow(projected)) {
          throw new TypeError("Local tabs unresolved in independent projection");
        }
        projected.zenIndependentCatalog = Cu.cloneInto(
          this.#independentProjection.marker, {}
        );
        this.#sidebar = projected;
      } catch (e) {
        this.#independentProjection = null;
        this.#profileBindingBlocked = true;
        this.#sidebar = data;
        console.warn("ZenSessionManager: Independent projection refused", e);
      }
      this.#fileReadComplete = true;
      delete this._dataFromFile;
      return;
    }
    // Only the old on-disk local schema is eligible for implicit ownership.
    this.#legacyLocalCatalog =
      !Object.hasOwn(data, "geckoProfileBindingVersion") &&
      !Object.hasOwn(data, "version") &&
      Number.isFinite(data.lastCollected) &&
      Array.isArray(data.spaces) &&
      Array.isArray(data.tabs) &&
      data.spaces.every(
        space =>
          space &&
          typeof space.uuid === "string" &&
          typeof space.name === "string" &&
          !Object.hasOwn(space, "geckoProfileReference")
      );
    if (this.#legacyLocalCatalog) {
      for (const space of data.spaces) {
        space.geckoProfileReference = this.getCurrentProfileReference();
      }
      data.geckoProfileBindingVersion = 1;
    }
    this.#sidebar = data;
    this.#profileBindingBlocked = false;
    this.#profileBindingBlocked =
      Object.hasOwn(data, "version") ||
      (Object.hasOwn(data, "geckoProfileBindingVersion") &&
        data.geckoProfileBindingVersion !== 1) ||
      (Object.hasOwn(data, "spaces") &&
        (data.geckoProfileBindingVersion !== 1 ||
          !this.canRestoreWindow({ spaces: data.spaces })));
    if (this.#profileBindingBlocked) {
      console.warn(
        "ZenSessionManager: Profile ownership unresolved; restore and writes blocked"
      );
    }
    if (
      !this.#profileBindingBlocked &&
      !this.#sidebarWithoutCloning.spaces?.length &&
      !this._shouldRunMigration
    ) {
      this.log(
        "No spaces data found in session file, running migration",
        this.#sidebarWithoutCloning
      );
      // If we have no spaces data, we should run migration
      // to restore them from the database. Note we also do a
      // check if we already planned to run migration for optimization.
      this._shouldRunMigration = true;
      await this.#getDataFromDBForMigration();
    }
    if (
      Services.prefs.getBoolPref("zen.session-store.log-tab-entries", false)
    ) {
      for (const tab of this.#sidebarWithoutCloning.tabs || []) {
        this.log("Tab entry in session file:", tab);
      }
    }
    delete this._dataFromFile;
    this.#fileReadComplete = true;
  }

  get #shouldRestoreOnlyPinned() {
    let buildId = Services.appinfo.platformBuildID;
    let lastBuildId = Services.prefs.getStringPref(LAST_BUILD_ID_PREF, "");
    let buildIdChanged = buildId !== lastBuildId;
    if (buildIdChanged) {
      // If the build ID has changed since the last session, it means the user has updated the app,
      // so we should not remove the unpinned tabs as they might want to keep them after the update.
      this.log(
        "Build ID has changed since last session, not restoring only pinned tabs",
        {
          buildId,
          lastBuildId,
        }
      );
      Services.prefs.setStringPref(LAST_BUILD_ID_PREF, buildId);
      return false;
    }
    return (
      Services.prefs.getIntPref("browser.startup.page", 1) !==
        BROWSER_STARTUP_RESUME_SESSION ||
      lazy.PrivateBrowsingUtils.permanentPrivateBrowsing
    );
  }

  get #shouldRestoreFromCrash() {
    return (
      lazy.SessionStartup.previousSessionCrashed &&
      Services.prefs.getBoolPref("browser.sessionstore.resume_from_crash")
    );
  }

  /**
   * Called when the session file is read. Restores the sidebar data
   * into all windows.
   *
   * @param {object} initialState
   *        The initial session state read from the session file.
   */
  onFileRead(initialState) {
    if (!this.#fileReadComplete || this.#profileBindingBlocked) {
      return initialState;
    }
    if (this.#independentProjection) {
      if (initialState && !this.canRestoreState(initialState)) {
        this.#profileBindingBlocked = true;
        return initialState;
      }
      const projected = this.#projectState(Cu.cloneInto(initialState || {}, {}));
      if (!this.canRestoreState(projected)) {
        this.#profileBindingBlocked = true;
        return initialState;
      }
      initialState = projected;
    }
    // For the first time after migration, we restore the tabs
    // That where going to be restored by SessionStore. The sidebar
    // object will always be empty after migration because we haven't
    // gotten the opportunity to save the session yet.
    if (this._shouldRunMigration) {
      initialState = this.#runStateMigration(initialState);
    }
    for (const winData of [
      ...(initialState?.windows || []),
      ...(initialState?._closedWindows || []),
    ]) {
      if (!("spaces" in winData)) {
        winData.spaces = this.getClonedSpaces();
      }
      // Window-local UUIDs never entered the old shared sidebar collector.
      const localLegacy =
        this.#legacyLocalCatalog &&
        !Object.hasOwn(initialState, "geckoProfileBindingVersion") &&
        (!Object.hasOwn(initialState, "version") ||
          (Array.isArray(initialState.version) &&
            initialState.version[0] === "sessionrestore" &&
            initialState.version[1] === 1)) &&
        winData.isZenUnsynced === true &&
        !Object.hasOwn(winData, "version") &&
        !Object.hasOwn(winData, "geckoProfileBindingVersion") &&
        Array.isArray(winData.tabs) &&
        Array.isArray(winData.spaces) &&
        winData.spaces.every(
          space =>
            space &&
            typeof space.uuid === "string" &&
            typeof space.name === "string" &&
            !Object.hasOwn(space, "geckoProfileReference")
        );
      for (const space of winData.spaces || []) {
        if (!Object.hasOwn(space, "geckoProfileReference")) {
          const known = this.#sidebarWithoutCloning.spaces?.find(
            candidate => candidate.uuid === space.uuid
          );
          if (known?.geckoProfileReference || localLegacy) {
            space.geckoProfileReference = Cu.cloneInto(
              known?.geckoProfileReference || this.getCurrentProfileReference(),
              {}
            );
          }
        }
      }
    }
    if (initialState && !this.canRestoreState(initialState)) {
      this.#profileBindingBlocked = true;
      console.warn(
        "ZenSessionManager: Startup Profile ownership unresolved; writes blocked"
      );
      return initialState;
    }
    this.#startupAdmissionComplete = true;
    if (!lazy.gWindowSyncEnabled) {
      if (initialState?.windows?.length && this.#shouldRestoreOnlyPinned) {
        this.log("Window sync disabled, restoring only pinned tabs");
        for (let i = 0; i < initialState.windows.length; i++) {
          let winData = initialState.windows[i];
          winData.tabs = (winData.tabs || []).filter(tab => tab.pinned);
        }
      }
      return initialState;
    }
    const allowRestoreUnsynced = Services.prefs.getBoolPref(
      "zen.session-store.restore-unsynced-windows",
      true
    );
    if (initialState?.windows?.length && !allowRestoreUnsynced) {
      initialState.windows = initialState.windows.filter(win => {
        if (win.isZenUnsynced) {
          this.log("Skipping unsynced window during restore");
        }
        return !win.isZenUnsynced;
      });
    }
    // If there are no windows, we create an empty one. By default,
    // firefox would create simply a new empty window, but we want
    // to make sure that the sidebar object is properly initialized.
    // This would happen on first run after having a single private window
    // open when quitting the app, for example.
    let normalWindowsExist = initialState?.windows?.some(
      win =>
        !win.isPrivate &&
        !win.isPopup &&
        !win.isTaskbarTab &&
        !win.isZenUnsynced
    );
    if (!initialState?.windows?.length || !normalWindowsExist) {
      this.log("No windows found in initial state, creating an empty one");
      initialState ||= {};
      initialState.windows ||= [];
      initialState.windows.push({
        tabs: [],
      });
    }
    return initialState;
  }

  /**
   * Called after @onFileRead, when session startup has crash checkpoint information available.
   * Restores the sidebar data into all windows, and runs any crash checkpoint related logic,
   * such as restoring only pinned tabs if the previous session was not crashed and the user
   * preference is set to do so.
   *
   * @param {object} initialState
   *        The initial session state read from the session file, possibly modified by onFileRead.
   */
  onCrashCheckpoints(initialState) {
    if (this.#profileBindingBlocked || !lazy.gWindowSyncEnabled) {
      return;
    }
    // When we don't have browser.startup.page set to resume session,
    // we only want to restore the pinned tabs into the new windows.
    if (
      this.#shouldRestoreOnlyPinned &&
      !this.#shouldRestoreFromCrash &&
      this.#sidebarWithoutCloning?.tabs
    ) {
      this.log("Restoring only pinned tabs into windows");
      const sidebar = this.#sidebarWithoutCloning;
      sidebar.tabs = (sidebar.tabs || []).filter(tab => tab.pinned);
      this.#sidebar = sidebar;
    }
    // Restore all windows with the same sidebar object, this will
    // guarantee that all tabs, groups, folders and split view data
    // are properly synced across all windows.
    if (!this._shouldRunMigration) {
      this.log(
        `Restoring Zen session data into ${initialState.windows?.length || 0} windows`
      );
      for (let i = 0; i < initialState.windows.length; i++) {
        let winData = initialState.windows[i];
        if (
          winData.isZenUnsynced ||
          winData.isPrivate ||
          winData.isPopup ||
          winData.isTaskbarTab
        ) {
          continue;
        }
        this.#restoreWindowData(winData);
      }
    } else if (initialState) {
      this.log("Saving windata state after migration");
      this.saveState(Cu.cloneInto(initialState, {}), true);
    }
    delete this._shouldRunMigration;
  }

  get #sidebar() {
    return this.#sidebarObject.data;
  }

  get #sidebarWithoutCloning() {
    return this.#sidebarObject.dataWithoutCloning;
  }

  set #sidebar(data) {
    this.#sidebarObject.data = data;
  }

  /**
   * Runs the state migration to restore spaces and pinned tabs
   * from the Places database into the initial session state.
   *
   * @param {object} initialState
   *        The initial session state read from the session file.
   */
  // eslint-disable-next-line complexity
  #runStateMigration(initialState) {
    this.log(
      "Restoring tabs from Places DB after migration",
      initialState,
      initialState?.lastSessionState,
      this._migrationData
    );
    if (!initialState?.windows?.length && this._migrationData?.recoveryData) {
      this.log("Using recovery data for migration");
      initialState = this._migrationData.recoveryData;
    }
    delete this._migrationData?.recoveryData;
    // Restore spaces into the sidebar object if we don't
    // have any yet.
    if (!this.#sidebarWithoutCloning.spaces?.length) {
      this.#sidebar = {
        ...this.#sidebar,
        spaces: this._migrationData?.spaces || [],
      };
    }
    if (
      !initialState?.windows?.length &&
      (initialState?.lastSessionState || initialState?.deferredInitialState)
    ) {
      initialState = {
        ...(initialState.lastSessionState || initialState.deferredInitialState),
      };
    }
    // There might be cases where there are no windows in the
    // initial state, for example if the user had 'restore previous
    // session' disabled before migration. In that case, we try
    // to restore the last closed normal window.
    if (!initialState?.windows?.length) {
      let normalClosedWindow = initialState?._closedWindows?.find(
        win => !win.isPopup && !win.isTaskbarTab && !win.isPrivate
      );
      if (normalClosedWindow) {
        initialState.windows = [Cu.cloneInto(normalClosedWindow, {})];
        this.log("Restoring tabs from last closed normal window");
      }
    }
    if (!initialState?.windows?.length) {
      initialState ||= {};
      initialState.windows = [
        {
          tabs: [],
        },
      ];
    }
    for (const winData of initialState?.windows || []) {
      winData.spaces =
        (winData.spaces?.length
          ? winData.spaces
          : this._migrationData?.spaces) || [];
      if (winData.tabs) {
        for (const tabData of winData.tabs) {
          let storeId = tabData.zenSyncId || tabData.zenPinnedId;
          const pinData = this._migrationData?.pins?.find(
            pin => pin.uuid === storeId
          );
          // We need to migrate the static label from the pin data as this information
          // was not stored in the session file before.
          if (pinData) {
            tabData.zenStaticLabel = pinData.editedTitle
              ? pinData.title
              : undefined;
          }
        }
      }
    }
    return initialState;
  }

  onRestoringClosedWindow(aWinData) {
    // We only want to save all pinned tabs if the user preference allows it.
    // See https://github.com/zen-browser/desktop/issues/12307
    if (this.#shouldRestoreOnlyPinned && aWinData?.tabs?.length) {
      this.log("Restoring only pinned tabs for closed window");
      this.#filterUnpinnedTabs(aWinData);
    }
  }

  /**
   * Filters out all unpinned tabs and groups from the given window data object.
   *
   * @param {object} aWindow - The window data object to filter.
   */
  #filterUnpinnedTabs(aWindow) {
    aWindow.tabs = aWindow.tabs.filter(tab => tab.pinned);
    aWindow.groups = aWindow.groups?.filter(group => group.pinned);
  }

  /**
   * Determines if a given window data object is saveable.
   *
   * @param {object} aWinData - The window data object to check.
   * @returns {boolean} True if the window is saveable, false otherwise.
   */
  #isWindowSaveable(aWinData) {
    return (
      !aWinData.isPopup && !aWinData.isTaskbarTab && !aWinData.isZenUnsynced
    );
  }

  /**
   * Saves the current session state. Collects data and writes to disk.
   *
   * @param {object} state The current session state.
   * @param {boolean} soon Whether to save the file soon or immediately.
   *        If true, the file will be saved asynchronously or when quitting
   *        the app. If false, the file will be saved immediately.
   */
  saveState(state, soon = false) {
    if (!this.canSaveSession) {
      return false;
    }
    let windows = state?.windows || [];
    windows = windows.filter(win => this.#isWindowSaveable(win));
    if (!windows.length) {
      // Don't save (or even collect) anything in permanent private
      // browsing mode. We also don't want to save if there are no windows.
      return;
    }
    if (
      !windows.every(win => this.canRestoreWindow(win)) ||
      (this.#independentProjection && !this.canRestoreState(state))
    ) {
      if (this.#independentProjection) {
        this.#profileBindingBlocked = true;
      }
      return false;
    }
    const cleanPath = PathUtils.join(this.#backupFolderPath, "clean.jsonlz4");
    IOUtils.copy(this.#storeFilePath, cleanPath, { recursive: true }).catch(
      () => {
        /* ignore errors creating clean backup, as it is not critical and
         * we want to save the session even if we fail to create it */
      }
    );
    this.#collectWindowData(windows);
    // Let interested consumers (e.g. Firefox Sync) know fresh sidebar data
    // is available, without this module knowing anything about them.
    Services.obs.notifyObservers(null, "zen-sidebar-data-collected");
    // This would save the data to disk asynchronously or when quitting the app.
    let sidebar = this.#sidebarWithoutCloning;
    this.#file.data = sidebar;
    const saved = soon ? this.#file.saveSoon() : this.#file._save();
    if (!soon) {
      this.#sessionSavePromise = Promise.all([
        this.#sessionSavePromise,
        saved,
      ]).then(
        () => {},
        () => {}
      );
    }
    lazy.ZenLiveFoldersManager.saveState(soon);
    this.#debounceRegeneration();
    this.log(`Saving Zen session data with ${sidebar.tabs?.length || 0} tabs`);
    return saved;
  }

  /**
   * Returns the sidebar data object.
   *
   * @returns {object}
   */
  getSidebarData() {
    return this.#sidebarWithoutCloning;
  }

  /**
   * Called when the last known backup should be deleted and a new one
   * created. This uses the #deferredBackupTask to debounce clusters of
   * events that might cause such a regeneration to occur.
   */
  #debounceRegeneration() {
    this.#deferredBackupTask.arm();
  }

  /**
   * Creates backups of the session file if needed. We only keep
   * a limited number of backups to avoid using too much disk space.
   * The way we are doing this is by replacing the file for today's
   * date if it already exists, otherwise we create a new one.
   * We then delete the oldest backups if we exceed the maximum
   * number of backups allowed.
   *
   * We run the next backup creation after a delay or when idling,
   * to avoid blocking the main thread during session saves.
   */
  async #createBackupsIfNeeded() {
    if (!this.canSaveSession || !SHOULD_BACKUP_FILE) {
      return;
    }
    try {
      const today = new Date();
      const backupFolder = this.#backupFolderPath;
      await IOUtils.makeDirectory(backupFolder, {
        ignoreExisting: true,
        createAncestors: true,
      });
      // Since backups from days ago are not that useful compared to more
      // recent ones, we would ideally want to keep more backups for recent days
      // and less for older ones. To achieve this, we create backups only
      // every few hours (configurable via gBackupHourSpan), so that we
      // can have multiple backups per day for recent days, but only
      // one backup per day for older days.
      // Use the local date, since the hour below is local too. Otherwise the
      // file names don't sort in the order the backups were made.
      const pad = n => String(n).padStart(2, "0");
      const year = today.getFullYear();
      const month = pad(today.getMonth() + 1);
      let dateToUse = `${year}-${month}-${pad(today.getDate())}`; // YYYY-MM-DD
      const hourSpan = Math.min(Math.max(1, lazy.gBackupHourSpan), 24);
      const backupHour = Math.floor(today.getHours() / hourSpan) * hourSpan;
      dateToUse += `-${String(backupHour).padStart(2, "0")}`;
      const todayFileName = `zen-sessions-${dateToUse}.jsonlz4`;
      const todayFilePath = PathUtils.join(backupFolder, todayFileName);
      const sessionFilePath = this.#file.path;
      this.log(`Backing up session file to ${todayFileName}`);
      await IOUtils.copy(sessionFilePath, todayFilePath, {
        noOverwrite: false,
      });
      // Now we need to check if we have exceeded the maximum
      // number of backups allowed, and delete the oldest ones
      // if needed.
      let prefix = PathUtils.join(backupFolder, "zen-sessions-");
      let files = await IOUtils.getChildren(backupFolder);
      files = files.filter(file => file.startsWith(prefix)).sort();
      for (let i = 0; i < files.length - lazy.gMaxSessionBackups; i++) {
        this.log(`Deleting old backup file ${files[i]}`);
        await IOUtils.remove(files[i]);
      }
    } catch (e) {
      console.error(
        "ZenSessionManager: Failed to create session file backups",
        e
      );
    }
  }

  /**
   * Saves the session data for a closed window if it meets the criteria.
   * See SessionStoreInternal.maybeSaveClosedWindow for more details.
   *
   * @param {object} aWinData - The window data object to save.
   * @param {boolean} isLastWindow - Whether this is the last saveable window.
   */
  maybeSaveClosedWindow(aWinData, isLastWindow) {
    // We only want to save the *last* normal window that is closed.
    // If its not the last window, we can still update the sidebar object
    // based on other open windows.
    if (
      aWinData.isPopup ||
      aWinData.isTaskbarTab ||
      aWinData.isZenUnsynced ||
      !isLastWindow
    ) {
      return;
    }
    this.log("Saving closed window session data into Zen session store");
    this.saveState({ windows: [aWinData] }, true);
  }

  /**
   * Collects session data for a given window.
   *
   * @param {object} aStateWindows The array of window state objects.
   */
  #collectWindowData(aStateWindows, publish = true) {
    // We only want to collect the sidebar data once from
    // a single window, as all windows share the same
    // sidebar data.
    let sidebarData = {};

    sidebarData.geckoProfileBindingVersion = 1;
    if (this.#independentProjection) {
      sidebarData.zenIndependentCatalog = Cu.cloneInto(
        this.#independentProjection.marker, {}
      );
      sidebarData.activeZenSpace = aStateWindows[0].activeZenSpace;
      sidebarData.selected = aStateWindows[0].selected;
    }
    sidebarData.lastCollected = Date.now();
    this.#collectTabsData(sidebarData, aStateWindows);
    if (publish) {
      this.#sidebar = sidebarData;
    }
    return sidebarData;
  }

  /**
   * Determines whether a tab should be collected based on its data.
   *
   * @param {object} tabData - The tab data object to evaluate.
   * @returns {boolean} True if the tab should be collected, false otherwise.
   */
  #shouldCollectTab(tabData) {
    if (!tabData || (tabData.zenIsEmpty && !tabData.groupId)) {
      return false;
    }
    // See gh-12152.
    let isBlank = this.#isBlankTabData(tabData);
    if (isBlank) {
      this.log("Skipping blank tab data", tabData);
    }
    return !!tabData.zenSyncId || !isBlank;
  }

  /**
   * Whether a tab's data holds nothing.
   *
   * @param {object} aTabData - A tab's collected data
   * @returns {boolean} Whether it is one of those stand-ins
   */
  #isBlankTabData(aTabData) {
    const entries = aTabData.entries || [];
    return (
      !entries.length ||
      (entries.length === 1 &&
        (() => {
          const entryUrl = entries[0].url;
          const aTabState = aTabData;
          return (
            entryUrl == "about:blank" ||
            (entryUrl == "about:home" && !aTabState.splitViewId) ||
            (entryUrl == "about:newtab" && !aTabState.splitViewId) ||
            entryUrl == "about:privatebrowsing"
          );
        })())
    );
  }

  /**
   * Decides which of a tab's two copies to keep for the session.
   *
   * @param {object} aCandidate - The copy just come across
   * @param {object} aKept - The copy held so far
   * @returns {boolean} Whether the candidate should take its place
   */
  #isBetterTabData(aCandidate, aKept) {
    // See gh-14004.
    const candidateIsBlank = this.#isBlankTabData(aCandidate);
    if (candidateIsBlank !== this.#isBlankTabData(aKept)) {
      return !candidateIsBlank;
    }
    return !!aCandidate._zenIsActiveTab;
  }

  #collectUsedTabsFromWindows(aStateWindows) {
    const tabIdRelationMap = new Map();
    for (const window of aStateWindows) {
      // Only accept the tabs with `_zenIsActiveTab` set to true from
      // every window. We do this to avoid collecting tabs with invalid
      // state when multiple windows are open. Note that if we a tab without
      // this flag set in any other window, we just add it anyway.
      for (const tabData of window.tabs || []) {
        if (!this.#shouldCollectTab(tabData)) {
          continue;
        }
        const kept = tabIdRelationMap.get(tabData.zenSyncId);
        if (!kept || this.#isBetterTabData(tabData, kept)) {
          tabIdRelationMap.set(tabData.zenSyncId, tabData);
        }
      }
    }
    return Array.from(tabIdRelationMap.values());
  }

  /**
   * Collects session data for all tabs in a given window.
   *
   * @param {object} sidebarData The sidebar data object to populate.
   * @param {object} aStateWindows The array of window state objects.
   */
  #collectTabsData(sidebarData, aStateWindows) {
    sidebarData.tabs = this.#collectUsedTabsFromWindows(aStateWindows);

    let firstWindow = aStateWindows[0];
    sidebarData.folders = firstWindow.folders;
    sidebarData.splitViewData = firstWindow.splitViewData;
    sidebarData.groups = firstWindow.groups;
    sidebarData.spaces = this.#independentProjection
      ? this.getClonedSpaces(firstWindow.spaces)
      : Cu.cloneInto(firstWindow.spaces, {});
  }

  /**
   * Restores the sidebar data into a given window data object.
   * We do this in order to make sure all new window objects
   * have the same sidebar data.
   *
   * @param {object} aWindowData The window data object to restore into.
   */
  #restoreWindowData(aWindowData) {
    const sidebar = this.#sidebar;
    if (!sidebar) {
      return;
    }
    // If we should only sync the pinned tabs, we should only edit the unpinned
    // tabs in the window data and keep the pinned tabs from the window data,
    // as they should be the same as the ones in the sidebar.
    if (lazy.gSyncOnlyPinnedTabs) {
      let pinnedTabs = (sidebar.tabs || []).filter(tab => tab.pinned);
      let unpinedWindowTabs = [];
      if (!this.#shouldRestoreOnlyPinned) {
        unpinedWindowTabs = (aWindowData.tabs || []).filter(tab => !tab.pinned);
      }
      aWindowData.tabs = [...pinnedTabs, ...unpinedWindowTabs];

      // We restore ALL the split view data in the sidebar, if the group doesn't exist in the window,
      // it should be a no-op anyways.
      aWindowData.splitViewData = [
        ...(sidebar.splitViewData || []),
        ...(aWindowData.splitViewData || []),
      ];
      // Same thing with groups, we restore all the groups from the sidebar, if they don't have any
      // existing tabs in the window, they should be a no-op.
      aWindowData.groups = [
        ...(sidebar.groups || []),
        ...(aWindowData.groups || []),
      ];
    } else {
      aWindowData.tabs = sidebar.tabs || [];
      aWindowData.splitViewData = sidebar.splitViewData;
      aWindowData.groups = sidebar.groups;
    }

    // Folders are always pinned, so we dont need to check for the pinned state here.
    aWindowData.folders = sidebar.folders;
    aWindowData.spaces = this.#independentProjection
      ? this.getClonedSpaces(aWindowData.spaces)
      : sidebar.spaces;
    this.log("Restored sidebar data into window", {
      tabs: aWindowData.tabs?.length || 0,
      groups: aWindowData.groups?.length || 0,
      folders: aWindowData.folders?.length || 0,
      spaces: aWindowData.spaces?.length || 0,
    });
  }

  /**
   * Restores a new window with Zen session data. This should be called
   * not at startup, but when a new window is opened by the user.
   *
   * @param {Window} aWindow
   *        The window to restore.
   * @param {object} SessionStoreInternal
   *        The SessionStore module instance.
   * @param {boolean} fromClosedWindow
   *        Whether this new window is being restored from a closed window.
   */
  restoreNewWindow(aWindow, SessionStoreInternal, fromClosedWindow = false) {
    if (
      this.#profileBindingBlocked ||
      aWindow.gZenWorkspaces?.privateWindowOrDisabled
    ) {
      return;
    }
    this.log("Restoring new window with Zen session data");
    const currentState = lazy.SessionStore.getCurrentState(true);
    // We want to iterate all windows except from aWindow.__SSi (string).
    // SessionStoreInternal._windows is an object, with the ID as key and the
    // window data as value, so we need to filter out the values that have the
    // same ID as aWindow.__SSi. but lets filter it into an array to make it easier to work with.
    let windows = [];
    for (const winKey of Object.keys(SessionStoreInternal._windows)) {
      const winData = SessionStoreInternal._windows[winKey];
      if (
        winData &&
        winKey !== aWindow.__SSi &&
        !winData.isPrivate &&
        !winData.isPopup &&
        !winData.isTaskbarTab &&
        !winData.isZenUnsynced
      ) {
        windows.push(winData);
      }
    }
    if (
      this.#independentProjection &&
      !windows.every(win => this.canRestoreWindow(win))
    ) {
      return;
    }
    let windowToClone = windows[0] || {};
    let newWindow = Cu.cloneInto(windowToClone, {});
    newWindow.tabs = this.#collectUsedTabsFromWindows(windows);
    if (this.#independentProjection) {
      newWindow.tabs = Cu.cloneInto(newWindow.tabs, {});
      newWindow.spaces = this.getClonedSpaces(newWindow.spaces);
    }
    let shouldRestoreOnlyPinned =
      !lazy.gWindowSyncEnabled || lazy.gSyncOnlyPinnedTabs;
    if (windows.length < 1) {
      // We only want to restore the sidebar object if we found
      // only one normal window to clone from (which is the one
      // we are opening).
      this.log("Restoring sidebar data into new window");
      this.#restoreWindowData(newWindow);
      shouldRestoreOnlyPinned ||= this.#shouldRestoreOnlyPinned;
    }
    if (shouldRestoreOnlyPinned) {
      // Don't bring over any unpinned tabs if window sync is disabled or if syncing only pinned tabs.
      this.#filterUnpinnedTabs(newWindow);
    }

    // These are window-specific from the previous window state that
    // we don't want to restore into the new window. Otherwise, new
    // windows would appear overlapping the previous one, or with
    // the same size and position, which should be decided by the
    // window manager.
    if (!fromClosedWindow) {
      delete newWindow.selected;
      delete newWindow.screenX;
      delete newWindow.screenY;
      delete newWindow.width;
      delete newWindow.height;
      delete newWindow.sizemode;
      delete newWindow.sizemodeBeforeMinimized;
      delete newWindow.zIndex;
      delete newWindow.workspaceID;
    }

    const newState = {
      windows: [newWindow],
      global: Cu.cloneInto(currentState.global, {}),
    };
    if (!this.canRestoreState(newState)) {
      this.onNewEmptySession(aWindow);
      return;
    }
    this.log(`Cloning window with ${newWindow.tabs.length} tabs`);

    SessionStoreInternal._deferredInitialState = newState;
    SessionStoreInternal.initializeWindow(aWindow, newState);
    this.#refreshRestoredTabsState(aWindow, SessionStoreInternal).catch(e =>
      console.error("ZenSessionManager: Failed to refresh restored tabs", e)
    );
  }

  /**
   * The state we clone into a new window comes from the parent process
   * cache, which may lag behind the content processes (e.g. for a tab that
   * was opened or navigated right before opening the new window). After the
   * new window has been restored, flush the previous window and update each
   * counterpart tab that hasn't started loading yet.
   *
   * @param {Window} aWindow
   *        The newly restored window.
   * @param {object} SessionStoreInternal
   *        The SessionStore module instance.
   */
  async #refreshRestoredTabsState(aWindow, SessionStoreInternal) {
    // Wait until the tabs have actually been created in the new window.
    await aWindow.gZenWorkspaces.promiseInitialized;
    if (aWindow.closed) {
      return;
    }
    // Only refresh from the most recently used window: any other window
    // already reported its state when it lost focus, so the cloned data
    // is up to date for it.
    let previousWindow = null;
    for (const win of SessionStoreInternal._browserWindows) {
      if (win !== aWindow && !win.closed) {
        previousWindow = win;
        break;
      }
    }
    if (!previousWindow) {
      return;
    }
    for (const tab of previousWindow.gZenWorkspaces.allStoredTabs) {
      const syncId = tab.getAttribute("id");
      // A tab that has never loaded has no state in the content process,
      // so there's nothing newer to flush out of it.
      if (!syncId || tab.closing || !tab.linkedPanel) {
        continue;
      }
      const targetTab = aWindow.document.getElementById(syncId);
      // Only refresh a tab that hasn't started loading: setting the state
      // of a loaded tab would reload it.
      if (
        !aWindow.gBrowser.isTab(targetTab) ||
        targetTab.linkedPanel ||
        targetTab.closing
      ) {
        continue;
      }
      lazy.TabStateFlusher.flush(tab.linkedBrowser)
        .then(() => {
          // Things may have changed while the flush was in flight.
          if (
            aWindow.closed ||
            tab.closing ||
            targetTab.linkedPanel ||
            targetTab.closing
          ) {
            return;
          }
          lazy.SessionStore.setTabState(
            targetTab,
            lazy.SessionStore.getTabState(tab)
          );
        })
        .catch(e =>
          console.error("ZenSessionManager: Failed to refresh tab state", e)
        );
    }
  }

  /**
   * Called when a new empty session is created. For example,
   * when creating a new profile or when the user installed it for
   * the first time.
   *
   * @param {Window} aWindow
   */
  onNewEmptySession(aWindow) {
    if (!this.canRestoreWindow({})) {
      return false;
    }
    this.log("Restoring empty session with Zen session data");
    aWindow.gZenWorkspaces.restoreWorkspacesFromSessionStore({
      spaces: this.getClonedSpaces(),
    });
    // There is no restore coming for this window, so nothing else is going to
    // tell the spaces their tabs are in place.
    aWindow.gZenWorkspaces.onWindowRestored();
  }

  /**
   * Gets the cloned spaces data from the sidebar object.
   * This is used during migration to restore spaces into
   * the initial session state.
   *
   * @returns {Array} The cloned spaces data.
   */
  getClonedSpaces(localSpaces = []) {
    if (this.#independentProjection) {
      return Cu.cloneInto(this.#independentProjection.spaces, {}).map(space => {
        const display = localSpaces.find(local => local.uuid === space.uuid);
        if (typeof display?.hasCollapsedPinnedTabs === "boolean") {
          space.hasCollapsedPinnedTabs = display.hasCollapsedPinnedTabs;
        }
        return space;
      });
    }
    const sidebar = this.#sidebarWithoutCloning;
    if (!sidebar || !sidebar.spaces) {
      return [];
    }
    return Cu.cloneInto(sidebar.spaces, {});
  }
}

export const ZenSessionStore = new nsZenSessionManager();
