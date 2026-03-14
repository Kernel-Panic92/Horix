const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const Database   = require('better-sqlite3');
const cors       = require('cors');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const multer     = require('multer');
const AdmZip     = require('adm-zip');
const bcrypt     = require('bcrypt');
const upload     = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const BCRYPT_ROUNDS = 12;
const AES_KEY = crypto.scryptSync(process.env.HE_SECRET || 'horasextra_aes_key_default_2025', 'he_salt_aes', 32);
const app = express();
const db  = new Database('horas_extra.db');
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─────────────────────────────────────────────
// TABLAS
// ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id        TEXT PRIMARY KEY,
    nombre    TEXT NOT NULL,
    email     TEXT NOT NULL UNIQUE,
    password  TEXT NOT NULL,
    rol       TEXT NOT NULL DEFAULT 'consulta',
    sede      TEXT NOT NULL DEFAULT 'Principal',
    activo    INTEGER NOT NULL DEFAULT 1,
    creado    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sesiones (
    token     TEXT PRIMARY KEY,
    usuarioId TEXT NOT NULL,
    expira    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tokens_reset (
    token     TEXT PRIMARY KEY,
    usuarioId TEXT NOT NULL,
    expira    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS configuracion (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS empleados (
    id            TEXT PRIMARY KEY,
    nombre        TEXT NOT NULL,
    cedula        TEXT NOT NULL,
    cargo         TEXT NOT NULL,
    departamento  TEXT NOT NULL,
    sede          TEXT NOT NULL DEFAULT 'Principal',
    email         TEXT,
    telefono      TEXT
  );
  CREATE TABLE IF NOT EXISTS nominas (
    id      TEXT PRIMARY KEY,
    nombre  TEXT NOT NULL,
    tipo    TEXT NOT NULL,
    inicio  TEXT NOT NULL,
    fin     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS registros (
    id            TEXT PRIMARY KEY,
    empleadoId    TEXT NOT NULL,
    nominaId      TEXT NOT NULL,
    fecha         TEXT NOT NULL,
    horas         REAL NOT NULL,
    tipo          TEXT NOT NULL,
    aprobador     TEXT NOT NULL,
    motivo        TEXT NOT NULL,
    creado        TEXT NOT NULL,
    concepto      TEXT NOT NULL DEFAULT '',
    observaciones TEXT NOT NULL DEFAULT '',
    transporte    REAL NOT NULL DEFAULT 0,
    sede          TEXT NOT NULL DEFAULT 'Principal'
  );
  CREATE TABLE IF NOT EXISTS usuario_empleados (
    usuarioId  TEXT NOT NULL,
    empleadoId TEXT NOT NULL,
    PRIMARY KEY (usuarioId, empleadoId)
  );
  CREATE TABLE IF NOT EXISTS centros (
    id      TEXT PRIMARY KEY,
    nombre  TEXT NOT NULL UNIQUE,
    activo  INTEGER NOT NULL DEFAULT 1,
    creado  TEXT NOT NULL
  );
`);

// ─────────────────────────────────────────────
// MIGRACIONES
// ─────────────────────────────────────────────
try { db.exec(`ALTER TABLE registros  ADD COLUMN concepto TEXT NOT NULL DEFAULT ''`);  } catch {}
try { db.exec(`ALTER TABLE registros  ADD COLUMN creadoPor TEXT NOT NULL DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE registros  ADD COLUMN sede TEXT NOT NULL DEFAULT 'Principal'`); } catch {}
try { db.exec(`ALTER TABLE registros  ADD COLUMN observaciones TEXT NOT NULL DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE registros  ADD COLUMN transporte REAL NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE empleados  ADD COLUMN sede TEXT NOT NULL DEFAULT 'Principal'`); } catch {}
try { db.exec(`ALTER TABLE usuarios   ADD COLUMN sede TEXT NOT NULL DEFAULT 'Principal'`); } catch {}
try { db.exec(`ALTER TABLE usuarios   ADD COLUMN cambio_password INTEGER NOT NULL DEFAULT 0`); } catch {}

// SMTP defaults
const smtpDefaults = {
  smtp_host:      '',
  smtp_puerto:    '587',
  smtp_tls:       'true',
  smtp_usuario:   '',
  smtp_password:  '',
  smtp_remitente: 'Horix RRHH <noreply@tuempresa.com>',
  reset_asunto:   'Recuperación de contraseña — Horix',
  reset_cuerpo:   'Hola {nombre},\n\nRecibimos una solicitud para restablecer tu contraseña.\n\nHaz clic en el siguiente enlace (válido por 30 minutos):\n{enlace}\n\nSi no solicitaste esto, ignora este correo.\n\nSaludos,\nEquipo RRHH'
};
for (const [clave, valor] of Object.entries(smtpDefaults)) {
  const existe = db.prepare('SELECT clave FROM configuracion WHERE clave = ?').get(clave);
  if (!existe) db.prepare('INSERT INTO configuracion VALUES (?,?)').run(clave, valor);
}

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
async function hashPassword(p) {
  return bcrypt.hash(p, BCRYPT_ROUNDS);
}
async function verificarPassword(plain, hash) {
  if (hash.length === 64 && !hash.startsWith('$2')) {
    const legacyHash = crypto.createHash('sha256').update(plain + 'horasextra_salt_2025').digest('hex');
    if (legacyHash === hash) return { ok: true, migrar: true };
    return { ok: false };
  }
  return { ok: await bcrypt.compare(plain, hash), migrar: false };
}
function encryptSmtp(text) {
  if (!text) return '';
  const iv        = crypto.randomBytes(16);
  const cipher    = crypto.createCipheriv('aes-256-gcm', AES_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  return 'aes:' + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}
function decryptSmtp(stored) {
  if (!stored || !stored.startsWith('aes:')) return stored;
  try {
    const [, ivHex, tagHex, encHex] = stored.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', AES_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8');
  } catch { return ''; }
}
function validarPassword(p) {
  const errores = [];
  if (!p || p.length < 8)              errores.push('Mínimo 8 caracteres');
  if (!/[A-Z]/.test(p))                errores.push('Al menos una mayúscula');
  if (!/[0-9]/.test(p))                errores.push('Al menos un número');
  if (!/[!@#$%^&*(),.?":{}|<>_\-+=/\\[\]~`]/.test(p)) errores.push('Al menos un carácter especial');
  return errores;
}
function generateToken() {
  return crypto.randomBytes(48).toString('hex');
}
function getConfig() {
  const rows = db.prepare('SELECT clave, valor FROM configuracion').all();
  const cfg  = Object.fromEntries(rows.map(r => [r.clave, r.valor]));
  if (cfg.smtp_password) cfg.smtp_password = decryptSmtp(cfg.smtp_password);
  return cfg;
}
function getBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}
function getAdminEmail() {
  const admin = db.prepare("SELECT email FROM usuarios WHERE rol='admin' AND activo=1 ORDER BY creado ASC LIMIT 1").get();
  return admin ? admin.email : null;
}
async function enviarCorreo(para, asunto, cuerpo) {
  const cfg = getConfig();
  const transporter = nodemailer.createTransport({
    host:       cfg.smtp_host,
    port:       parseInt(cfg.smtp_puerto),
    secure:     cfg.smtp_puerto === '465',
    requireTLS: cfg.smtp_tls === 'true',
    auth:       { user: cfg.smtp_usuario, pass: cfg.smtp_password },
    tls:        { rejectUnauthorized: false }
  });
  await transporter.sendMail({ from: cfg.smtp_remitente, to: para, subject: asunto, text: cuerpo });
}

