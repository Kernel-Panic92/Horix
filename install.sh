#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  install.sh — Instalador automático de Horix v2.3.0
#
#  Uso:
#    chmod +x install.sh
#    ./install.sh
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
echo -e "${AZUL}   Horix — Instalador v2.3.0${RESET}"
echo -e "${AZUL}   Sistema de Control de Horas Extra${RESET}"
echo -e "${AZUL}══════════════════════════════════════════════${RESET}"
echo ""

[[ "$OSTYPE" != "linux-gnu"* ]] && err "Este instalador es para Linux (Ubuntu/Debian)."

# ── 1. Node.js
info "Verificando Node.js..."
if ! command -v node &>/dev/null; then
  warn "Node.js no encontrado. Instalando v20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
ok "Node.js $(node -e 'console.log(process.version)')"

# ── 2. PM2
info "Verificando PM2..."
if ! command -v pm2 &>/dev/null; then
  warn "PM2 no encontrado. Instalando..."; sudo npm install -g pm2
fi
ok "PM2 $(pm2 -v)"

# ── 3. Dependencias npm
info "Instalando dependencias..."
npm install --production
ok "Dependencias instaladas"

# ── 4. Configuración
echo ""
echo -e "${AZUL}── Configuración del sistema ────────────────${RESET}"

read -p "  Puerto del servidor [3000]: " PUERTO
PUERTO=${PUERTO:-3000}

read -p "  Nombre de la empresa: " EMPRESA
EMPRESA=${EMPRESA:-"Mi Empresa"}

read -p "  Centro de operación inicial [Principal]: " SEDE_PRINCIPAL
SEDE_PRINCIPAL=${SEDE_PRINCIPAL:-"Principal"}

echo ""

# ── 5. Actualizar server.js con credenciales
info "Configurando server.js..."
cat > .env << ENVEOF
HE_SECRET=$(openssl rand -hex 32)
ENVEOF
echo "  ✓ Archivo .env generado"
echo "  ✓ Credenciales guardadas en .env"
sed -i "s|const SEDES = \['Principal'\];|const SEDES = ['$SEDE_PRINCIPAL'];|g" server.js
ok "server.js configurado"

# ── 6. .backup_pass
echo "configurar_pass_nas" > .backup_pass
chmod 600 .backup_pass
ok ".backup_pass creado"

# ── 7. Carpeta de backups
BACKUP_LOCAL="$HOME/backups/horix"
mkdir -p "$BACKUP_LOCAL"
ok "Carpeta de backups: $BACKUP_LOCAL"

# ── 8. Backup en NAS
echo ""
echo -e "${AZUL}── Configuración de Backup ──────────────────${RESET}"
read -p "  ¿Configurar backup en servidor NAS/red? [s/N]: " CONF_NAS
USAR_NAS="false"
SMB_SERVER="" SMB_MOUNT="/mnt/nas_backup" SMB_USER="" SMB_PASS="" BACKUP_RED=""

if [[ "$CONF_NAS" =~ ^[Ss]$ ]]; then
  USAR_NAS="true"
  read -p "  IP/ruta del share (ej: //192.168.1.10/Backups): " SMB_SERVER
  read -p "  Usuario del NAS: " SMB_USER
  read -s -p "  Contraseña del NAS: " SMB_PASS; echo ""
  read -p "  Subcarpeta en el NAS [Horix_Backups]: " NAS_SUB
  NAS_SUB=${NAS_SUB:-"Horix_Backups"}
  BACKUP_RED="$SMB_MOUNT/$NAS_SUB"
  ok "NAS configurado: $SMB_SERVER"
fi

