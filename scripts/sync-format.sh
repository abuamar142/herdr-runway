#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
cp runway/shared/format.js runway/mods/runway/format.js
cp runway/shared/format.js runway/mods/runway-detail/format.js
