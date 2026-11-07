/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ZenSessionStore } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenSessionManager.sys.mjs"
);
const { BrowserWindowTracker } = ChromeUtils.importESModule(
  "resource:///modules/BrowserWindowTracker.sys.mjs"
);

add_task(async function test_browser_admission_before_closing_other_windows() {
  const originalTabs = new Set(gBrowser.tabs);
  registerCleanupFunction(() => {
    for (const tab of gBrowser.tabs) {
      if (!originalTabs.has(tab)) {
        BrowserTestUtils.removeTab(tab);
      }
    }
    SessionStore.deleteCustomGlobalValue("g1-admission");
  });
  const owned = await BrowserTestUtils.openNewBrowserWindow();
  registerCleanupFunction(async () => {
    if (!owned.closed) {
      await BrowserTestUtils.closeWindow(owned);
    }
  });
  await owned.gZenWorkspaces.promiseInitialized;
  // setBrowserState keeps only the top window: keep the harness primary safe.
  await SimpleTest.promiseFocus(window);
  Assert.equal(
    BrowserWindowTracker.getTopWindow({ allowPopups: true }),
    window
  );
  const tabs = Array.from(gBrowser.tabs);
  const selected = gBrowser.selectedTab;
  const active = gZenWorkspaces.activeWorkspace;
  const global = SessionStore.getCustomGlobalValue("g1-admission");
  const closed = SessionStore.getClosedWindowData();
  let restored = 0;
  const observer = () => restored++;
  Services.obs.addObserver(observer, "sessionstore-browser-state-restored");
  registerCleanupFunction(() =>
    Services.obs.removeObserver(observer, "sessionstore-browser-state-restored")
  );
  const local = {
    spaces: structuredClone(gZenWorkspaces.getWorkspaces()),
    tabs: [{ entries: [{ url: "about:robots" }] }],
    selected: 1,
  };
  const directory = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
  directory.append("zen-browser-admission-foreign");
  directory.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  registerCleanupFunction(() => directory.remove(true));
  const foreign = structuredClone(local);
  foreign.spaces[0].geckoProfileReference = {
    version: 1,
    persistentDescriptor: directory.persistentDescriptor,
  };
  SessionStore.setBrowserState(
    JSON.stringify({
      windows: [local, foreign],
      global: { "g1-admission": "must-not-be-installed" },
    })
  );
  await new Promise(resolve => executeSoon(resolve));
  Assert.ok(
    !owned.closed,
    "Rejected mixed payload must not close owned second window"
  );
  Assert.deepEqual(
    Array.from(gBrowser.tabs),
    tabs,
    "Primary tabs survive rejection"
  );
  Assert.equal(
    gBrowser.selectedTab,
    selected,
    "Selected tab survives rejection"
  );
  Assert.equal(
    gZenWorkspaces.activeWorkspace,
    active,
    "Active Space survives rejection"
  );
  Assert.equal(
    SessionStore.getCustomGlobalValue("g1-admission"),
    global,
    "Global state survives rejection"
  );
  Assert.deepEqual(
    SessionStore.getClosedWindowData(),
    closed,
    "Closed-window metadata survives rejection"
  );
  Assert.equal(
    restored,
    0,
    "Rejected input does not emit a restore completion lifecycle"
  );
});

add_task(async function test_window_admission_checks_closed_payload() {
  const owned = await BrowserTestUtils.openNewBrowserWindow();
  await owned.gZenWorkspaces.promiseInitialized;
  const closed = SessionStore.getClosedWindowData();
  try {
    const tabs = Array.from(owned.gBrowser.tabs);
    const selected = owned.gBrowser.selectedTab;
    const active = owned.gZenWorkspaces.activeWorkspace;
    const foreign = {
      spaces: [{ uuid: "g1-unknown-closed-space", name: "Unknown legacy" }],
      tabs: [
        {
          entries: [{ url: "about:robots" }],
          zenWorkspace: "g1-unknown-closed-space",
        },
      ],
    };
    const payload = { windows: [], _closedWindows: [foreign] };
    const before = structuredClone(payload);
    SessionStore.setWindowState(owned, payload, true);
    Assert.deepEqual(
      SessionStore.getClosedWindowData(),
      closed,
      "Rejected closed-window payload preserves existing session metadata"
    );
    Assert.deepEqual(
      payload,
      before,
      "Unknown closed owner is not rebound or assigned closed IDs"
    );
    Assert.deepEqual(
      Array.from(owned.gBrowser.tabs),
      tabs,
      "Closed-state rejection preserves tabs"
    );
    Assert.equal(
      owned.gBrowser.selectedTab,
      selected,
      "Closed-state rejection preserves selection"
    );
    Assert.equal(
      owned.gZenWorkspaces.activeWorkspace,
      active,
      "Closed-state rejection preserves active Space"
    );
  } finally {
    try {
      SessionStore.setWindowState(
        owned,
        { windows: [], _closedWindows: closed },
        false
      );
    } finally {
      await BrowserTestUtils.closeWindow(owned);
    }
  }
});

