const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { soloAdmin } = require('../middleware/auth');
const { hashPassword, validarPassword } = require('../services/crypto');
const { uid } = require('../utils/helpers');

router.get('/', soloAdmin, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT id, nombre, email, rol, sede, activo, cambio_password, creado FROM usuarios ORDER BY creado DESC').all());
});

router.post('/', soloAdmin, async (req, res) => {
  const db = getDb();
  const { nombre, email, password, rol, sede } = req.body;
  if (!nombre || !email || !password || !rol || !sede) return res.status(400).json({ error: 'Todos los campos son requeridos' });

  const errPass = validarPassword(password);
  if (errPass.length) return res.status(400).json({ error: 'Contraseña inválida: ' + errPass.join(', ') });

  if (!['admin','rrhh','consulta','operador'].includes(rol)) return res.status(400).json({ error: 'Rol inválido' });

  const centroValido = db.prepare('SELECT id FROM centros WHERE nombre=? AND activo=1').get(sede);
  if (!centroValido) return res.status(400).json({ error: 'Centro de operación inválido' });

  const existe = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email.toLowerCase().trim());
  if (existe) return res.status(400).json({ error: 'Ya existe un usuario con ese correo' });

  const id = uid();
  const pwHash = await hashPassword(password);
  db.prepare('INSERT INTO usuarios (id,nombre,email,password,rol,sede,activo,creado) VALUES (?,?,?,?,?,?,?,?)').run(
    id, nombre.trim(), email.toLowerCase().trim(), pwHash, rol, sede, 1, new Date().toISOString()
  );
  res.json({ id });
});

router.get('/asignaciones/:id', soloAdmin, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT empleadoId FROM usuario_empleados WHERE usuarioId = ?').all(req.params.id);
  res.json(rows.map(r => r.empleadoId));
});

router.put('/asignaciones/:id', soloAdmin, (req, res) => {
  const db = getDb();
  const { empleados: lista } = req.body;
  db.transaction(() => {
    db.prepare('DELETE FROM usuario_empleados WHERE usuarioId = ?').run(req.params.id);
    if (Array.isArray(lista)) {
      const ins = db.prepare('INSERT OR IGNORE INTO usuario_empleados VALUES (?,?)');
      for (const eid of lista) ins.run(req.params.id, eid);
    }
  })();
  res.json({ ok: true });
});

router.put('/:id', soloAdmin, async (req, res) => {
  const db = getDb();
  const { nombre, email, rol, sede, activo, password } = req.body;

  if (!['admin','rrhh','consulta','operador'].includes(rol)) return res.status(400).json({ error: 'Rol inválido' });

  const centroValido = db.prepare('SELECT id FROM centros WHERE nombre=? AND activo=1').get(sede);
  if (!centroValido) return res.status(400).json({ error: 'Centro de operación inválido' });

  if (req.params.id === req.usuario.id && activo === 0) return res.status(400).json({ error: 'No puedes desactivarte a ti mismo' });

  if (password && password.trim() !== '') {
    const errPassU = validarPassword(password);
    if (errPassU.length) return res.status(400).json({ error: 'Contraseña inválida: ' + errPassU.join(', ') });

    const pwHashU = await hashPassword(password);
    db.prepare('UPDATE usuarios SET nombre=?,email=?,rol=?,sede=?,activo=?,password=? WHERE id=?')
      .run(nombre.trim(), email.toLowerCase().trim(), rol, sede, activo ? 1 : 0, pwHashU, req.params.id);
  } else {
    db.prepare('UPDATE usuarios SET nombre=?,email=?,rol=?,sede=?,activo=? WHERE id=?')
      .run(nombre.trim(), email.toLowerCase().trim(), rol, sede, activo ? 1 : 0, req.params.id);
  }
  res.json({ ok: true });
});

router.post('/:id/forzar-cambio', soloAdmin, (req, res) => {
  const db = getDb();
  if (req.params.id === req.usuario.id) return res.status(400).json({ error: 'No puedes forzar el cambio a tu propio usuario' });

  db.prepare('UPDATE usuarios SET cambio_password = 1 WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM sesiones WHERE usuarioId = ?').run(req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', soloAdmin, (req, res) => {
  const db = getDb();
  if (req.params.id === req.usuario.id) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });

  db.prepare('DELETE FROM sesiones WHERE usuarioId = ?').run(req.params.id);
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;