# Horix — Sistema de Control de Horas Extra

Sistema web para la gestión y control de horas extra del personal, desarrollado para el área de Recursos Humanos.

## Características

- Registro de horas extra por empleado, tipo y período de nómina
- Aprobación y seguimiento de registros
- Gestión de **Centros de Operación** (sedes) dinámica — configurable desde la interfaz
- Dashboard con widgets interactivos (draggable, redimensionables)
- Reportes y exportación a CSV
- Backups automáticos locales y en red (NAS/SMB)
- Gestión de usuarios con roles: Admin, RRHH, Consulta, Operador
- Soporte para recuperación de contraseña vía correo
- Tema claro / oscuro
- Personalización de logo corporativo

## Requisitos

- Node.js >= 18.0.0
- Linux (Ubuntu 20.04+ / Debian)
- PM2 (instalado automáticamente por el instalador)

## Instalación

```bash
git clone https://github.com/Kernel-Panic92/Horix.git
cd Horix
chmod +x install.sh
./install.sh
```

El instalador configura interactivamente:
- Puerto del servidor
- Email y contraseña del administrador
- Centro de operación inicial
- Backup en servidor NAS (opcional)
- Cron de backup automático diario (opcional)

## Configuración post-instalación

1. Abre `http://<IP_SERVIDOR>:<PUERTO>` en el navegador
2. Inicia sesión con las credenciales definidas en el instalador
3. Ve a **Configuración → Config. Correo** para configurar el servidor SMTP
4. Ve a **Centros de Operación** para agregar las sedes de tu organización

## Roles de usuario

| Rol | Permisos |
|-----|----------|
| Admin | Acceso total |
| RRHH | Registrar, editar, aprobar, gestionar centros |
| Consulta | Solo lectura |
| Operador | Ver y registrar solo su centro |

## Scripts útiles

```bash
pm2 logs horix          # Ver logs en tiempo real
pm2 restart horix       # Reiniciar servidor
pm2 stop horix          # Detener servidor
./backup_horasextra.sh  # Ejecutar backup manual
```

## Estructura del proyecto

```
horix/
├── server.js                     # Backend — Express + SQLite
├── public/
│   ├── index.html                # Frontend SPA
│   └── reset-password.html       # Página de reset de contraseña
├── install.sh                    # Instalador interactivo
├── backup_horasextra_template.sh # Plantilla de backup (generada por install.sh)
├── package.json
└── LICENSE
```

## Seguridad

- Las contraseñas se almacenan con bcrypt
- La contraseña SMTP se cifra con AES-256-GCM
- Los tokens de sesión tienen expiración configurable
- El script de backup generado (`backup_horasextra.sh`) contiene credenciales del cliente y está excluido del repositorio vía `.gitignore`

## Licencia

Copyright (c) 2025 Edgar Velasquez. Todos los derechos reservados.  
Consulta el archivo [LICENSE](LICENSE) para más información.
