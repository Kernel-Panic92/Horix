#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  backup_horasextra.sh — Backup automático de HorasExtra
#  Vitamar S.A. — genera el mismo ZIP que el botón "Exportar" del WebUI
#
#  Cron diario a las 2:00 AM (ejecutar como root):
#    0 2 * * * /home/coordinadorsistemas/horas-extra/backup_horasextra.sh >> /var/log/backup_horasextra.log 2>&1
# ═══════════════════════════════════════════════════════════════

# ── CONFIGURACIÓN ──────────────────────────────────────────────
APP_URL="http://localhost:3000"
ADMIN_EMAIL="coordinadorsistemas@vitamar.com.co"
ADMIN_PASS="$(node -e "
  const db = require('better-sqlite3')('/home/coordinadorsistemas/horas-extra/horas_extra.db');
  const u = db.prepare('SELECT password FROM usuarios WHERE email = ?').get('coordinadorsistemas@vitamar.com.co');
  // No imprimimos la pass — usamos autenticación directa
  db.close();
" 2>/dev/null)"

BACKUP_LOCAL="/home/coordinadorsistemas/backups/horasextra"
BACKUP_RED="/mnt/nas_vitamar/Backup_Horas_Extra"
SMB_SERVER="//192.168.168.110/Veeam"
SMB_MOUNT="/mnt/nas_vitamar"
SMB_USER="admin"
SMB_PASS="v1t4m4r*2019"
RETENER_DIAS=30
FECHA=$(date +"%Y-%m-%d_%H-%M-%S")
NOMBRE="horasextra_backup_${FECHA}.zip"
LOG_TAG="[HorasExtra Backup]"
ERROR_RED=""  # Acumula errores de red
# ──────────────────────────────────────────────────────────────

# ── Función: enviar alerta por correo vía el servidor ──────────
enviar_alerta() {
  local ERROR_MSG="$1"
  local DETALLE="$2"
  echo "$LOG_TAG  📧 Enviando alerta por correo..."

  # Obtener token para autenticar
  local PASS=$(cat /home/coordinadorsistemas/horas-extra/.backup_pass 2>/dev/null)
  local LOGIN=$(curl -s -X POST "$APP_URL/api/auth/login"     -H "Content-Type: application/json"     -d "{"email":"coordinadorsistemas@vitamar.com.co","password":"$PASS"}")
  local TOK=$(echo "$LOGIN" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).token||'');}catch(e){console.log('');}});")

  if [ -n "$TOK" ]; then
    curl -s -X POST "$APP_URL/api/backup/alerta"       -H "Content-Type: application/json"       -H "Authorization: Bearer $TOK"       -d "{"error":"$ERROR_MSG","detalle":"$DETALLE"}" > /dev/null
    echo "$LOG_TAG  ✓ Alerta enviada a coordinadorsistemas@vitamar.com.co"
  else
    echo "$LOG_TAG  ✗ No se pudo enviar alerta (sin token)"
  fi
}

echo ""
echo "══════════════════════════════════════════"
echo "$LOG_TAG  Iniciando — $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════"

# ── 1. Crear carpeta local
mkdir -p "$BACKUP_LOCAL"

# ── 2. Login — obtener token
echo "$LOG_TAG  🔐 Autenticando..."
LOGIN_RESP=$(curl -s -X POST "$APP_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"coordinadorsistemas@vitamar.com.co\",\"password\":\"$(cat /home/coordinadorsistemas/horas-extra/.backup_pass 2>/dev/null || echo 'CONFIGURAR_PASS')\"}")

TOKEN=$(echo "$LOGIN_RESP" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{ try{ console.log(JSON.parse(d).token||''); }catch(e){ console.log(''); } });
")

if [ -z "$TOKEN" ]; then
  echo "$LOG_TAG  ✗ ERROR: No se pudo obtener token. Verifica la contraseña en .backup_pass"
  echo "$LOG_TAG  Respuesta del servidor: $LOGIN_RESP"
  enviar_alerta "Error de autenticación" "No se pudo obtener token. Respuesta: $LOGIN_RESP"
  exit 1
fi
echo "$LOG_TAG  ✓ Autenticado correctamente"

