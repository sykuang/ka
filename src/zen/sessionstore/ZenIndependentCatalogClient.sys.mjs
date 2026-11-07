/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

let inFlight = null;
const refused = (failure, error) => ({ status: "REFUSED", failure, error });
const unknown = error => ({ status: "UNKNOWN", failure: "API_OR_IO", error });

function requireClient(condition) {
  if (!condition) {
    throw new TypeError("Zen catalog client refused");
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
  return Array.isArray(left) === Array.isArray(right) && keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && equalMetadata(left[key], right[key]));
}

function nativeDirectory(file) {
  requireClient(file !== null && typeof file.path === "string" && file.path.startsWith("/") &&
    file.exists() && !file.isSymlink() && file.isDirectory());
  return file;
}

function launchOptions(text) {
  requireClient(Services.appinfo.OS === "Darwin");
  const executable = Services.dirsvc.get("XREExeF", Ci.nsIFile);
  requireClient(executable !== null && typeof executable.path === "string" &&
    executable.path.startsWith("/") && executable.exists() && !executable.isSymlink() &&
    executable.isFile() && executable.isExecutable());
  const appData = nativeDirectory(Services.dirsvc.get("UAppData", Ci.nsIFile));
  // These native getters can create/cache directories: commit caller consent is required.
  const profiles = nativeDirectory(Services.dirsvc.get("DefProfLRt", Ci.nsIFile));
  requireClient(profiles.leafName === "Profiles");
  const localBase = nativeDirectory(profiles.parent);
  requireClient(profiles.path === localBase.path.replace(/\/$/, "") + "/Profiles");
  return { command: executable.path,
    arguments: ["--backgroundtask", "zen_catalog", "--zen-catalog-request", text],
    environmentAppend: true, stderr: "pipe",
    environment: { MOZ_APP_DATA: appData.path, MOZ_LOCAL_APP_DATA: localBase.path,
      XRE_RESTART_TO_PROFILE_MANAGER: null, XRE_PROFILE_PATH: null, XRE_PROFILE_LOCAL_PATH: null,
      SELECTABLE_PROFILE_RESET_PATH: null, SELECTABLE_PROFILE_RESET_STORE_ID: null,
      MOZ_RESET_PROFILE_RESTART: null, XPCSHELL_TESTING_MODULES_URI: null } };
}

async function drain(pipe, retain) {
  const bytes = new Uint8Array(retain ? 4096 : 0);
  let length = 0, overflow = false;
  for (;;) {
    const chunk = new Uint8Array(await pipe.read());
    if (chunk.length === 0) {
      break;
    }
    if (retain && !overflow) {
      if (chunk.length > bytes.length - length) {
        overflow = true;
      } else {
        bytes.set(chunk, length);
        length += chunk.length;
      }
    }
  }
  requireClient(!overflow);
  return retain ? bytes.subarray(0, length) : null;
}

function replyRecord(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  requireClient(text.endsWith("\n") && !text.slice(0, -1).includes("\n"));
  const reply = JSON.parse(text.slice(0, -1));
  requireClient(reply !== null && typeof reply === "object" && !Array.isArray(reply) &&
    JSON.stringify(reply) === text.slice(0, -1));
  const success = ["COMMITTED", "NOOP"].includes(reply.status);
  const keys = success ? ["status", "zenCatalogId", "zenCatalogRevision", "zenCatalogRequestId", "processID", "profD"] :
    ["status", "failure", "error"];
  requireClient(Object.keys(reply).length === keys.length && keys.every(key => Object.hasOwn(reply, key)));
  if (success) {
    requireClient(Number.isSafeInteger(reply.zenCatalogRevision) && reply.zenCatalogRevision > 0 &&
      Number.isSafeInteger(reply.processID) && reply.processID > 0 &&
      typeof reply.profD === "string" && reply.profD.length > 0);
  } else {
    requireClient(["REFUSED", "UNKNOWN"].includes(reply.status) &&
      ["VALIDATION", "API_OR_IO"].includes(reply.failure) && typeof reply.error === "string" &&
      /^[A-Za-z0-9_]{1,80}$/.test(reply.error));
  }
  return reply;
}