// Migrar smtp_password a AES si está en texto plano
{
  const row = db.prepare("SELECT valor FROM configuracion WHERE clave='smtp_password'").get();
  if (row && row.valor && !row.valor.startsWith('aes:')) {
    const encrypted = encryptSmtp(row.valor);
    db.prepare("UPDATE configuracion SET valor=? WHERE clave='smtp_password'").run(encrypted);
    console.log('🔐 smtp_password migrado a AES-256-GCM');
  }
}

// Centros y admin por defecto
(async () => {
  const totalCentros = db.prepare('SELECT COUNT(*) as n FROM centros').get().n;
  if (totalCentros === 0) {
    db.prepare('INSERT INTO centros (id,nombre,activo,creado) VALUES (?,?,1,?)').run(uid(), 'Principal', new Date().toISOString());
    console.log('🏢 Centro de operación inicial creado: Principal');
  }
  const totalUsuarios = db.prepare('SELECT COUNT(*) as c FROM usuarios').get();
  if (totalUsuarios.c === 0) {
    const primerCentro = db.prepare('SELECT nombre FROM centros LIMIT 1').get()?.nombre || 'Principal';
    db.prepare('INSERT INTO usuarios (id,nombre,email,password,rol,sede,activo,creado) VALUES (?,?,?,?,?,?,?,?)').run(
      uid(), 'Administrador', 'admin@empresa.com',
      await hashPassword('Admin2025!'), 'admin', primerCentro, 1, new Date().toISOString()
    );
    console.log('👤 Usuario admin creado: admin@empresa.com / Admin2025!');
  }
})();

