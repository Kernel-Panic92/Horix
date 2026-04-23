# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

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