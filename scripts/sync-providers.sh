#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
cp runway/shared/providers.js runway/mods/runway/providers.js
cp runway/shared/providers.js runway/mods/runway-detail/providers.js
