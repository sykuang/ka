/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Space IDs use gZenUIManager.generateUuidv4 → Services.uuid.toString:
// lowercase, braced nsID format. Do not repair or normalize other tokens.
const UUID = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/;

function requireMetadata(condition) {
  if (!condition) {
    throw new TypeError("Invalid Zen catalog metadata");
  }
}

function record(value, required, optional = []) {
  requireMetadata(
    value !== null &&
      typeof value === "object" &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireMetadata(
      (required.includes(key) || optional.includes(key)) &&
        descriptor.enumerable &&
        Object.hasOwn(descriptor, "value")
    );
  }
  requireMetadata(required.every(key => Object.hasOwn(value, key)));
}

// Only approved UI settings. Everything else remains profile-local.
export const ZEN_SHARED_PREFERENCES = Object.freeze({
  "zen.view.compact.toolbar-flash-popup": "boolean",
  "zen.workspaces.hide-default-container-indicator": "boolean",
  "zen.pinned-tab-manager.close-shortcut-behavior": Object.freeze([
    "reset-unload-switch", "unload-switch", "reset-switch", "switch", "reset", "close",
  ]),
  "zen.workspaces.open-new-tab-if-last-unpinned-tab-is-closed": "boolean",
  "zen.glance.activation-method": Object.freeze(["ctrl", "alt", "shift", "meta"]),
  "zen.glance.enabled": "boolean",
  "zen.view.drag-window-from-content": "boolean",
  "zen.urlbar.behavior": Object.freeze(["normal", "floating-on-type", "float"]),
  "zen.tabs.show-newtab-vertical": "boolean",
  "zen.view.show-newtab-button-top": "boolean",
  "media.videocontrols.picture-in-picture.enabled": "boolean",
  "zen.tabs.ctrl-tab.ignore-essential-tabs": "boolean",
  "zen.tabs.ctrl-tab.ignore-pending-tabs": "boolean",
  "zen.tabs.close-on-back-with-no-history": "boolean",
  "zen.tabs.select-recently-used-on-close": "boolean",
  "zen.view.sidebar-expanded": "boolean",
  "zen.view.use-single-toolbar": "boolean",
});

/** Absence is unconfigured; null explicitly clears each profile's user value. */
export function validateZenSharedPreferences(value) {
  record(value, [], Object.keys(ZEN_SHARED_PREFERENCES));
  for (const [key, setting] of Object.entries(value)) {
    const type = ZEN_SHARED_PREFERENCES[key];
    requireMetadata(setting === null || (type === "boolean"
      ? typeof setting === "boolean"
      : typeof setting === "string" && type.includes(setting)));
  }
  return structuredClone(value);
}

function list(value) {
  requireMetadata(
    Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  );
  // Reject holes and hidden/extra properties, not a JSON round-trip that
  // silently drops them. Known optional undefined fields remain intact.
  requireMetadata(Reflect.ownKeys(value).length === value.length + 1);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    requireMetadata(
      descriptor?.enumerable && Object.hasOwn(descriptor, "value")
    );
  }
}

function isUuid(value) {
  return typeof value === "string" && value.length === 38 && UUID.test(value);
}

function isLightness(value) {
  return (
    Number.isFinite(value) ||
    (typeof value === "string" &&
      value.trim() !== "" &&
      Number.isFinite(Number(value)))
  );
}

