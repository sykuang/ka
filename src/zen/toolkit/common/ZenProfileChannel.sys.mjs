/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Manager <-> profile worker channel: newline-delimited JSON over a 0600 Unix
// socket. The worker's first message must carry the per-launch token. The
// worker reports its tabs; the manager sends browsing commands back.

const encoder = new TextEncoder();

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  ExtensionParent: "resource://gre/modules/ExtensionParent.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});

function wire(transport, onMessage, onClose) {
  const output = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(
    Ci.nsIBinaryOutputStream
  );
  output.setOutputStream(transport.openOutputStream(0, 0, 0));
  const input = transport.openInputStream(0, 0, 0);
  const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
    Ci.nsIBinaryInputStream
  );
  binary.setInputStream(input);
  const decoder = new TextDecoder();
  let pending = "";
  const pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(
    Ci.nsIInputStreamPump
  );
  pump.init(input, 0, 0, false);
  pump.asyncRead({
    onStartRequest() {},
    onStopRequest() {
      onClose?.();
    },
    onDataAvailable(request, stream, offset, count) {
      pending += decoder.decode(new Uint8Array(binary.readByteArray(count)), {
        stream: true,
      });
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          transport.close(Cr.NS_ERROR_FAILURE);
          return;
        }
        try {
          onMessage(message);
        } catch (e) {
          console.error("ZenProfileChannel: message handler failed", e);
        }
      }
    },
  });
  return {
    send(message) {
      const bytes = encoder.encode(JSON.stringify(message) + "\n");
      output.writeByteArray(bytes);
      output.flush();
    },
    close() {
      transport.close(Cr.NS_OK);
    },
  };
}

// Manager side. Returns { path, token, send, close }; onMessage only ever sees
// messages from the one worker that presented the token.
export function listen(onMessage) {
  const token = Services.uuid.generateUUID().toString().slice(1, -1);
  // Unix socket paths are short (104 bytes on macOS): keep it under /tmp.
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(`/tmp/zen-${Services.appinfo.processID}-${token.slice(0, 8)}.sock`);
  const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(
    Ci.nsIServerSocket
  );
  server.initWithFilename(file, 0o600, -1);
  let peer = null;
  server.asyncListen({
    onSocketAccepted(socket, transport) {
      if (peer) {
        transport.close(Cr.NS_ERROR_FAILURE);
        return;
      }
      let admitted = false;
      const connection = wire(
        transport,
        message => {
          if (!admitted) {
            if (message?.hello !== token) {
              connection.close();
              return;
            }
            admitted = true;
            peer = connection;
            return;
          }
          onMessage(message);
        },
        () => {
          if (peer === connection) {
            peer = null;
          }
        }
      );
    },
    onStopListening() {},
  });
  return {
    path: file.path,
    token,
    send(message) {
      peer?.send(message);
    },
    close() {
      peer?.close();
      server.close();
      try {
        file.remove(false);
      } catch {}
    },
  };
}

