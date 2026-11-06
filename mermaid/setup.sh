#!/bin/sh
# Local Mermaid renderer for the Telegram gateway.
# The install stays under $OMB_DATA_DIR/mermaid. Chromium is Puppeteer's own build.
set -eu
ROOT="${OMB_DATA_DIR:-$HOME/.openmausbot}/mermaid"
mkdir -p "$ROOT"
cd "$ROOT"
if [ ! -f package.json ]; then
  npm init -y >/dev/null
fi
npm install --save-exact @mermaid-js/mermaid-cli@12.2.0
# npm 11 may skip Puppeteer's postinstall. Download Chromium explicitly.
node node_modules/puppeteer/install.mjs
echo "Mermaid CLI: $ROOT/node_modules/.bin/mmdc"
