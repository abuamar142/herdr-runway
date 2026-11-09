#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

cmp runway/shared/format.js runway/mods/runway/format.js
cmp runway/shared/format.js runway/mods/runway-detail/format.js
cmp runway/shared/providers.js runway/mods/runway/providers.js
cmp runway/shared/providers.js runway/mods/runway-detail/providers.js

python3 -m py_compile runway/mods/runway/*.py
python3 -m unittest discover -s tests -v
node --check runway/mods/runway/main.js
node --check runway/mods/runway/merge.js
node --check runway/mods/runway/providers.js
node --check runway/mods/runway-detail/providers.js
node --check runway/mods/runway-detail/main.js
node --check runway/mods/runway-detail/cards.js
node --check runway/mods/runway-detail/settings.js
node --check runway/mods/runway-detail/metadata.js
node --check runway/mods/runway-detail/history.js
node --test tests/*.test.mjs
