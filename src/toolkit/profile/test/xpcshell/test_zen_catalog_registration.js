/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

add_task(async function test_zen_catalog_persistent_registration() {
  Assert.ok(
    AppConstants.MOZ_BACKGROUNDTASKS,
    "Native background tasks must be enabled for this registration test"
  );

  writeProfilesIni({ profiles: [], backgroundTasksProfiles: [] });
  const bts = Cc["@mozilla.org/backgroundtasks;1"].getService(
    Ci.nsIBackgroundTasks
  );
  const originalTaskName = bts.backgroundTaskName();
  registerCleanupFunction(() =>
    bts.overrideBackgroundTaskNameForTesting(originalTaskName)
  );
  bts.overrideBackgroundTaskNameForTesting("zen_catalog");

  const { rootDir, localDir, profile } = selectStartupProfile();
  const taskRoot = gDataHome.clone();
  taskRoot.append("Background Tasks Profiles");
  const profileData = readProfilesIni();
  const records = profileData.backgroundTasksProfiles ?? [];
  info(
    JSON.stringify({
      appData: gDataHome.path,
      taskRoot: taskRoot.path,
      rootDir: rootDir.path,
      localDir: localDir.path,
      profileIsNull: profile === null,
      browsingProfileCount: getProfileService().profileCount,
      records,
    })
  );

  Assert.ok(
    taskRoot.contains(rootDir),
    "Catalog uses the persistent native background task root"
  );
  Assert.ok(rootDir.equals(localDir), "Manager root/local use the same store");
  Assert.equal(profile, null, "Manager is not a selectable browsing Profile");
  Assert.equal(
    records.length,
    1,
    "Native registry records exactly one manager"
  );
  Assert.ok(
    records[0].name.endsWith(
      `BackgroundTask-${xreDirProvider.getInstallHash()}-zen_catalog`
    ),
    "Registry key identifies this installation's zen_catalog task"
  );
  Assert.equal(
    records[0].path,
    rootDir.leafName,
    "Registry records actual leaf"
  );
  Assert.ok(
    rootDir.leafName.endsWith(`.${records[0].name}`),
    "Manager directory is salted with the native registry key"
  );
  Assert.equal(
    profileData.profiles.length,
    0,
    "No browsing registry entry added"
  );
  Assert.equal(
    getProfileService().profileCount,
    0,
    "Browsing profile count is zero"
  );
  Assert.equal(
    Array.from(getProfileService().profiles).length,
    0,
    "Manager is absent from browsing Profile enumeration"
  );
});
