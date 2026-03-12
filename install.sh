#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  install.sh — Instalador automático de HorasExtra
#  Vitamar S.A.
#
#  Uso:
#    chmod +x install.sh
#    ./install.sh
# ═══════════════════════════════════════════════════════════════

set -e

VERDE="\033[0;32m"
AMARILLO="\033[1;33m"
ROJO="\033[0;31m"
AZUL="\033[0;34m"
RESET="\033[0m"

ok()   { echo -e "${VERDE}  ✓ $1${RESET}"; }
info() { echo -e "${AZUL}  → $1${RESET}"; }
warn() { echo -e "${AMARILLO}  ⚠ $1${RESET}"; }
err()  { echo -e "${ROJO}  ✗ $1${RESET}"; exit 1; }

echo ""
echo -e "${AZUL}══════════════════════════════════════════════${RESET}"
echo -e "${AZUL}   Horix — Instalador v2.1.0${RESET}"
echo -e "${AZUL}   Vitamar S.A.${RESET}"
echo -e "${AZUL}══════════════════════════════════════════════${RESET}"
echo ""

# ── 1. Verificar que se ejecuta en Linux
if [[ "$OSTYPE" != "linux-gnu"* ]]; then
  err "Este instalador es para Linux (Ubuntu/Debian)."
fi

# ── 2. Verificar Node.js
info "Verificando Node.js..."
if ! command -v node &>/dev/null; then
  warn "Node.js no encontrado. Instalando via NodeSource (v20 LTS)..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
NODE_VER=$(node -e "console.log(process.version)")
ok "Node.js $NODE_VER"

# ── 3. Verificar PM2
info "Verificando PM2..."
if ! command -v pm2 &>/dev/null; then
  warn "PM2 no encontrado. Instalando..."
  sudo npm install -g pm2
fi
ok "PM2 $(pm2 -v)"

# ── 4. Instalar dependencias npm
info "Instalando dependencias..."
npm install --production
ok "Dependencias instaladas"

# ── 5. Configuración interactiva
echo ""
echo -e "${AZUL}── Configuración ────────────────────────────${RESET}"

# Puerto
read -p "  Puerto del servidor [3000]: " PUERTO
PUERTO=${PUERTO:-3000}

# Usuario administrador
read -p "  Email del administrador [admin@empresa.com]: " ADMIN_EMAIL
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@empresa.com}

read -s -p "  Contraseña del administrador [Admin2025!]: " ADMIN_PASS
echo ""
ADMIN_PASS=${ADMIN_PASS:-Admin2025!}

# Contraseña para el script de backup
read -s -p "  Contraseña para el script de backup (misma del admin): " BACKUP_PASS
echo ""
BACKUP_PASS=${BACKUP_PASS:-$ADMIN_PASS}

echo ""

# ── 6. Crear .backup_pass
info "Guardando configuración de backup..."
echo "$BACKUP_PASS" > .backup_pass
chmod 600 .backup_pass
ok ".backup_pass creado"

# ── 7. Patch: actualizar email y contraseña del admin en server.js
# Solo si el usuario puso algo diferente al default
if [[ "$ADMIN_EMAIL" != "admin@empresa.com" ]] || [[ "$ADMIN_PASS" != "Admin2025!" ]]; then
  info "Actualizando credenciales del admin en server.js..."
  sed -i "s|'admin@empresa.com'|'$ADMIN_EMAIL'|g" server.js
  sed -i "s|await hashPassword('Admin2025!')|await hashPassword('$ADMIN_PASS')|g" server.js
  ok "Credenciales actualizadas"
fi

# ── 8. Crear carpeta de backups locales
mkdir -p ../backups/horasextra
ok "Carpeta de backups creada"

# ── 9. Iniciar con PM2
info "Iniciando aplicación con PM2..."
APP_NAME="horix"

# Si ya existe, reiniciar
if pm2 list | grep -q "$APP_NAME"; then
  pm2 restart "$APP_NAME"
  ok "Aplicación reiniciada en PM2"
else
  pm2 start server.js --name "$APP_NAME"
  ok "Aplicación iniciada en PM2"
fi

# Guardar configuración PM2 para que arranque al reiniciar el servidor
pm2 save
info "Configurando PM2 para arranque automático..."
pm2 startup | tail -1 | bash 2>/dev/null || warn "Ejecuta manualmente: pm2 startup"

# ── 10. Configurar cron de backup
echo ""
echo -e "${AZUL}── Cron de Backup ───────────────────────────${RESET}"
read -p "  ¿Configurar backup automático diario a las 2 AM? [s/N]: " CONF_CRON
if [[ "$CONF_CRON" =~ ^[Ss]$ ]]; then
  SCRIPT_PATH="$(pwd)/backup_horasextra.sh"
  chmod +x "$SCRIPT_PATH"
  CRON_LINE="0 2 * * * $SCRIPT_PATH >> /var/log/backup_horasextra.log 2>&1"
  # Agregar solo si no existe ya
  (sudo crontab -l 2>/dev/null | grep -v "backup_horasextra"; echo "$CRON_LINE") | sudo crontab -
  ok "Cron configurado: $CRON_LINE"
fi

# ── 11. Resumen final
echo ""
echo -e "${VERDE}══════════════════════════════════════════════${RESET}"
echo -e "${VERDE}  ✅ Horix instalado correctamente${RESET}"
echo -e "${VERDE}══════════════════════════════════════════════${RESET}"
echo ""
echo -e "  🌐 URL:      http://$(hostname -I | awk '{print $1}'):${PUERTO}"
echo -e "  👤 Admin:    ${ADMIN_EMAIL}"
echo -e "  🔑 Password: ${ADMIN_PASS}"
echo ""
echo -e "${AMARILLO}  ⚠ Cambia la contraseña del admin tras el primer login.${RESET}"
echo -e "${AMARILLO}  ⚠ Configura el SMTP desde Configuración → Config. Correo.${RESET}"
if [[ -f "backup_horasextra.sh" ]]; then
  echo -e "${AMARILLO}  ⚠ Edita backup_horasextra.sh con la IP y credenciales de tu NAS.${RESET}"
fi
echo ""
echo -e "  📋 Ver logs:    pm2 logs horix"
echo -e "  🔄 Reiniciar:   pm2 restart horix"
echo -e "  ⏹  Detener:     pm2 stop horix"
echo ""