// ─────────────────────────────────────────────
// RATE LIMITING — protección fuerza bruta login
// ─────────────────────────────────────────────
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS    = 5 * 60 * 1000;
const LOGIN_BLOCK_MS     = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of loginAttempts.entries()) {
    if (data.blockedUntil && now > data.blockedUntil) loginAttempts.delete(ip);
    else if (now - data.firstAttempt > LOGIN_WINDOW_MS) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000);

function getRealIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.headers['x-real-ip']
      || req.socket.remoteAddress
      || 'unknown';
}
function loginRateLimit(req, res, next) {
  const ip  = getRealIp(req);
  const now = Date.now();
  let data  = loginAttempts.get(ip) || { count: 0, firstAttempt: now, blockedUntil: null };
  if (data.blockedUntil && now < data.blockedUntil) {
    const mins = Math.ceil((data.blockedUntil - now) / 60000);
    return res.status(429).json({ error: `Demasiados intentos fallidos. Intenta de nuevo en ${mins} minuto${mins !== 1 ? 's' : ''}.` });
  }
  if (now - data.firstAttempt > LOGIN_WINDOW_MS) {
    data = { count: 0, firstAttempt: now, blockedUntil: null };
  }
  loginAttempts.set(ip, data);
  req._loginIp = ip;
  next();
}
function loginRegisterFail(ip) {
  const now  = Date.now();
  const data = loginAttempts.get(ip) || { count: 0, firstAttempt: now, blockedUntil: null };
  data.count++;
  if (data.count >= LOGIN_MAX_ATTEMPTS) {
    data.blockedUntil = now + LOGIN_BLOCK_MS;
    console.warn(`🔒 IP bloqueada por fuerza bruta: ${ip} (${data.count} intentos)`);
  }
  loginAttempts.set(ip, data);
}
function loginRegisterSuccess(ip) {
  loginAttempts.delete(ip);
}

// ─────────────────────────────────────────────
// MIDDLEWARE AUTH
// ─────────────────────────────────────────────
function autenticar(rolesPermitidos = []) {
  return (req, res, next) => {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No autenticado' });
    const sesion = db.prepare('SELECT * FROM sesiones WHERE token = ?').get(token);
    if (!sesion || new Date(sesion.expira) < new Date()) {
      if (sesion) db.prepare('DELETE FROM sesiones WHERE token = ?').run(token);
      return res.status(401).json({ error: 'Sesión expirada' });
    }
    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ? AND activo = 1').get(sesion.usuarioId);
    if (!usuario) return res.status(401).json({ error: 'Usuario inactivo' });
    if (rolesPermitidos.length && !rolesPermitidos.includes(usuario.rol))
      return res.status(403).json({ error: 'Sin permisos para esta acción' });
    req.usuario = usuario;
    next();
  };
}
const soloAdmin      = autenticar(['admin']);
const adminRrhh      = autenticar(['admin', 'rrhh']);
const adminRrhhOp    = autenticar(['admin', 'rrhh', 'operador']);
const todosRoles     = autenticar(['admin', 'rrhh', 'consulta', 'operador']);

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────
app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Campos requeridos' });
  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ? AND activo = 1').get(email.toLowerCase().trim());
  if (!usuario) { loginRegisterFail(req._loginIp); return res.status(401).json({ error: 'Correo o contraseña incorrectos' }); }
  const check = await verificarPassword(password, usuario.password);
  if (!check.ok) { loginRegisterFail(req._loginIp); return res.status(401).json({ error: 'Correo o contraseña incorrectos' }); }
  if (check.migrar) {
    const newHash = await hashPassword(password);
    db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(newHash, usuario.id);
    console.log(`🔄 Contraseña migrada a bcrypt: ${usuario.email}`);
  }
  db.prepare('DELETE FROM sesiones WHERE usuarioId = ?').run(usuario.id);
  const token  = generateToken();
  const expira = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sesiones VALUES (?,?,?)').run(token, usuario.id, expira);
  loginRegisterSuccess(req._loginIp);
  res.json({ token, usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol, sede: usuario.sede, cambio_password: usuario.cambio_password||0 } });
});
app.post('/api/auth/logout', todosRoles, (req, res) => {
  db.prepare('DELETE FROM sesiones WHERE token = ?').run(req.headers['authorization']?.replace('Bearer ', ''));
  res.json({ ok: true });
});
app.get('/api/auth/me', todosRoles, (req, res) => {
  const u = req.usuario;
  res.json({ id: u.id, nombre: u.nombre, email: u.email, rol: u.rol, sede: u.sede, cambio_password: u.cambio_password||0 });
});

