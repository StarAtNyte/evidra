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
# Install an archive, not a link into the temporary checkout. Dependency
# install scripts must run so native modules such as better-sqlite3 work.
npm pack --ignore-scripts --quiet >/dev/null
PACKAGE_VERSION=$(node -p "require('./package.json').version")
npm install --global "$INSTALL_DIR/evidra/evidra-$PACKAGE_VERSION.tgz"
GLOBAL_PREFIX=$(npm prefix --global)
"$GLOBAL_PREFIX/bin/evidra" --version >/dev/null
echo "Evidra installed globally. Run: evidra"
case ":$PATH:" in
  *":$GLOBAL_PREFIX/bin:"*) ;;
  *) echo "Add $GLOBAL_PREFIX/bin to your PATH to run evidra." ;;
esac
