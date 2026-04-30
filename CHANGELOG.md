# Changelog

## Pendientes / Known Issues

### Críticos
- [x] **Logo no cargaba por HTTPS** - Nginx servía `index.html` en lugar de proxy `/logo` a Node.js. **Fix:** Agregada regla `location = /logo` en `/etc/nginx/sites-available/horix` para proxy pass a Node.js.

### Medios
- [ ] **URLs hardcodeadas** - La dirección `horixvitamar.fortiddns.com` está hardcoded en múltiples lugares para emails
- [ ] **Validación de tamaño faltante en backend** - El backend no valida el tamaño del archivo de logo (solo el frontend limita a 2MB)
- [ ] **No hay rate limiting** - En el endpoint de subida de logo `/api/logo`

### Bajos
- [x] **Demasiados console.log** - Eliminados ~7 statements `console.log` de debug en `server.js` (migración, DEBUG req.body, logs de logo). Archivo: `server.js`
- [ ] **CORS permisivo** - `server.js:21` usa `cors()` sin restricciones (acepta cualquier origen)
- [ ] **Backup incluye contraseñas** - El backup contiene passwords hasheadas, considerar encriptar el ZIP
- [ ] **Uso inconsistente de `var`** - Algunos loops usan `var` en lugar de `let/const`

---

## Fixes Aplicados

### 2026-04-30
- **Logo no cargaba por HTTPS** - El endpoint `/logo` era interceptado por nginx `try_files` que devolvía `index.html`. **Fix:** Agregada regla `location = /logo` en nginx para proxy pass a Node.js. Archivo: `/etc/nginx/sites-available/horix`
- **Logo roto (frontend)** - Corregido `aplicarLogo()` en `public/index.html`:
  - Se corrigió el selector CSS en `querySelectorAll` (se quitó el espacio antes de `.login-logo`)
  - Se valida que el contenido sea `image/*` antes de crear el `<img>`
  - El `catch` ahora restaura el texto "HORIX." en lugar de quedar vacío
  - Agregado manejo `onerror` en la imagen y cache-busting con `?t=` timestamp
  - Archivos: `public/index.html:3361-3385`
- **Limpieza de console.log** - Eliminados statements de debug innecesarios en `server.js`:
  - Migración smtp_password (línea 298)
  - DEBUG req.body (línea 879)
  - Logs de depuración de logo (líneas 1249, 1257, 1269, 1273, 1277)
  - Logs de depuración en `public/index.html` (función `aplicarLogo`)
- **Flujo seguro de creación de usuarios** - Al crear usuario:
  - Ya no se requiere que el admin defina la contraseña
  - Se genera contraseña temporal aleatoria automáticamente
  - Se crea token de 7 días y se envía correo con enlace a `/reset-password.html`
  - Se fuerza cambio de contraseña en primer login (`cambio_password = 1`)
  - Archivo: `server.js:615-660`