if [[ -f "backup_horasextra_template.sh" ]]; then
  info "Generando script de backup..."
  cp backup_horasextra_template.sh backup_horasextra.sh
  sed -i "s|__PORT__|$PUERTO|g"               backup_horasextra.sh
  sed -i "s|__ADMIN_EMAIL__|admin@tuempresa.com|g"   backup_horasextra.sh
  sed -i "s|__INSTALL_DIR__|$INSTALL_DIR|g"   backup_horasextra.sh
  sed -i "s|__BACKUP_LOCAL__|$BACKUP_LOCAL|g" backup_horasextra.sh
  sed -i "s|__USAR_NAS__|$USAR_NAS|g"         backup_horasextra.sh
  sed -i "s|__BACKUP_RED__|$BACKUP_RED|g"     backup_horasextra.sh
  sed -i "s|__SMB_SERVER__|$SMB_SERVER|g"     backup_horasextra.sh
  sed -i "s|__SMB_MOUNT__|$SMB_MOUNT|g"       backup_horasextra.sh
  sed -i "s|__SMB_USER__|$SMB_USER|g"         backup_horasextra.sh
  sed -i "s|__SMB_PASS__|$SMB_PASS|g"         backup_horasextra.sh
  chmod +x backup_horasextra.sh
  ok "backup_horasextra.sh generado"
fi

# ── 9. PM2
info "Iniciando con PM2..."
if pm2 list | grep -q "horix"; then pm2 restart horix; else pm2 start server.js --name "horix"; fi
pm2 save
pm2 startup | tail -1 | bash 2>/dev/null || warn "Ejecuta manualmente: pm2 startup"
ok "Aplicación en PM2"

# ── 10. Cron de backup
echo ""
read -p "  ¿Configurar backup automático diario a las 2 AM? [s/N]: " CONF_CRON
if [[ "$CONF_CRON" =~ ^[Ss]$ ]]; then
  chmod +x "$INSTALL_DIR/backup_horasextra.sh"
  CRON_LINE="0 2 * * * $INSTALL_DIR/backup_horasextra.sh >> /var/log/backup_horix.log 2>&1"
  (sudo crontab -l 2>/dev/null | grep -v "backup_horasextra"; echo "$CRON_LINE") | sudo crontab -
  ok "Cron configurado"
fi

# ── 11. HTTPS con Nginx
echo ""
echo -e "${AZUL}── Configuración HTTPS (opcional) ───────────${RESET}"
read -p "  ¿Configurar HTTPS con Nginx? [s/N]: " CONF_HTTPS
HTTPS_URL=""
CERT_TIPO=""

if [[ "$CONF_HTTPS" =~ ^[Ss]$ ]]; then

  if ! command -v nginx &>/dev/null; then
    info "Instalando Nginx..."
    sudo apt-get install -y nginx
  fi
  ok "Nginx: $(nginx -v 2>&1)"

  read -p "  Dominio del servidor (ej: horix.empresa.local): " HTTPS_DOMAIN
  while [[ -z "$HTTPS_DOMAIN" ]]; do
    warn "El dominio es requerido."
    read -p "  Dominio: " HTTPS_DOMAIN
  done

  read -p "  Puerto HTTPS [8443]: " HTTPS_PORT
  HTTPS_PORT=${HTTPS_PORT:-8443}

  echo ""
  echo -e "${AZUL}  Tipo de certificado SSL:${RESET}"
  echo -e "  1) Autofirmado       — red interna, sin dominio público"
  echo -e "  2) Let's Encrypt     — dominio público, puertos 80/443 expuestos"
  read -p "  Selecciona [1/2]: " CERT_TIPO
  CERT_TIPO=${CERT_TIPO:-1}

  NGINX_CONF="/etc/nginx/sites-available/horix"

  if [[ "$CERT_TIPO" == "2" ]]; then
    # ── Let's Encrypt
    if ! command -v certbot &>/dev/null; then
      info "Instalando Certbot..."
      sudo apt-get install -y certbot python3-certbot-nginx
    fi
    ok "Certbot: $(certbot --version 2>&1)"

    # Detener apache si está en el puerto 80
    if sudo ss -tlnp | grep -q ':80.*apache'; then
      warn "Apache2 detectado en el puerto 80. Deteniéndolo temporalmente..."
      sudo systemctl stop apache2
      APACHE_DETENIDO=true
    fi

    # Nginx debe escuchar en 80 para la validación
    sudo tee /etc/nginx/sites-available/horix-certbot > /dev/null << CERTEOF
