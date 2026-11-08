/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { ZenProfileOverlay } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenProfileOverlay.sys.mjs"
);

const $ = id => document.getElementById(id);
const browserWindow = () => Services.wm.getMostRecentWindow("navigator:browser");

function spacesOf(descriptor) {
  return browserWindow()
    .gZenWorkspaces.getWorkspaces()
    .filter(
      space =>
        ZenProfileOverlay.boundProfile(space.uuid)?.persistentDescriptor === descriptor
    );
}

function render(select = $("list").value) {
  const profiles = ZenProfileOverlay.otherProfiles();
  $("list").replaceChildren(
    ...profiles.map(({ name, descriptor }) => {
      const count = spacesOf(descriptor).length;
      const option = new Option(
        `${name} — ${count ? `${count} Space${count > 1 ? "s" : ""}` : "no Spaces"}`,
        descriptor
      );
      option.dataset.name = name;
      return option;
    })
  );
  $("list").value = profiles.some(p => p.descriptor === select)
    ? select
    : (profiles[0]?.descriptor ?? "");
  $("remove").disabled = profiles.length < 2;
  showSelected();
}

function showSelected() {
  const option = $("list").selectedOptions[0];
  $("right").hidden = !option;
  if (!option) {
    return;
  }
  $("name").value = option.dataset.name;
  const spaces = spacesOf(option.value);
  $("spaces").replaceChildren(
    ...spaces.map(space => {
      const li = document.createElement("li");
      li.textContent = space.name;
      return li;
    })
  );
  for (const button of $("panes").querySelectorAll("button")) {
    button.disabled = !spaces.length;
  }
  $("note").hidden = !!spaces.length;
}

async function openPane(pane) {
  const window = browserWindow();
  const [space] = spacesOf($("list").value);
  if (window.gZenWorkspaces.activeWorkspace !== space.uuid) {
    await window.gZenWorkspaces.changeWorkspaceWithID(space.uuid);
  }
  window.openTrustedLinkIn(`about:preferences#${pane}`, "tab");
  window.focus();
}

function add() {
  const name = { value: "" };
  if (!Services.prompt.prompt(window, "New Profile", "Name", name, null, {}) || !name.value.trim()) {
    return;
  }
  render(ZenProfileOverlay.createProfile(name.value.trim()));
}

function rename() {
  const name = $("name").value.trim();
  if (name) {
    ZenProfileOverlay.renameProfile($("list").value, name);
    render();
  }
}

async function remove() {
  const descriptor = $("list").value;
  const name = $("list").selectedOptions[0].dataset.name;
  const others = ZenProfileOverlay.otherProfiles().filter(p => p.descriptor !== descriptor);
  let moveTo = others[0].descriptor;
  const spaces = spacesOf(descriptor);
  if (spaces.length) {
    const choice = {};
    if (
      !Services.prompt.select(
        window,
        `Delete ${name}`,
        `Move its ${spaces.length} Space(s) to:`,
        others.map(p => p.name),
        choice
      )
    ) {
      return;
    }
    moveTo = others[choice.value].descriptor;
  }
  if (
    !Services.prompt.confirm(
      window,
      `Delete ${name}`,
      `All data of ${name} (history, cookies, passwords, extensions) will be deleted for good.`
    )
  ) {
    return;
  }
  await ZenProfileOverlay.deleteProfile(descriptor, moveTo);
  const workspaces = browserWindow().gZenWorkspaces;
  await workspaces.changeWorkspace(workspaces.getActiveWorkspaceFromCache(), {
    alwaysChange: true,
  });
  render(moveTo);
}

window.addEventListener("DOMContentLoaded", () => {
  $("list").addEventListener("change", () => showSelected());
  $("add").addEventListener("click", add);
  $("rename").addEventListener("click", rename);
  $("name").addEventListener("keydown", e => e.key === "Enter" && rename());
  $("remove").addEventListener("click", remove);
  $("panes").addEventListener("click", e => e.target.dataset.pane && openPane(e.target.dataset.pane));
  window.addEventListener("focus", () => render());
  render();
});
