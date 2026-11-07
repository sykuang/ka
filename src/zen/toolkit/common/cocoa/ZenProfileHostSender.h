/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef ZenProfileHostSender_h
#define ZenProfileHostSender_h
#include "../ZenProfileHostProtocol.h"
#import <QuartzCore/QuartzCore.h>
namespace zen::profilehost {
// Caller owns a stable model-tree observation lock. Never mutates/reparents the
// source, flushes rendering, waits for delivery, or certifies render freshness.
mach_msg_return_t SendStaging(mach_port_t endpoint, const Identity& identity,
                              CALayer* modelRoot, float backingScale);
}
#endif