function confirmEffect(prior, catalog, request, status) {
  if (status === "NOOP") {
    requireClient(prior !== null && equalMetadata(prior, catalog));
  } else {
    requireClient(catalog.zenCatalogRequestId === request.zenCatalogRequestId &&
      catalog.zenCatalogRevision === (prior === null ? 1 : prior.zenCatalogRevision + 1) &&
      (prior === null || catalog.zenCatalogId === prior.zenCatalogId));
  }
  if (request.zenCatalogOperation === "activate") {
    requireClient(status === "COMMITTED" && prior === null &&
      !Object.hasOwn(catalog, "sharedPreferences") && equalMetadata(catalog.spaces, request.spaces));
    return;
  }
  if (request.zenCatalogOperation === "preference") {
    const expected = { ...prior.sharedPreferences,
      [request.preference.key]: request.preference.value };
    requireClient(equalMetadata(prior.spaces, catalog.spaces) &&
      equalMetadata(expected, catalog.sharedPreferences));
    if (status === "COMMITTED") {
      requireClient(!equalMetadata(prior.sharedPreferences, catalog.sharedPreferences));
    }
    return;
  }
  requireClient(Object.hasOwn(prior, "sharedPreferences") === Object.hasOwn(catalog, "sharedPreferences") &&
    equalMetadata(prior.sharedPreferences, catalog.sharedPreferences));
  // ponytail: O(n) semantic confirmation, no exported/copied Task transaction algorithm.
  if (request.zenCatalogOperation === "upsert") {
    const old = prior.spaces.find(space => space.uuid === request.space.uuid);
    const actual = catalog.spaces.find(space => space.uuid === request.space.uuid);
    requireClient(equalMetadata(actual, request.space) &&
      (!old || equalMetadata(old.geckoProfileReference, actual.geckoProfileReference)) &&
      catalog.spaces.length === prior.spaces.length + (old ? 0 : 1));
    let index = 0;
    for (const space of catalog.spaces) {
      if (index < prior.spaces.length && prior.spaces[index].uuid === request.space.uuid) {
        requireClient(space.uuid === request.space.uuid);
      } else if (index < prior.spaces.length) {
        requireClient(equalMetadata(space, prior.spaces[index]));
      } else {
        requireClient(space.uuid === request.space.uuid);
      }
      index++;
    }
  } else {
    requireClient(catalog.spaces.length === prior.spaces.length);
    const selected = new Set(request.uuids);
    const originals = new Map(prior.spaces.map(space => [space.uuid, space]));
    let index = 0;
    catalog.spaces.forEach((space, slot) => {
      requireClient(equalMetadata(space, originals.get(space.uuid)) &&
        space.uuid === (selected.has(prior.spaces[slot].uuid) ? request.uuids[index++] : prior.spaces[slot].uuid));
    });
    requireClient(index === request.uuids.length);
  }
  if (status === "COMMITTED") {
    requireClient(!equalMetadata(prior.spaces, catalog.spaces));
  }
}

