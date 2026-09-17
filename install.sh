#!/usr/bin/env sh
set -eu

REPO_URL="https://github.com/StarAtNyte/evidra.git"
MIN_NODE_MAJOR=22
MIN_NODE_VERSION=22.19.0

if ! command -v node >/dev/null 2>&1; then
  echo "Evidra requires Node.js ${MIN_NODE_VERSION}+. Install it with nvm first:"
  echo "  nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}"
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'; then
  echo "Evidra requires Node.js ${MIN_NODE_VERSION}+ (found $(node --version))."
  echo "  nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}"
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Evidra requires git to install from source."
  exit 1
fi

INSTALL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/evidra-install.XXXXXX")
PROGRESS_PID=""
cleanup() {
  if [ -n "$PROGRESS_PID" ]; then kill "$PROGRESS_PID" 2>/dev/null || :; fi
  rm -rf "$INSTALL_DIR"
}
trap cleanup EXIT INT TERM

run_stage() {
  STAGE_LABEL=$1
  shift
  printf '\n→ %s\n' "$STAGE_LABEL"
  (
    ELAPSED=0
    while sleep 5; do
      ELAPSED=$((ELAPSED + 5))
      printf '  %s… %ss elapsed\n' "$STAGE_LABEL" "$ELAPSED"
    done
  ) &
  PROGRESS_PID=$!
  STAGE_STATUS=0
  "$@" >"$INSTALL_DIR/stage.log" 2>&1 || STAGE_STATUS=$?
  kill "$PROGRESS_PID" 2>/dev/null || :
  wait "$PROGRESS_PID" 2>/dev/null || :
  PROGRESS_PID=""
  if [ "$STAGE_STATUS" -ne 0 ]; then
    printf '✗ %s failed (exit %s)\n' "$STAGE_LABEL" "$STAGE_STATUS" >&2
    cat "$INSTALL_DIR/stage.log" >&2
    exit "$STAGE_STATUS"
  fi
  printf '✓ %s complete\n' "$STAGE_LABEL"
}

run_stage "1/4 Downloading Evidra" git clone --quiet --depth 1 "$REPO_URL" "$INSTALL_DIR/evidra"
cd "$INSTALL_DIR/evidra"
run_stage "2/4 Installing dependencies and building" npm install
# Install an archive, not a link into the temporary checkout. Dependency
# install scripts must run so native modules such as better-sqlite3 work.
run_stage "3/4 Packaging CLI" npm pack --ignore-scripts --quiet
PACKAGE_VERSION=$(node -p "require('./package.json').version")
run_stage "4/4 Installing global command" npm install --global "$INSTALL_DIR/evidra/evidra-$PACKAGE_VERSION.tgz"
GLOBAL_PREFIX=$(npm prefix --global)
run_stage "Verifying installation" "$GLOBAL_PREFIX/bin/evidra" --version
echo "Evidra installed globally. Run: evidra"
case ":$PATH:" in
  *":$GLOBAL_PREFIX/bin:"*) ;;
  *) echo "Add $GLOBAL_PREFIX/bin to your PATH to run evidra." ;;
esac