server {
    listen 80;
    server_name $HTTPS_DOMAIN;
    location / { return 200 'ok'; }
}
CERTEOF
    sudo ln -sf /etc/nginx/sites-available/horix-certbot /etc/nginx/sites-enabled/horix-certbot
    sudo rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
    sudo systemctl restart nginx

    info "Obteniendo certificado Let's Encrypt para $HTTPS_DOMAIN..."
    read -p "  Email para notificaciones de Let's Encrypt: " CERTBOT_EMAIL
    sudo certbot certonly --nginx -d "$HTTPS_DOMAIN" --non-interactive --agree-tos -m "$CERTBOT_EMAIL" || \
      err "Certbot falló. Verifica que el dominio resuelva a esta IP y los puertos 80/443 estén abiertos."

    sudo rm -f /etc/nginx/sites-enabled/horix-certbot
    SSL_CERT="/etc/letsencrypt/live/$HTTPS_DOMAIN/fullchain.pem"
    SSL_KEY="/etc/letsencrypt/live/$HTTPS_DOMAIN/privkey.pem"
    ok "Certificado Let's Encrypt obtenido"

    [[ "$APACHE_DETENIDO" == "true" ]] && sudo systemctl start apache2

  else
    # ── Autofirmado
    CERT_DIR="/etc/ssl/horix"
    info "Generando certificado SSL autofirmado (válido 10 años)..."
    sudo mkdir -p "$CERT_DIR"
    sudo openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
      -keyout "$CERT_DIR/key.pem" \
      -out    "$CERT_DIR/cert.pem" \
      -subj "/C=CO/ST=Antioquia/L=Medellin/O=Horix/CN=$HTTPS_DOMAIN" \
      -addext "subjectAltName=DNS:$HTTPS_DOMAIN,DNS:localhost,IP:127.0.0.1" 2>/dev/null
    sudo chmod 600 "$CERT_DIR/key.pem"
    sudo chmod 644 "$CERT_DIR/cert.pem"
    SSL_CERT="$CERT_DIR/cert.pem"
    SSL_KEY="$CERT_DIR/key.pem"
    CERT_EXPORT="$HOME/horix_cert.crt"
    sudo cp "$CERT_DIR/cert.pem" "$CERT_EXPORT"
    sudo chown "$USER" "$CERT_EXPORT"
    ok "Certificado autofirmado generado → $CERT_EXPORT"
  fi

  # Config Nginx final
  info "Configurando Nginx..."
  sudo tee "$NGINX_CONF" > /dev/null << NGINXEOF
server {
    listen $HTTPS_PORT ssl;
    server_name $HTTPS_DOMAIN;

    ssl_certificate     $SSL_CERT;
    ssl_certificate_key $SSL_KEY;

    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;

    client_max_body_size 50M;

    location / {
        proxy_pass         http://127.0.0.1:$PUERTO;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
    }
}

# Redirigir HTTP → HTTPS
server {
    listen 80;
    server_name $HTTPS_DOMAIN;
    return 301 https://\$host:$HTTPS_PORT\$request_uri;
}
NGINXEOF

  sudo ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/horix
  sudo rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
  sudo nginx -t || err "Error en configuración de Nginx"
  sudo systemctl restart nginx
  sudo systemctl enable nginx
  ok "Nginx activo"

  if sudo ufw status 2>/dev/null | grep -q "Status: active"; then
    sudo ufw allow "$HTTPS_PORT/tcp"
    sudo ufw allow 80/tcp
    ok "Puertos $HTTPS_PORT y 80 abiertos en firewall"
  fi

  HTTPS_URL="https://$HTTPS_DOMAIN:$HTTPS_PORT"