// Worker side: report this window's tabs and obey manager commands.
export function serveWorker(window, spec) {
  const [path, token] = spec.split(" ");
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  const transport = Cc[
    "@mozilla.org/network/socket-transport-service;1"
  ].getService(Ci.nsISocketTransportService).createUnixDomainTransport(file);
  const { gBrowser } = window;
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = tab => {
    if (!ids.has(tab)) {
      ids.set(tab, nextId++);
    }
    return ids.get(tab);
  };
  const tabById = id => gBrowser.tabs.find(tab => idOf(tab) === id);

  let answerPrompt = () => {};
  const browserAction = id => {
    const extension = WebExtensionPolicy.getByID(id)?.extension;
    return extension && lazy.ExtensionParent.apiManager.global.browserActionFor?.(extension);
  };
  const channel = wire(transport, message => {
    if (message.type === "prompt-answer") {
      answerPrompt(message);
      return;
    }
    const tab = tabById(message.id);
    switch (message.type) {
      case "select":
        if (tab) {
          gBrowser.selectedTab = tab;
        }
        break;
      case "close":
        if (tab) {
          gBrowser.removeTab(tab);
        }
        break;
      case "open":
        window.openTrustedLinkIn(message.url || "about:blank", "tab");
        break;
      case "extension": {
        // The worker draws no toolbar: run the action here; a popup is shown
        // as a tab (the manager overlays this window's content, not its panels).
        // ponytail: popup as a tab, not an anchored panel; draw panels in the
        // manager if popups that rely on panel sizing/auto-close matter.
        const action = browserAction(message.extension);
        const url = action?.action.triggerClickOrPopup(gBrowser.selectedTab, {
          button: 0,
          modifiers: [],
        });
        if (url) {
          window.openTrustedLinkIn(url, "tab");
        }
        break;
      }
      case "pin":
        if (tab && tab.pinned !== !!message.pinned) {
          message.pinned ? gBrowser.pinTab(tab) : gBrowser.unpinTab(tab);
        }
        break;
      case "move": {
        // Place after the tab that precedes it in the manager sidebar (none:
        // first of its pinned/unpinned group).
        const after = tabById(message.after);
        // (moveTabTo's tabIndex means "insert before the tab now at this index".)
        if (tab && after && after !== tab) {
          gBrowser.moveTabTo(tab, { tabIndex: gBrowser.tabs.indexOf(after) + 1 });
        } else if (tab && !message.after) {
          gBrowser.moveTabTo(tab, { tabIndex: tab.pinned ? 0 : gBrowser.pinnedTabCount });
        }
        break;
      }
      case "navigate":
        if (tab) {
          gBrowser.selectedTab = tab;
        }
        window.openTrustedLinkIn(message.url, "current");
        break;
    }
  }, () => {
    // The manager went away (quit or crash): we only exist to serve it, and
    // lingering would keep this Profile locked for the next launch.
    Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
  });
  channel.send({ hello: token });

  // Permission prompts would open in this worker's hidden chrome; ask the
  // manager to show them instead and run the chosen action here.
  // ponytail: message + buttons only (no checkbox, no custom panel content).
  const prompts = new Map();
  let nextPrompt = 1;
  const { PopupNotifications } = window;
  const show = PopupNotifications.show.bind(PopupNotifications);
  PopupNotifications.show = (...args) => {
    const notification = show(...args);
    const [, , message, , mainAction, secondaryActions, options] = args;
    if (notification && mainAction) {
      const key = nextPrompt++;
      prompts.set(key, notification);
      const text = typeof message === "string" ? message : message?.textContent || "";
      channel.send({
        type: "prompt",
        key,
        message: text.replace("<>", options?.name ?? ""),
        actions: [mainAction, ...(secondaryActions || [])].map(action => action.label),
      });
    }
    return notification;
  };
  answerPrompt = ({ key, index }) => {
    const notification = prompts.get(key);
    prompts.delete(key);
    const action = [notification?.mainAction, ...(notification?.secondaryActions || [])][index];
    if (action) {
      action.callback({ checkboxChecked: false, source: "button" });
      PopupNotifications.remove(notification);
    }
  };

  const icons = new Map(); // worker icon URL -> data: URL ("" while loading)
  const iconData = url => {
    // Tab images are moz-remote-image:// wrappers bound to this process's
    // content; the real icon URL is its url= parameter.
    if (url?.startsWith("moz-remote-image:")) {
      url = new URL(url).searchParams.get("url");
    }
    if (!url || url.startsWith("data:")) {
      return url || "";
    }
    if (!icons.has(url)) {
      icons.set(url, "");
      lazy.NetUtil.asyncFetch(
        { uri: url, loadUsingSystemPrincipal: true },
        (stream, status, request) => {
          if (!Components.isSuccessCode(status)) {
            console.error("ZenProfileChannel: icon fetch failed", url, status);
            return;
          }
          // ponytail: 64 KB cap, ample for favicons.
          const bytes = lazy.NetUtil.readInputStreamToString(
            stream,
            Math.min(stream.available(), 65536)
          );
          const type = request.QueryInterface(Ci.nsIChannel).contentType || "image/png";
          icons.set(url, `data:${type};base64,${btoa(bytes)}`);
          report();
        }
      );
    }
    return icons.get(url);
  };
  let queued = false;
  const report = () => {
    if (queued) {
      return;
    }
    queued = true;
    window.setTimeout(() => {
      queued = false;
      const extensions = [];
      for (const policy of WebExtensionPolicy.getActiveExtensions()) {
        const action = policy.extension && browserAction(policy.id);
        if (!action || policy.isPrivileged) {
          continue;
        }
        const tab = gBrowser.selectedTab;
        const icons = action.action.getProperty(tab, "icon") || {};
        const size = Object.keys(icons).sort((a, b) => Math.abs(a - 32) - Math.abs(b - 32))[0];
        extensions.push({
          id: policy.id,
          title: action.action.getProperty(tab, "title") || policy.name,
          icon: iconData(icons[size]),
        });
      }
      channel.send({
        type: "tabs",
        extensions,
        // Zen's own placeholder "empty tab" is chrome, not browsing state.
        tabs: gBrowser.tabs.filter(tab => !tab.hasAttribute("zen-empty-tab")).map(tab => ({
          id: idOf(tab),
          label: tab.label,
          url: tab.linkedBrowser?.currentURI?.spec ?? "",
          // The worker's icon URLs (page-icon:, cached http) mean nothing to
          // the manager, so ship the bytes as a data: URL.
          icon: iconData(tab.image),
          selected: tab.selected,
          pinned: tab.pinned,
        })),
      });
    }, 50);
  };
  for (const type of [
    "TabOpen",
    "TabClose",
    "TabSelect",
    "TabAttrModified",
    "TabPinned",
    "TabUnpinned",
    "TabMove",
  ]) {
    gBrowser.tabContainer.addEventListener(type, report);
  }
  gBrowser.addTabsProgressListener({ onLocationChange: report });
  lazy.ExtensionParent.apiManager.on("ready", report);
  lazy.ExtensionParent.apiManager.on("shutdown", report);

  // Downloads run here with no UI; hand finished ones to the manager's list.
  lazy.Downloads.getList(lazy.Downloads.ALL).then(list =>
    list.addView({
      onDownloadChanged(download) {
        if (download.succeeded && !download.zenReported) {
          download.zenReported = true;
          channel.send({
            type: "download",
            source: download.source.url,
            target: download.target.path,
          });
        }
      },
    })
  );
  report();
}
