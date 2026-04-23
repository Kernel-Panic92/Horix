const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { adminRrhh, todosRoles, soloAdmin } = require('../middleware/auth');
const { uid } = require('../utils/helpers');

router.get('/', todosRoles, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM nominas ORDER BY inicio DESC').all());
});

router.post('/', adminRrhh, (req, res) => {
  const db = getDb();
  const { nombre, tipo, inicio, fin } = req.body;
  const id = uid();
  db.prepare('INSERT INTO nominas VALUES (?,?,?,?,?)').run(id, nombre, tipo, inicio, fin);
  res.json({ id });
});

router.delete('/:id', soloAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM nominas WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;