/** Source-only. Normal caller owns private/disabled/generation/consent and activation owner admission. */
export async function requestZenCatalogCommit(input, admit) {
  const guarded = arguments.length === 2;
  let request, text, reader;
  try {
    requireClient(arguments.length === 1 || guarded && typeof admit === "function");
    const { validateZenCatalogRequest } = ChromeUtils.importESModule(
      "resource:///modules/backgroundtasks/BackgroundTask_zen_catalog.sys.mjs"
    );
    // Capture all caller data before the first await; never serialize away unknown properties.
    request = validateZenCatalogRequest(input);
    text = JSON.stringify(request);
    requireClient(new TextEncoder().encode(text).length <= 65536);
    request = validateZenCatalogRequest(JSON.parse(text));
    reader = ChromeUtils.importESModule("resource:///modules/zen/ZenIndependentCatalogReader.sys.mjs");
  } catch {
    return refused("VALIDATION", "InvalidRequest");
  }
  if (inFlight !== null) {
    return refused("API_OR_IO", "Busy");
  }
  const state = { dispatched: false, confirmedExit: false, settled: false, expired: false };
  inFlight = state;
  const release = () => {
    if (state.settled && (!state.dispatched || state.confirmedExit) && inFlight === state) {
      inFlight = null;
    }
  };
  let timer, clearTimer;
  try {
    const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    clearTimer = clearTimeout;
    // ponytail: one 30s public ceiling; unresolved owned lifetime stays busy, no implicit kill policy.
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { state.expired = true; resolve(unknown("Deadline")); }, 30000);
    });
    const work = (async () => {
      try {
        requireClient(Services.appinfo.OS === "Darwin");
        const prior = await reader.readCatalogMetadata();
        if (request.zenCatalogOperation === "activate") {
          requireClient(prior === null);
        } else {
          requireClient(prior !== null && request.zenCatalogId === prior.zenCatalogId &&
            request.zenCatalogRevision === prior.zenCatalogRevision &&
            request.zenCatalogRequestId !== prior.zenCatalogRequestId);
        }
        requireClient(!state.expired);
        const options = launchOptions(text);
        const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
        requireClient(!state.expired);
        // Caller-local admission after the last await, never serialized authority.
        // Detach so the guard cannot mutate our private readback-confirmation prior.
        requireClient(!guarded || admit(structuredClone(prior)) === true);
        state.dispatched = true;
        let proc;
        try {
          proc = await Subprocess.call(options);
        } catch (error) {
          if (Subprocess.ERROR_BAD_EXECUTABLE !== undefined && error?.errorCode === Subprocess.ERROR_BAD_EXECUTABLE) {
            state.dispatched = false; // Documented no-spawn, not a generic worker rejection.
            return refused("API_OR_IO", "BadExecutable");
          }
          return unknown("LaunchUnknown");
        }
        // Attach owned wait even for late launch resolution after the public deadline.
        const wait = Promise.resolve().then(() => proc.wait()).then(exit => {
          state.confirmedExit = true;
          release();
          return exit;
        });
        wait.catch(() => {}); // Rejection is uncertainty, never proof of exit.
        const stdout = drain(proc.stdout, true), stderr = drain(proc.stderr, false);
        const close = Promise.resolve().then(() => proc.stdin.close());
        const [bytes, , , exit] = await Promise.all([stdout, stderr, close, wait]);
        const reply = replyRecord(bytes);
        if (["REFUSED", "UNKNOWN"].includes(reply.status)) {
          requireClient(exit.exitCode === (reply.status === "UNKNOWN" ? 13 : reply.failure === "VALIDATION" ? 11 : 12));
          return { status: reply.status, failure: reply.failure,
            error: reply.status === "REFUSED" ? "TaskRefused" : "TaskUnknown" };
        }
        requireClient(exit.exitCode === 0 && reply.processID === proc.pid);
        const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(Ci.nsIToolkitProfileService);
        const manager = nativeDirectory(service.getZenCatalogProfileDirectory()).clone();
        if (request.zenCatalogOperation === "activate" && prior === null &&
            reply.status === "COMMITTED" && service.isListOutdated) {
          requireClient(!state.expired && reply.profD === manager.path);
          service.adoptZenCatalogProfileRegistration(manager);
        }
        requireClient(!service.isListOutdated && reply.profD === manager.path);
        const catalog = reader.validateZenCatalogMetadata(await reader.readCatalogMetadata());
        requireClient(catalog.zenCatalogId === reply.zenCatalogId &&
          catalog.zenCatalogRevision === reply.zenCatalogRevision &&
          catalog.zenCatalogRequestId === reply.zenCatalogRequestId);
        confirmEffect(prior, catalog, request, reply.status);
        return { status: reply.status, catalog };
      } catch {
        return state.dispatched ? unknown("TransportUnknown") : refused("API_OR_IO", "PreflightFailed");
      } finally {
        state.settled = true;
        release();
      }
    })();
    return await Promise.race([work, deadline]);
  } catch {
    state.settled = true;
    release();
    return state.dispatched ? unknown("TransportUnknown") : refused("API_OR_IO", "PreflightFailed");
  } finally {
    if (clearTimer) {
      clearTimer(timer);
    }
  }
}
