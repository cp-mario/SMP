#!/bin/sh
# POSIX sh: safe to run as curl ... | sh
set -eu

REPO="cp-mario/SMP"
INSTALL_DIR="${SMP_INSTALL_DIR:-/opt/smp}"
TMP_DIR=""
STAGE_DIR=""
BACKUP_DIR=""
SUDO=""
BUN_BIN=""

echo "SMP Installer (Linux/macOS)"

# --- Cleanup ---

cleanup() {
    # If the script died after moving the previous installation aside but
    # before the new one was in place, put it back.
    if [ -n "$BACKUP_DIR" ] && [ -e "$BACKUP_DIR" ] && [ ! -e "$INSTALL_DIR" ]; then
        run_root mv "$BACKUP_DIR" "$INSTALL_DIR" 2>/dev/null || true
    fi

    if [ -n "$STAGE_DIR" ]; then
        if [ -n "$SUDO" ]; then
            sudo rm -rf "$STAGE_DIR"
        else
            rm -rf "$STAGE_DIR"
        fi
    fi

    if [ -n "$TMP_DIR" ]; then
        rm -rf "$TMP_DIR"
    fi
}

trap cleanup 0
trap 'exit 1' HUP INT TERM

# --- Requirements ---

for cmd in curl tar mktemp sed grep tr id awk; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Missing dependency: $cmd" >&2
        exit 1
    fi
done

INSTALL_DIR="${INSTALL_DIR%/}"

