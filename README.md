# Horix — Sistema de Control de Horas Extra
**v2.1.0** · © 2025 Edgar Velasquez · Desarrollado para Vitamar S.A.

> Software propietario bajo licencia comercial. Ver [LICENSE](./LICENSE).

Sistema web para registro, seguimiento y reporte de horas extra del personal. Desarrollado en Node.js + SQLite con interfaz web responsiva, tema oscuro/claro, dashboard interactivo y backup automático.

---

## Requisitos del servidor

| Requisito | Versión mínima |
|-----------|---------------|
| Ubuntu Server | 20.04 LTS o superior |
| Node.js | 18.x o superior |
| PM2 | Cualquier versión reciente |
| RAM | 512 MB mínimo |
| Disco | 2 GB mínimo |

---

## Instalación rápida

```bash
git clone https://github.com/TU_USUARIO/horix.git
cd horix
chmod +x install.sh
./install.sh
```

El instalador se encarga de: verificar/instalar Node.js, instalar dependencias, configurar el usuario admin, iniciar con PM2, arranque automático y cron de backup.

---

## Estructura del proyecto

```
horix/
├── server.js                 # Backend Node.js + Express
├── package.json              # Dependencias
├── install.sh                # Instalador automático
├── backup_horasextra.sh      # Script de backup automático
├── LICENSE                   # Licencia propietaria
└── public/
    ├── index.html            # Aplicación frontend
    └── reset-password.html   # Recuperación de contraseña
```

> Los archivos sensibles (`.backup_pass`, `horas_extra.db`, `logo_empresa.*`) son generados automáticamente durante la instalación y están excluidos por `.gitignore`.

---

## Roles de usuario

| Rol | Permisos |
|-----|----------|
| **Admin** | Acceso total. Usuarios, configuración, backup. |
| **RRHH** | Registrar, editar y eliminar horas. Empleados y nóminas. |
| **Operador** | Registrar horas de sus empleados asignados. |
| **Consulta** | Solo lectura. |

---

## Gestión con PM2

```bash
pm2 logs horix        # Logs en tiempo real
pm2 restart horix     # Reiniciar
pm2 stop horix        # Detener
pm2 status            # Estado
```

---

## Actualizar

```bash
cd horix && git pull && npm install --production && pm2 restart horix
```

---

## Credenciales por defecto

> ⚠ Cambia estas credenciales tras el primer login.

- **Email:** `admin@empresa.com`  
- **Contraseña:** `Admin2025!`

---

## Licencia

Software propietario. © 2025 Edgar Velasquez. Desarrollado para Vitamar S.A.  
Todos los derechos reservados. Ver [LICENSE](./LICENSE) para términos completos.
