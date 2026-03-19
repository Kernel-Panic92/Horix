#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  update.sh — Actualizador de Horix (no reinstala, no borra datos)
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
[[ ! -f "server.js" ]] && err "No se encontró server.js. Ejecuta desde el directorio de Horix."
# ── 1. Verificar repo git
if [[ ! -d ".git" ]]; then
  warn "No es un repositorio git. Solo se actualizarán dependencias y configuraciones opcionales."
  TIENE_GIT=false
else
  TIENE_GIT=true
fi
# ── 2. Backup preventivo
info "Haciendo backup preventivo..."
BACKUP_PREV="$HOME/backups/horix/pre_update_$(date +%Y%m%d_%H%M%S).db"
mkdir -p "$(dirname "$BACKUP_PREV")"
if [[ -f "horas_extra.db" ]]; then
  cp horas_extra.db "$BACKUP_PREV"
  ok "BD respaldada en $BACKUP_PREV"
else
  warn "No se encontró horas_extra.db — omitiendo backup preventivo"
fi
# ── Canal de actualización ────────────
CHANNEL=${1:-beta}
info "Canal seleccionado: $CHANNEL"

GITHUB_TOKEN=$(cat ~/horix/.horix_token 2>/dev/null || echo '')
REPO="Kernel-Panic92/Horix"

