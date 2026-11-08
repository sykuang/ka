/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifdef XP_MACOSX
#  include "ZenProfileOverlay.h"
#endif
#include "ZenCommonUtils.h"
#include "ZenShareInternal.h"
#ifdef XP_MACOSX
#  include "ZenProfileHostNative.h"
#endif

#include "nsGlobalWindowOuter.h"
#include "nsQueryObject.h"
#include "nsIWindowMediator.h"
#include "nsServiceManagerUtils.h"
#include "nsISharePicker.h"

#include "mozilla/StaticPrefs_zen.h"

#if defined(XP_WIN)
#  include "mozilla/WindowsVersion.h"
#endif

namespace zen {

NS_IMETHODIMP
ZenCommonUtils::StartProfileOverlay(mozIDOMWindowProxy* aWindow, nsACString& aResult) {
#ifdef XP_MACOSX
  return zen::profileoverlay::Start(aWindow, aResult);
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}
NS_IMETHODIMP
ZenCommonUtils::AdmitProfileOverlayWorker(uint32_t aWorkerPID) {
#ifdef XP_MACOSX
  return zen::profileoverlay::Admit(aWorkerPID);
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}
NS_IMETHODIMP
ZenCommonUtils::ShowProfileOverlay(mozIDOMWindowProxy* aWindow, double aX, double aY,
                                   double aWidth, double aHeight) {
#ifdef XP_MACOSX
  return zen::profileoverlay::Show(aWindow, aX, aY, aWidth, aHeight);
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}
NS_IMETHODIMP
ZenCommonUtils::HideProfileOverlay() {
#ifdef XP_MACOSX
  return zen::profileoverlay::Hide();
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}
NS_IMETHODIMP
ZenCommonUtils::FocusProfileOverlay() {
#ifdef XP_MACOSX
  return zen::profileoverlay::FocusView();
#else
  return NS_ERROR_NOT_IMPLEMENTED;
#endif
}

NS_IMETHODIMP
ZenCommonUtils::GetProfileOverlayFrames(uint64_t* aResult) {
#ifdef XP_MACOSX
  *aResult = zen::profileoverlay::FrameCount();
  return NS_OK;
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}
NS_IMETHODIMP
ZenCommonUtils::PrepareProfileHostStartupWorker(mozIDOMWindowProxy* aWindow,
    nsIFile* aAuthority, nsIFile* aRoot, nsIFile* aLocal, const nsACString& aName,
    const nsACString& aPath, const nsACString& aIsRelative, bool aStoreIDPresent,
    const nsACString& aStoreID, bool aShowSelectorPresent, const nsACString& aShowSelector,
    const nsACString& aPrefsAggregateLimit, nsIObserver* aListener) {
#ifdef XP_MACOSX
  return profilehost::PrepareStartupWorker(aWindow, aAuthority, aRoot, aLocal,
      aName, aPath, aIsRelative, aStoreIDPresent, aStoreID,
      aShowSelectorPresent, aShowSelector, aPrefsAggregateLimit, aListener);
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}

NS_IMETHODIMP
ZenCommonUtils::PrepareProfileHostWorker(mozIDOMWindowProxy* aWindow, nsIFile* aExpected,
                                         nsIObserver* aListener) {
#ifdef XP_MACOSX
  return profilehost::PrepareWorker(aWindow, aExpected, aListener);
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}
NS_IMETHODIMP
ZenCommonUtils::BindProfileHostWorker(mozIDOMWindowProxy* aWindow, uint32_t aOwnedPID,
                                      bool aCleanupOnly) {
#ifdef XP_MACOSX
  return profilehost::BindWorker(aWindow, aOwnedPID, aCleanupOnly);
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}
NS_IMETHODIMP
ZenCommonUtils::CleanupProfileHostWorker(mozIDOMWindowProxy* aWindow) {
#ifdef XP_MACOSX
  return profilehost::CleanupWorker(aWindow);
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}
NS_IMETHODIMP
ZenCommonUtils::ConnectProfileHostSource(mozIDOMWindowProxy* aWindow, uint32_t aParentPID,
                                         const nsACString& aService, nsIObserver* aListener) {
#ifdef XP_MACOSX
  return profilehost::ConnectSource(aWindow, aParentPID, aService, aListener);
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}
NS_IMETHODIMP
ZenCommonUtils::RequestProfileHostQuit(mozIDOMWindowProxy* aWindow, const nsACString& aRequest) {
#ifdef XP_MACOSX
  return profilehost::RequestQuit(aWindow, aRequest);
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}
NS_IMETHODIMP
ZenCommonUtils::ReplyProfileHostQuit(mozIDOMWindowProxy* aWindow, const nsACString& aRequest,
                                     uint32_t aStatus) {
#ifdef XP_MACOSX
  return profilehost::ReplyQuit(aWindow, aRequest, aStatus);
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}

NS_IMETHODIMP
ZenCommonUtils::AttachProfileHost(mozIDOMWindowProxy* aWindow,
                                 nsACString& aEndpoint) {
  aEndpoint.Truncate();
#ifdef XP_MACOSX
  return profilehost::Attach(aWindow, aEndpoint);
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}

NS_IMETHODIMP
ZenCommonUtils::DetachProfileHost(mozIDOMWindowProxy* aWindow) {
#ifdef XP_MACOSX
  return profilehost::Detach(aWindow);
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}

NS_IMETHODIMP
ZenCommonUtils::AdmitProfileHost(mozIDOMWindowProxy* aWindow, uint32_t aWorkerPID,
                                const nsACString& aWidget,
                                const nsACString& aRoot,
                                const nsACString& aGeneration) {
#ifdef XP_MACOSX
  return profilehost::Admit(aWindow, aWorkerPID, aWidget, aRoot, aGeneration);
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}

NS_IMETHODIMP
ZenCommonUtils::StartProfileHostSource(mozIDOMWindowProxy* aWindow,
                                      uint32_t aParentPID,
                                      const nsACString& aService,
                                      const nsACString& aToken,
                                      nsACString& aDescriptor) {
  aDescriptor.Truncate();
#ifdef XP_MACOSX
  return profilehost::StartSource(aWindow, aParentPID, aService, aToken, aDescriptor);
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}

NS_IMETHODIMP
ZenCommonUtils::StopProfileHostSource(mozIDOMWindowProxy* aWindow) {
#ifdef XP_MACOSX
  return profilehost::StopSource(aWindow);
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}

NS_IMETHODIMP
ZenCommonUtils::RequestProfileHostProducerAck(
    mozIDOMWindowProxy* aWindow, mozilla::dom::Element* aBrowser,
    const nsACString& aSourceGeneration, JSContext* aCx,
    mozilla::dom::Promise** aPromise) {
  *aPromise = nullptr;
#ifdef XP_MACOSX
  return profilehost::RequestProducerAck(aWindow, aBrowser, aSourceGeneration,
                                         aCx, aPromise);
#else
  return NS_ERROR_NOT_AVAILABLE;
#endif
}

// Use the macro to inject all of the definitions for nsISupports.
NS_IMPL_ISUPPORTS(ZenCommonUtils, nsIZenCommonUtils)
using WindowGlobalChild = mozilla::dom::WindowGlobalChild;

namespace {
/**
 * @brief Helper function to fetch the most recent window proxy.
 * @param aWindow The window to query.
 * @returns The most recent window.
 */
static nsresult GetMostRecentWindowProxy(mozIDOMWindowProxy** aWindow) {
  nsresult rv;
  nsCOMPtr<nsIWindowMediator> med(
      do_GetService(NS_WINDOWMEDIATOR_CONTRACTID, &rv));
  if (NS_FAILED(rv)) return rv;

  if (med) return med->GetMostRecentBrowserWindow(aWindow);

  return NS_ERROR_FAILURE;
}
/**
 * @brief Helper function to query and get a reference to the window.
 * @param aWindow The window to query.
 */
static nsCOMPtr<mozIDOMWindowProxy> GetMostRecentWindow() {
  nsCOMPtr<mozIDOMWindowProxy> aWindow;
  nsresult rv = GetMostRecentWindowProxy(getter_AddRefs(aWindow));
  if (NS_FAILED(rv) || !aWindow) {
    return nullptr;
  }
  return aWindow;
}
}  // namespace

using mozilla::dom::WindowGlobalChild;

#define NS_ZEN_CAN_SHARE_FAILURE() \
  *canShare = false;               \
  return NS_OK;

NS_IMETHODIMP
ZenCommonUtils::PlayHapticFeedback() {
  // We don't have any haptic feedback on non-macOS platforms
  // so we can just return.
  if (!mozilla::StaticPrefs::zen_haptic_feedback_enabled()) {
    return NS_OK;
  }
  return PlayHapticFeedbackInternal();
}

NS_IMETHODIMP
ZenCommonUtils::CanShare(bool* canShare) {
  auto aWindow = GetMostRecentWindow();
  if (!aWindow) {
    NS_ZEN_CAN_SHARE_FAILURE();
  }
  *canShare = IsSharingSupported();
  return NS_OK;
}

NS_IMETHODIMP
ZenCommonUtils::Share(nsIURI* url, const nsACString& title,
                      const nsACString& text, uint32_t aX, uint32_t aY,
                      uint32_t aWidth, uint32_t aHeight) {
  auto aWindow = GetMostRecentWindow();
  if (!aWindow) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  if (!IsSharingSupported()) {
    return NS_OK;  // We don't want to throw an error here
  }
  return ShareInternal(aWindow, url, title, text, aX, aY, aWidth, aHeight);
}

nsresult ZenCommonUtils::ShareInternal(nsCOMPtr<mozIDOMWindowProxy>& aWindow,
                                       nsIURI* url, const nsACString& title,
                                       const nsACString& text, uint32_t aX,
                                       uint32_t aY, uint32_t aWidth,
                                       uint32_t aHeight) {
  // We shoud've had done pointer checks before, so we can assume
  // aWindow is valid.
#ifdef NS_ZEN_CAN_SHARE_NATIVE
  return ::nsZenNativeShareInternal::ShowNativeDialog(aWindow, url, title, text,
                                                      aX, aY, aWidth, aHeight);
#else
  return NS_ERROR_NOT_IMPLEMENTED;
#endif
}

auto ZenCommonUtils::IsSharingSupported() -> bool {
#if defined(XP_WIN) && !defined(__MINGW32__)
  // The first public build that supports ShareCanceled API
  return mozilla::IsWindows10BuildOrLater(18956);
#elif defined(NS_ZEN_CAN_SHARE_NATIVE)
  return NS_ZEN_CAN_SHARE_NATIVE;
#else
  return false;
#endif
}

}  // namespace zen
