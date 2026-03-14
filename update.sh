#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  update.sh — Actualizador de Horix (no reinstala, no borra datos)
#
#  Uso:
#    chmod +x update.sh
#    ./update.sh
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

# ── 2. Backup preventivo antes de actualizar
info "Haciendo backup preventivo..."
BACKUP_PREV="$HOME/backups/horix/pre_update_$(date +%Y%m%d_%H%M%S).db"
mkdir -p "$(dirname "$BACKUP_PREV")"
if [[ -f "horas_extra.db" ]]; then
  cp horas_extra.db "$BACKUP_PREV"
  ok "BD respaldada en $BACKUP_PREV"
else
  warn "No se encontró horas_extra.db — omitiendo backup preventivo"
fi

# ── 3. Git pull
if [[ "$TIENE_GIT" == "true" ]]; then
  info "Obteniendo últimos cambios del repositorio..."
  git fetch origin
  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse origin/main 2>/dev/null || git rev-parse origin/master 2>/dev/null)
  if [[ "$LOCAL" == "$REMOTE" ]]; then
    ok "Ya estás en la versión más reciente"
    SIN_CAMBIOS=true
  else
    git pull origin main 2>/dev/null || git pull origin master 2>/dev/null
    ok "Código actualizado"
    SIN_CAMBIOS=false
  fi
fi

# ── 4. Actualizar dependencias npm
info "Actualizando dependencias npm..."
npm install --production
ok "Dependencias actualizadas"

# ── 5. Reiniciar aplicación
info "Reiniciando Horix..."
pm2 restart horix
ok "Horix reiniciado"

# ── 6. Opcionales — configuraciones nuevas
echo ""
echo -e "${AZUL}── Configuraciones opcionales ───────────────${RESET}"

# ── 6a. Fail2ban
if command -v fail2ban-client &>/dev/null; then
  ok "Fail2ban ya instalado ($(fail2ban-client --version 2>&1 | head -1))"
  # Verificar si el jail de Horix existe
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
    info "Instalando Fail2ban..."
    sudo apt-get install -y fail2ban
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
maxretry  = 10
findtime  = 300
bantime   = 1800
F2BJAIL

  sudo systemctl enable fail2ban
  sudo systemctl restart fail2ban
  ok "Fail2ban configurado"
  echo -e "    sudo fail2ban-client status horix-login   # Ver IPs bloqueadas"
  echo -e "    sudo fail2ban-client set horix-login unbanip <IP>  # Desbloquear"
fi

# ── 6b. Sudoers para mount NAS (si no está)
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

# ── 6c. Let's Encrypt — renovación manual si está configurado
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
