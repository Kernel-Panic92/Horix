# Changelog - Horix

## [2.3.4] - 2026-04-29

### ✨ Añadido
- **Botón para colapsar sidebar**: Nuevo botón en el lateral que permite ocultar/mostrar el menú. Al colapsar, solo se muestran los iconos para ahorrar espacio en pantalla
- **Persistencia del estado del sidebar**: El estado colapsado/expandido se guarda en localStorage y se restaura al recargar la página

### 🎨 Mejorado
- **Interfaz responsive mejorada**: 
  - Todas las tablas ahora se convierten en tarjetas apiladas en móviles (≤480px) con etiquetas `data-label`
  - Mejorada la visualización de tablas en tablets (≤768px) con scroll horizontal más fluido
  - Agregado `data-label` a las tablas: Historial, Empleados, Centros, Usuarios y Reportes para mejor experiencia móvil
  - El sidebar ahora tiene transición suave al colapsar/expandir

### 📝 Notas técnicas
- Nueva función `toggleSidebarCollapse()` para manejar el colapso del sidebar
- CSS actualizado para sidebar colapsado: `.sidebar.collapsed` (ancho 68px, solo iconos)
- Mejorado el CSS responsive para móviles y tablets en `index.html`

### 📋 Pendiente para próxima sesión
- [ ] **Mejorar legibilidad de widgets**: Optimizar el diseño y presentación de las tarjetas de métricas en el dashboard

---

## [2.3.3] - 2026-04-28

### 🐛 Corregido
- **Bug crítico en guardado de registros**: Se corrigió error 500 al guardar registros de horas extra. El problema era un `?` extra en la sentencia INSERT de `server.js:893` (17 columnas pero 18 valores).

### ✨ Añadido
- **Columna de estado en tablas**: Ahora todas las tablas (dashboard, historial, consulta) muestran el estado del registro:
  - 🟢 `aprobado` (badge verde)
  - 🟡 `pendiente` (badge amarillo)
  - 🔴 `rechazado` (badge rojo)

- **Flujo de aprobación mejorado**:
  - Botones de "✓ Aprobar" y "✗ Rechazar" visibles para usuarios con rol gerencia/admin
  - Al rechazar, permite agregar observaciones (opcional)
  - Al aprobar, permite agregar observaciones (opcional)

- **Enlace directo en correos**: Los gerentes ahora reciben un enlace directo en el correo de notificación:
  - Formato: `https://horixvitamar.fortiddns.com?registro=[ID]`
  - Al abrir el enlace, la app resalta el registro en la tabla y hace scroll automático

- **Dashboard actualizado** - Solo contabiliza horas aprobadas:
  - Total Horas Aprobadas
  - Horas Este Mes (aprobadas)
  - Horas Este Año (aprobadas)
  - Empleados con Horas Extra
  - Horas Pendientes
  - Registros Rechazados
  - Registros Aprobados

### 🎨 Mejorado
- **Contraste de colores**: Se mejoraron los colores para mejor legibilidad en modo claro y oscuro:
  - `--success: #2f855a` (verde más oscuro)
  - `--warning: #d69e2e` (amarillo más oscuro)
  - `--danger: #c53030` (rojo más oscuro)
  - `--accent: #2b6cb0` (azul más oscuro)

- **Indicadores visuales**: El dashboard ahora muestra claramente "✓ Solo horas aprobadas"

### 📝 Notas técnicas
- Se agregaron estilos CSS para badges: `.badge-success`, `.badge-danger`, `.badge-warning`
- Función `puedoAprobar()` para verificar permisos de aprobación
- Función `aprobarRegistro(id, aprobar)` para manejar aprobación/rechazo
- Función `resaltarRegistro(id)` para resaltar registros desde URL
- Los gráficos del dashboard ahora solo procesan registros con estado 'aprobado'

### 📋 Pendiente para próxima sesión
- [ ] **Hacer la interfaz responsive**: Revisar y ajustar todos los componentes para móviles/tablets
- [ ] **Mejorar legibilidad de widgets**: Optimizar el diseño y presentación de las tarjetas de métricas en el dashboard

---

## [2.3.2] - 2026-04-27

### Inicial
- Configuración base del proyecto
