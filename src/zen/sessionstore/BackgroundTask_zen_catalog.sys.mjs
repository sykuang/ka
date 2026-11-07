/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const UUID = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/;

function requireCatalog(condition) {
  if (!condition) {
    const error = new Error("Zen catalog request refused");
    error.name = "ZenCatalogRefusal";
    throw error;
  }
}

function equalMetadata(left, right) {
  if (left === right) {
    return true;
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const keys = Object.keys(left);
  return Array.isArray(left) === Array.isArray(right) &&
    keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && equalMetadata(left[key], right[key]));
}

function parseRequest(commandLine) {
  if (typeof commandLine?.handleFlagWithParam !== "function") {
    const error = new Error("Zen catalog command line API unavailable");
    error.name = "ZenCatalogAPIUnavailable";
    throw error;
  }
  const text = commandLine.handleFlagWithParam("zen-catalog-request", false);
  requireCatalog(typeof text === "string" && commandLine.length === 0 &&
    new TextEncoder().encode(text).length <= 65536);
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    requireCatalog(false);
  }
  return validateZenCatalogRequest(request);
}

function snapshotRequest(value, ancestors = new Set()) {
  if (value === null || typeof value !== "object") {
    requireCatalog(["string", "number", "boolean", "undefined"].includes(typeof value) || value === null);
    requireCatalog(typeof value !== "number" || Number.isFinite(value));
    return value;
  }
  requireCatalog(!ancestors.has(value));
  const array = Array.isArray(value);
  requireCatalog(array ? Object.getPrototypeOf(value) === Array.prototype :
    [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const keys = Reflect.ownKeys(value);
  requireCatalog(!array || keys.length === value.length + 1);
  ancestors.add(value);
  const copy = array ? [] : {};
  for (const key of keys) {
    if (array && key === "length") {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireCatalog(typeof key === "string" && key !== "toJSON" &&
      descriptor.enumerable && Object.hasOwn(descriptor, "value") &&
      (!array || /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length));
    Object.defineProperty(copy, key, { value: snapshotRequest(descriptor.value, ancestors),
      enumerable: true, writable: true, configurable: true });
  }
  ancestors.delete(value);
  return copy;
}

/** Pure detached admission; no native identity, authority or I/O effects. */
export function validateZenCatalogRequest(input) {
  const request = snapshotRequest(input);
  requireCatalog(request !== null && typeof request === "object" && !Array.isArray(request));
  const fields = {
    activate: ["spaces"],
    upsert: ["zenCatalogId", "space"],
    order: ["zenCatalogId", "uuids"],
    preference: ["zenCatalogId", "preference"],
  };
  // No backend beforeunload/foreign-empty admission exists yet: delete is unsupported.
  requireCatalog(typeof request.zenCatalogOperation === "string" &&
    Object.hasOwn(fields, request.zenCatalogOperation));
  const required = ["zenCatalogOperation", "zenCatalogRequestId", "zenCatalogRevision",
    ...fields[request.zenCatalogOperation]];
  requireCatalog(Object.keys(request).length === required.length &&
    required.every(key => Object.hasOwn(request, key)) &&
    typeof request.zenCatalogRequestId === "string" && UUID.test(request.zenCatalogRequestId) &&
    Number.isSafeInteger(request.zenCatalogRevision) && request.zenCatalogRevision >= 0);
  if (request.zenCatalogOperation === "activate") {
    requireCatalog(request.zenCatalogRevision === 0 && Array.isArray(request.spaces) && request.spaces.length > 0);
  } else {
    requireCatalog(typeof request.zenCatalogId === "string" && UUID.test(request.zenCatalogId));
  }
  if (request.zenCatalogOperation === "preference") {
    const preference = request.preference;
    requireCatalog(preference !== null && typeof preference === "object" &&
      !Array.isArray(preference) && Object.keys(preference).length === 2 &&
      Object.hasOwn(preference, "key") && Object.hasOwn(preference, "value") &&
      typeof preference.key === "string");
    const { validateZenSharedPreferences } = ChromeUtils.importESModule(
      "resource:///modules/zen/ZenIndependentCatalogReader.sys.mjs"
    );
    validateZenSharedPreferences({ [preference.key]: preference.value });
  } else if (request.zenCatalogOperation === "order") {
    requireCatalog(Array.isArray(request.uuids) &&
      request.uuids.every(uuid => typeof uuid === "string" && UUID.test(uuid)) &&
      new Set(request.uuids).size === request.uuids.length);
  } else {
    const { validateZenCatalogMetadata } = ChromeUtils.importESModule(
      "resource:///modules/zen/ZenIndependentCatalogReader.sys.mjs"
    );
    // Schema-only frame uses admitted values, never an authority or task reply.
    validateZenCatalogMetadata({ zenCatalogVersion: 1,
      zenCatalogId: request.zenCatalogId ?? request.zenCatalogRequestId,
      zenCatalogRevision: 1, zenCatalogRequestId: request.zenCatalogRequestId,
      spaces: request.zenCatalogOperation === "activate" ? request.spaces : [request.space] });
  }
  return request;
}

function requireManager(service, original = null) {
  // Native task startup owns registration and the root lock; JS creates neither.
  if (typeof service.getZenCatalogProfileDirectory !== "function") {
    const error = new Error("Zen catalog native API unavailable");
    error.name = "ZenCatalogAPIUnavailable";
    throw error;
  }
  const root = service.getZenCatalogProfileDirectory();
  requireCatalog(root !== null && !service.isListOutdated &&
    !root.isSymlink() && root.isDirectory() &&
    root.equals(Services.dirsvc.get("ProfD", Ci.nsIFile)) &&
    (!original || root.equals(original)));
  return root;
}

function knownDescriptors(service) {
  const known = new Set();
  // This service belongs to this cold task, never an A-window reader cache.
  const profiles = service.profiles;
  while (profiles.hasMoreElements()) {
    const root = profiles.getNext().QueryInterface(Ci.nsIToolkitProfile).rootDir;
    requireCatalog(!root.isSymlink() && root.isDirectory());
    const descriptor = root.persistentDescriptor;
    requireCatalog(typeof descriptor === "string" && descriptor.length > 0);
    known.add(descriptor);
  }
  return known;
}

function requireBindings(catalog, known) {
  requireCatalog(catalog.spaces.every(space => known.has(space.geckoProfileReference.persistentDescriptor)));
}

async function regularLeaf(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  try {
    // IOUtils.stat alone does not certify a non-symlink (including dangling links).
    requireCatalog(!file.isSymlink());
  } catch (error) {
    if (error.name === "NS_ERROR_FILE_NOT_FOUND") {
      return false;
    }
    throw error;
  }
  requireCatalog((await IOUtils.stat(path)).type === "regular");
  return true;
}

function applyZenCatalogOperation(current, request, validate) {
  if (request.zenCatalogOperation === "activate") {
    requireCatalog(current === null);
    const candidate = validate({
      zenCatalogVersion: 1,
      zenCatalogId: Services.uuid.generateUUID().toString(),
      zenCatalogRevision: 1,
      zenCatalogRequestId: request.zenCatalogRequestId,
      spaces: request.spaces,
    });
    const owner = candidate.spaces[0].geckoProfileReference.persistentDescriptor;
    requireCatalog(candidate.spaces.every(space => space.geckoProfileReference.persistentDescriptor === owner));
    return candidate;
  }
  requireCatalog(current !== null && request.zenCatalogId === current.zenCatalogId &&
    request.zenCatalogRevision === current.zenCatalogRevision &&
    request.zenCatalogRequestId !== current.zenCatalogRequestId);
  const candidate = structuredClone(current);
  if (request.zenCatalogOperation === "preference") {
    candidate.sharedPreferences = { ...candidate.sharedPreferences,
      [request.preference.key]: request.preference.value };
  } else if (request.zenCatalogOperation === "upsert") {
    requireCatalog(request.space !== null && typeof request.space === "object" && !Array.isArray(request.space));
    const index = candidate.spaces.findIndex(space => space.uuid === request.space.uuid);
    if (index < 0) {
      candidate.spaces.push(request.space);
    } else {
      requireCatalog(equalMetadata(candidate.spaces[index].geckoProfileReference, request.space.geckoProfileReference));
      candidate.spaces[index] = request.space;
    }
  } else {
    requireCatalog(Array.isArray(request.uuids) && new Set(request.uuids).size === request.uuids.length);
    const selected = request.uuids.map(uuid => candidate.spaces.find(space => space.uuid === uuid));
    requireCatalog(selected.every(Boolean));
    const uuids = new Set(request.uuids);
    let index = 0;
    // ponytail: replace selected slots only; no global ordering protocol needed.
    candidate.spaces = candidate.spaces.map(space => uuids.has(space.uuid) ? selected[index++] : space);
  }
  validate(candidate);
  if (equalMetadata(candidate, current)) {
    return current;
  }
  requireCatalog(current.zenCatalogRevision < Number.MAX_SAFE_INTEGER);
  candidate.zenCatalogRevision++;
  candidate.zenCatalogRequestId = request.zenCatalogRequestId;
  return validate(candidate);
}

/** Source-only until the separately authorized backgroundtasks delivery lands. */
export async function runBackgroundTask(commandLine) {
  let writeStarted = false;
  try {
    const task = Cc["@mozilla.org/backgroundtasks;1"].getService(Ci.nsIBackgroundTasks);
    requireCatalog(task.isBackgroundTaskMode && task.backgroundTaskName() === "zen_catalog");
    const request = parseRequest(commandLine);
    const { validateZenCatalogMetadata: validate } = ChromeUtils.importESModule(
      "resource:///modules/zen/ZenIndependentCatalogReader.sys.mjs"
    );
    const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(Ci.nsIToolkitProfileService);
    const root = requireManager(service);
    const path = PathUtils.join(root.path, "zen-independent-catalog.json");
    const tmpPath = path + ".tmp";
    const present = await regularLeaf(path);
    let current = null;
    try {
      current = validate(await IOUtils.readJSON(path));
    } catch (error) {
      // Only actual initial NotFound on an absent leaf permits activation.
      if (present || error.name !== "NotFoundError" || request.zenCatalogOperation !== "activate") {
        throw error;
      }
    }
    const known = knownDescriptors(service);
    if (current) {
      requireBindings(current, known);
    }
    const candidate = applyZenCatalogOperation(current, request, validate);
    requireBindings(candidate, known);
    const reply = {
      status: "COMMITTED",
      zenCatalogId: candidate.zenCatalogId,
      zenCatalogRevision: candidate.zenCatalogRevision,
      zenCatalogRequestId: candidate.zenCatalogRequestId,
      processID: Services.appinfo.processID,
      profD: root.path,
    };
    requireCatalog(new TextEncoder().encode(JSON.stringify(reply)).length <= 4095);
    requireManager(service, root);
    // Fail closed on any leftover tmp; never treat it as authority or clean it.
    requireCatalog(!(await regularLeaf(tmpPath)));
    requireCatalog((await regularLeaf(path)) === present);
    requireManager(service, root);
    if (candidate !== current) {
      writeStarted = true; // A rejected write can still have effects: never promise rollback.
      const written = await IOUtils.writeJSON(path, candidate, { tmpPath, flush: true });
      const serialized = JSON.stringify(candidate);
      requireCatalog(written?.size === new TextEncoder().encode(serialized).length &&
        written?.jsonLength === serialized.length);
    } else {
      reply.status = "NOOP";
    }
    requireCatalog(await regularLeaf(path));
    const readback = validate(await IOUtils.readJSON(path));
    requireCatalog(equalMetadata(readback, candidate));
    dump(JSON.stringify(reply) + "\n");
    return 0;
  } catch (error) {
    // Do not print request bodies, exception messages/private paths, or catalog contents.
    const name = /^[A-Za-z0-9_]{1,80}$/.test(error.name) ? error.name : "Error";
    const refused = ["ZenCatalogRefusal", "TypeError", "SyntaxError", "NS_ERROR_INVALID_ARG"].includes(name);
    dump(JSON.stringify({ status: writeStarted ? "UNKNOWN" : "REFUSED", failure: refused ? "VALIDATION" : "API_OR_IO", error: name }) + "\n");
    return writeStarted ? 13 : refused ? 11 : 12;
  }
}