add_task(async function test_inherited_restore_metadata_is_validated() {
  const owned = await BrowserTestUtils.openNewBrowserWindow();
  await owned.gZenWorkspaces.promiseInitialized;
  const closed = SessionStore.getClosedWindowData();
  const directory = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
  directory.append("zen-inherited-foreign");
  directory.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  try {
    const tabs = Array.from(owned.gBrowser.tabs);
    const selected = owned.gBrowser.selectedTab;
    const active = owned.gZenWorkspaces.activeWorkspace;
    const foreign = {
      spaces: structuredClone(owned.gZenWorkspaces.getWorkspaces()),
      tabs: [{ entries: [{ url: "about:robots" }] }],
    };
    foreign.spaces[0].geckoProfileReference = {
      version: 1,
      persistentDescriptor: directory.persistentDescriptor,
    };
    const before = structuredClone(foreign);
    const payload = Object.assign(
      Object.create({ _closedWindows: [foreign] }),
      { windows: [] }
    );
    SessionStore.setWindowState(owned, payload, true);
    Assert.deepEqual(
      SessionStore.getClosedWindowData(),
      closed,
      "Inherited foreign closed state is not installed"
    );
    Assert.deepEqual(
      foreign,
      before,
      "Inherited input is not assigned closed IDs"
    );
    Assert.deepEqual(
      Array.from(owned.gBrowser.tabs),
      tabs,
      "Tabs survive rejection"
    );
    Assert.equal(
      owned.gBrowser.selectedTab,
      selected,
      "Selection survives rejection"
    );
    Assert.equal(
      owned.gZenWorkspaces.activeWorkspace,
      active,
      "Active Space survives rejection"
    );
    for (const key of ["windows", "_closedWindows"]) {
      Assert.ok(
        !ZenSessionStore.canRestoreState(Object.create({ [key]: [foreign] })),
        `Inherited ${key} ownership is validated`
      );
    }
    for (const key of ["lastSessionState", "deferredInitialState"]) {
      Assert.ok(
        !ZenSessionStore.canRestoreState(
          Object.create({ [key]: { windows: [foreign] } })
        ),
        `Inherited ${key} ownership is validated`
      );
    }
    Assert.ok(
      !ZenSessionStore.canRestoreState(
        Object.create({ geckoProfileBindingVersion: 999 })
      ),
      "Inherited unknown binding version is rejected"
    );
    Assert.ok(
      !ZenSessionStore.canRestoreWindow(
        Object.assign(Object.create({ spaces: foreign.spaces }), {
          tabs: foreign.tabs,
        })
      ),
      "Inherited foreign Space ownership is validated"
    );
    Assert.ok(
      !ZenSessionStore.canRestoreWindow(Object.create({ tabs: {} })),
      "Inherited malformed tabs are rejected"
    );
    Assert.ok(
      ZenSessionStore.canRestoreState(
        Object.create({
          windows: [{ spaces: owned.gZenWorkspaces.getWorkspaces() }],
        })
      ),
      "Inherited valid local state is not blanket-rejected"
    );
  } finally {
    try {
      SessionStore.setWindowState(
        owned,
        { windows: [], _closedWindows: closed },
        false
      );
    } finally {
      try {
        await BrowserTestUtils.closeWindow(owned);
      } finally {
        directory.remove(true);
      }
    }
  }
});

