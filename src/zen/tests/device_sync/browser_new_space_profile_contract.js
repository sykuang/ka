/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Arc syncs Spaces/Tabs, not machine-local Profiles. This exercises Zen's
// existing non-opt-in Sync path, not acceptance of a remote Profile descriptor.
add_task(async function test_new_space_and_tab_sync_without_local_descriptor() {
  await gZenWorkspaces.promiseInitialized;
  const originalSpaces = structuredClone(gZenWorkspaces.getWorkspaces());
  const originalActive = gZenWorkspaces.activeWorkspace;
  const spaceId = gZenUIManager.generateUuidv4();
  const tabId = gZenUIManager.generateUuidv4();
  registerCleanupFunction(async () => {
    const tab = document.getElementById(tabId);
    if (gBrowser.isTab(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
    await gZenWorkspaces.propagateWorkspaces(originalSpaces);
    await gZenWorkspaces.changeWorkspaceWithID(originalActive);
    ZenSpacesSyncModel.noteApplied(spaceId, null);
    ZenSpacesSyncModel.noteApplied(tabId, null);
  });

  const records = [
    {
      id: spaceId,
      deleted: false,
      cleartext: {
        kind: "space",
        data: {
          uuid: spaceId,
          name: "Incoming ordinary Space",
          icon: null,
          theme: null,
          containerGuid: null,
        },
      },
    },
    tabRecord(tabId, { pinned: true, workspaceUuid: spaceId }),
  ];
  let failed;
  let rejection = null;
  try {
    failed = await ZenSpacesSyncApplier.applyBatch(records);
  } catch (error) {
    rejection = error.message;
  }
  Assert.equal(
    rejection,
    null,
    "Ordinary Sidebar Sync must not reject a new Space for lacking a local Profile descriptor"
  );
  Assert.deepEqual(failed, [], "Both ordinary Sync records should apply");
  const space = gZenWorkspaces.getWorkspaceFromId(spaceId);
  Assert.ok(space, "The incoming Space should exist");
  if (space) {
    Assert.equal(
      space.geckoProfileReference?.version,
      1,
      "A local binding is created"
    );
    Assert.equal(
      space.geckoProfileReference?.persistentDescriptor,
      Services.dirsvc.get("ProfD", Ci.nsIFile).persistentDescriptor,
      "The binding belongs to the actual receiving Profile"
    );
    const projection = (await collectProjections()).get(spaceId);
    Assert.ok(projection, "The received Space remains syncable");
    Assert.ok(
      !Object.hasOwn(projection.data, "geckoProfileReference"),
      "The newly created local binding is not sent back through Sync"
    );
  }
  const tab = document.getElementById(tabId);
  Assert.ok(gBrowser.isTab(tab), "Its pinned tab should materialize");
  if (gBrowser.isTab(tab)) {
    Assert.equal(
      tab.getAttribute("zen-workspace-id"),
      spaceId,
      "The tab belongs to the incoming Space"
    );
  }
});
