#!/bin/sh
# Turn a packaged Zen .app into Ka.app: single window, Spaces bound to Profiles.
# Ka keeps its own profiles (~/Library/Application Support/Ka) and remoting
# name, so it never touches or hands off to an installed Zen.
# Usage: scripts/make_ka_app.sh <packaged Zen .app> [dest dir, default ~/Applications]
set -eu
src=$1
dest=${2:-$HOME/Applications}/Ka.app
rm -rf "$dest"
mkdir -p "$(dirname "$dest")"
cp -R "$src" "$dest"

plist="$dest/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Ka" \
  -c "Set :CFBundleIdentifier com.kenkuang.ka" "$plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Ka" "$plist" 2>/dev/null ||
  /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Ka" "$plist"

ini="$dest/Contents/Resources/application.ini"
# The profile root is compiled in (configs/common/mozconfig); refuse a build
# that would share profiles with an installed Zen.
grep -q '^Profile=Ka$' "$ini" || { echo "build is not MOZ_APP_PROFILE=Ka" >&2; exit 1; }

codesign --force --deep --sign - "$dest" 2>/dev/null
echo "$dest"
