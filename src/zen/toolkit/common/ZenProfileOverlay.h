/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef ZenProfileOverlay_h
#define ZenProfileOverlay_h
#include "nsError.h"
#include "nsStringFwd.h"
#include <cstdint>
class mozIDOMWindowProxy;
namespace zen::profileoverlay {
nsresult Start(mozIDOMWindowProxy* aWindow, nsACString& aDescriptor);
nsresult Admit(uint32_t aWorkerPID);
nsresult Show(mozIDOMWindowProxy* aWindow, double aX, double aY, double aW, double aH);
nsresult Hide();
uint64_t FrameCount();
}  // namespace zen::profileoverlay
#endif
