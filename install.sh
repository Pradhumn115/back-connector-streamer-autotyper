#!/usr/bin/env bash
# Beamdesk one-click installer — macOS and Linux.
#
#   ./install.sh            (or double-click install.command on macOS)
#
# Installs Node.js if it's missing or too old, then does the whole setup:
# workspace deps -> OS prerequisites (ffmpeg, cloudflared, audio loopback) ->
# build -> the launcher menu. Safe to re-run: every step is a no-op when the
# thing it installs is already there.
#
# Flags:
#   --yes           answer every consent prompt with "yes" (unattended runs)
#   --no-launch     stop after building instead of opening the launcher menu
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR" || exit 1

# Node 20 is the floor the agent's dependencies need; 22 is what we install
# when we have to install one ourselves (the active LTS line).
NODE_MIN_MAJOR=20
NODE_LTS_MAJOR=22

ASSUME_YES=0
LAUNCH=1
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --no-launch) LAUNCH=0 ;;
    -h|--help)
      sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
AMBER=$'\033[38;5;214m'; GREEN=$'\033[38;5;42m'; RED=$'\033[38;5;203m'

step() { printf '\n%s\n' "${AMBER}${BOLD}▸ $*${RESET}"; }
ok()   { printf '%s\n' "${GREEN}✓ $*${RESET}"; }
warn() { printf '%s\n' "${AMBER}⚠ $*${RESET}"; }
die()  { printf '%s\n' "${RED}✗ $*${RESET}" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Ask before anything the user might not want done unattended. Not a TTY
# (piped/CI) means "no", so the script never hangs waiting on a prompt nobody
# can answer; --yes opts in there.
confirm() {
  local q="$1"
  if [ "$ASSUME_YES" = 1 ]; then echo "$q → yes (--yes)"; return 0; fi
  if [ ! -t 0 ]; then echo "$q → skipped (not an interactive terminal; re-run with --yes)"; return 1; fi
  local answer
  read -r -p "$q [Y/n] " answer
  case "${answer:-y}" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
node_ok() { have node && [ "$(node_major)" -ge "$NODE_MIN_MAJOR" ]; }

# Node's official prebuilt tarballs are laid out as bin/ lib/ include/ share/,
# so extracting one into /usr/local with --strip-components=1 lands `node` and
# `npm` on the default PATH of both macOS and every mainstream Linux distro.
# We use these rather than the distro package because apt/dnf/pacman routinely
# ship a Node older than 20, which is the thing we're trying to fix.
install_node_tarball() {
  local os arch listing file url tmp
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux)  os=linux ;;
    *) die "Unsupported OS: $(uname -s). Install Node ${NODE_MIN_MAJOR}+ from https://nodejs.org and re-run." ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64)  arch=x64 ;;
    armv7l)        arch=armv7l ;;
    *) die "Unsupported CPU: $(uname -m). Install Node ${NODE_MIN_MAJOR}+ from https://nodejs.org and re-run." ;;
  esac

  have curl || die "curl is required to download Node.js. Install curl, or get Node from https://nodejs.org"

  local base="https://nodejs.org/dist/latest-v${NODE_LTS_MAJOR}.x"
  listing="$(curl -fsSL "$base/")" || die "Couldn't reach nodejs.org. Check your connection, or install Node manually from https://nodejs.org"
  file="$(printf '%s' "$listing" | grep -o "node-v[0-9][0-9.]*-${os}-${arch}\.tar\.gz" | head -1)"
  [ -n "$file" ] || die "No Node ${NODE_LTS_MAJOR}.x build for ${os}-${arch}. Install manually from https://nodejs.org"
  url="$base/$file"

  echo "  Downloading ${file}"
  echo "  from ${url}"
  echo "  and installing it into /usr/local (needs your password for sudo)."
  confirm "  Install Node.js now?" || die "Node.js ${NODE_MIN_MAJOR}+ is required. Install it from https://nodejs.org and re-run."

  tmp="$(mktemp -d)"
  curl -fL --progress-bar -o "$tmp/node.tar.gz" "$url" || die "Download failed: $url"
  sudo mkdir -p /usr/local || die "Couldn't create /usr/local"
  sudo tar -xzf "$tmp/node.tar.gz" -C /usr/local --strip-components=1 \
    --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md \
    || die "Couldn't extract Node into /usr/local"
  rm -rf "$tmp"
  # This shell inherited its PATH before the install, and hash may cache a
  # stale (or absent) `node`, so make the new one visible to the rest of the run.
  export PATH="/usr/local/bin:$PATH"
  hash -r 2>/dev/null || true
}

ensure_node() {
  step "Checking Node.js"
  if node_ok; then
    ok "Node $(node -v) already installed"
    return
  fi
  if have node; then
    warn "Node $(node -v) is older than the required v${NODE_MIN_MAJOR}"
  else
    echo "  Node.js isn't installed."
  fi

  # Homebrew is already the package manager beamdesk's own setup uses on macOS,
  # so when it's there we let it own Node too — that keeps upgrades in one place.
  if [ "$(uname -s)" = Darwin ] && have brew; then
    if confirm "  Install Node.js with Homebrew?"; then
      brew install node
      hash -r 2>/dev/null || true
    fi
  fi
  node_ok || install_node_tarball
  node_ok || die "Node.js still isn't on PATH. Install it from https://nodejs.org and re-run."
  ok "Node $(node -v) ready"
}

ensure_node
have npm || die "npm is missing even though node is installed — reinstall Node from https://nodejs.org"

step "Installing workspace dependencies (npm install)"
npm install || die "npm install failed"
ok "dependencies installed"

step "Installing prerequisites (ffmpeg, cloudflared, audio loopback)"
# setup.mjs asks its own consent questions and skips anything already present.
if [ "$ASSUME_YES" = 1 ]; then
  npm run setup -- --yes || warn "some prerequisites didn't install — beamdesk still runs, see the notes above"
else
  npm run setup || warn "some prerequisites didn't install — beamdesk still runs, see the notes above"
fi

step "Building (shared, agent, client)"
npm run build || die "build failed"
ok "build complete"

printf '\n%s\n' "${GREEN}${BOLD}Beamdesk is installed.${RESET}"
printf '%s\n' "${DIM}Run it any time with:  npm start${RESET}"

if [ "$LAUNCH" = 1 ] && [ -t 0 ]; then
  if confirm $'\nOpen the beamdesk launcher now?'; then
    exec npm start
  fi
fi
