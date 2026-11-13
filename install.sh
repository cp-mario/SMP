
#!/bin/sh
# POSIX sh: safe to run as curl ... | sh
set -eu

REPO="cp-mario/SMP"
INSTALL_DIR="/opt/smp"
TMP_DIR=""
STAGE_DIR=""
BACKUP_DIR=""
SUDO=""

echo "SMP Installer (Linux)"

# --- Cleanup ---

cleanup() {
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

for cmd in curl tar mktemp sed grep tr id head; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Missing dependency: $cmd" >&2
        exit 1
    fi
done

if [ "$(id -u)" -ne 0 ]; then
    if ! command -v sudo >/dev/null 2>&1; then
        echo "sudo is required to install SMP into /opt." >&2
        exit 1
    fi
    SUDO="sudo"
fi

# --- Bun (official installer, only when missing) ---

if ! command -v bun >/dev/null 2>&1; then
    echo "Installing Bun..."

    if ! command -v bash >/dev/null 2>&1; then
        echo "Bash is required by the official Bun installer." >&2
        exit 1
    fi

    curl -fsSL https://bun.sh/install | bash

    export PATH="$HOME/.bun/bin:$PATH"

    if ! command -v bun >/dev/null 2>&1; then
        echo "Bun installation failed." >&2
        exit 1
    fi
fi

echo "Bun: $(bun --version)"

# --- Release channel ---

echo ""
echo "Choose the release channel:"
echo "  1) Stable (recommended)"
echo "  2) Experimental (pre-releases included)"

CHANNEL_ANSWER=""

if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf "Channel [1/stable, default 1]: " >/dev/tty
    IFS= read -r CHANNEL_ANSWER </dev/tty || CHANNEL_ANSWER=""
else
    echo "No interactive terminal. Using stable."
fi

case "$(printf '%s' "$CHANNEL_ANSWER" | tr '[:upper:]' '[:lower:]')" in
    2|experimental|exp|beta|pre)
        CHANNEL="experimental"
        ;;
    *)
        CHANNEL="stable"
        ;;
esac

echo "Channel: $CHANNEL"

# --- Temporary directory ---

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/smp-install.XXXXXX")"

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

# --- Root command helper ---

run_root() {
    if [ -n "$SUDO" ]; then
        sudo "$@"
    else
        "$@"
    fi
}

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

# --- Set ownership ---

if [ -n "$SUDO" ]; then
    run_root chown -R "$(id -u):$(id -g)" "$STAGE_DIR"
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
echo "  bun run $INSTALL_DIR/start.js"
