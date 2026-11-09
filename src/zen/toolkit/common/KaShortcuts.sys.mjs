/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Ka's shortcut layer over Zen's gZenKeyboardShortcutsManager: Arc default
// migrations, per-side overrides (ka.shortcuts.{sidebar,page}) and the
// worker's adopted page table.

const ZEN_VERSION_PREF = "zen.keyboard.shortcuts.version";
const VERSION_PREF = "ka.shortcuts.version";
const LATEST = 2;

const isWorker = () => Services.env.exists("ZEN_GECKO_LAYER_SERVICE");

function migrate(data, version) {
  const KeyShortcut = data[0].constructor;
  const Modifiers = data[0].getModifiers().constructor;
  if (version < 1) {
    const rebind = {
      key_privatebrowsing: ["N", { accel: true, shift: true }],
      "zen-new-unsynced-window": null,
      "zen-toggle-pin-tab": ["D", { accel: true }],
      addBookmarkAsKb: ["D", { accel: true, shift: true }],
      "zen-new-empty-split-view": ["+", { ctrl: true, shift: true }],
      "zen-split-view-unsplit": ["_", { ctrl: true, shift: true }],
    };
    for (const shortcut of data) {
      if (!(shortcut.getID() in rebind)) {
        continue;
      }
      const to = rebind[shortcut.getID()];
      if (to) {
        shortcut.setNewBinding(to[0]);
        shortcut.setModifiers(Modifiers.fromObject(to[1]));
      } else {
        shortcut.clearKeybind();
      }
    }
    const add = (id, key, keycode, modifiers, action) =>
      data.push(
        new KeyShortcut(id, key, keycode, "zen-other", Modifiers.fromObject(modifiers), action, id)
      );
    add("ka-select-next-tab", "", "VK_DOWN", { accel: true, alt: true }, "cmd_zenSelectNextTab");
    add("ka-select-previous-tab", "", "VK_UP", { accel: true, alt: true }, "cmd_zenSelectPreviousTab");
    for (const n of [1, 2, 3, 4]) {
      add(`ka-split-focus-${n}`, `${n}`, "", { ctrl: true, shift: true }, `cmd_zenSplitFocus${n}`);
    }
  }
  if (version < 2) {
    // Older saves left New Window unbound; Arc's Cmd+N opens a new window.
    const newWindow = data.find(s => s.getID() === "key_newNavigator");
    if (newWindow?.isEmpty()) {
      newWindow.setNewBinding("N");
      newWindow.setModifiers(Modifiers.fromObject({ accel: true }));
    }
  }
  return data;
}

export const KaShortcuts = {
  // Wraps Zen's migrations. Ka once bumped Zen's own version to 22/23; those
  // saves move to ka.shortcuts.version. Whenever Zen migrates or rebuilds,
  // Ka's migrations run again after it, as they did inside Zen's chain.
  migrate(versioner, data) {
    let zen = Services.prefs.getIntPref(ZEN_VERSION_PREF, 0);
    if (!Services.prefs.prefHasUserValue(VERSION_PREF) && (zen === 22 || zen === 23)) {
      Services.prefs.setIntPref(VERSION_PREF, zen - 21);
      Services.prefs.setIntPref(ZEN_VERSION_PREF, 21);
      zen = 21;
    }
    const version =
      !data || zen !== versioner.constructor.LATEST_KBS_VERSION
        ? 0
        : Services.prefs.getIntPref(VERSION_PREF, 0);
    data = versioner.migrateIfNeeded(data);
    if (version < LATEST) {
      data = migrate(data, version);
      Services.prefs.setIntPref(VERSION_PREF, LATEST);
    }
    return data;
  },

  // The manager's table is shared by its sidebar and the pages (drawn by
  // workers); each side applies its own overrides from a pref, as
  // {id: [key, keycode, modifiers] | null}, null unbinding the shortcut.
  scopedList(manager, scope) {
    let overrides = {};
    try {
      overrides = JSON.parse(Services.prefs.getStringPref(`ka.shortcuts.${scope}`, "{}")) ?? {};
    } catch {}
    return manager._currentShortcutList.map(shortcut => {
      if (!Object.hasOwn(overrides, shortcut.getID())) {
        return shortcut;
      }
      const [copy] = shortcut.constructor.parseFromSaved([shortcut.toJSONForm()]);
      const to = overrides[shortcut.getID()];
      if (Array.isArray(to)) {
        copy.setNewBinding(to[0] || to[1] || "");
        copy.setModifiers(shortcut.getModifiers().constructor.fromObject(to[2] ?? {}));
      } else {
        copy.clearKeybind();
      }
      return copy;
    });
  },

  list(manager) {
    return isWorker() ? manager._currentShortcutList : this.scopedList(manager, "sidebar");
  },

  // A worker takes the manager's page table instead of its own.
  adopt(manager, json) {
    manager._kaSharedList = json;
    const current = manager._currentShortcutList;
    if (current) {
      manager._currentShortcutList = current[0].constructor.parseFromSaved(json);
      manager._applyShortcuts();
    }
  },

  sharedList(manager, KeyShortcut) {
    return manager._kaSharedList ? KeyShortcut.parseFromSaved(manager._kaSharedList) : null;
  },

  // False in a worker: it never saves the adopted table.
  beforeSave() {
    if (isWorker()) {
      return false;
    }
    Services.obs.notifyObservers(null, "ka-shortcuts-changed");
    return true;
  },

  addCommands(window) {
    const { document } = window;
    const handlers = {
      cmd_zenSelectNextTab: () => window.gBrowser.tabContainer.advanceSelectedTab(1, true),
      cmd_zenSelectPreviousTab: () => window.gBrowser.tabContainer.advanceSelectedTab(-1, true),
    };
    for (const n of [1, 2, 3, 4]) {
      handlers[`cmd_zenSplitFocus${n}`] = () => {
        const splitter = window.gZenViewSplitter;
        const tab = splitter._data[splitter.currentView]?.tabs[n - 1];
        if (tab) {
          window.gBrowser.selectedTab = tab;
        }
      };
    }
    const set = document.createXULElement("commandset");
    document.getElementById("zenCommandSet").after(set);
    for (const [id, handler] of Object.entries(handlers)) {
      const command = document.createXULElement("command");
      command.id = id;
      command.addEventListener("command", handler);
      set.append(command);
    }
  },
};