# ── 3. Descargar ZIP desde el WebUI (idéntico al botón Exportar)
ARCHIVO_LOCAL="$BACKUP_LOCAL/$NOMBRE"
echo "$LOG_TAG  📦 Descargando backup..."
HTTP_CODE=$(curl -s -o "$ARCHIVO_LOCAL" -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$APP_URL/api/backup")

if [ "$HTTP_CODE" = "200" ] && [ -s "$ARCHIVO_LOCAL" ]; then
  TAMAÑO=$(du -sh "$ARCHIVO_LOCAL" | cut -f1)
  echo "$LOG_TAG  ✓ Backup descargado: $ARCHIVO_LOCAL ($TAMAÑO)"
else
  echo "$LOG_TAG  ✗ ERROR: Falló la descarga (HTTP $HTTP_CODE)"
  rm -f "$ARCHIVO_LOCAL"
  enviar_alerta "Error al descargar backup" "HTTP $HTTP_CODE al llamar $APP_URL/api/backup"
  exit 1
fi

# ── 4. Montar share de red
MONTAR_DESMONTADO=false
if ! mountpoint -q "$SMB_MOUNT" 2>/dev/null; then
  echo "$LOG_TAG  📡 Montando share $SMB_SERVER..."
  mkdir -p "$SMB_MOUNT"
  mount -t cifs "$SMB_SERVER" "$SMB_MOUNT" \
    -o username="$SMB_USER",password="$SMB_PASS",uid=$(id -u coordinadorsistemas),gid=$(id -g coordinadorsistemas),iocharset=utf8 2>/dev/null
  if [ $? -eq 0 ]; then
    echo "$LOG_TAG  ✓ Share montado"
    MONTAR_DESMONTADO=true
  else
    ERROR_RED="No se pudo montar el share $SMB_SERVER — backup guardado solo local"
    echo "$LOG_TAG  ✗ $ERROR_RED"
    enviar_alerta "Error al montar share de red" "$ERROR_RED"
    BACKUP_RED=""
  fi
else
  echo "$LOG_TAG  ✓ Share ya montado"
fi

# ── 5. Copiar a red
if [ -n "$BACKUP_RED" ]; then
  mkdir -p "$BACKUP_RED" 2>/dev/null
  cp "$ARCHIVO_LOCAL" "$BACKUP_RED/"
  if [ $? -eq 0 ]; then
    echo "$LOG_TAG  ✓ Copia en red: $BACKUP_RED/$NOMBRE"
  else
    echo "$LOG_TAG  ✗ ERROR: No se pudo copiar a la red"
  fi
fi

# ── 6. Limpiar backups locales viejos
BORRADOS=$(find "$BACKUP_LOCAL" -name "horasextra_backup_*.zip" -mtime +$RETENER_DIAS -type f)
if [ -n "$BORRADOS" ]; then
  find "$BACKUP_LOCAL" -name "horasextra_backup_*.zip" -mtime +$RETENER_DIAS -type f -delete
  echo "$LOG_TAG  🧹 Eliminados: $(echo "$BORRADOS" | wc -l) backup(s) viejos"
fi

# ── 7. Limpiar backups de red viejos
if [ -n "$BACKUP_RED" ] && [ -d "$BACKUP_RED" ]; then
  find "$BACKUP_RED" -name "horasextra_backup_*.zip" -mtime +$RETENER_DIAS -type f -delete
fi

# ── 8. Desmontar share
if [ "$MONTAR_DESMONTADO" = true ]; then
  umount "$SMB_MOUNT" 2>/dev/null && echo "$LOG_TAG  📡 Share desmontado"
fi

# ── 9. Guardar info del último backup para el WebUI
TAMANO_FINAL=$(du -sh "$ARCHIVO_LOCAL" 2>/dev/null | cut -f1 || echo "desconocido")
RED_OK="false"
[ -n "$BACKUP_RED" ] && [ -f "$BACKUP_RED/$NOMBRE" ] && RED_OK="true"

export ERROR_RED="$ERROR_RED"
node -e "
const errorRed = process.env.ERROR_RED || null;
const data = {
  fecha:   new Date().toISOString(),
  archivo: '$NOMBRE',
  tamano:  '$TAMANO_FINAL',
  ok:      !errorRed,
  local:   true,
  red:     $RED_OK,
  error:   errorRed
};
require('fs').writeFileSync(
  '/home/coordinadorsistemas/horas-extra/last_backup.json',
  JSON.stringify(data, null, 2)
);
"
echo "$LOG_TAG  ✓ Info guardada en last_backup.json"

# ── 10. Resumen
TOTAL_LOCAL=$(find "$BACKUP_LOCAL" -name "horasextra_backup_*.zip" -type f 2>/dev/null | wc -l)
echo ""
if [ -n "$ERROR_RED" ]; then
  echo "$LOG_TAG  ⚠ Backup local OK — pero con errores en la red: $ERROR_RED"
else
  echo "$LOG_TAG  ✅ Backup completado exitosamente (local + red)"
fi
echo "$LOG_TAG  📁 Backups locales: $TOTAL_LOCAL archivo(s)"
echo "$LOG_TAG  ⏱  Fin — $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════"
