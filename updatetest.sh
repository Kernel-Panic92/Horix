#!/bin/bash
set -e

# ── Colores ─────────────────────────────────────────────
VERDE="\033[0;32m"; AMARILLO="\033[1;33m"; ROJO="\033[0;31m"; AZUL="\033[0;34m"; RESET="\033[0m"
ok()   { echo -e "${VERDE}  ✓ $1${RESET}"; }
info() { echo -e "${AZUL}  → $1${RESET}"; }
warn() { echo -e "${AMARILLO}  ⚠ $1${RESET}"; }
err()  { echo -e "${ROJO}  ✗ $1${RESET}"; exit 1; }

INSTALL_DIR="$(pwd)"
REPO="Kernel-Panic92/Horix"

echo ""
echo -e "${AZUL}══════════════════════════════════════════════${RESET}"
echo -e "${AZUL}   Horix — Actualizador${RESET}"
echo -e "${AZUL}══════════════════════════════════════════════${RESET}"
echo ""

# ── Validaciones ────────────────────────────────────────
[[ "$OSTYPE" != "linux-gnu"* ]] && err "Solo Linux"
command -v jq &>/dev/null || err "jq no instalado"
command -v pm2 &>/dev/null || err "PM2 no encontrado"
[[ ! -f "src/server.js" ]] && err "Ejecuta desde Horix"

# ── Token ───────────────────────────────────────────────
USER_HOME=$(eval echo ~${SUDO_USER:-$USER})
GITHUB_TOKEN=$(xargs < "$USER_HOME/.horix_token" 2>/dev/null || echo '')

if [[ -n "$GITHUB_TOKEN" ]]; then
  AUTH_HEADER="Authorization: Bearer $GITHUB_TOKEN"
  ok "Token cargado"
else
  AUTH_HEADER=""
  warn "Sin token (fallará si el repo es privado)"
fi

# ── Detectar rama local ─────────────────────────────────
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
ok "Rama local: $BRANCH"

# ── Canal ───────────────────────────────────────────────
CHANNEL=${1:-}

if [[ -z "$CHANNEL" ]]; then
  if [[ "$BRANCH" == "main" ]]; then
    CHANNEL="stable"
  else
    CHANNEL="beta"
  fi
fi

info "Canal: $CHANNEL"

# ── Definir origen ──────────────────────────────────────
if [[ "$CHANNEL" == "stable" ]]; then
  info "Usando releases (stable)"
  API_URL="https://api.github.com/repos/$REPO/releases/latest"

  RESPONSE=$(curl -sL -H "$AUTH_HEADER" "$API_URL")

  if echo "$RESPONSE" | jq -e '.message' >/dev/null 2>&1; then
    err "GitHub API: $(echo "$RESPONSE" | jq -r '.message')"
  fi

  RELEASE_TAG=$(echo "$RESPONSE" | jq -r '.tag_name')
  RELEASE_URL=$(echo "$RESPONSE" | jq -r '.zipball_url')

else
  info "Usando rama dev (beta 🔥)"
  RELEASE_TAG="dev-latest"
  RELEASE_URL="https://api.github.com/repos/$REPO/zipball/dev"
fi

ok "Origen: $RELEASE_TAG"
info "URL: $RELEASE_URL"

# ── Versión actual ──────────────────────────────────────
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
info "Versión actual: $CURRENT_VERSION"

# ── Backup ──────────────────────────────────────────────
BACKUP_DIR="$HOME/backups/horix"
mkdir -p "$BACKUP_DIR"

BACKUP_FILE="$BACKUP_DIR/backup_$(date +%Y%m%d_%H%M%S).tar.gz"

info "Creando backup..."
tar -czf "$BACKUP_FILE" .

ok "Backup creado"

# ── Descargar ───────────────────────────────────────────
TMPDIR=$(mktemp -d)

info "Descargando..."

curl -sL -H "$AUTH_HEADER" "$RELEASE_URL" -o "$TMPDIR/release.zip"

[[ ! -s "$TMPDIR/release.zip" ]] && err "Error descargando"

# ── Extraer ─────────────────────────────────────────────
unzip -q "$TMPDIR/release.zip" -d "$TMPDIR/extracted"
DIR=$(ls "$TMPDIR/extracted")

# ── Verificación rápida (debug útil)
info "Contenido descargado:"
ls "$TMPDIR/extracted/$DIR" | head

# ── Actualizar ──────────────────────────────────────────
info "Actualizando archivos..."

rsync -av \
  --delete \
  --exclude='horas_extra.db' \
  --exclude='.env' \
  --exclude='node_modules/' \
  "$TMPDIR/extracted/$DIR/" \
  "$INSTALL_DIR/" || {
    err "Fallo actualización → restaurando backup"
    tar -xzf "$BACKUP_FILE" -C "$INSTALL_DIR"
  }

rm -rf "$TMPDIR"

ok "Archivos actualizados"

# ── Dependencias ────────────────────────────────────────
info "Instalando dependencias..."
npm install --omit=dev

# ── Reiniciar ───────────────────────────────────────────
pm2 restart horix
ok "Servicio reiniciado"

# ── Final ───────────────────────────────────────────────
echo ""
echo -e "${VERDE}══════════════════════════════════════════════${RESET}"
echo -e "${VERDE}  ✅ Horix actualizado correctamente${RESET}"
echo -e "${VERDE}══════════════════════════════════════════════${RESET}"
echo ""

echo -e "  📦 Origen: $RELEASE_TAG"
echo -e "  🗄 Backup: $BACKUP_FILE"
echo ""