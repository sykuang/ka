/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ZenSessionStore } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenSessionManager.sys.mjs"
);
const { readLocalProjection } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenIndependentCatalogReader.sys.mjs"
);

// Run only in a parent-admitted disposable, registered catalog fixture whose
// local consent was installed before startup. This is not activation coverage.
add_task({
  skip_if: () => !Cc["@mozilla.org/process/environment;1"]
    .getService(Ci.nsIEnvironment)
    .get("ZEN_R_PROJECTION_FIXTURE_ROOT"),
}, async function test_independent_projection_normal_consumer() {
  const fixturePath = Cc["@mozilla.org/process/environment;1"]
    .getService(Ci.nsIEnvironment)
    .get("ZEN_R_PROJECTION_FIXTURE_ROOT");
  Assert.ok(fixturePath, "An explicit owned R fixture is required");
  const fixture = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  fixture.initWithPath(fixturePath);
  const profD = Services.dirsvc.get("ProfD", Ci.nsIFile);
  const manager = Cc["@mozilla.org/toolkit/profile-service;1"]
    .getService(Ci.nsIToolkitProfileService)
    .getZenCatalogProfileDirectory();
  Assert.ok(
    fixture.leafName.startsWith("zen-manager-projection-") &&
      !fixture.isSymlink() && fixture.isDirectory() &&
      fixture.contains(profD) && manager && fixture.contains(manager),
    "Both registered metadata storage and browsing ProfD must be owned"
  );
  const canonical = manager.clone();
  canonical.append("zen-independent-catalog.json");
  const original = await IOUtils.read(canonical.path);
  const projection = await readLocalProjection();
  Assert.ok(ZenSessionStore.hasIndependentCatalogProjection);
  Assert.ok(ZenSessionStore.canSaveSession);
  Assert.deepEqual(ZenSessionStore.getClonedSpaces(), projection.spaces);
  const clone = ZenSessionStore.getClonedSpaces();
  if (clone.length) {
    clone[0].name = "detached poison";
    clone[0].geckoProfileReference.persistentDescriptor = "not an owner";
  } else {
    Assert.deepEqual(gZenWorkspaces.getWorkspaces(), []);
    Assert.equal(gZenWorkspaces.activeWorkspace, "");
    await gZenWorkspaces.promiseInitialized;
    Assert.equal(gZenWorkspaces.getDefaultContainer(), 0);
    gZenWorkspaces._organizeWorkspaceStripLocations(undefined);
  }
  Assert.deepEqual(ZenSessionStore.getClonedSpaces(), projection.spaces);
  await SessionSaver.run();
  const local = await IOUtils.readJSON(
    PathUtils.join(PathUtils.profileDir, "zen-sessions.jsonlz4"),
    { decompress: true }
  );
  Assert.deepEqual(local.zenIndependentCatalog, {
    version: 1,
    zenCatalogId: projection.zenCatalogId,
    zenCatalogRevision: projection.zenCatalogRevision,
  });
  Assert.deepEqual(
    local.spaces.map(space => {
      const metadata = structuredClone(space);
      delete metadata.hasCollapsedPinnedTabs;
      return metadata;
    }),
    projection.spaces
  );
  Assert.deepEqual(await IOUtils.read(canonical.path), original);
});