add_task(async function test_window_payload_validation_and_local_restore() {
  const directory = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
  directory.append("zen-foreign-admission");
  directory.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  const owned = await BrowserTestUtils.openNewBrowserWindow();
  await owned.gZenWorkspaces.promiseInitialized;
  const closed = SessionStore.getClosedWindowData();
  try {
    const tabs = Array.from(owned.gBrowser.tabs);
    const selected = owned.gBrowser.selectedTab;
    const active = owned.gZenWorkspaces.activeWorkspace;
    const local = {
      spaces: structuredClone(owned.gZenWorkspaces.getWorkspaces()),
      tabs: [{ entries: [{ url: "about:robots" }], zenWorkspace: active }],
      selected: 1,
    };
    const references = [
      null,
      { version: 999, persistentDescriptor: PathUtils.profileDir },
      { version: 1, persistentDescriptor: "invalid-relative-descriptor" },
      { version: 1, persistentDescriptor: directory.persistentDescriptor },
    ];
    let lifecycle = 0;
    const listener = () => lifecycle++;
    owned.addEventListener("SSWindowRestoring", listener);
    try {
      const payloads = [
        "not JSON",
        null,
        [],
        { windows: {} },
        { windows: [null] },
        { windows: [{ tabs: [null] }] },
        { windows: [], _closedWindows: {} },
        { windows: [], geckoProfileBindingVersion: 999 },
      ];
      for (const reference of references) {
        const rejected = structuredClone(local);
        rejected.spaces[0].geckoProfileReference = reference;
        payloads.push(
          { windows: [rejected] },
          { windows: [local], _closedWindows: [rejected] },
          { windows: [], lastSessionState: { windows: [rejected] } },
          { windows: [], deferredInitialState: { _closedWindows: [rejected] } }
        );
      }
      for (const payload of payloads) {
        const input = structuredClone(payload);
        SessionStore.setWindowState(owned, payload, true);
        Assert.deepEqual(payload, input, "Rejected payload remains unmodified");
        Assert.deepEqual(
          SessionStore.getClosedWindowData(),
          closed,
          "Rejected payload preserves closed metadata"
        );
        Assert.deepEqual(
          Array.from(owned.gBrowser.tabs),
          tabs,
          "Rejected payload preserves exact tab identities"
        );
        Assert.equal(
          owned.gBrowser.selectedTab,
          selected,
          "Rejected payload preserves selection"
        );
        Assert.equal(
          owned.gZenWorkspaces.activeWorkspace,
          active,
          "Rejected payload preserves active Space"
        );
      }
      await new Promise(resolve => executeSoon(resolve));
      Assert.equal(
        lifecycle,
        0,
        "Rejected payloads never start a restore lifecycle"
      );
    } finally {
      owned.removeEventListener("SSWindowRestoring", listener);
    }
    await forceSaveState();
    const legacy = structuredClone(local);
    for (const space of legacy.spaces) {
      delete space.geckoProfileReference;
    }
    const migrated = ZenSessionStore.onFileRead({
      windows: [],
      _closedWindows: [legacy],
    });
    Assert.ok(
      ZenSessionStore.canRestoreWindow(migrated._closedWindows[0]),
      "Known local legacy closed window resolves through authoritative catalog"
    );
    Assert.deepEqual(
      legacy.spaces.map(space => space.geckoProfileReference),
      local.spaces.map(space => space.geckoProfileReference),
      "Legacy keeps its known owners instead of assigning an arbitrary owner"
    );
    SessionStore.setWindowState(
      owned,
      { windows: [], _closedWindows: migrated._closedWindows },
      false
    );
    Assert.equal(
      SessionStore.getClosedWindowData().length,
      1,
      "Admitted local closed state remains available for undo"
    );
    const restored = BrowserTestUtils.waitForEvent(owned, "SSWindowRestored");
    SessionStore.setWindowState(owned, { windows: [local] }, true);
    await restored;
    Assert.equal(
      owned.gBrowser.selectedBrowser.currentURI.spec,
      "about:robots",
      "Valid local restore still loads fixture"
    );
    Assert.equal(
      owned.gZenWorkspaces.activeWorkspace,
      active,
      "Valid local restore retains its active owner"
    );
  } finally {
    try {
      SessionStore.setWindowState(
        owned,
        { windows: [], _closedWindows: closed },
        false
      );
      Assert.deepEqual(
        SessionStore.getClosedWindowData(),
        closed,
        "Closed snapshot is restored before fixture window is closed"
      );
    } finally {
      try {
        await BrowserTestUtils.closeWindow(owned);
      } finally {
        directory.remove(true);
      }
    }
  }
});
