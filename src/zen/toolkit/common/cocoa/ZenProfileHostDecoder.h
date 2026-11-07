/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef ZenProfileHostDecoder_h
#define ZenProfileHostDecoder_h
#include "../ZenProfileHostProtocol.h"
#import <QuartzCore/QuartzCore.h>
namespace zen::profilehost {
// Takes ownership of successful-receive rights, even on rejection. On success
// replaces an owned, detached staging root; never attaches it to a display tree.
bool Consume(mach_msg_header_t* header, size_t capacity, const Gate& owner,
             double expectedScale, CALayer** staged);
}
#endif
