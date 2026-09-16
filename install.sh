#!/usr/bin/env sh
set -eu

REPO_URL="https://github.com/StarAtNyte/evidra.git"
MIN_NODE_MAJOR=22

if ! command -v node >/dev/null 2>&1; then
  echo "Evidra requires Node.js ${MIN_NODE_MAJOR}+. Install it with nvm first:"
  echo "  nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  echo "Evidra requires Node.js ${MIN_NODE_MAJOR}+ (found $(node --version))."
  echo "  nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}"
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Evidra requires git to install from source."
  exit 1
fi

INSTALL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/evidra-install.XXXXXX")
cleanup() { rm -rf "$INSTALL_DIR"; }
trap cleanup EXIT INT TERM

echo "Downloading Evidra..."
git clone --quiet --depth 1 "$REPO_URL" "$INSTALL_DIR/evidra"
cd "$INSTALL_DIR/evidra"
echo "Installing dependencies and building..."
npm install
npm install --global . --ignore-scripts
echo "Evidra installed globally. Run: evidra"