function validateTheme(theme) {
  // The local DB migration can supply null and nullable rotation/opacity/
  // texture. getTheme produces gradientColors/opacity/texture; share imports
  // and the picker retain numeric OR string lightness, and custom CSS colors.
  if (theme === null) {
    return;
  }
  record(theme, ["type", "gradientColors"], [
    "opacity",
    "texture",
    "rotation",
    "lightness",
  ]);
  requireMetadata(theme.type === "gradient");
  for (const key of ["opacity", "texture", "rotation"]) {
    requireMetadata(theme[key] == null || Number.isFinite(theme[key]));
  }
  requireMetadata(theme.lightness === undefined || isLightness(theme.lightness));
  list(theme.gradientColors);
  for (const color of theme.gradientColors) {
    record(color, ["c"], [
      "isCustom",
      "algorithm",
      "isPrimary",
      "lightness",
      "position",
      "type",
    ]);
    for (const key of ["isCustom", "isPrimary"]) {
      requireMetadata(color[key] === undefined || typeof color[key] === "boolean");
    }
    requireMetadata(
      color.algorithm === undefined || typeof color.algorithm === "string"
    );
    // These are string-valued metadata in existing picker/share consumers,
    // not a new enum: older dots stringify undefined, custom dots have null.
    requireMetadata(color.type == null || typeof color.type === "string");
    requireMetadata(color.lightness === undefined || isLightness(color.lightness));
    if (color.isCustom) {
      requireMetadata(typeof color.c === "string" && color.c.length > 0);
    } else {
      list(color.c);
      requireMetadata(
        color.c.length === 3 &&
          color.c.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 255)
      );
    }
    if (color.position != null) {
      record(color.position, ["x", "y"]);
      requireMetadata(
        Number.isFinite(color.position.x) && Number.isFinite(color.position.y)
      );
    }
  }
}

/**
 * Validate the entire version-1 authority metadata shape and return a detached
 * clone. Throws TypeError on invalid input; never drops unknown fields or
 * mutates the caller. Accepts plain data objects/arrays, not accessors/classes.
 *
 * This pure boundary does NOT resolve descriptors, verify native registration,
 * discover authority, read/project/write files, or apply the request's 64 KiB
 * transport ceiling to the authority catalog. Native binding admission must
 * follow before a future sole writer can commit this candidate.
 */
export function validateZenCatalogMetadata(candidate) {
  record(candidate, [
    "zenCatalogVersion",
    "zenCatalogId",
    "zenCatalogRevision",
    "zenCatalogRequestId",
    "spaces",
  ], ["sharedPreferences"]);
  if (Object.hasOwn(candidate, "sharedPreferences")) {
    validateZenSharedPreferences(candidate.sharedPreferences);
  }
  requireMetadata(
    candidate.zenCatalogVersion === 1 &&
      isUuid(candidate.zenCatalogId) &&
      isUuid(candidate.zenCatalogRequestId) &&
      Number.isSafeInteger(candidate.zenCatalogRevision) &&
      candidate.zenCatalogRevision > 0
  );
  list(candidate.spaces);
  const uuids = new Set();
  for (const space of candidate.spaces) {
    record(space, ["uuid", "name", "theme", "containerTabId", "geckoProfileReference"], ["icon"]);
    requireMetadata(
      isUuid(space.uuid) &&
        !uuids.has(space.uuid) &&
        typeof space.name === "string" &&
        (space.icon == null || typeof space.icon === "string") &&
        Number.isSafeInteger(space.containerTabId) &&
        space.containerTabId >= 0
    );
    uuids.add(space.uuid);
    record(space.geckoProfileReference, ["version", "persistentDescriptor"]);
    requireMetadata(
      space.geckoProfileReference.version === 1 &&
        typeof space.geckoProfileReference.persistentDescriptor === "string" &&
        space.geckoProfileReference.persistentDescriptor.length > 0
    );
    validateTheme(space.theme);
  }
  return structuredClone(candidate);
}

function requireCatalogDirectory(root) {
  requireMetadata(root !== null && !root.isSymlink() && root.isDirectory());
}

function catalogManager(service) {
  // Missing native API and getter errors propagate; only strict null is inactive.
  const root = service.getZenCatalogProfileDirectory();
  if (root !== null) {
    requireMetadata(!service.isListOutdated);
    requireCatalogDirectory(root);
  }
  return root;
}

