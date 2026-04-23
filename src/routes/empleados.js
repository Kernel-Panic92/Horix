const express = require('express');
const router = express.Router();
const multer = require('multer');
const { getDb } = require('../db');
const { adminRrhh, todosRoles, soloAdmin } = require('../middleware/auth');
const { uid } = require('../utils/helpers');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

router.get('/', todosRoles, (req, res) => {
  const db = getDb();
  const u = req.usuario;

  const asignados = db.prepare('SELECT empleadoId FROM usuario_empleados WHERE usuarioId = ?').all(u.id).map(r => r.empleadoId);

  if (asignados.length > 0) {
    const placeholders = asignados.map(() => '?').join(',');
    return res.json(db.prepare(`SELECT * FROM empleados WHERE id IN (${placeholders})`).all(...asignados));
  }

  if (u.rol === 'operador') {
    return res.json(db.prepare('SELECT * FROM empleados WHERE sede = ?').all(u.sede));
  }
  if (u.rol === 'rrhh' && req.query.sede) {
    return res.json(db.prepare('SELECT * FROM empleados WHERE sede = ?').all(req.query.sede));
  }
  res.json(db.prepare('SELECT * FROM empleados').all());
});

router.post('/', adminRrhh, (req, res) => {
  const db = getDb();
  const { nombre, cedula, cargo, departamento, sede, email, telefono } = req.body;

  const centroValido = db.prepare('SELECT id FROM centros WHERE nombre=? AND activo=1').get(sede);
  if (!centroValido) return res.status(400).json({ error: 'Centro de operación inválido' });

  const id = uid();
  db.prepare('INSERT INTO empleados (id,nombre,cedula,cargo,departamento,sede,email,telefono) VALUES (?,?,?,?,?,?,?,?)').run(
    id, nombre, cedula, cargo, departamento, sede, email || '', telefono || ''
  );
  res.json({ id });
});

router.put('/:id', adminRrhh, (req, res) => {
  const db = getDb();
  const { nombre, cedula, cargo, departamento, sede, email, telefono } = req.body;

  const centroValido = db.prepare('SELECT id FROM centros WHERE nombre=? AND activo=1').get(sede);
  if (!centroValido) return res.status(400).json({ error: 'Centro de operación inválido' });

  db.prepare('UPDATE empleados SET nombre=?,cedula=?,cargo=?,departamento=?,sede=?,email=?,telefono=? WHERE id=?')
    .run(nombre, cedula, cargo, departamento, sede, email || '', telefono || '', req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', soloAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM registros WHERE empleadoId=?').run(req.params.id);
  db.prepare('DELETE FROM empleados WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/importar', soloAdmin, upload.single('archivo'), (req, res) => {
  const db = getDb();
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

  try {
    const texto = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
    const lineas = texto.split('\n').map(l => l.trim()).filter(l => l);
    if (lineas.length < 2) return res.status(400).json({ error: 'El archivo está vacío o no tiene datos' });

    const primeraLinea = lineas[0];
    const separador = primeraLinea.includes('\t') ? '\t' : primeraLinea.includes(';') ? ';' : ',';

    const parseCsv = line => {
      const cols = []; let cur = '', inQ = false;
      for (const ch of line) {
        if (ch === '"') { inQ = !inQ; }
        else if (ch === separador && !inQ) { cols.push(cur); cur = ''; }
        else cur += ch;
      }
      cols.push(cur);
      return cols.map(c => c.replace(/^"|"$/g, '').replace(/""/g, '"').trim());
    };

    const headers = parseCsv(lineas[0]).map(h => h.toLowerCase());
    const idx = h => headers.indexOf(h);

    const required = ['nombre', 'cedula', 'cargo', 'departamento', 'sede'];
    const missing = required.filter(r => idx(r) === -1);
    if (missing.length) return res.status(400).json({ error: `Columnas faltantes: ${missing.join(', ')}` });

    let agregados = 0, omitidos = 0, errores = 0;
    const detalleErrores = [];

    for (let i = 1; i < lineas.length; i++) {
      const cols = parseCsv(lineas[i]);
      if (cols.length < required.length) { errores++; continue; }
      const cedula = cols[idx('cedula')]?.trim();
      if (!cedula) { errores++; continue; }
      const existe = db.prepare('SELECT id FROM empleados WHERE cedula = ?').get(cedula);
      if (existe) { omitidos++; continue; }

      const nombre = cols[idx('nombre')]?.trim();
      const cargo = cols[idx('cargo')]?.trim();
      const departamento = cols[idx('departamento')]?.trim();
      const sede = cols[idx('sede')]?.trim() || 'Principal';
      const email = idx('email') !== -1 ? cols[idx('email')]?.trim() : '';
      const telefono = idx('telefono') !== -1 ? cols[idx('telefono')]?.trim() : '';

      if (!nombre || !cargo || !departamento) {
        detalleErrores.push(`Fila ${i + 1}: datos incompletos`);
        errores++; continue;
      }

      const centroValido = db.prepare('SELECT id FROM centros WHERE nombre = ? AND activo = 1').get(sede);
      if (!centroValido) {
        detalleErrores.push(`Fila ${i + 1}: sede "${sede}" no existe`);
        errores++; continue;
      }

      db.prepare('INSERT INTO empleados (id,nombre,cedula,cargo,departamento,sede,email,telefono) VALUES (?,?,?,?,?,?,?,?)')
        .run(uid(), nombre, cedula, cargo, departamento, sede, email || '', telefono || '');
      agregados++;
    }
    res.json({ ok: true, agregados, omitidos, errores, detalleErrores });
  } catch (e) {
    console.error('Error importar empleados:', e);
    res.status(500).json({ error: 'Error procesando el archivo: ' + e.message });
  }
});

module.exports = router;