fi
# ── 12. Fail2ban
echo ""
echo -e "${AZUL}── Protección contra fuerza bruta (opcional) ─${RESET}"
read -p "  ¿Instalar y configurar Fail2ban? [s/N]: " CONF_F2B
if [[ "$CONF_F2B" =~ ^[Ss]$ ]]; then
  if ! command -v fail2ban-client &>/dev/null; then
    info "Instalando Fail2ban..."
    sudo apt-get install -y fail2ban
  fi
  ok "Fail2ban: $(fail2ban-client --version 2>&1 | head -1)"

  NGINX_LOG="/var/log/nginx/access.log"
  F2B_PORT=${HTTPS_PORT:-$PUERTO}

  if [[ ! "$CONF_HTTPS" =~ ^[Ss]$ ]]; then
    warn "HTTPS no configurado — Fail2ban solo funcionará si Nginx está instalado y activo."
    warn "Si Nginx no está activo, los intentos fallidos no serán detectados."
  fi

  sudo tee /etc/fail2ban/filter.d/horix-login.conf > /dev/null << 'F2BFILTER'
[Definition]
failregex = ^<HOST> .* "POST /api/auth/login HTTP.*" 401
ignoreregex =
F2BFILTER

  sudo tee /etc/fail2ban/jail.d/horix.conf > /dev/null << F2BJAIL
[horix-login]
enabled   = false
port      = $F2B_PORT,80,443
filter    = horix-login
logpath   = $NGINX_LOG
backend   = polling
maxretry  = 5
findtime  = 300
bantime   = 600
ignoreip  = 127.0.0.1/8
F2BJAIL

  sudo systemctl enable fail2ban
  sudo systemctl restart fail2ban
  ok "Fail2ban activo en puerto $F2B_PORT"
  info "Comandos útiles de Fail2ban:"
  echo -e "    sudo fail2ban-client status horix-login"
  echo -e "    sudo fail2ban-client set horix-login unbanip <IP>"
fi

# Configurar sudoers para mount NAS (independiente de Fail2ban)
if [[ "$USAR_NAS" == "true" ]]; then
  echo "$USER ALL=(ALL) NOPASSWD: /bin/mount, /bin/umount, /usr/bin/mkdir, /bin/mkdir" | \
    sudo tee /etc/sudoers.d/horix-mount > /dev/null
  sudo chmod 440 /etc/sudoers.d/horix-mount
  ok "Permisos sudo para mount configurados"
fi

# ── 13. Resumen final
SERVER_IP=$(hostname -I | awk '{print $1}')
echo ""
echo -e "${VERDE}══════════════════════════════════════════════${RESET}"
echo -e "${VERDE}  ✅ Horix v2.3.1 instalado correctamente${RESET}"
echo -e "${VERDE}══════════════════════════════════════════════${RESET}"
echo ""
echo -e "  🏢 Empresa:  $EMPRESA"
echo -e "  🌐 HTTP:     http://$SERVER_IP:$PUERTO"
[[ -n "$HTTPS_URL" ]] && echo -e "  🔒 HTTPS:    $HTTPS_URL"
echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     CREDENCIALES POR DEFECTO         ║"
echo "  ║  Usuario: admin@tuempresa.com        ║"
echo "  ║  Password: Admin*2026!               ║"
echo "  ║  ⚠Cambia estas credenciales         ║"
echo "  ║    tras el primer login              ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo -e "${AMARILLO}  ⚠ Configura el SMTP en Configuración → Config. Correo.${RESET}"
RAMA=$(git branch --show-current 2>/dev/null || echo "desconocida")
echo -e "  🌿 Rama:     $RAMA"
[[ "$CERT_TIPO" == "1" && -n "$HTTPS_URL" ]] && echo -e "${AMARILLO}  ⚠ Instala el certificado ~/horix_cert.crt en los equipos clientes.${RESET}"
[[ "$CERT_TIPO" == "1" && -n "$HTTPS_URL" ]] && echo -e "${AMARILLO}  ⚠ Agrega al DNS interno: $SERVER_IP  $HTTPS_DOMAIN${RESET}"
echo ""
echo -e "  pm2 logs horix      # Ver logs"
echo -e "  pm2 restart horix   # Reiniciar"
echo ""