case "$INSTALL_DIR" in
    /*) ;;
    *)
        echo "SMP_INSTALL_DIR must be an absolute path (got: $INSTALL_DIR)." >&2
        exit 1
        ;;
esac

# --- Root command helper ---

if [ "$(id -u)" -ne 0 ]; then
    if ! command -v sudo >/dev/null 2>&1; then
        echo "sudo is required to install SMP into $INSTALL_DIR." >&2
        exit 1
    fi
    SUDO="sudo"
fi

run_root() {
    if [ -n "$SUDO" ]; then
        sudo "$@"
    else
        "$@"
    fi
}

# --- Temporary directory ---

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/smp-install.XXXXXX")"

# --- Bun (official installer, only when missing) ---

if ! command -v bun >/dev/null 2>&1; then
    echo "Installing Bun..."

    if ! command -v bash >/dev/null 2>&1; then
        echo "Bash is required by the official Bun installer." >&2
        exit 1
    fi

    curl -fsSL https://bun.sh/install -o "$TMP_DIR/bun-install.sh"
    bash "$TMP_DIR/bun-install.sh"

    export PATH="$HOME/.bun/bin:$PATH"

    if ! command -v bun >/dev/null 2>&1; then
        echo "Bun installation failed." >&2
        exit 1
    fi
fi

BUN_BIN="$(command -v bun)"
BUN_BIN="$(cd "$(dirname "$BUN_BIN")" && pwd)/$(basename "$BUN_BIN")"
echo "Bun: $("$BUN_BIN" --version)"

# --- Release channel (argument, SMP_CHANNEL, or interactive prompt) ---

CHANNEL_ANSWER="${1:-${SMP_CHANNEL:-}}"

if [ -z "$CHANNEL_ANSWER" ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then
    echo ""
    echo "Choose the release channel:"
    echo "  1) Stable (recommended)"
    echo "  2) Experimental (pre-releases included)"
    printf "Channel [1/stable, default 1]: " >/dev/tty
    IFS= read -r CHANNEL_ANSWER </dev/tty || CHANNEL_ANSWER=""
elif [ -z "$CHANNEL_ANSWER" ]; then
    echo "No interactive terminal. Using stable."
fi

CHANNEL_ANSWER="$(printf '%s' "$CHANNEL_ANSWER" | tr -d '[:space:]')"

case "$(printf '%s' "$CHANNEL_ANSWER" | tr '[:upper:]' '[:lower:]')" in
    2|experimental|exp|beta|pre)
        CHANNEL="experimental"
        ;;
    *)
        CHANNEL="stable"
        ;;
esac

echo "Channel: $CHANNEL"

# --- Refuse to overwrite a running installation ---

PORT="${SMP_PORT:-3001}"

if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"service"[[:space:]]*:[[:space:]]*"smp"'; then
    echo "An SMP panel is already running on port $PORT." >&2
    echo "Stop it before installing, or use Settings -> Updates to update in place." >&2
    exit 1
fi

# --- Resolve latest release (Atom feed / latest page, no API) ---

echo ""
echo "Resolving latest $CHANNEL release..."

if [ "$CHANNEL" = "experimental" ]; then
    curl -fsSL \
        "https://github.com/$REPO/releases.atom" \
        -o "$TMP_DIR/releases.atom"

    TAG="$(
        tr '\n' ' ' < "$TMP_DIR/releases.atom" |
        awk '
            {
                start = index($0, "<entry>")
                if (!start) exit 1

                entry = substr($0, start + 7)
                finish = index(entry, "</entry>")
                if (!finish) exit 1

                entry = substr(entry, 1, finish - 1)

                title_start = index(entry, "<title>")
                if (!title_start) exit 1

                title = substr(entry, title_start + 7)
                title_end = index(title, "</title>")
                if (!title_end) exit 1

                print substr(title, 1, title_end - 1)
                exit
            }
        '
    )"
else
    curl -fsSL \
        "https://github.com/$REPO/releases/latest" \
        -o "$TMP_DIR/release.html"

    TAG="$(
        grep -m1 -oE '<title>[^<]+</title>' "$TMP_DIR/release.html" |
        sed -E 's/<title>([^<]+)<\/title>/\1/' |
        grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?' ||
        true
    )"
fi

TAG="$(printf '%s' "$TAG" | tr -d '[:space:]')"

if [ -z "$TAG" ]; then
    echo "Could not resolve the latest $CHANNEL release from GitHub." >&2
    exit 1
fi

VERSION="${TAG#v}"

echo "Downloading SMP $TAG (source)..."

# --- Download source ---

ARCHIVE_URL="https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz"

if ! curl -fLsS --retry 3 --retry-delay 1 \
    "$ARCHIVE_URL" \
    -o "$TMP_DIR/smp.tar.gz"; then

    echo "Failed to download SMP source." >&2
    exit 1
fi

# --- Prepare installation directory ---

run_root mkdir -p "$(dirname "$INSTALL_DIR")"

STAGE_DIR="$(run_root mktemp -d "$(dirname "$INSTALL_DIR")/.smp-install.XXXXXX")"

# --- Extract source ---

echo "Extracting source..."

if ! run_root tar -xzf "$TMP_DIR/smp.tar.gz" \
    -C "$STAGE_DIR" --strip-components=1; then

    echo "Failed to extract SMP source." >&2
    exit 1
fi

# --- Validate source ---

if ! run_root test -f "$STAGE_DIR/start.js"; then
    echo "Unexpected archive layout: start.js not found." >&2
    exit 1
fi

# --- Set ownership (the panel runs as the invoking user, not root) ---

if [ -n "$SUDO" ]; then
    run_root chown -R "$(id -u):$(id -g)" "$STAGE_DIR"
fi

# --- Install dependencies, build the panel, drop development files ---

if [ -f "$STAGE_DIR/scripts/install-app.js" ]; then
    echo "Installing dependencies and building the web panel..."

    if ! ( cd "$STAGE_DIR" && "$BUN_BIN" run ./scripts/install-app.js ); then
        echo "Installation failed; the previous installation was left untouched." >&2
        exit 1
    fi
else
    # Releases older than scripts/install-app.js install on first launch.
    echo "This release predates the pre-install step; dependencies will be installed on first launch."
    rm -rf "$STAGE_DIR/web/tests" "$STAGE_DIR/web/README.md" "$STAGE_DIR/web/scripts" "$STAGE_DIR/.github" "$STAGE_DIR/.junie" "$STAGE_DIR/dev.js"
fi

# --- Replace previous installation ---

BACKUP_DIR="$(dirname "$INSTALL_DIR")/.smp-backup.$$"

if [ -e "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; then
    echo "Backing up previous installation..."
    run_root mv "$INSTALL_DIR" "$BACKUP_DIR"
fi

if ! run_root mv "$STAGE_DIR" "$INSTALL_DIR"; then
    echo "Installation failed. Restoring previous installation..." >&2

    if [ -e "$BACKUP_DIR" ] || [ -L "$BACKUP_DIR" ]; then
        run_root mv "$BACKUP_DIR" "$INSTALL_DIR"
    fi

    exit 1
fi

STAGE_DIR=""

# --- Remove backup ---

if [ -e "$BACKUP_DIR" ] || [ -L "$BACKUP_DIR" ]; then
    if ! run_root rm -rf "$BACKUP_DIR"; then
        echo "Warning: could not remove previous installation backup." >&2
    fi
fi

# --- Done ---

echo ""
echo "Installed SMP $VERSION to $INSTALL_DIR"
echo "Run the panel with:"
echo "  bun run \"$INSTALL_DIR/start.js\""
echo "(if it doesn't work, run it on a new terminal)"