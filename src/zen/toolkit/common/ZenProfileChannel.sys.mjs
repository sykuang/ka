/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Manager <-> profile worker channel: newline-delimited JSON over a 0600 Unix
// socket. The worker's first message must carry the per-launch token. The
// worker reports its tabs; the manager sends browsing commands back.

const encoder = new TextEncoder();

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
        onMessage(message);
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

  const channel = wire(transport, message => {
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
      case "navigate":
        window.openTrustedLinkIn(message.url, "current");
        break;
    }
  });
  channel.send({ hello: token });

  let queued = false;
  const report = () => {
    if (queued) {
      return;
    }
    queued = true;
    window.setTimeout(() => {
      queued = false;
      channel.send({
        type: "tabs",
        tabs: gBrowser.tabs.map(tab => ({
          id: idOf(tab),
          label: tab.label,
          url: tab.linkedBrowser?.currentURI?.spec ?? "",
          // ponytail: favicon URL as the worker sees it; page-icon: URLs need
          // the bytes sent over when the manager draws them.
          icon: tab.image || "",
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
  report();
}
