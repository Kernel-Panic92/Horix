const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { getDb } = require('../db');
const { soloAdmin } = require('../middleware/auth');
const { encryptSmtp } = require('../services/crypto');
const { getConfig, enviarCorreo, getAdminEmail } = require('../services/mail');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

function getBackupDir() {
  const candidatos = ['last_backup.json', '.ultimo_backup.json'].map(f => path.join(__dirname, '../../', f));
  for (const infoFile of candidatos) {
    try {
      if (!fs.existsSync(infoFile)) continue;
      const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
      if (info.archivo) {
        const posibleDir = path.join(os.homedir(), 'backups', 'horix');
        if (fs.existsSync(posibleDir)) return posibleDir;
      }
    } catch {}
  }
  const fallback = path.join(os.homedir(), 'backups', 'horix');
  return fs.existsSync(fallback) ? fallback : null;
}

router.get('/', soloAdmin, (req, res) => {
  try {
    const db = getDb();
    const data = {
      version: '1.0',
      generado: new Date().toISOString(),
      app: 'HorasExtra',
      configuracion: getConfig(),
      usuarios: db.prepare('SELECT id,nombre,email,password,rol,sede,activo,cambio_password,creado FROM usuarios').all(),
      empleados: db.prepare('SELECT * FROM empleados').all(),
      nominas: db.prepare('SELECT * FROM nominas').all(),
      registros: db.prepare('SELECT * FROM registros').all(),
      usuario_empleados: db.prepare('SELECT * FROM usuario_empleados').all(),
    };

    const zip = new AdmZip();
    zip.addFile('backup.json', Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
    zip.addFile('empleados.csv', Buffer.from(toCSV(data.empleados), 'utf8'));
    zip.addFile('nominas.csv', Buffer.from(toCSV(data.nominas), 'utf8'));
    zip.addFile('registros.csv', Buffer.from(toCSV(data.registros), 'utf8'));
    zip.addFile('usuarios.csv', Buffer.from(toCSV(data.usuarios), 'utf8'));

    const fecha = new Date().toISOString().slice(0, 10);
    const filename = `horasextra_backup_${fecha}.zip`;
    const buffer = zip.toBuffer();

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  } catch (e) {
    console.error('Error backup:', e);
    res.status(500).json({ error: 'Error generando backup: ' + e.message });
  }
});

router.post('/restore', soloAdmin, upload.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

  try {
    let data;
    if (req.file.originalname.endsWith('.zip')) {
      const zip = new AdmZip(req.file.buffer);
      const entry = zip.getEntry('backup.json');
      if (!entry) return res.status(400).json({ error: 'El ZIP no contiene backup.json' });
      data = JSON.parse(entry.getData().toString('utf8'));
    } else {
      data = JSON.parse(req.file.buffer.toString('utf8'));
    }

    if (data.app !== 'HorasExtra') return res.status(400).json({ error: 'Archivo de backup inválido' });

    const db = getDb();
    db.transaction(() => {
      if (data.configuracion) {
        for (const [clave, valor] of Object.entries(data.configuracion)) {
          const stored = clave === 'smtp_password' ? encryptSmtp(valor) : valor;
          db.prepare('INSERT OR REPLACE INTO configuracion VALUES (?,?)').run(clave, stored);
        }
      }
      if (data.empleados?.length) {
        db.prepare('DELETE FROM empleados').run();
        const ins = db.prepare('INSERT OR REPLACE INTO empleados (id,nombre,cedula,cargo,departamento,sede,email,telefono) VALUES (?,?,?,?,?,?,?,?)');
        for (const e of data.empleados) ins.run(e.id, e.nombre, e.cedula, e.cargo, e.departamento, e.sede || 'Principal', e.email || '', e.telefono || '');
      }
      if (data.nominas?.length) {
        db.prepare('DELETE FROM nominas').run();
        const ins = db.prepare('INSERT OR REPLACE INTO nominas VALUES (?,?,?,?,?)');
        for (const n of data.nominas) ins.run(n.id, n.nombre, n.tipo, n.inicio, n.fin);
      }
      if (data.registros?.length) {
        db.prepare('DELETE FROM registros').run();
        const ins = db.prepare('INSERT OR REPLACE INTO registros (id,empleadoId,nominaId,fecha,horas,tipo,aprobador,motivo,creado,concepto,sede,creadoPor,observaciones,transporte) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const r of data.registros) ins.run(r.id, r.empleadoId, r.nominaId, r.fecha, r.horas, r.tipo, r.aprobador, r.motivo, r.creado, r.concepto || '', r.sede || 'Principal', r.creadoPor || '', r.observaciones || '', parseFloat(r.transporte || 0));
      }
      if (data.usuario_empleados?.length) {
        db.prepare('DELETE FROM usuario_empleados').run();
        const ins = db.prepare('INSERT OR IGNORE INTO usuario_empleados VALUES (?,?)');
        for (const r of data.usuario_empleados) ins.run(r.usuarioId, r.empleadoId);
      }
      if (data.usuarios?.length) {
        const insUser = db.prepare('INSERT OR REPLACE INTO usuarios (id,nombre,email,password,rol,sede,activo,cambio_password,creado) VALUES (?,?,?,?,?,?,?,?,?)');
        for (const u of data.usuarios) {
          if (u.id === req.usuario.id) continue;
          if (!u.password) continue;
          insUser.run(u.id, u.nombre, u.email, u.password, u.rol, u.sede || 'Principal', u.activo ?? 1, u.cambio_password ?? 0, u.creado);
        }
      }
    })();

    res.json({ ok: true, mensaje: 'Restauración completada correctamente' });
  } catch (e) {
    console.error('Error restauración:', e);
    res.status(500).json({ error: 'Error restaurando: ' + e.message });
  }
});

router.post('/alerta', soloAdmin, async (req, res) => {
  const { error, detalle } = req.body;
  const fecha = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  try {
    await enviarCorreo(
      getAdminEmail() || req.usuario.email,
      `⚠ Error en Backup Automático — HorasExtra ${fecha}`,
      `Hola,\n\nEl backup automático programado de HorasExtra falló el ${fecha}.\n\nError:\n${error || 'Error desconocido'}\n\nDetalle:\n${detalle || 'Sin detalle adicional'}\n\nPor favor revisa el log en el servidor.\n\nSaludos,\nSistema Horix`
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo enviar el correo: ' + e.message });
  }
});

router.get('/lista', soloAdmin, (req, res) => {
  const dir = getBackupDir();
  if (!dir || !fs.existsSync(dir)) return res.json([]);
  try {
    const archivos = fs.readdirSync(dir)
      .filter(f => f.startsWith('horix_backup_') && f.endsWith('.zip'))
      .map(f => {
        const fullPath = path.join(dir, f);
        const stat = fs.statSync(fullPath);
        return { nombre: f, tamaño: stat.size, fecha: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
      .slice(0, 7);
    res.json(archivos);
  } catch (e) {
    res.status(500).json({ error: 'Error listando backups: ' + e.message });
  }
});

router.get('/descargar/:filename', soloAdmin, (req, res) => {
  const { filename } = req.params;
  if (!/^horix_backup_[\w\-]+\.zip$/.test(filename)) {
    return res.status(400).json({ error: 'Nombre de archivo inválido' });
  }
  const dir = getBackupDir();
  if (!dir) return res.status(404).json({ error: 'Directorio de backups no encontrado' });
  const fullPath = path.join(dir, filename);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.download(fullPath, filename);
});

router.post('/restore/local/:filename', soloAdmin, (req, res) => {
  const { filename } = req.params;
  if (!/^horix_backup_[\w\-]+\.zip$/.test(filename)) {
    return res.status(400).json({ error: 'Nombre de archivo inválido' });
  }
  const dir = getBackupDir();
  if (!dir) return res.status(404).json({ error: 'Directorio de backups no encontrado' });
  const fullPath = path.join(dir, filename);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Archivo no encontrado' });

  try {
    const zip = new AdmZip(fullPath);
    const entry = zip.getEntry('backup.json');
    if (!entry) return res.status(400).json({ error: 'El ZIP no contiene backup.json' });
    const data = JSON.parse(entry.getData().toString('utf8'));

    const db = getDb();
    db.transaction(() => {
      if (data.configuracion) {
        for (const [clave, valor] of Object.entries(data.configuracion)) {
          const stored = clave === 'smtp_password' ? encryptSmtp(valor) : valor;
          db.prepare('INSERT OR REPLACE INTO configuracion VALUES (?,?)').run(clave, stored);
        }
      }
      if (data.empleados?.length) {
        db.prepare('DELETE FROM empleados').run();
        const ins = db.prepare('INSERT OR REPLACE INTO empleados (id,nombre,cedula,cargo,departamento,sede,email,telefono) VALUES (?,?,?,?,?,?,?,?)');
        for (const e of data.empleados) ins.run(e.id, e.nombre, e.cedula, e.cargo, e.departamento, e.sede || 'Principal', e.email || '', e.telefono || '');
      }
      if (data.nominas?.length) {
        db.prepare('DELETE FROM nominas').run();
        const ins = db.prepare('INSERT OR REPLACE INTO nominas VALUES (?,?,?,?,?)');
        for (const n of data.nominas) ins.run(n.id, n.nombre, n.tipo, n.inicio, n.fin);
      }
      if (data.registros?.length) {
        db.prepare('DELETE FROM registros').run();
        const ins = db.prepare('INSERT OR REPLACE INTO registros (id,empleadoId,nominaId,fecha,horas,tipo,aprobador,motivo,creado,concepto,sede,creadoPor,observaciones,transporte) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const r of data.registros) ins.run(r.id, r.empleadoId, r.nominaId, r.fecha, r.horas, r.tipo, r.aprobador, r.motivo, r.creado, r.concepto || '', r.sede || 'Principal', r.creadoPor || '', r.observaciones || '', parseFloat(r.transporte || 0));
      }
      if (data.usuario_empleados?.length) {
        db.prepare('DELETE FROM usuario_empleados').run();
        const ins = db.prepare('INSERT OR IGNORE INTO usuario_empleados VALUES (?,?)');
        for (const r of data.usuario_empleados) ins.run(r.usuarioId, r.empleadoId);
      }
      if (data.usuarios?.length) {
        const insUser = db.prepare('INSERT OR REPLACE INTO usuarios (id,nombre,email,password,rol,sede,activo,cambio_password,creado) VALUES (?,?,?,?,?,?,?,?,?)');
        for (const u of data.usuarios) {
          if (u.id === req.usuario.id) continue;
          if (!u.password) continue;
          insUser.run(u.id, u.nombre, u.email, u.password, u.rol, u.sede || 'Principal', u.activo ?? 1, u.cambio_password ?? 0, u.creado);
        }
      }
    })();

    res.json({ ok: true, mensaje: 'Restauración completada correctamente' });
  } catch (e) {
    console.error('Error restauración local:', e);
    res.status(500).json({ error: 'Error restaurando: ' + e.message });
  }
});

module.exports = router;