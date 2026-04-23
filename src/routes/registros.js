const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { adminRrhh, adminRrhhOp, todosRoles } = require('../middleware/auth');
const { uid } = require('../utils/helpers');

router.get('/', todosRoles, (req, res) => {
  const db = getDb();
  const u = req.usuario;
  const base = `
    SELECT r.*, COALESCE(u.nombre, '') AS nombreCreador
    FROM registros r
    LEFT JOIN usuarios u ON r.creadoPor = u.id
  `;

  if (u.rol === 'operador') {
    return res.json(db.prepare(base + ' WHERE r.creadoPor = ? ORDER BY r.fecha DESC').all(u.id));
  }
  if (u.rol === 'rrhh' && req.query.sede) {
    return res.json(db.prepare(base + ' JOIN empleados e ON r.empleadoId = e.id WHERE e.sede = ? ORDER BY r.fecha DESC').all(req.query.sede));
  }
  res.json(db.prepare(base + ' ORDER BY r.fecha DESC').all());
});

router.post('/', adminRrhhOp, (req, res) => {
  const db = getDb();
  const { empleadoId, nominaId, fecha, horas, tipo, concepto, aprobador, motivo, observaciones, transporte } = req.body;
  const hoy = new Date().toISOString().split('T')[0];
  if (fecha > hoy) return res.status(400).json({ error: 'La fecha no puede ser futura.' });

  const u = req.usuario;
  if (u.rol !== 'admin') {
    const asignados = db.prepare('SELECT empleadoId FROM usuario_empleados WHERE usuarioId = ?').all(u.id).map(r => r.empleadoId);
    if (asignados.length > 0 && !asignados.includes(empleadoId)) {
      return res.status(403).json({ error: 'No tienes permiso para registrar horas a este empleado.' });
    }
  }

  const emp = db.prepare('SELECT sede FROM empleados WHERE id = ?').get(empleadoId);
  const sede = emp ? emp.sede : 'Principal';
  const id = uid();
  db.prepare('INSERT INTO registros (id,empleadoId,nominaId,fecha,horas,tipo,aprobador,motivo,creado,concepto,sede,creadoPor,observaciones,transporte) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, empleadoId, nominaId, fecha, horas, tipo, aprobador, motivo, new Date().toISOString(), concepto || '', sede, req.usuario.id, observaciones || '', parseFloat(transporte || 0));
  res.json({ id });
});

router.delete('/:id', adminRrhh, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM registros WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;