/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef ZenProfileHostNative_h
#define ZenProfileHostNative_h
#include "nsError.h"
#include "nsStringFwd.h"
#include <cstdint>
class mozIDOMWindowProxy;
class nsIFile;
class nsIObserver;
struct JSContext;
namespace mozilla::dom {
class Element;
class Promise;
}
namespace zen::profilehost {
struct StartupExpectation;
nsresult PrepareStartupWorker(mozIDOMWindowProxy* window, nsIFile* authority,
    nsIFile* root, nsIFile* local, const nsACString& name, const nsACString& path,
    const nsACString& isRelative, bool storeIDPresent, const nsACString& storeID,
    bool showSelectorPresent, const nsACString& showSelector,
    const nsACString& prefsAggregateLimit, nsIObserver* listener);
// Pre-XPCOM, synchronous, finite authentication only. No Profile use/admission.
nsresult AuthenticateStartupWorker(uint32_t parentPID, const nsACString& service);
// Refusal clears out; cancellation/abandonment is irreversible for this owner.
nsresult GetAuthenticatedStartupBinding(StartupExpectation& out);
nsresult AbandonStartupWorker();
nsresult PrepareWorker(mozIDOMWindowProxy* window, nsIFile* expected, nsIObserver* listener);
nsresult BindWorker(mozIDOMWindowProxy* window, uint32_t ownedPID, bool cleanupOnly);
nsresult CleanupWorker(mozIDOMWindowProxy* window);
nsresult ConnectSource(mozIDOMWindowProxy* window, uint32_t parentPID,
                       const nsACString& service, nsIObserver* listener);
nsresult RequestQuit(mozIDOMWindowProxy* window, const nsACString& request);
nsresult ReplyQuit(mozIDOMWindowProxy* window, const nsACString& request, uint32_t status);
nsresult RequestProducerAck(mozIDOMWindowProxy* window,
                            mozilla::dom::Element* browser,
                            const nsACString& sourceGeneration, JSContext* cx,
                            mozilla::dom::Promise** promise);
nsresult StartSource(mozIDOMWindowProxy* window, uint32_t parentPID,
                     const nsACString& service, const nsACString& token,
                     nsACString& descriptor);
nsresult StopSource(mozIDOMWindowProxy* window);
nsresult Attach(mozIDOMWindowProxy* window, nsACString& endpoint);
nsresult Detach(mozIDOMWindowProxy* window);
nsresult Admit(mozIDOMWindowProxy* window, uint32_t workerPID,
               const nsACString& widget, const nsACString& root,
               const nsACString& generation);
}
#endif
