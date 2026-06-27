#!/usr/bin/env bash
#
# Portir Site Agent installer — distro- and architecture-agnostic.
#
#   curl -fsSL https://raw.githubusercontent.com/JetLaggedJackal/portir-agent/main/install.sh | bash
#
# Unattended (skip prompts):
#   ... | GATEWAY_URL=wss://portir.io/agent bash
#
# Overridable env: GATEWAY_URL, INSTALL_DIR, BRANCH, NODE_VERSION, NO_SERVICE=1
#
set -euo pipefail

REPO_SLUG="JetLaggedJackal/portir-agent"
REPO_URL="https://github.com/${REPO_SLUG}.git"
BRANCH="${BRANCH:-main}"
NODE_VERSION="${NODE_VERSION:-22.12.0}"
DEFAULT_GW="wss://portir.io/agent"

esc(){ printf '\033[%sm' "$1"; }
BOLD=$(esc 1); GRN=$(esc '0;32'); YEL=$(esc '1;33'); RED=$(esc '0;31'); RST=$(esc 0)
say(){  printf '%s %s\n' "${GRN}▶${RST}" "$*"; }
warn(){ printf '%s %s\n' "${YEL}!${RST}" "$*" >&2; }
die(){  printf '%s %s\n' "${RED}✗${RST}" "$*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = "Linux" ] || die "This installer targets Linux."

# ---- privilege + target user/home (works whether run plain, as root, or via sudo) ----
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if need sudo; then SUDO="sudo"; else warn "no root / sudo — systemd service will be skipped"; fi
fi
RUN_USER="${SUDO_USER:-$(id -un)}"
HOME_DIR="$(getent passwd "$RUN_USER" 2>/dev/null | cut -d: -f6 || true)"
[ -n "$HOME_DIR" ] || HOME_DIR="$HOME"
INSTALL_DIR="${INSTALL_DIR:-$HOME_DIR/portir-agent}"

# ---- CPU architecture → official Node arch ----
case "$(uname -m)" in
  x86_64|amd64)   NARCH=x64;;
  aarch64|arm64)  NARCH=arm64;;
  armv7l)         NARCH=armv7l;;
  armv6l)         NARCH=armv7l; warn "armv6 is unsupported by modern Node — trying armv7l, may fail";;
  *) die "Unsupported CPU architecture: $(uname -m)";;
esac

# ---- downloader ----
if need curl; then DL(){ curl -fsSL "$1"; }; elif need wget; then DL(){ wget -qO- "$1"; }; else die "need curl or wget"; fi

say "Installing the Portir agent for ${BOLD}$RUN_USER${RST} into ${BOLD}$INSTALL_DIR${RST} ($(uname -m))"

# ---- Node: reuse system Node ≥18, else fetch official build (or apk on Alpine) ----
node_major(){ "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
NODE_BIN=""; NPM_BIN=""
if need node && [ "$(node_major node)" -ge 18 ]; then
  NODE_BIN="$(command -v node)"; NPM_BIN="$(command -v npm || true)"
  say "Using system Node $("$NODE_BIN" -v)"
elif [ -f /etc/alpine-release ]; then
  say "Alpine detected — installing Node via apk"
  $SUDO apk add --no-cache nodejs npm git curl >/dev/null
  NODE_BIN="$(command -v node)"; NPM_BIN="$(command -v npm)"
else
  RT="$INSTALL_DIR/.runtime"; ND="$RT/node-v$NODE_VERSION-linux-$NARCH"
  if [ ! -x "$ND/bin/node" ]; then
    say "Fetching Node v$NODE_VERSION ($NARCH)…"
    mkdir -p "$RT"
    DL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NARCH.tar.gz" | tar -xz -C "$RT" \
      || die "Node download/extract failed (arch $NARCH)"
  fi
  NODE_BIN="$ND/bin/node"; NPM_BIN="$ND/bin/npm"
fi
[ -x "$NODE_BIN" ] || die "Node not available"

# ---- fetch / update the agent source ----
if [ -d "$INSTALL_DIR/.git" ] && need git; then
  say "Updating existing checkout…"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
elif need git; then
  say "Cloning agent…"
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
else
  say "Downloading agent snapshot…"
  mkdir -p "$INSTALL_DIR"
  DL "https://codeload.github.com/$REPO_SLUG/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$INSTALL_DIR" --strip-components=1
fi

# ---- dependencies ----
say "Installing dependencies…"
( cd "$INSTALL_DIR" && "$NPM_BIN" install --omit=dev --no-audit --no-fund --loglevel=error )

# ---- gateway URL (prompt via the terminal even under curl|bash) ----
CFG="$INSTALL_DIR/agent/config.json"
GW="${GATEWAY_URL:-}"
if [ -z "$GW" ]; then
  DEF="$DEFAULT_GW"
  if [ -f "$CFG" ]; then
    EXIST="$(grep -oE 'wss?://[^"]+' "$CFG" 2>/dev/null | head -1 || true)"
    [ -n "${EXIST:-}" ] && DEF="$EXIST"
  fi
  if [ -r /dev/tty ]; then
    printf '%s' "Gateway WebSocket URL [$DEF]: " > /dev/tty
    read -r GW < /dev/tty || true
  fi
  [ -n "$GW" ] || GW="$DEF"
fi
case "$GW" in ws://*|wss://*) ;; *) warn "URL doesn't start with ws:// or wss:// — using as-is: $GW";; esac
printf '{ "gatewayUrl": "%s" }\n' "$GW" > "$CFG"
say "Wrote $CFG  →  gateway: ${BOLD}$GW${RST}"

# ---- make the install owned by the service user (in case we ran via sudo) ----
[ "$(id -u)" -eq 0 ] && chown -R "$RUN_USER" "$INSTALL_DIR" 2>/dev/null || true

# ---- systemd service (run on boot, auto-restart) ----
if [ "${NO_SERVICE:-0}" = 1 ]; then
  warn "NO_SERVICE=1 — skipping service. Run manually:  $NODE_BIN $INSTALL_DIR/agent/agent.js"
elif need systemctl && { [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ]; }; then
  say "Installing systemd service…"
  $SUDO tee /etc/systemd/system/portir-agent.service >/dev/null <<EOF
[Unit]
Description=Portir Site Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN agent/agent.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now portir-agent
  sleep 2
  $SUDO systemctl --no-pager --full status portir-agent | head -n 10 || true
else
  warn "systemd not available — run the agent yourself:"
  echo "    cd $INSTALL_DIR && $NODE_BIN agent/agent.js"
fi

FP="$($SUDO journalctl -u portir-agent -n 60 --no-pager 2>/dev/null | grep -iE 'fingerprint' | tail -1 || true)"
cat <<EOF

${GRN}✓ Installed.${RST}
${BOLD}Next:${RST} approve this agent in the app  →  Admin → Site Agents → "Waiting for approval"
${FP:+      ${BOLD}$FP${RST}}
Logs:  ${BOLD}journalctl -u portir-agent -f${RST}
EOF
