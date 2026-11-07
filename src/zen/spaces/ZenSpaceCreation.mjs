/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "l10n", () => {
  return new Localization(["browser/zen-workspaces.ftl"], true);
});

ChromeUtils.defineESModuleGetters(
  lazy,
  {
    ZenLibrary: "moz-src:///zen/library/ZenLibrary.mjs",
    nsZenThemePicker: "resource:///modules/zen/ZenGradientGenerator.mjs",
  },
  { global: "current" }
);

class nsZenWorkspaceCreation extends MozXULElement {
  #wasInCollapsedMode = false;
  #urlbarDimmed = false;
  #ownerManager = null;
  #closed = false;
  #submitting = false;

  get #ownsDraft() {
    return this.isConnected && !this.#closed && !window.closed &&
      gZenWorkspaces === this.#ownerManager &&
      this.#ownerManager.creatingWorkspaceId === this.workspaceId;
  }

  get #canEdit() {
    return this.workspaceDraft
      ? this.#ownsDraft && !this.#submitting
      : gZenWorkspaces.canMutateWorkspaceMetadata !== false;
  }

  promiseInitialized = new Promise(resolve => {
    this.resolveInitialized = resolve;
  });

  #hiddenElements = [];

  static get elementsToDisable() {
    return [
      "cmd_zenOpenWorkspacePanel",
      "cmd_zenOpenWorkspaceCreation",
      "cmd_zenOpenFolderCreation",
      "cmd_zenToggleSidebar",
      "cmd_newNavigatorTab",
      "cmd_newNavigatorTabNoEvent",
    ];
  }

  static get markup() {
    return `
        <vbox class="zen-workspace-creation" flex="1">
          <form>
            <vbox>
              <html:h1 data-l10n-id="zen-workspace-creation-header" class="zen-workspace-creation-title" />
              <html:div>
                <label data-l10n-id="zen-workspace-creation-label" class="zen-workspace-creation-label" />
              </html:div>
            </vbox>
            <vbox class="zen-workspace-creation-form">
              <hbox class="zen-workspace-creation-name-wrapper">
                <toolbarbutton class="zen-workspace-creation-icon-label zen-squircle-before" />
                <html:input
                  class="zen-workspace-creation-name"
                  type="text"
                  data-l10n-id="zen-workspace-creation-name" />
              </hbox>
              <hbox class="zen-workspace-creation-profile-wrapper">
                <label class="zen-workspace-creation-profile-label" data-l10n-id="zen-workspace-creation-profile" />
                <button class="zen-workspace-creation-profile" />
              </hbox>
              <button
                class="zen-workspace-creation-edit-theme-button"
                data-l10n-id="zen-workspaces-change-theme"
                command="cmd_zenOpenZenThemePicker" />
              <menupopup class="zen-workspace-creation-profiles-popup" />
            </vbox>
            <vbox class="zen-workspace-creation-buttons">
              <html:div>
                <button class="zen-workspace-creation-create-button footer-button primary"
                  data-l10n-id="zen-panel-ui-workspaces-create" disabled="true" />
              </html:div>
              <button class="zen-workspace-creation-cancel-button footer-button"
                data-l10n-id="zen-general-cancel-label" />
            </vbox>
          </form>
        </vbox>
      `;
  }

  get workspaceId() {
    return this.getAttribute("workspace-id");
  }

  get previousWorkspaceId() {
    return this.getAttribute("previous-workspace-id");
  }

  get elementsToAnimate() {
    return [
      this.querySelector(".zen-workspace-creation-title"),
      this.querySelector(".zen-workspace-creation-label").parentElement,
      this.querySelector(".zen-workspace-creation-name-wrapper"),
      this.querySelector(".zen-workspace-creation-profile-wrapper"),
      this.querySelector(".zen-workspace-creation-edit-theme-button"),
      this.createButton.parentNode,
      this.cancelButton,
    ];
  }

  get #spaceSwitchDuration() {
    return (
      Services.prefs.getIntPref("zen.workspaces.switch-animation-duration") /
      1000
    );
  }

  #dimUrlbar() {
    if (this.#urlbarDimmed || !gZenVerticalTabsManager._hasSetSingleToolbar) {
      return;
    }
    this.#urlbarDimmed = true;
    const animation = gZenUIManager.motion.animate(
      gURLBar,
      {
        opacity: [1, 0],
      },
      {
        duration: this.#spaceSwitchDuration,
        type: "spring",
        bounce: 0,
      }
    );
    if (gReduceMotion) {
      animation.complete();
    }
  }

  #restoreUrlbar() {
    if (!this.#urlbarDimmed) {
      return;
    }
    this.#urlbarDimmed = false;
    const animation = gZenUIManager.motion.animate(
      gURLBar,
      {
        opacity: [0, 1],
      },
      {
        duration: this.#spaceSwitchDuration,
        type: "spring",
        bounce: 0,
      }
    );
    if (gReduceMotion) {
      animation.complete();
    }
    animation.then(() => {
      gURLBar.style.removeProperty("opacity");
    });
  }

  connectedCallback() {
    if (this.delayConnectedCallback()) {
      // If we are not ready yet, or if we have already connected, we
      // don't need to do anything.
      return;
    }

    this.#ownerManager = gZenWorkspaces;
    lazy.ZenLibrary.close();
    this.appendChild(this.constructor.fragment);
    this.initializeAttributeInheritance();

    this.inputName = this.querySelector(".zen-workspace-creation-name");
    this.inputIcon = this.querySelector(".zen-workspace-creation-icon-label");
    this.inputProfile = this.querySelector(".zen-workspace-creation-profile");
    this.createButton = this.querySelector(
      ".zen-workspace-creation-create-button"
    );
    this.cancelButton = this.querySelector(
      ".zen-workspace-creation-cancel-button"
    );

    if (this.workspaceDraft) {
      // The shared picker resolves live Spaces and saves on close; it has no
      // draft callback. Keep this basic color preview entirely inside the form.
      const button = this.querySelector(".zen-workspace-creation-edit-theme-button");
      button.removeAttribute("command");
      const color = document.createElementNS("http://www.w3.org/1999/xhtml", "input");
      color.type = "color";
      button.id = `zen-workspace-creation-edit-theme-${this.workspaceId}`;
      color.setAttribute("aria-labelledby", button.id);
      button.after(color);
      button.addEventListener("command", () => {
        if (this.#canEdit) {
          color.click();
        }
      });
      color.addEventListener("input", () => {
        if (!this.#canEdit) {
          return;
        }
        this.workspaceDraft.theme = lazy.nsZenThemePicker.getTheme([
          { c: color.value, isCustom: true },
        ]);
        this.querySelector(".zen-workspace-creation-form").style.backgroundColor = color.value;
      });
    }

    this.#wasInCollapsedMode =
      document.documentElement.getAttribute("zen-sidebar-expanded") !== "true";

    gNavToolbox.setAttribute("zen-sidebar-expanded", "true");
    document.documentElement.setAttribute("zen-sidebar-expanded", "true");

    window.docShell.treeOwner
      .QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsIAppWindow)
      .rollupAllPopups();

    gURLBar.view.close();
    gURLBar.handleRevert();
    gURLBar.blur();

    this.handleZenWorkspacesChangeBind =
      this.handleZenWorkspacesChange.bind(this);

    for (const element of this.parentElement.children) {
      if (element !== this && !element.hidden) {
        element.hidden = true;
        this.#hiddenElements.push(element);
      }
    }

    for (const element of nsZenWorkspaceCreation.elementsToDisable) {
      const el = document.getElementById(element);
      if (el) {
        el.setAttribute("disabled", "true");
      }
    }

    this.createButton.addEventListener(
      "command",
      this.onCreateButtonCommand.bind(this)
    );
    this.cancelButton.addEventListener(
      "command",
      this.onCancelButtonCommand.bind(this)
    );

    this.inputName.addEventListener("input", () => {
      this.createButton.disabled = this.#submitting || !this.inputName.value.trim();
    });

    this.inputName.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (!this.createButton.disabled) {
          this.createButton.doCommand();
        }
      }
    });

    // Bound on the root so Esc works regardless of which child has focus
    // (name input, icon picker trigger, profile button, primary button).
    // Open popups consume Esc before it reaches us, so the emoji/profile
    // pickers still close as expected.
    this.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.cancelButton.doCommand();
      }
    });

    this.inputIcon.addEventListener("command", this.onIconCommand.bind(this));

    this.profilesPopup = this.querySelector(
      ".zen-workspace-creation-profiles-popup"
    );

    if (gZenWorkspaces.shouldShowContainers) {
      this.inputProfile.addEventListener(
        "command",
        this.onProfileCommand.bind(this)
      );
      this.profilesPopup.addEventListener(
        "popupshowing",
        this.onProfilePopupShowing.bind(this)
      );
      this.profilesPopup.addEventListener(
        "command",
        this.onProfilePopupCommand.bind(this)
      );

      this.currentProfile = {
        id: 0,
        name: lazy.l10n.formatValueSync("zen-workspace-default-profile"),
      };
    } else {
      this.inputProfile.parentNode.hidden = true;
    }

    document.getElementById("zen-sidebar-splitter").style.pointerEvents =
      "none";
    this.#dimUrlbar();
    this.resolveInitialized();
  }

  connectedMoveCallback() {
    // Moving the owning Space preserves this form and its draft ownership.
  }

  disconnectedCallback() {
    if (this.#ownerManager?.creatingWorkspaceId === this.workspaceId) {
      this.#ownerManager.creatingWorkspaceId = null;
    }
    if (this.workspaceDraft && !this.#closed) {
      void this.#cleanup({ animateOut: false });
    }
  }

  async onCreateButtonCommand() {
    if (this.workspaceDraft) {
      if (this.#submitting || this.#closed) {
        return;
      }
      const manager = this.#ownerManager;
      let result = { status: "REFUSED" };
      if (this.#ownsDraft && manager.canCreateIndependentCatalogSpace && this.inputName.value.trim()) {
        this.#submitting = true;
        this.createButton.disabled = true;
        const draft = {
          ...this.workspaceDraft,
          name: this.inputName.value.trim(),
          icon: this.inputIcon.image || this.inputIcon.label || undefined,
          containerTabId: this.currentProfile ?? 0,
        };
        try {
          result = await manager.createIndependentCatalogSpace(draft, () => this.#ownsDraft);
        } catch (error) {
          Cu.reportError(error);
          result = { status: "UNKNOWN" };
        }
      }
      const current = this.#ownsDraft;
      await this.#cleanup({ animateOut: false });
      if (result.status === "COMMITTED" && current && !window.closed &&
          gZenWorkspaces === manager && !manager.creatingWorkspaceId &&
          manager.canCreateIndependentCatalogSpace &&
          manager.activeWorkspace === this.previousWorkspaceId) {
        await manager.changeWorkspaceWithID(this.workspaceId);
      } else if (result.status !== "COMMITTED" && !window.closed) {
        const [title, body] = await document.l10n.formatValues([
          { id: "zen-workspaces-independent-title" },
          { id: result.status === "PARTIAL" ? "zen-workspaces-independent-partial" :
              result.status === "UNKNOWN" ? "zen-workspaces-independent-unknown" :
              "zen-workspaces-independent-refused" },
        ]);
        if (!window.closed) {
          Services.prompt.alert(window, title, body);
        }
      }
      return result;
    }
    if (gZenWorkspaces.canMutateWorkspaceMetadata === false) {
      return;
    }
    const workspace = gZenWorkspaces.getActiveWorkspace();
    workspace.name = this.inputName.value.trim();
    workspace.icon = this.inputIcon.image || this.inputIcon.label || undefined;
    workspace.containerTabId = this.currentProfile ?? 0;
    await gZenWorkspaces.saveWorkspace(workspace);

    await this.#cleanup();

    gZenWorkspaces._organizeWorkspaceStripLocations(workspace, true);
    gZenWorkspaces.updateTabsContainers();

    gBrowser.tabContainer._invalidateCachedTabs();
  }

  async onCancelButtonCommand() {
    if (this.workspaceDraft) {
      await this.#cleanup({ animateOut: false });
      return;
    }
    if (gZenWorkspaces.canMutateWorkspaceMetadata === false) {
      await this.#cleanup({ animateOut: false });
      return;
    }
    document.documentElement.removeAttribute("zen-creating-workspace");
    this.#restoreUrlbar();
    await gZenWorkspaces.changeWorkspaceWithID(this.previousWorkspaceId);
  }

  onIconCommand(event) {
    if (!this.#canEdit) {
      return;
    }
    gZenEmojiPicker.open(event.target, {
      closeOnSelect: false,
      onSelect: async icon => {
        if (!this.#canEdit) {
          return;
        }
        const isSvg = icon && icon.endsWith(".svg");
        if (isSvg) {
          this.inputIcon.label = "";
          this.inputIcon.image = icon;
          this.inputIcon.setAttribute("has-svg-icon", "true");
        } else {
          this.inputIcon.image = "";
          this.inputIcon.label = icon || "";
          this.inputIcon.removeAttribute("has-svg-icon");
        }
      },
    });
  }

  set currentProfile(profile) {
    this.inputProfile.label = profile.name;
    this._profileId = profile.id;
  }

  get currentProfile() {
    return this._profileId;
  }

  onProfileCommand(event) {
    if (!this.#canEdit) {
      return;
    }
    this.profilesPopup.openPopup(event.target, "after_start");
  }

  onProfilePopupShowing(event) {
    if (!this.#canEdit) {
      return;
    }
    window.createUserContextMenu(event, {
      isContextMenu: true,
      showDefaultTab: true,
      showManageContainers: false,
    });

    const defaultItem = event.target.querySelector('[data-usercontextid="0"]');
    if (defaultItem) {
      defaultItem.removeAttribute("data-l10n-id");
      defaultItem.label = lazy.l10n.formatValueSync(
        "zen-workspace-default-profile"
      );
    }
  }

  onProfilePopupCommand(event) {
    if (!this.#canEdit) {
      return;
    }
    let userContextId = parseInt(
      event.target.getAttribute("data-usercontextid")
    );
    if (isNaN(userContextId)) {
      return;
    }
    this.currentProfile = {
      id: userContextId,
      name: event.target.label,
    };
  }

  finishSetup() {
    this.inputName.focus();
    gZenWorkspaces.addChangeListeners(this.handleZenWorkspacesChangeBind, {
      once: true,
    });
  }

  async handleZenWorkspacesChange() {
    if (this.workspaceDraft || gZenWorkspaces.canMutateWorkspaceMetadata === false) {
      await this.#cleanup({ animateOut: false });
      return;
    }
    // The space we were living in has already slid away, no need to animate
    // ourselves out of it.
    await this.#cleanup({ animateOut: false });
    await gZenWorkspaces.removeWorkspace(this.workspaceId);
  }

  async #cleanup({ animateOut = true } = {}) {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (animateOut && !gReduceMotion && this.isConnected) {
      await gZenUIManager.motion.animate(
        this.elementsToAnimate.reverse(),
        {
          y: [0, 20],
          opacity: [1, 0],
          filter: ["blur(0)", "blur(2px)"],
        },
        {
          duration: 0.3,
          type: "spring",
          bounce: 0,
          delay: gZenUIManager.motion.stagger(0.03),
        }
      );
    }

    document.getElementById("zen-sidebar-splitter").style.pointerEvents = "";

    this.#ownerManager.removeChangeListeners(this.handleZenWorkspacesChangeBind);
    for (const element of this.constructor.elementsToDisable) {
      const el = document.getElementById(element);
      if (el) {
        el.removeAttribute("disabled");
      }
    }

    if (this.#wasInCollapsedMode) {
      gNavToolbox.removeAttribute("zen-sidebar-expanded");
      document.documentElement.removeAttribute("zen-sidebar-expanded");
    }

    document.documentElement.removeAttribute("zen-creating-workspace");

    this.remove();
    this.#restoreUrlbar();

    // Give the space back its own contents.
    const revealedElements = this.#hiddenElements;
    this.#hiddenElements = [];
    for (const element of revealedElements) {
      element.hidden = false;
    }

    // Now that the form is gone the space owns its essentials again, so let
    // it lay itself out before we fade everything back in.
    const workspace = gZenWorkspaces.getActiveWorkspace();
    gZenWorkspaces._organizeWorkspaceStripLocations(workspace);
    gZenWorkspaces.updateTabsContainers();
    // The essentials were parked off screen while we were up, put them back.
    gZenWorkspaces.resetEssentialsPosition();

    if (animateOut && !gReduceMotion) {
      const elementsToReveal = revealedElements.filter(
        element => element?.isConnected
      );
      if (elementsToReveal.length) {
        gZenUIManager.motion
          .animate(
            elementsToReveal,
            {
              opacity: [0, 1],
            },
            {
              duration: 0.3,
              type: "spring",
              bounce: 0,
            }
          )
          .then(() => {
            for (const element of elementsToReveal) {
              element.style.removeProperty("opacity");
            }
          });
      }
    }

    gZenUIManager.updateTabsToolbar();
  }
}

customElements.define("zen-workspace-creation", nsZenWorkspaceCreation);
