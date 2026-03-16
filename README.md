# Horix v2.3.1 — Sistema de Control de Horas Extra

Sistema web para la gestión y control de horas extra del personal, desarrollado para el área de Recursos Humanos.

## Requisitos

| Componente | Versión mínima | Notas |
|-----------|---------------|-------|
| Node.js   | 18.0.0        | Instalado automáticamente por el instalador |
| PM2       | cualquiera    | Instalado automáticamente por el instalador |
| Fail2Ban  | cualquiera    | Instalado automáticamente por el instalador |
| Nginx     | cualquiera    | Solo si se configura HTTPS. `sudo apt install nginx -y` |
| Linux     | Ubuntu 20.04+ / Debian 11+ | |

## Instalación

```bash
git clone -b dev git@github.com:Kernel-Panic92/Horix.git horix
cd horix
chmod +x install.sh
./install.sh
```

El instalador configura interactivamente:

- Puerto del servidor
- Nombre de la empresa
- Email y contraseña del administrador
- Centro de operación inicial
- Backup local y en servidor NAS (opcional)
- Cron de backup automático diario (opcional)
- **HTTPS con Nginx** — dominio y puerto configurables (opcional)

## Configuración HTTPS

Si seleccionas HTTPS durante la instalación, el instalador:

1. Instala Nginx si no está presente
2. Genera un certificado SSL autofirmado válido por 10 años
3. Configura Nginx como reverse proxy (HTTPS → Node.js)
4. Exporta el certificado a `~/horix_cert.crt` para distribuirlo a los clientes

### Distribución del certificado en red con Active Directory

**DNS interno** — Agrega un registro A en `dnsmgmt.msc`:
```
Zona: tudominio.local → Nuevo host (A)
  Nombre: horix
  IP: <IP del servidor>
```

**Certificado vía GPO** — En `gpmc.msc`:
```
Configuración del equipo → Directivas → Configuración de Windows
  → Configuración de seguridad → Directivas de clave pública
    → Entidades de certificación raíz de confianza → Importar → horix_cert.crt
```

Luego aplica con `gpupdate /force` en los equipos cliente.

## Configuración post-instalación

1. Abre la URL del sistema en el navegador
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

## Comandos útiles

```bash
pm2 logs horix          # Ver logs en tiempo real
pm2 restart horix       # Reiniciar servidor
pm2 stop horix          # Detener servidor
./backup_horasextra.sh  # Ejecutar backup manual
sudo crontab -l         # Ver tareas programadas
sudo fail2ban-client status horix-login   # Ver IPs bloqueadas
sudo fail2ban-client set horix-login unbanip <IP>  # Desbloquear IP
```

## Estructura del proyecto

```
horix/
├── server.js                       # Backend — Express + SQLite
├── public/
│   ├── index.html                  # Frontend SPA
│   └── reset-password.html         # Página de reset de contraseña
├── install.sh                      # Instalador interactivo
├── backup_horasextra_template.sh   # Plantilla de backup (el instalador genera el .sh real)
├── package.json
├── update.sh                       # Script de actualizacion
└── LICENSE
```

## Seguridad

- Contraseñas almacenadas con bcrypt
- Contraseña SMTP cifrada con AES-256-GCM
- Tokens de sesión con expiración
- HTTPS mediante Nginx como reverse proxy
- Script de backup con credenciales generado localmente, nunca versionado

## Licencia

Copyright (c) 2025 Edgar Velasquez. Todos los derechos reservados.  
Consulta el archivo [LICENSE](LICENSE) para más información.
