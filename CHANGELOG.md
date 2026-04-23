# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

## [2.4.2] - 2026-04-23

### Agregado (Backend - Módulo configuración avanzado)
- Logo empresa (subir desde UI): `POST /api/configuracion/logo`
- Configuración de seguridad (rate limit, fail2ban): `/api/configuracion/seguridad`
- Updater desde UI (check, update, restart): `/api/configuracion/updater/*`
- Backups automáticos configurables (cron, retención, NAS): `/api/configuracion/backups-auto/*`
- Tareas cron configurables: `/api/configuracion/cron`
- Script `src/scripts/backup-auto.js` para backups automáticos

### NUEVAS RUTAS API
```
/api/configuracion/logo         POST     - Subir logo empresa
/api/configuracion/seguridad    GET/PUT   - Config rate limiting y fail2ban
/api/configuracion/updater/status GET      - Estado del updater
/api/configuracion/updater/check POST   - Buscar actualizaciones
/api/configuracion/updater/update POST  - Ejecutar actualización
/api/configuracion/updater/restart POST - Reiniciar servicio
/api/configuracion/backups-auto    GET/PUT   - Config backup automático
/api/configuracion/backups-auto/ultimo GET   - Ver último backup
/api/configuracion/cron           GET/PUT   - Config tareas cron
```

### Archivos nuevos/incluidos
```
src/scripts/backup-auto.js   - Script para backup automático (cron)
```

## [2.4.1] - 2026-04-23

### Agregado
- Estructura modular (src/, routes/, middleware/, services/)
- Archivo `.env.example` para variables de entorno

### Cambiado
- Separado el código monolítico en módulos especializados
- `server.js` → `src/server.js` (entry point)
- Actualizado `update.sh` para buscar `src/server.js`

### Archivos nuevos
```
src/
├── server.js           # Entry point
├── db/index.js        # Setup DB + migraciones
├── routes/           # Endpoints API
│   ├── auth.js
│   ├── centros.js
│   ├── empleados.js
│   ├── registros.js
│   ├── nominas.js
│   ├── usuarios.js
│   ├── backup.js
│   └── config.js
├── middleware/        # Auth + rate limiting
│   ├── auth.js
│   └── ratelimit.js
├── services/         # Lógica de negocio
│   ├── mail.js      # SMTP
│   └── crypto.js     # Hash + AES
└── utils/
    └── helpers.js
```

## [2.3.3] - 2026-01-XX

### Agregado
- Backup automático en NAS SMB
- Alerta SMTP cuando falla backup

### Cambiado
-Mejoras en calendario

---

Formatos:
- [Agregado] para nuevas características
- [Cambiado] para cambios en funcionalidad existente
- [Corregido] para bug fixes
- [Removido] para características eliminadas