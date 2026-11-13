#!/usr/bin/env bash
set -euo pipefail

echo "SMP Installer (Linux)"

# Ensure bun
if ! command -v bun >/dev/null 2>&1; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing dependencies (server)..."
cd "$ROOT/server"
bun install

echo "Installing dependencies (web)..."
cd "$ROOT/web"
bun install

echo "Building web panel..."
cd "$ROOT/web"
bun run build
cd "$ROOT"

echo "Building smp binary..."
cd "$ROOT/server"
bun run build
cd "$ROOT"

BIN="$ROOT/server/dist/smp"
INSTALL_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"

if [ -f "$BIN" ]; then
  cp "$BIN" "$INSTALL_DIR/smp"
  chmod +x "$INSTALL_DIR/smp"
  PUBLIC_SRC="$ROOT/server/src/public"
  PUBLIC_DST="$INSTALL_DIR/public"
  if [ -d "$PUBLIC_SRC" ]; then
    rm -rf "$PUBLIC_DST"
    cp -r "$PUBLIC_SRC" "$PUBLIC_DST"
  fi
  echo "Installed smp to $INSTALL_DIR/smp"
else
  cat > "$INSTALL_DIR/smp" <<EOF
#!/usr/bin/env bash
exec bun run "$ROOT/server/src/index.js" "\$@"
EOF
  chmod +x "$INSTALL_DIR/smp"
  echo "Installed smp wrapper to $INSTALL_DIR/smp"
fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Add $INSTALL_DIR to your PATH (e.g. export PATH=\"\$PATH:$INSTALL_DIR")" ;;
esac

echo "Done. Run: smp start  (open http://localhost:3001)"