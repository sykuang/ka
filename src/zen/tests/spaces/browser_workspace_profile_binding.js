/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ZenSessionStore, nsZenSessionManager } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenSessionManager.sys.mjs"
);

function fileFromDescriptor(descriptor) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.persistentDescriptor = descriptor;
  return file;
}

add_task(async function test_new_spaces_persist_real_profile_owner() {
  const originalSpace = gZenWorkspaces.activeWorkspace;
  const created = [];
  registerCleanupFunction(async () => {
    await gZenWorkspaces.changeWorkspaceWithID(originalSpace);
    for (const space of created) {
      await gZenWorkspaces.removeWorkspace(space.uuid);
    }
  });
  for (const name of ["Owner one", "Owner two"]) {
    created.push(await gZenWorkspaces.createAndSaveWorkspace(name));
  }
  const localTab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:robots"
  );
  gBrowser.pinTab(localTab);
  const profile = Services.dirsvc.get("ProfD", Ci.nsIFile);
  for (const space of created) {
    Assert.equal(
      space.geckoProfileReference?.version,
      1,
      "Versioned owner reference"
    );
    if (!space.geckoProfileReference) {
      continue;
    }
    Assert.ok(
      fileFromDescriptor(
        space.geckoProfileReference.persistentDescriptor
      ).equals(profile),
      "The real Gecko descriptor resolves to this harness ProfD"
    );
  }
  Assert.deepEqual(
    created[0].geckoProfileReference,
    created[1].geckoProfileReference,
    "Two Spaces may share one real Profile owner"
  );
  const reference = structuredClone(created[0].geckoProfileReference);
  const { geckoProfileReference, ...renamed } = created[0];
  await gZenWorkspaces.saveWorkspace({ ...renamed, name: "Renamed owner" });
  await forceSaveState();
  const path = PathUtils.join(PathUtils.profileDir, "zen-sessions.jsonlz4");
  await ZenSessionStore.saveState(SessionStore.getCurrentState(true));
  const disk = await IOUtils.readJSON(path, { decompress: true });
  Assert.ok(
    disk.spaces.some(space => space.name === "Renamed owner"),
    "Existing session writer flushed renamed Space to disk"
  );
  Assert.deepEqual(
    disk.spaces.find(space => space.uuid === created[0].uuid)
      .geckoProfileReference,
    reference,
    "Disk writer preserves explicit reference on ordinary save"
  );
  const reader = new nsZenSessionManager();
  await reader.readFile();
  Assert.deepEqual(
    reader.getClonedSpaces().find(space => space.uuid === created[0].uuid)
      .geckoProfileReference,
    reference,
    "Fresh session reader, not the writer cache, retains ownership"
  );
  const { ZenSpacesSyncModel } = ChromeUtils.importESModule(
    "resource:///modules/zen/ZenSpacesSyncModel.sys.mjs"
  );
  const projection = ZenSpacesSyncModel.projections().get(created[0].uuid);
  Assert.ok(projection, "Real Sync projection contains the Space");
  Assert.ok(
    !JSON.stringify(projection).includes("persistentDescriptor"),
    "Sync's allowlisted projection excludes the local Profile reference"
  );
  const win = await BrowserTestUtils.openNewBrowserWindow();
  try {
    await win.gZenWorkspaces.promiseInitialized;
    Assert.deepEqual(
      win.gZenWorkspaces.getWorkspaceFromId(created[0].uuid)
        .geckoProfileReference,
      reference,
      "Normal window consumer reconstructs the same ownership"
    );
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_reject_before_cache_ui_or_tab_side_effects() {
  const foreign = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
  foreign.append("g1a-foreign-owner");
  foreign.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  registerCleanupFunction(() => foreign.remove(true));
  const references = [
    undefined,
    null,
    {},
    {
      version: 2,
      persistentDescriptor: Services.dirsvc.get("ProfD", Ci.nsIFile)
        .persistentDescriptor,
    },
    { version: 1, persistentDescriptor: "not-an-absolute-descriptor" },
    { version: 1, persistentDescriptor: foreign.persistentDescriptor },
  ];
  let uiEvents = 0;
  const onUI = () => uiEvents++;
  window.addEventListener("ZenWorkspaceDataChanged", onUI);
  registerCleanupFunction(() =>
    window.removeEventListener("ZenWorkspaceDataChanged", onUI)
  );
  for (const reference of references) {
    const spaces = structuredClone(gZenWorkspaces.getWorkspaces());
    const tabs = Array.from(gBrowser.tabs);
    const active = gZenWorkspaces.activeWorkspace;
    const candidate = {
      ...spaces[0],
      uuid: gZenUIManager.generateUuidv4(),
      name: "Rejected owner",
    };
    if (reference !== undefined) {
      candidate.geckoProfileReference = reference;
    } else {
      delete candidate.geckoProfileReference;
    }
    const before = structuredClone(candidate);
    const eventsBefore = uiEvents;
    Assert.strictEqual(
      gZenWorkspaces.saveWorkspace(candidate),
      false,
      "Save rejects unresolved owner"
    );
    await Assert.rejects(
      gZenWorkspaces.propagateWorkspaces([...spaces, candidate]),
      /Profile ownership/,
      "Propagation rejects unresolved owner and aborts dependent consumers"
    );
    Assert.strictEqual(
      gZenWorkspaces.restoreWorkspacesFromSessionStore({ spaces: [candidate] }),
      false,
      "Restore rejects before even the initialized-cache shortcut"
    );
    Assert.strictEqual(
      await gZenWorkspaces.changeWorkspace(candidate),
      false,
      "Switch explicitly rejects, without swallowed throw"
    );
    Assert.deepEqual(
      gZenWorkspaces.getWorkspaces(),
      spaces,
      "Rejected input leaves cache untouched"
    );
    Assert.equal(
      gZenWorkspaces.activeWorkspace,
      active,
      "No fallback selection"
    );
    Assert.equal(uiEvents, eventsBefore, "No UI propagation");
    Assert.deepEqual(
      candidate,
      before,
      "Unknown/foreign reference is not rewritten"
    );
    SessionStore.setWindowState(
      window,
      JSON.stringify({
        windows: [
          {
            spaces: [candidate],
            selected: 1,
            tabs: [
              {
                entries: [{ url: "about:blank#g1a-rejected" }],
                zenWorkspace: candidate.uuid,
              },
            ],
          },
        ],
      }),
      true
    );
    Assert.deepEqual(
      Array.from(gBrowser.tabs),
      tabs,
      "SessionStore admission precedes tab removal/creation"
    );
    Assert.equal(
      gZenWorkspaces.activeWorkspace,
      active,
      "SessionStore refusal does not fall back"
    );
  }
});

add_task(async function test_sync_cannot_override_existing_local_binding() {
  const { ZenSpacesSyncApplier } = ChromeUtils.importESModule(
    "resource:///modules/zen/ZenSpacesSyncApplier.sys.mjs"
  );
  const space = await gZenWorkspaces.createAndSaveWorkspace("Local Sync owner");
  registerCleanupFunction(() => gZenWorkspaces.removeWorkspace(space.uuid));
  const reference = structuredClone(space.geckoProfileReference);
  const failed = await ZenSpacesSyncApplier.applyBatch([
    {
      id: space.uuid,
      cleartext: {
        kind: "space",
        data: {
          uuid: space.uuid,
          name: "Synced metadata update",
          geckoProfileReference: {
            version: 999,
            persistentDescriptor: "remote",
          },
        },
      },
    },
  ]);
  Assert.deepEqual(failed, [], "Ordinary metadata update still applies");
  const updated = gZenWorkspaces.getWorkspaceFromId(space.uuid);
  Assert.equal(updated.name, "Synced metadata update", "Name update applied");
  Assert.deepEqual(
    updated.geckoProfileReference,
    reference,
    "Remote non-syncable fields cannot replace the existing local owner"
  );
});

add_task(async function test_local_legacy_and_unsupported_disk_data() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sessionstore.interval", 1000000000]],
  });
  await forceSaveState();
  const path = PathUtils.join(PathUtils.profileDir, "zen-sessions.jsonlz4");
  await ZenSessionStore.saveState(SessionStore.getCurrentState(true));
  const saved = await IOUtils.read(path);
  try {
    const legacy = await IOUtils.readJSON(path, { decompress: true });
    delete legacy.geckoProfileBindingVersion;
    for (const space of legacy.spaces) {
      delete space.geckoProfileReference;
    }
    await IOUtils.writeJSON(path, legacy, { compress: true });
    const reader = new nsZenSessionManager();
    await reader.readFile();
    const migrated = reader.getClonedSpaces();
    Assert.ok(
      legacy.tabs.length > 0,
      "Legacy fixture includes a real collected browser tab"
    );
    Assert.deepEqual(
      migrated.map(space => space.uuid),
      legacy.spaces.map(space => space.uuid),
      "Local legacy migration preserves all Spaces"
    );
    Assert.deepEqual(
      reader.getSidebarData().tabs,
      legacy.tabs,
      "Legacy migration preserves tabs"
    );
    Assert.ok(
      migrated.every(space =>
        fileFromDescriptor(
          space.geckoProfileReference.persistentDescriptor
        ).equals(Services.dirsvc.get("ProfD", Ci.nsIFile))
      ),
      "Only known local legacy is assigned actual ProfD"
    );
    const localState = reader.onFileRead({
      windows: [
        {
          spaces: structuredClone(legacy.spaces),
          tabs: structuredClone(legacy.tabs),
        },
      ],
    });
    Assert.ok(
      reader.canRestoreWindow(localState.windows[0]),
      "Trusted local legacy also passes the actual startup admission chain"
    );
    const foreign = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
    foreign.append("g1a-disk-foreign-owner");
    foreign.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
    try {
      const cases = [
        { ...legacy, geckoProfileBindingVersion: 999 },
        { ...legacy, geckoProfileBindingVersion: 999, spaces: [] },
        { ...legacy, version: 999 },
        { spaces: legacy.spaces, tabs: legacy.tabs },
        ...[
          null,
          { version: 999 },
          { version: 1, persistentDescriptor: "bad" },
          { version: 1, persistentDescriptor: foreign.persistentDescriptor },
        ].map(reference => ({
          ...legacy,
          geckoProfileBindingVersion: 1,
          spaces: legacy.spaces.map(space => ({
            ...space,
            geckoProfileReference: reference,
          })),
        })),
      ];
      for (const data of cases) {
        await IOUtils.writeJSON(path, data, { compress: true });
        const blocked = new nsZenSessionManager();
        await blocked.readFile();
        Assert.deepEqual(
          blocked.getClonedSpaces(),
          data.spaces,
          "Unsupported disk reference preserved verbatim"
        );
        Assert.strictEqual(
          blocked.canRestoreWindow({}),
          false,
          "Unsupported disk data is not legacy or restorable"
        );
        Assert.strictEqual(
          blocked.saveState({ windows: [{ spaces: migrated, tabs: [] }] }),
          false,
          "Ordinary local save cannot overwrite blocked persistent data"
        );
        Assert.deepEqual(
          await IOUtils.readJSON(path, { decompress: true }),
          data,
          "Rejected restore/save leaves disk Spaces and tabs intact"
        );
      }
    } finally {
      foreign.remove(true);
    }
  } finally {
    await IOUtils.write(path, saved);
    await SpecialPowers.popPrefEnv();
  }
});
