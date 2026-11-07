/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

add_task(async function catalog_popup_is_registered() {
  await gZenWorkspaces.promiseInitialized;
  const item = document.getElementById("context_zenIndependentCatalog");
  Assert.ok(item, "The existing Space popup exposes catalog connection");
  Assert.equal(item.localName, "menuitem", "One ordinary menu item");
  Assert.equal(
    item.parentNode.id,
    "zenWorkspaceMoreActions",
    "No separate manager UI"
  );
  Assert.equal(
    document.querySelectorAll("#context_zenIndependentCatalog").length,
    1,
    "Connection command is registered once"
  );
  const { ZenSessionStore } = ChromeUtils.importESModule(
    "resource:///modules/zen/ZenSessionManager.sys.mjs"
  );
  Assert.equal(typeof ZenSessionStore.activateIndependentCatalog, "function");
  Assert.equal(typeof gZenWorkspaces.canMutateWorkspaceMetadata, "boolean");
  info(
    "SKIP activation transport: this browser test has no owned registered catalog fixture; no Client or native task is launched."
  );
});