// ─────────────────────────────────────────────
// RECUPERACIÓN DE CONTRASEÑA
// ─────────────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Correo requerido' });
  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ? AND activo = 1').get(email.toLowerCase().trim());
  if (!usuario) return res.json({ ok: true });
  db.prepare('DELETE FROM tokens_reset WHERE usuarioId = ?').run(usuario.id);
  const token  = generateToken();
  const expira = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO tokens_reset VALUES (?,?,?)').run(token, usuario.id, expira);
  const cfg    = getConfig();
  const enlace = `${getBaseUrl(req)}/reset-password.html?token=${token}`;
  const cuerpo = cfg.reset_cuerpo.replace('{nombre}', usuario.nombre).replace('{enlace}', enlace);
  try {
    await enviarCorreo(usuario.email, cfg.reset_asunto, cuerpo);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error SMTP:', e.message);
    res.status(500).json({ error: 'No se pudo enviar el correo. Verifica la configuración SMTP.' });
  }
});
app.post('/api/auth/cambio-forzado', todosRoles, async (req, res) => {
  const { password } = req.body;
  const errores = validarPassword(password);
  if (errores.length) return res.status(400).json({ error: errores.join(', ') });
  const pwHashF = await hashPassword(password);
  db.prepare('UPDATE usuarios SET password = ?, cambio_password = 0 WHERE id = ?').run(pwHashF, req.usuario.id);
  db.prepare('DELETE FROM sesiones WHERE usuarioId = ? AND token != ?')
    .run(req.usuario.id, req.headers['authorization']?.replace('Bearer ', ''));
  res.json({ ok: true });
});
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Datos incompletos' });
  const errPassR = validarPassword(password);
  if (errPassR.length) return res.status(400).json({ error: 'Contraseña inválida: ' + errPassR.join(', ') });
  const registro = db.prepare('SELECT * FROM tokens_reset WHERE token = ?').get(token);
  if (!registro || new Date(registro.expira) < new Date()) {
    if (registro) db.prepare('DELETE FROM tokens_reset WHERE token = ?').run(token);
    return res.status(400).json({ error: 'El enlace es inválido o ya expiró' });
  }
  const pwHashR = await hashPassword(password);
  db.prepare('UPDATE usuarios SET password = ?, cambio_password = 0 WHERE id = ?').run(pwHashR, registro.usuarioId);
  db.prepare('DELETE FROM tokens_reset WHERE token = ?').run(token);
  db.prepare('DELETE FROM sesiones WHERE usuarioId = ?').run(registro.usuarioId);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// CONFIGURACIÓN SMTP
