const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { soloAdmin, adminRrhh, todosRoles } = require('../middleware/auth');
const { uid } = require('../utils/helpers');

router.get('/', todosRoles, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM centros ORDER BY nombre ASC').all());
});

router.post('/', adminRrhh, (req, res) => {
  const db = getDb();
  const { nombre } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });

  const existe = db.prepare('SELECT id FROM centros WHERE nombre = ?').get(nombre.trim());
  if (existe) return res.status(400).json({ error: 'Ya existe un centro con ese nombre' });

  const id = uid();
  db.prepare('INSERT INTO centros (id,nombre,activo,creado) VALUES (?,?,1,?)').run(id, nombre.trim(), new Date().toISOString());
  res.json(db.prepare('SELECT * FROM centros WHERE id=?').get(id));
});

router.put('/:id', adminRrhh, (req, res) => {
  const db = getDb();
  const { nombre, activo } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });

  const existe = db.prepare('SELECT id FROM centros WHERE nombre = ? AND id != ?').get(nombre.trim(), req.params.id);
  if (existe) return res.status(400).json({ error: 'Ya existe un centro con ese nombre' });

  db.prepare('UPDATE centros SET nombre=?, activo=? WHERE id=?').run(nombre.trim(), activo ? 1 : 0, req.params.id);
  res.json(db.prepare('SELECT * FROM centros WHERE id=?').get(req.params.id));
});

router.delete('/:id', soloAdmin, (req, res) => {
  const db = getDb();
  const enUso = db.prepare("SELECT COUNT(*) as n FROM empleados WHERE sede=( SELECT nombre FROM centros WHERE id=?)").get(req.params.id);
  if (enUso?.n > 0) return res.status(400).json({ error: 'No se puede eliminar: hay empleados asignados a este centro' });

  db.prepare('DELETE FROM centros WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;