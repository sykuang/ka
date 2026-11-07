/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Inert until the later initial-launch owner supplies its exact early-role window.
// Native retains this listener through authenticated control/retirement only.
const workers = new WeakMap();

export function connectProfileHostWorker(sourceWindow, parentPID, service) {
  if (!sourceWindow || sourceWindow.closed || workers.has(sourceWindow)) {
    throw new Error("Profile worker window unavailable or already connected");
  }
  let voting = false;
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
    observe(subject, topic, requestId) {
      if (topic !== "zen-profile-host-normal-quit" || voting) {
        return;
      }
      voting = true;
      let status = 3; // NOT_AVAILABLE; never bypass the normal observer vote.
      try {
        if (typeof sourceWindow.canQuitApplication === "function") {
          if (!sourceWindow.canQuitApplication(undefined, "OS")) {
            status = 2; // VETOED
          } else {
            Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
            status = 1; // REQUESTED, not EXITED: CanClose may independently veto.
          }
        }
      } catch {
        status = 3;
      }
      try {
        if (requestId !== "0") {
          Services.zen.replyProfileHostQuit(sourceWindow, requestId, status);
        }
      } catch {
        // Normal shutdown may synchronously invalidate the native control owner.
        // No fallback, force quit or implicit ownership release.
      } finally {
        voting = false;
      }
    },
  };
  const owner = Object.freeze({ sourceWindow, listener });
  // Reserve before connect: a synchronous native callback cannot connect twice.
  workers.set(sourceWindow, owner);
  try {
    Services.zen.connectProfileHostSource(sourceWindow, parentPID, service, listener);
  } catch (error) {
    workers.delete(sourceWindow);
    throw error;
  }
  return owner;
}
