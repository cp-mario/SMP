#!/bin/sh
# POSIX sh: safe to run as `curl ... | sh` (dash does not support pipefail).
set -eu

echo "SMP Installer (Linux)"

# --- Bun (official installer, only when missing) ---
if ! command -v bun >/dev/null 2>&1; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    echo "Bun installation failed." >&2
    exit 1
  fi
fi

# --- Release channel ---
echo "Choose the release channel:"
echo "  1) Stable (recommended)"
echo "  2) Experimental (pre-releases included)"
read -rp "Channel [1/stable, default 1]: " CHANNEL_ANSWER
case "$(printf '%s' "$CHANNEL_ANSWER" | tr '[:upper:]' '[:lower:]')" in
  2|experimental|exp|beta|pre) CHANNEL="experimental" ;;
  *) CHANNEL="stable" ;;
esac
echo "Channel: $CHANNEL"

# --- Resolve the latest release of the channel (Atom feed / latest page, no API) ---
if [ "$CHANNEL" = "experimental" ]; then
  TAG="$(curl -fsSL "https://github.com/cp-mario/SMP/releases.atom" | sed -n '/<entry>/,/<\/entry>/p' | grep -m1 -oE '<title>[^<]+</title>' | sed -E 's/.*<title>([^<]+)<\/title>.*/\1/' || true)"
else
  TAG="$(curl -fsSL "https://github.com/cp-mario/SMP/releases/latest" | grep -m1 -oE '<title>[^<]+</title>' | sed -E 's/.*<title>([^<]+)<\/title>.*/\1/' | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?' || true)"
fi
if [ -z "${TAG:-}" ]; then
  echo "Could not resolve the latest $CHANNEL release from GitHub." >&2
  exit 1
fi
VERSION="${TAG#v}"
echo "Downloading SMP $TAG (source)..."

# --- Download and unpack the source ---
INSTALL_DIR="/opt/smp"
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
TMP_DIR="$(mktemp -d)"
curl -fsSL "https://github.com/cp-mario/SMP/archive/refs/tags/$TAG.tar.gz" -o "$TMP_DIR/smp.tar.gz"
$SUDO mkdir -p "$INSTALL_DIR"
tar -xzf "$TMP_DIR/smp.tar.gz" -C "$INSTALL_DIR" --strip-components=1
rm -rf "$TMP_DIR"
# Hand the tree to the invoking user so deps, builds and runtime work without root.
if [ -n "$SUDO" ]; then $SUDO chown -R "$(id -u):$(id -g)" "$INSTALL_DIR"; fi



echo ""
echo "Installed SMP $VERSION to $INSTALL_DIR"
echo "Run the panel in another terminal with: bun run $INSTALL_DIR/start.js"