#!/usr/bin/env sh
# Deploy: push main and mirror it to gh-pages, which GitHub Pages serves.
set -eu
cd "$(dirname "$0")/.."
git push origin main
git push origin main:gh-pages
echo "Deployed. Live in a minute or two at https://ralfhodgson.github.io/party-door/"