function registeredCatalogRoots(service) {
  requireMetadata(!service.isListOutdated);
  const roots = new Map();
  const profiles = service.profiles;
  while (profiles.hasMoreElements()) {
    const root = profiles.getNext().QueryInterface(Ci.nsIToolkitProfile).rootDir;
    const descriptor = root.persistentDescriptor;
    requireMetadata(typeof descriptor === "string" && descriptor.length > 0 &&
      !roots.has(descriptor));
    // Do not stat unused roots or resolve caller/catalog descriptors into paths.
    roots.set(descriptor, root.clone());
  }
  return roots;
}

function requireCatalogBindings(catalog, roots, manager) {
  for (const descriptor of new Set(catalog.spaces.map(
    space => space.geckoProfileReference.persistentDescriptor
  ))) {
    const root = roots.get(descriptor);
    requireMetadata(root !== undefined && !root.equals(manager));
    requireCatalogDirectory(root);
  }
}

function localCatalogDescriptor(profD, roots, manager) {
  requireCatalogDirectory(profD);
  requireMetadata(!profD.equals(manager));
  for (const [descriptor, root] of roots) {
    if (root.equals(profD)) {
      requireCatalogDirectory(root);
      return descriptor;
    }
  }
  throw new TypeError("Unregistered Zen catalog browsing profile");
}

async function readAdmittedCatalog(local) {
  const service = Cc["@mozilla.org/toolkit/profile-service;1"]
    .getService(Ci.nsIToolkitProfileService);
  const discovered = catalogManager(service);
  if (discovered === null) {
    return null;
  }
  const manager = discovered.clone();
  const roots = registeredCatalogRoots(service);
  const profD = local ? Services.dirsvc.get("ProfD", Ci.nsIFile).clone() : null;
  const descriptor = local ? localCatalogDescriptor(profD, roots, manager) : null;
  const file = manager.clone();
  file.append("zen-independent-catalog.json");
  requireMetadata(!file.isSymlink() && file.isFile());
  const catalog = validateZenCatalogMetadata(await IOUtils.readJSON(file.path));
  requireCatalogBindings(catalog, roots, manager);

  // ponytail: resident enumeration + metadata checks are not cross-epoch full
  // freshness or a hostile TOCTOU lock; those need a native snapshot/lease API.
  const currentManager = catalogManager(service);
  requireMetadata(currentManager !== null && manager.equals(currentManager));
  requireCatalogDirectory(manager);
  requireMetadata(!file.isSymlink() && file.isFile());
  const currentRoots = registeredCatalogRoots(service);
  requireCatalogBindings(catalog, currentRoots, manager);
  const referenced = new Set(catalog.spaces.map(
    space => space.geckoProfileReference.persistentDescriptor
  ));
  if (local) {
    const currentProfD = Services.dirsvc.get("ProfD", Ci.nsIFile);
    requireMetadata(profD.equals(currentProfD) &&
      localCatalogDescriptor(currentProfD, currentRoots, manager) === descriptor);
    referenced.add(descriptor);
  }
  for (const reference of referenced) {
    requireMetadata(roots.get(reference).equals(currentRoots.get(reference)));
  }
  requireMetadata(!service.isListOutdated);
  return local ? {
    ...catalog,
    spaces: catalog.spaces.filter(
      space => space.geckoProfileReference.persistentDescriptor === descriptor
    ),
  } : catalog;
}

/** Read full authority metadata; caller owns private/disabled/consent gating. */
export async function readCatalogMetadata() {
  if (arguments.length !== 0) {
    throw new TypeError("readCatalogMetadata takes no arguments");
  }
  return readAdmittedCatalog(false);
}

/** Read full metadata first, then return the actual ProfD's detached subset. */
export async function readLocalProjection() {
  if (arguments.length !== 0) {
    throw new TypeError("readLocalProjection takes no arguments");
  }
  return readAdmittedCatalog(true);
}