if [[ "$CHANNEL" == "stable" ]]; then
  RELEASE_INFO=$(curl -s \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/$REPO/releases/latest")

elif [[ "$CHANNEL" == "beta" ]]; then
  ALL_RELEASES=$(curl -s \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/$REPO/releases")

  RELEASE_TAG=$(echo "$ALL_RELEASES" | jq -r '[.[] | select(.prerelease==true)][0].tag_name')
  RELEASE_URL=$(echo "$ALL_RELEASES" | jq -r '[.[] | select(.prerelease==true)][0].zipball_url')

else
  # fallback: usar tag directo (ej: canary)
  RELEASE_INFO=$(curl -s \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/$REPO/releases/tags/$CHANNEL")
fi

# Si no es beta, parse normal
if [[ "$CHANNEL" != "beta" ]]; then
  RELEASE_TAG=$(echo "$RELEASE_INFO" | jq -r '.tag_name')
  RELEASE_URL=$(echo "$RELEASE_INFO" | jq -r '.zipball_url')
fi

# Validación
if [ -z "$RELEASE_TAG" ] || [ "$RELEASE_TAG" == "null" ] || \
   [ -z "$RELEASE_URL" ] || [ "$RELEASE_URL" == "null" ]; then
  err "No se pudo obtener la release para el canal '$CHANNEL'"
fi

ok "Release detectada: $RELEASE_TAG"

# Descargar ZIP de la release
TMPDIR_UPDATE=$(mktemp -d)
info "Descargando $RELEASE_TAG..."
curl -sL \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "$RELEASE_URL" \
  -o "$TMPDIR_UPDATE/release.zip"

if [ ! -s "$TMPDIR_UPDATE/release.zip" ]; then
  err "Error descargando la release."
fi

# Extraer y copiar archivos
unzip -q "$TMPDIR_UPDATE/release.zip" -d "$TMPDIR_UPDATE/extracted"
EXTRACTED_DIR=$(ls "$TMPDIR_UPDATE/extracted")

# Copiar solo los archivos del proyecto (no sobreescribir BD ni .env)
rsync -av \
  --exclude='horas_extra.db' \
  --exclude='.env' \
  --exclude='.backup_pass' \
  --exclude='last_backup.json' \
  --exclude='node_modules/' \
  --exclude='public/logo_empresa.*' \
  "$TMPDIR_UPDATE/extracted/$EXTRACTED_DIR/" \
  "$INSTALL_DIR/"

rm -rf "$TMPDIR_UPDATE"
ok "Archivos actualizados desde release $RELEASE_TAG"
# ── 4. Dependencias npm
info "Actualizando dependencias npm..."
npm install --production
ok "Dependencias actualizadas"
# ── 5. Reiniciar
info "Reiniciando Horix..."
pm2 restart horix
ok "Horix reiniciado"
# ── 6. Opcionales
echo ""
echo -e "${AZUL}── Configuraciones opcionales ───────────────${RESET}"
# Fail2ban
if command -v fail2ban-client &>/dev/null; then
  ok "Fail2ban ya instalado ($(fail2ban-client --version 2>&1 | head -1))"
  if [[ ! -f "/etc/fail2ban/jail.d/horix.conf" ]]; then
    warn "Jail de Horix no configurado."
    read -p "  ¿Configurar Fail2ban para Horix ahora? [s/N]: " CONF_F2B
    CONF_F2B=${CONF_F2B:-N}
  else
    ok "Jail Horix en Fail2ban ya configurado"
    CONF_F2B="N"
  fi
else
  read -p "  ¿Instalar y configurar Fail2ban? [s/N]: " CONF_F2B
  CONF_F2B=${CONF_F2B:-N}
fi
if [[ "$CONF_F2B" =~ ^[Ss]$ ]]; then
  if ! command -v fail2ban-client &>/dev/null; then
    info "Instalando Fail2ban..."; sudo apt-get install -y fail2ban
  fi
  read -p "  Puerto HTTPS de Horix [8443]: " F2B_PORT
  F2B_PORT=${F2B_PORT:-8443}
  sudo tee /etc/fail2ban/filter.d/horix-login.conf > /dev/null << 'F2BFILTER'
[Definition]
failregex = ^<HOST> .* "POST /api/auth/login HTTP.*" 401
ignoreregex =
F2BFILTER
  sudo tee /etc/fail2ban/jail.d/horix.conf > /dev/null << F2BJAIL
[horix-login]
enabled   = true
port      = $F2B_PORT,80,443
filter    = horix-login
logpath   = /var/log/nginx/access.log
backend   = polling
maxretry  = 5
findtime  = 300
bantime   = 600
ignoreip  = 127.0.0.1/8
F2BJAIL
  sudo systemctl enable fail2ban
  sudo systemctl restart fail2ban
  ok "Fail2ban configurado"
fi
# Sudoers NAS
if [[ -f "backup_horasextra.sh" ]]; then
  if grep -q 'USAR_NAS="true"' backup_horasextra.sh 2>/dev/null; then
    if [[ ! -f "/etc/sudoers.d/horix-mount" ]]; then
      warn "NAS configurado pero sin permisos sudo para mount."
      read -p "  ¿Configurar sudo para mount sin contraseña? [s/N]: " CONF_MOUNT
      if [[ "$CONF_MOUNT" =~ ^[Ss]$ ]]; then
        echo "$USER ALL=(ALL) NOPASSWD: /bin/mount, /bin/umount, /usr/bin/mkdir, /bin/mkdir" | \
          sudo tee /etc/sudoers.d/horix-mount > /dev/null
        sudo chmod 440 /etc/sudoers.d/horix-mount
        ok "Permisos sudo para mount configurados"
      fi
    else
      ok "Permisos sudo para mount ya configurados"
    fi
  fi
fi
# Certbot
if command -v certbot &>/dev/null; then
  ok "Certbot disponible — renovación automática activa"
  CERT_STATUS=$(sudo certbot certificates 2>/dev/null | grep -E "VALID|EXPIRED|Expiry" | head -3)
  [[ -n "$CERT_STATUS" ]] && echo -e "    $CERT_STATUS"
fi
# ── 7. Resumen
echo ""
echo -e "${VERDE}══════════════════════════════════════════════${RESET}"
echo -e "${VERDE}  ✅ Horix actualizado correctamente${RESET}"
echo -e "${VERDE}══════════════════════════════════════════════${RESET}"
echo ""
echo -e "  📦 Versión: $(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo 'desconocida')"
echo -e "  🗄  BD respaldada: $BACKUP_PREV"
echo ""
echo -e "  pm2 logs horix      # Ver logs"
echo -e "  pm2 status          # Estado del proceso"
echo ""
