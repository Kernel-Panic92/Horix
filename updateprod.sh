#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  update.sh — Actualizador de Horix (auto canal por rama)
# ═══════════════════════════════════════════════════════════════
set -e
VERDE="\033[0;32m"; AMARILLO="\033[1;33m"; ROJO="\033[0;31m"; AZUL="\033[0;34m"; RESET="\033[0m"
ok()   { echo -e "${VERDE}  ✓ $1${RESET}"; }
info() { echo -e "${AZUL}  → $1${RESET}"; }
warn() { echo -e "${AMARILLO}  ⚠ $1${RESET}"; }
err()  { echo -e "${ROJO}  ✗ $1${RESET}"; exit 1; }

INSTALL_DIR="$(pwd)"

echo ""
echo -e "${AZUL}══════════════════════════════════════════════${RESET}"
echo -e "${AZUL}   Horix — Actualizador${RESET}"
echo -e "${AZUL}══════════════════════════════════════════════${RESET}"
echo ""

[[ "$OSTYPE" != "linux-gnu"* ]] && err "Este script es para Linux (Ubuntu/Debian)."
command -v pm2 &>/dev/null || err "PM2 no encontrado. ¿Está instalado Horix?"
[[ ! -f "src/server.js" ]] && err "No se encontró src/server.js. Ejecuta desde el directorio de Horix."

# ── Detectar rama ────────────
if [[ -d ".git" ]]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
else
  BRANCH="unknown"
fi

ok "Rama detectada: $BRANCH"

# ── Determinar canal ────────────
INPUT_CHANNEL=$1

if [[ -n "$INPUT_CHANNEL" ]]; then
  CHANNEL="$INPUT_CHANNEL"
  info "Canal forzado por parámetro: $CHANNEL"
else
  if [[ "$BRANCH" == "main" ]]; then
    CHANNEL="stable"
  elif [[ "$BRANCH" == "dev" ]]; then
    CHANNEL="beta"
  else
    CHANNEL="stable"
    warn "Rama desconocida, usando canal stable"
  fi

  info "Canal seleccionado automáticamente: $CHANNEL"

  echo ""
  read -p "¿Deseas continuar con este canal? [S/n]: " CONFIRM
  CONFIRM=${CONFIRM:-S}

  if [[ ! "$CONFIRM" =~ ^[Ss]$ ]]; then
    echo ""
    read -p "Selecciona canal manualmente (stable/beta): " CHANNEL

    if [[ "$CHANNEL" != "stable" && "$CHANNEL" != "beta" ]]; then
      err "Canal inválido"
    fi

    info "Canal seleccionado manualmente: $CHANNEL"
  fi
fi

# ── Backup ────────────
info "Haciendo backup preventivo..."
BACKUP_PREV="$HOME/backups/horix/pre_update_$(date +%Y%m%d_%H%M%S).db"
mkdir -p "$(dirname "$BACKUP_PREV")"

if [[ -f "horas_extra.db" ]]; then
  cp horas_extra.db "$BACKUP_PREV"
  ok "BD respaldada en $BACKUP_PREV"
else
  warn "No se encontró horas_extra.db"
fi

# ── Obtener release ────────────
GITHUB_TOKEN=$(cat ~/.horix_token 2>/dev/null || echo '')
REPO="Kernel-Panic92/Horix"

if [[ "$CHANNEL" == "stable" ]]; then
  RELEASE_INFO=$(curl -s \
    -H "Authorization: token $GITHUB_TOKEN" \
    "https://api.github.com/repos/$REPO/releases/latest")

  RELEASE_TAG=$(echo "$RELEASE_INFO" | jq -r '.tag_name')
  RELEASE_URL=$(echo "$RELEASE_INFO" | jq -r '.zipball_url')

elif [[ "$CHANNEL" == "beta" ]]; then
  ALL_RELEASES=$(curl -s \
    -H "Authorization: token $GITHUB_TOKEN" \
    "https://api.github.com/repos/$REPO/releases")

  RELEASE_TAG=$(echo "$ALL_RELEASES" | jq -r '[.[] | select(.prerelease==true)][0].tag_name')
  RELEASE_URL=$(echo "$ALL_RELEASES" | jq -r '[.[] | select(.prerelease==true)][0].zipball_url')

else
  err "Canal no soportado"
fi

# ── Validación ────────────
if [[ -z "$RELEASE_TAG" || "$RELEASE_TAG" == "null" ]]; then
  err "No se encontró release para canal $CHANNEL"
fi

ok "Release detectada: $RELEASE_TAG"

# ── Descargar ────────────
TMPDIR_UPDATE=$(mktemp -d)

info "Descargando..."
curl -sL \
  -H "Authorization: token $GITHUB_TOKEN" \
  "$RELEASE_URL" \
  -o "$TMPDIR_UPDATE/release.zip"

[[ ! -s "$TMPDIR_UPDATE/release.zip" ]] && err "Error descargando"

# ── Extraer ────────────
unzip -q "$TMPDIR_UPDATE/release.zip" -d "$TMPDIR_UPDATE/extracted"
EXTRACTED_DIR=$(ls "$TMPDIR_UPDATE/extracted")

# ── Copiar ────────────
rsync -av --delete --checksum \
  --exclude='horas_extra.db' \
  --exclude='.env' \
  --exclude='node_modules/' \
  "$TMPDIR_UPDATE/extracted/$EXTRACTED_DIR/" \
  "$INSTALL_DIR/"

rm -rf "$TMPDIR_UPDATE"

ok "Archivos actualizados"

# ── Dependencias ────────────
info "Actualizando dependencias..."
npm install --production

# ── Reiniciar ────────────
pm2 restart horix
ok "Horix reiniciado"

# ── Resumen ────────────
echo ""
echo -e "${VERDE}══════════════════════════════════════════════${RESET}"
echo -e "${VERDE}  ✅ Horix actualizado correctamente${RESET}"
echo -e "${VERDE}══════════════════════════════════════════════${RESET}"
echo ""
echo -e "  📦 Versión: $(node -e "console.log(require('./package.json').version)" 2>/dev/null)"
echo -e "  🗄  Backup: $BACKUP_PREV"
echo ""