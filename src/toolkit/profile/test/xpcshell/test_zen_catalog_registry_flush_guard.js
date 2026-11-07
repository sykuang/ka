/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

add_task(async function test_same_metadata_registry_preimage() {
  let defaultDir = makeRandomProfileDir("default");
  writeCompatibilityIni(defaultDir);
  writeProfilesIni({
    profiles: [{ name: "default", path: defaultDir.leafName }],
    installs: {
      [xreDirProvider.getInstallHash()]: { default: defaultDir.leafName },
    },
  });
  selectStartupProfile();
  checkStartupReason("default");
  let service = getProfileService();
  checkProfileService();
  Assert.ok(Services.dirsvc.get("UAppData", Ci.nsIFile).equals(gDataHome));
  info(
    `ZEN_REGISTRY_FIXTURE ${JSON.stringify({ data: gDataHome.path, local: gDataHomeLocal.path, profile: gProfD.path })}`
  );

  let files = ["profiles.ini", "installs.ini"].map(name => {
    let file = gDataHome.clone();
    file.append(name);
    return file;
  });
  async function snapshot() {
    let result = [];
    for (let file of files) {
      let bytes = await IOUtils.readUTF8(file.path);
      let fresh = file.clone();
      result.push({
        bytes,
        size: fresh.fileSize,
        mtime: fresh.lastModifiedTime,
      });
    }
    return result;
  }
  function cache() {
    return Array.from(service.profiles, p => ({
      name: p.name,
      root: p.rootDir.path,
      local: p.localDir.path,
      storeID: p.storeID,
      showSelector: p.showProfileSelector,
    }));
  }

  await service.asyncFlush();
  let unchanged = await snapshot();
  await service.asyncFlush();
  Assert.deepEqual(
    (await snapshot()).map(s => s.bytes),
    unchanged.map(s => s.bytes),
    "Unchanged native asyncFlush succeeds"
  );
  service.createProfile(makeRandomProfileDir("normal"), "base00", "tests");
  await service.asyncFlush();
  checkProfileService();
  let before = await snapshot();
  Assert.notEqual(
    before[0].bytes,
    unchanged[0].bytes,
    "Legitimate native profile creation is persisted"
  );
  let cached = cache();
  let current = service.currentProfile;
  let defaultProfile = service.defaultProfile;
  let startWithLast = service.startWithLastProfile;
  let tamperedBytes = before[0].bytes.replace("Name=base00\n", "Name=other0\n");
  Assert.notEqual(
    tamperedBytes,
    before[0].bytes,
    "One meaningful normal-profile name changes"
  );

  try {
    await IOUtils.writeUTF8(files[0].path, tamperedBytes);
    files[0].clone().lastModifiedTime = before[0].mtime;
    let tampered = await snapshot();
    Assert.equal(
      tampered[0].size,
      before[0].size,
      "Changed registry has identical native byte size"
    );
    Assert.equal(
      tampered[0].mtime,
      before[0].mtime,
      "Changed registry has identical native mtime"
    );
    Assert.deepEqual(
      tampered[1],
      before[1],
      "Tamper does not touch installs.ini"
    );
    info(`ZEN_REGISTRY_METADATA_OUTDATED ${service.isListOutdated}`);

    let pending = service.asyncFlush();
    Assert.ok(
      pending instanceof Promise,
      "Real native asyncFlush returns a Promise"
    );
    let rv = Cr.NS_OK;
    try {
      await pending;
    } catch (error) {
      rv = typeof error == "number" ? error : error.result;
    }
    let after = await snapshot();
    let preserved = after.every((s, i) => s.bytes == tampered[i].bytes);
    let cacheUnchanged = JSON.stringify(cache()) == JSON.stringify(cached);
    info(
      `ZEN_REGISTRY_PREIMAGE ${JSON.stringify({ rv, expectedRv: Cr.NS_ERROR_DATABASE_CHANGED, before, tampered, after, preserved, cacheUnchanged, cached, cacheAfter: cache() })}`
    );
    Assert.strictEqual(
      service.currentProfile,
      current,
      "Current profile identity survives"
    );
    Assert.strictEqual(
      service.defaultProfile,
      defaultProfile,
      "Default profile identity survives"
    );
    Assert.equal(
      service.startWithLastProfile,
      startWithLast,
      "Startup selection survives"
    );
    Assert.deepEqual(cache(), cached, "Normal profile cache survives");
    Assert.ok(
      rv == Cr.NS_ERROR_DATABASE_CHANGED && preserved && cacheUnchanged,
      "Same-size/mtime exact-preimage mismatch must reject NS_ERROR_DATABASE_CHANGED before either registry write"
    );
  } finally {
    for (let [i, file] of files.entries()) {
      await IOUtils.writeUTF8(file.path, before[i].bytes);
      file.clone().lastModifiedTime = before[i].mtime;
    }
    Assert.deepEqual(
      await snapshot(),
      before,
      "Owned registry bytes and metadata are restored before cleanup"
    );
  }
});
