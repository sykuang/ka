/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

add_task(async function test_native_queued_full_flush() {
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
    `ZEN_QUEUE_FIXTURE ${JSON.stringify({ data: gDataHome.path, local: gDataHomeLocal.path, profile: gProfD.path })}`
  );

  let files = ["profiles.ini", "installs.ini"].map(name => {
    let file = gDataHome.clone();
    file.append(name);
    return file;
  });
  function snapshot() {
    return files.map(file => {
      let stream = Cc[
        "@mozilla.org/network/file-input-stream;1"
      ].createInstance(Ci.nsIFileInputStream);
      stream.init(file, 0x01, 0, 0);
      try {
        let bytes = NetUtil.readInputStreamToString(stream, stream.available());
        let fresh = file.clone();
        return { bytes, size: fresh.fileSize, mtime: fresh.lastModifiedTime };
      } finally {
        stream.close();
      }
    });
  }
  function cache() {
    return Array.from(service.profiles, p => ({
      name: p.name,
      root: p.rootDir.path,
      local: p.localDir.path,
      storeID: p.storeID,
      showSelector: p.showProfileSelector,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  let original = snapshot();
  let current = service.currentProfile;
  let defaultProfile = service.defaultProfile;
  let startWithLast = service.startWithLastProfile;
  let pending = [];
  try {
    await service.asyncFlush();
    let normalized = snapshot();
    let expected = readProfilesIni();
    checkProfileService(expected);
    let baseDir = makeRandomProfileDir("base00");
    let newerDir = makeRandomProfileDir("newer01");
    let base = service.createProfile(baseDir, "base00", "tests");
    let first = service.asyncFlush();
    pending.push(first);
    let newer = service.createProfile(newerDir, "newer01", "tests");
    let second = service.asyncFlush();
    pending.push(second);
    let queued = snapshot();
    let queuedCache = cache();
    let atFirstSettlement;
    let firstReceipt = first.then(
      () => (atFirstSettlement = snapshot()),
      () => (atFirstSettlement = snapshot())
    );
    let results = await Promise.allSettled([first, second]);
    await firstReceipt;
    let final = snapshot();
    let profileData = readProfilesIni();
    let installData = readInstallsIni();
    for (let [name, dir] of [
      ["base00", baseDir],
      ["newer01", newerDir],
    ]) {
      expected.profiles.push({
        name,
        path: dir.getRelativeDescriptor(gDataHome),
        isRelative: true,
        storeID: null,
        default: false,
      });
    }
    expected.profiles.sort((a, b) => a.name.localeCompare(b.name));
    let promiseResults = results.map(result => ({
      status: result.status,
      rv:
        result.status == "fulfilled"
          ? Cr.NS_OK
          : typeof result.reason == "number"
            ? result.reason
            : result.reason.result,
    }));
    info(
      `ZEN_QUEUE_RESULT ${JSON.stringify({ label: "controlled API request queue not natural crossprocess race", original, normalized, queued, atFirstSettlement, final, promiseResults, expected, profileData, installData, queuedCache, finalCache: cache(), profileCount: service.profileCount, currentUnchanged: service.currentProfile === current, defaultUnchanged: service.defaultProfile === defaultProfile, startWithLastUnchanged: service.startWithLastProfile === startWithLast })}`
    );
    Assert.ok(first instanceof Promise, "First native API returns a Promise");
    Assert.ok(second instanceof Promise, "Second native API returns a Promise");
    Assert.notEqual(first, second, "Native calls return separate promises");
    Assert.notEqual(
      final[0].bytes,
      normalized[0].bytes,
      "First legitimate profile changes the persisted image"
    );
    Assert.strictEqual(service.currentProfile, current, "Current is unchanged");
    Assert.strictEqual(
      service.defaultProfile,
      defaultProfile,
      "Default is unchanged"
    );
    Assert.equal(service.startWithLastProfile, startWithLast);
    Assert.equal(service.profileCount, expected.profiles.length);
    Assert.deepEqual(cache(), queuedCache, "Newest native cache survives");
    Assert.strictEqual(service.getProfileByName("base00"), base);
    Assert.strictEqual(service.getProfileByName("newer01"), newer);
    Assert.deepEqual(
      promiseResults,
      [
        { status: "fulfilled", rv: Cr.NS_OK },
        { status: "fulfilled", rv: Cr.NS_OK },
      ],
      "Both legitimate queued native full flushes must fulfill"
    );
    Assert.deepEqual(
      profileData,
      expected,
      "Final INI includes both exact profile name/path bindings"
    );
    checkProfileService(expected);
    checkBackup(profileData, installData);
  } finally {
    await Promise.allSettled(pending);
    for (let [i, file] of files.entries()) {
      await IOUtils.writeUTF8(file.path, original[i].bytes);
      file.clone().lastModifiedTime = original[i].mtime;
    }
    Assert.deepEqual(
      snapshot(),
      original,
      "Owned raw registry is restored after both promises settle, before cleanup"
    );
  }
});
