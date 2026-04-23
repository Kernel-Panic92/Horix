const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { todosRoles } = require('../middleware/auth');

router.get('/', todosRoles, (req, res) => {
  const db = getDb();
  res.json(db.prepare("SELECT nombre FROM centros WHERE activo=1 ORDER BY nombre ASC").all().map(c => c.nombre));
});

module.exports = router;