// ─────────────────────────────────────────────
app.get('/api/configuracion', soloAdmin, (req, res) => {
  const cfg = getConfig();
  res.json({ ...cfg, smtp_password: cfg.smtp_password ? '••••••••' : '' });
});
app.put('/api/configuracion', soloAdmin, (req, res) => {
  const campos = ['smtp_host','smtp_puerto','smtp_tls','smtp_usuario','smtp_password','smtp_remitente','reset_asunto','reset_cuerpo'];
  for (const campo of campos) {
    if (req.body[campo] !== undefined) {
      if (campo === 'smtp_password' && req.body[campo].includes('•')) continue;
      const valor = campo === 'smtp_password' ? encryptSmtp(req.body[campo]) : req.body[campo];
      db.prepare('INSERT OR REPLACE INTO configuracion VALUES (?,?)').run(campo, valor);
    }
  }
  res.json({ ok: true });
});
app.post('/api/configuracion/test', soloAdmin, async (req, res) => {
  try {
    await enviarCorreo(req.usuario.email, 'Prueba SMTP — Horix',
      `Hola ${req.usuario.nombre},\n\nEsta es una prueba de conexión SMTP desde Horix.\n\nSi recibes este mensaje, la configuración es correcta ✓\n\nSaludos,\nEquipo RRHH`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// CENTROS DE OPERACIÓN
// ─────────────────────────────────────────────
app.get('/api/centros', todosRoles, (req, res) => {
  res.json(db.prepare('SELECT * FROM centros ORDER BY nombre ASC').all());
});
app.post('/api/centros', adminRrhh, (req, res) => {
  const { nombre } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  const existe = db.prepare('SELECT id FROM centros WHERE nombre = ?').get(nombre.trim());
  if (existe) return res.status(400).json({ error: 'Ya existe un centro con ese nombre' });
  const id = uid();
  db.prepare('INSERT INTO centros (id,nombre,activo,creado) VALUES (?,?,1,?)').run(id, nombre.trim(), new Date().toISOString());
  res.json(db.prepare('SELECT * FROM centros WHERE id=?').get(id));
});
app.put('/api/centros/:id', adminRrhh, (req, res) => {
  const { nombre, activo } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  const existe = db.prepare('SELECT id FROM centros WHERE nombre = ? AND id != ?').get(nombre.trim(), req.params.id);
  if (existe) return res.status(400).json({ error: 'Ya existe un centro con ese nombre' });
  db.prepare('UPDATE centros SET nombre=?, activo=? WHERE id=?').run(nombre.trim(), activo?1:0, req.params.id);
  res.json(db.prepare('SELECT * FROM centros WHERE id=?').get(req.params.id));
});
app.delete('/api/centros/:id', soloAdmin, (req, res) => {
  const enUso = db.prepare("SELECT COUNT(*) as n FROM empleados WHERE sede=(SELECT nombre FROM centros WHERE id=?)").get(req.params.id);
  if (enUso?.n > 0) return res.status(400).json({ error: 'No se puede eliminar: hay empleados asignados a este centro' });
  db.prepare('DELETE FROM centros WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.get('/api/sedes', todosRoles, (req, res) => {
  res.json(db.prepare("SELECT nombre FROM centros WHERE activo=1 ORDER BY nombre ASC").all().map(c => c.nombre));
});

// ─────────────────────────────────────────────
// USUARIOS
// ─────────────────────────────────────────────
app.get('/api/usuarios', soloAdmin, (req, res) =>
  res.json(db.prepare('SELECT id, nombre, email, rol, sede, activo, cambio_password, creado FROM usuarios ORDER BY creado DESC').all()));
app.post('/api/usuarios', soloAdmin, async (req, res) => {
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
app.get('/api/usuario_empleados/:id', soloAdmin, (req, res) => {
  const rows = db.prepare('SELECT empleadoId FROM usuario_empleados WHERE usuarioId = ?').all(req.params.id);
  res.json(rows.map(r => r.empleadoId));
});
app.put('/api/usuario_empleados/:id', soloAdmin, (req, res) => {
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
app.put('/api/usuarios/:id', soloAdmin, async (req, res) => {
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
      .run(nombre.trim(), email.toLowerCase().trim(), rol, sede, activo?1:0, pwHashU, req.params.id);
  } else {
    db.prepare('UPDATE usuarios SET nombre=?,email=?,rol=?,sede=?,activo=? WHERE id=?')
      .run(nombre.trim(), email.toLowerCase().trim(), rol, sede, activo?1:0, req.params.id);
  }
  res.json({ ok: true });
});
app.post('/api/usuarios/:id/forzar-cambio', soloAdmin, (req, res) => {
  if (req.params.id === req.usuario.id) return res.status(400).json({ error: 'No puedes forzar el cambio a tu propio usuario' });
  db.prepare('UPDATE usuarios SET cambio_password = 1 WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM sesiones WHERE usuarioId = ?').run(req.params.id);
  res.json({ ok: true });
});
app.delete('/api/usuarios/:id', soloAdmin, (req, res) => {
  if (req.params.id === req.usuario.id) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
  db.prepare('DELETE FROM sesiones WHERE usuarioId = ?').run(req.params.id);
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// EMPLEADOS
// ─────────────────────────────────────────────
app.get('/api/empleados', todosRoles, (req, res) => {
  const u = req.usuario;
  const asignados = db.prepare('SELECT empleadoId FROM usuario_empleados WHERE usuarioId = ?')
    .all(u.id).map(r => r.empleadoId);
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
app.post('/api/empleados', adminRrhh, (req, res) => {
  const { nombre, cedula, cargo, departamento, sede, email, telefono } = req.body;
  const centroValido = db.prepare('SELECT id FROM centros WHERE nombre=? AND activo=1').get(sede);
  if (!centroValido) return res.status(400).json({ error: 'Centro de operación inválido' });
  const id = uid();
  db.prepare('INSERT INTO empleados (id,nombre,cedula,cargo,departamento,sede,email,telefono) VALUES (?,?,?,?,?,?,?,?)').run(
    id, nombre, cedula, cargo, departamento, sede, email||'', telefono||''
  );
  res.json({ id });
});
app.put('/api/empleados/:id', adminRrhh, (req, res) => {
  const { nombre, cedula, cargo, departamento, sede, email, telefono } = req.body;
  const centroValido = db.prepare('SELECT id FROM centros WHERE nombre=? AND activo=1').get(sede);
  if (!centroValido) return res.status(400).json({ error: 'Centro de operación inválido' });
  db.prepare('UPDATE empleados SET nombre=?,cedula=?,cargo=?,departamento=?,sede=?,email=?,telefono=? WHERE id=?')
    .run(nombre, cedula, cargo, departamento, sede, email||'', telefono||'', req.params.id);
  res.json({ ok: true });
});
app.delete('/api/empleados/:id', soloAdmin, (req, res) => {
  db.prepare('DELETE FROM registros WHERE empleadoId=?').run(req.params.id);
  db.prepare('DELETE FROM empleados WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// NÓMINAS
// ─────────────────────────────────────────────
app.get('/api/nominas', todosRoles, (req, res) =>
  res.json(db.prepare('SELECT * FROM nominas ORDER BY inicio DESC').all()));
app.post('/api/nominas', adminRrhh, (req, res) => {
  const { nombre, tipo, inicio, fin } = req.body;
  const id = uid();
  db.prepare('INSERT INTO nominas VALUES (?,?,?,?,?)').run(id, nombre, tipo, inicio, fin);
  res.json({ id });
});
app.delete('/api/nominas/:id', soloAdmin, (req, res) => {
  db.prepare('DELETE FROM nominas WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// REGISTROS
// ─────────────────────────────────────────────
app.get('/api/registros', todosRoles, (req, res) => {
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
    return res.json(db.prepare(base + `
      JOIN empleados e ON r.empleadoId = e.id
      WHERE e.sede = ? ORDER BY r.fecha DESC
    `).all(req.query.sede));
  }
  res.json(db.prepare(base + ' ORDER BY r.fecha DESC').all());
});
app.post('/api/registros', adminRrhhOp, (req, res) => {
  const { empleadoId, nominaId, fecha, horas, tipo, concepto, aprobador, motivo, observaciones, transporte } = req.body;
  const u = req.usuario;
  if (u.rol !== 'admin') {
    const asignados = db.prepare('SELECT empleadoId FROM usuario_empleados WHERE usuarioId = ?').all(u.id).map(r => r.empleadoId);
    if (asignados.length > 0 && !asignados.includes(empleadoId)) {
      return res.status(403).json({ error: 'No tienes permiso para registrar horas a este empleado.' });
    }
  }
  const emp  = db.prepare('SELECT sede FROM empleados WHERE id = ?').get(empleadoId);
  const sede = emp ? emp.sede : 'Principal';
  const id   = uid();
  db.prepare('INSERT INTO registros (id,empleadoId,nominaId,fecha,horas,tipo,aprobador,motivo,creado,concepto,sede,creadoPor,observaciones,transporte) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, empleadoId, nominaId, fecha, horas, tipo, aprobador, motivo, new Date().toISOString(), concepto||'', sede, req.usuario.id, observaciones||'', parseFloat(transporte||0));
  res.json({ id });
});
app.delete('/api/registros/:id', soloAdmin, (req, res) => {
  db.prepare('DELETE FROM registros WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// BACKUP & RESTAURACIÓN
// ─────────────────────────────────────────────
app.get('/api/backup', soloAdmin, (req, res) => {
  try {
    const cfg = getConfig();
    const data = {
      version:   '1.0',
      generado:  new Date().toISOString(),
      app:       'HorasExtra',
      configuracion: cfg,
      usuarios:  db.prepare('SELECT id,nombre,email,password,rol,sede,activo,cambio_password,creado FROM usuarios').all(),
      empleados: db.prepare('SELECT * FROM empleados').all(),
      nominas:   db.prepare('SELECT * FROM nominas').all(),
      registros: db.prepare('SELECT * FROM registros').all(),
      usuario_empleados: db.prepare('SELECT * FROM usuario_empleados').all(),
    };
    function toCSV(rows) {
      if (!rows.length) return '';
      const cols = Object.keys(rows[0]);
      const esc  = v => `"${String(v??'').replace(/"/g,'""')}"`;
      return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
    }
    const zip = new AdmZip();
    zip.addFile('backup.json', Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
    zip.addFile('empleados.csv',  Buffer.from(toCSV(data.empleados),  'utf8'));
    zip.addFile('nominas.csv',    Buffer.from(toCSV(data.nominas),    'utf8'));
    zip.addFile('registros.csv',  Buffer.from(toCSV(data.registros),  'utf8'));
    zip.addFile('usuarios.csv',   Buffer.from(toCSV(data.usuarios),   'utf8'));
    const fecha    = new Date().toISOString().slice(0,10);
    const filename = `horasextra_backup_${fecha}.zip`;
    const buffer   = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  } catch (e) {
    console.error('Error backup:', e);
    res.status(500).json({ error: 'Error generando backup: ' + e.message });
  }
});

app.post('/api/restore', soloAdmin, upload.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
  try {
    let data;
    if (req.file.originalname.endsWith('.zip')) {
      const zip   = new AdmZip(req.file.buffer);
      const entry = zip.getEntry('backup.json');
      if (!entry) return res.status(400).json({ error: 'El ZIP no contiene backup.json' });
      data = JSON.parse(entry.getData().toString('utf8'));
    } else {
      data = JSON.parse(req.file.buffer.toString('utf8'));
    }
    if (data.app !== 'HorasExtra') return res.status(400).json({ error: 'Archivo de backup inválido' });
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
        for (const e of data.empleados) ins.run(e.id,e.nombre,e.cedula,e.cargo,e.departamento,e.sede||'Principal',e.email||'',e.telefono||'');
      }
      if (data.nominas?.length) {
        db.prepare('DELETE FROM nominas').run();
        const ins = db.prepare('INSERT OR REPLACE INTO nominas VALUES (?,?,?,?,?)');
        for (const n of data.nominas) ins.run(n.id,n.nombre,n.tipo,n.inicio,n.fin);
      }
      if (data.registros?.length) {
        db.prepare('DELETE FROM registros').run();
        const ins = db.prepare('INSERT OR REPLACE INTO registros (id,empleadoId,nominaId,fecha,horas,tipo,aprobador,motivo,creado,concepto,sede,creadoPor,observaciones,transporte) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const r of data.registros) ins.run(r.id,r.empleadoId,r.nominaId,r.fecha,r.horas,r.tipo,r.aprobador,r.motivo,r.creado,r.concepto||'',r.sede||'Principal',r.creadoPor||'',r.observaciones||'',parseFloat(r.transporte||0));
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
          if (!u.password) { console.warn('Restore: usuario sin password omitido:', u.email); continue; }
          insUser.run(u.id, u.nombre, u.email, u.password, u.rol, u.sede||'Principal', u.activo??1, u.cambio_password??0, u.creado);
        }
      }
    })();
    res.json({ ok: true, mensaje: 'Restauración completada correctamente' });
  } catch (e) {
    console.error('Error restauración:', e);
    res.status(500).json({ error: 'Error restaurando: ' + e.message });
  }
});

// ─────────────────────────────────────────────
// ALERTA DE BACKUP
// ─────────────────────────────────────────────
app.post('/api/backup/alerta', soloAdmin, async (req, res) => {
  const { error, detalle } = req.body;
  const fecha = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  try {
    const adminEmail = getAdminEmail();
    if (!adminEmail) throw new Error('No hay admin activo para enviar la alerta');
    await enviarCorreo(
      adminEmail,
      `⚠ Error en Backup Automático — Horix ${fecha}`,
      `Hola,\n\nEl backup automático de Horix falló el ${fecha}.\n\nError:\n${error || 'Error desconocido'}\n\nDetalle:\n${detalle || 'Sin detalle adicional'}\n\nRevisa el log:\n  cat /var/log/backup_horix.log\n\nSaludos,\nSistema Horix`
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'No se pudo enviar el correo: ' + e.message });
  }
});

// ─────────────────────────────────────────────
// BACKUPS AUTOMÁTICOS — lista y descarga
// ─────────────────────────────────────────────
function getBackupDir() {
  const candidatos = ['last_backup.json', '.ultimo_backup.json'].map(f => path.join(__dirname, f));
  for (const infoFile of candidatos) {
    try {
      if (!fs.existsSync(infoFile)) continue;
      const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
      if (info.archivo) {
        const posibleDir = path.join(require('os').homedir(), 'backups', 'horix');
        if (fs.existsSync(posibleDir)) return posibleDir;
      }
    } catch {}
  }
  const fallback = path.join(require('os').homedir(), 'backups', 'horix');
  return fs.existsSync(fallback) ? fallback : null;
}
app.get('/api/backup/lista', soloAdmin, (req, res) => {
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
app.get('/api/backup/descargar/:filename', soloAdmin, (req, res) => {
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
app.post('/api/restore/local/:filename', soloAdmin, (req, res) => {
  const { filename } = req.params;
  if (!/^horix_backup_[\w\-]+\.zip$/.test(filename)) {
    return res.status(400).json({ error: 'Nombre de archivo inválido' });
  }
  const dir = getBackupDir();
  if (!dir) return res.status(404).json({ error: 'Directorio de backups no encontrado' });
  const fullPath = path.join(dir, filename);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Archivo no encontrado' });
  try {
    const zip   = new AdmZip(fullPath);
    const entry = zip.getEntry('backup.json');
    if (!entry) return res.status(400).json({ error: 'El ZIP no contiene backup.json' });
    const data = JSON.parse(entry.getData().toString('utf8'));
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
        for (const e of data.empleados) ins.run(e.id,e.nombre,e.cedula,e.cargo,e.departamento,e.sede||'Principal',e.email||'',e.telefono||'');
      }
      if (data.nominas?.length) {
        db.prepare('DELETE FROM nominas').run();
        const ins = db.prepare('INSERT OR REPLACE INTO nominas VALUES (?,?,?,?,?)');
        for (const n of data.nominas) ins.run(n.id,n.nombre,n.tipo,n.inicio,n.fin);
      }
      if (data.registros?.length) {
        db.prepare('DELETE FROM registros').run();
        const ins = db.prepare('INSERT OR REPLACE INTO registros (id,empleadoId,nominaId,fecha,horas,tipo,aprobador,motivo,creado,concepto,sede,creadoPor,observaciones,transporte) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const r of data.registros) ins.run(r.id,r.empleadoId,r.nominaId,r.fecha,r.horas,r.tipo,r.aprobador,r.motivo,r.creado,r.concepto||'',r.sede||'Principal',r.creadoPor||'',r.observaciones||'',parseFloat(r.transporte||0));
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
          insUser.run(u.id,u.nombre,u.email,u.password,u.rol,u.sede||'Principal',u.activo??1,u.cambio_password??0,u.creado);
        }
      }
    })();
    res.json({ ok: true, mensaje: 'Restauración completada correctamente' });
  } catch (e) {
    console.error('Error restauración local:', e);
    res.status(500).json({ error: 'Error restaurando: ' + e.message });
  }
});
app.get('/api/backup/ultimo', soloAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  const candidatos = ['last_backup.json', '.ultimo_backup.json'].map(f => path.join(__dirname, f));
  for (const infoFile of candidatos) {
    try {
      if (!fs.existsSync(infoFile)) continue;
      const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
      return res.json(info);
    } catch {}
  }
  res.json(null);
});

// ─────────────────────────────────────────────
// LOGO PERSONALIZADO
// ─────────────────────────────────────────────
const LOGO_PATH = path.join(__dirname, 'public', 'logo_empresa');
app.get('/logo', (req, res) => {
  const exts = ['.png', '.jpg', '.jpeg', '.svg', '.webp'];
  for (const ext of exts) {
    const p = LOGO_PATH + ext;
    if (fs.existsSync(p)) {
      const mime = ext === '.svg' ? 'image/svg+xml'
                 : ext === '.webp' ? 'image/webp'
                 : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                 : 'image/png';
      return res.set('Content-Type', mime).set('Cache-Control', 'no-store').sendFile(p);
    }
  }
  res.status(404).json({ error: 'Sin logo' });
});
app.post('/api/logo', soloAdmin, upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  const mime = req.file.mimetype;
  const ext  = mime === 'image/svg+xml' ? '.svg'
             : mime === 'image/webp'    ? '.webp'
             : mime === 'image/jpeg'    ? '.jpg'
             : '.png';
  ['.png','.jpg','.jpeg','.svg','.webp'].forEach(e => {
    const p = LOGO_PATH + e;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  fs.writeFileSync(LOGO_PATH + ext, req.file.buffer);
  res.json({ ok: true });
});
app.delete('/api/logo', soloAdmin, (req, res) => {
  ['.png','.jpg','.jpeg','.svg','.webp'].forEach(e => {
    const p = LOGO_PATH + e;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// INICIAR
// ─────────────────────────────────────────────
app.listen(3000, '0.0.0.0', () => {
  console.log('✅ Servidor corriendo en http://0.0.0.0:3000');
});
