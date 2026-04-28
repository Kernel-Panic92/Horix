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
require('dotenv').config();
const upload     = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const BCRYPT_ROUNDS = 12;
// Clave AES para cifrar smtp_password (32 bytes desde variable de entorno o fallback)
const AES_KEY = crypto.scryptSync(process.env.HE_SECRET || 'horasextra_aes_key_default_2025', 'he_salt_aes', 32);

const app = express();
const db  = new Database('horas_extra.db');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Centros de operación — gestionados dinámicamente en la BD

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
    id          TEXT PRIMARY KEY,
    empleadoId  TEXT NOT NULL,
    nominaId    TEXT NOT NULL,
    fecha       TEXT NOT NULL,
    horas       REAL NOT NULL,
    tipo        TEXT NOT NULL,
    aprobador   TEXT NOT NULL,
    motivo      TEXT NOT NULL,
    creado      TEXT NOT NULL,
    concepto    TEXT NOT NULL DEFAULT '',
    observaciones TEXT NOT NULL DEFAULT '',
    transporte    REAL NOT NULL DEFAULT 0,
    sede        TEXT NOT NULL DEFAULT 'Principal',
    estado      TEXT NOT NULL DEFAULT 'pendiente',
    aprobadoPor TEXT NOT NULL DEFAULT '',
    fechaAprobado TEXT NOT NULL DEFAULT ''
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
try { db.exec(`ALTER TABLE registros  ADD COLUMN estado TEXT NOT NULL DEFAULT 'pendiente'`); } catch {}
try { db.exec(`ALTER TABLE registros  ADD COLUMN aprobadoPor TEXT NOT NULL DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE registros  ADD COLUMN fechaAprobado TEXT NOT NULL DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE empleados  ADD COLUMN sede TEXT NOT NULL DEFAULT 'Principal'`); } catch {}
try { db.exec(`ALTER TABLE usuarios   ADD COLUMN sede TEXT NOT NULL DEFAULT 'Principal'`); } catch {}
try { db.exec(`ALTER TABLE usuarios   ADD COLUMN cambio_password INTEGER NOT NULL DEFAULT 0`); } catch {}

// Tabla de adjuntos por registro
db.exec(`
  CREATE TABLE IF NOT EXISTS adjuntos (
    id          TEXT PRIMARY KEY,
    registroId  TEXT NOT NULL,
    nombre      TEXT NOT NULL,
    mime        TEXT NOT NULL,
    tamano      INTEGER NOT NULL,
    datos       BLOB NOT NULL,
    subido      TEXT NOT NULL,
    subidoPor   TEXT NOT NULL,
    FOREIGN KEY (registroId) REFERENCES registros(id) ON DELETE CASCADE
  );
`);

// Directorio de adjuntos (almacenado en BD como BLOB, sin archivos físicos)
const ADJUNTOS_MAX_SIZE = 10 * 1024 * 1024; // 10 MB por archivo
const ADJUNTOS_TIPOS_PERMITIDOS = [
  'image/jpeg','image/png','image/gif','image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain','text/csv'
];
const uploadAdjunto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ADJUNTOS_MAX_SIZE },
  fileFilter: (req, file, cb) => {
    if (ADJUNTOS_TIPOS_PERMITIDOS.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de archivo no permitido'));
  }
});

// Configuración SMTP por defecto
const smtpDefaults = {
  smtp_host:      '',
  smtp_puerto:    '',
  smtp_tls:       '',
  smtp_usuario:   '',
  smtp_password:  '',
  smtp_remitente: 'Horix <mail@tuempresa.com>',
  reset_asunto:   'Recuperación de contraseña — Horix',
  reset_cuerpo:   'Hola {nombre},\n\nRecibimos una solicitud para restablecer tu contraseña.\n\nHaz clic en el siguiente enlace (válido por 30 minutos):\n{enlace}\n\nSi no solicitaste esto, ignora este correo.\n\nSaludos,\nEquipo Horix'
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
// Hash de contraseñas con bcrypt
async function hashPassword(p) {
  return bcrypt.hash(p, BCRYPT_ROUNDS);
}
async function verificarPassword(plain, hash) {
  // Soporte para hashes SHA-256 legacy durante migración
  if (hash.length === 64 && !hash.startsWith('$2')) {
    const legacyHash = crypto.createHash('sha256').update(plain + 'horasextra_salt_2025').digest('hex');
    if (legacyHash === hash) {
      // Migrar a bcrypt automáticamente en el login
      return { ok: true, migrar: true };
    }
    return { ok: false };
  }
  return { ok: await bcrypt.compare(plain, hash), migrar: false };
}

// Cifrado AES-256-GCM para smtp_password
function encryptSmtp(text) {
  if (!text) return '';
  const iv         = crypto.randomBytes(16);
  const cipher     = crypto.createCipheriv('aes-256-gcm', AES_KEY, iv);
  const encrypted  = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag    = cipher.getAuthTag();
  return 'aes:' + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}
function decryptSmtp(stored) {
  if (!stored || !stored.startsWith('aes:')) return stored; // legacy sin cifrar
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
function getAdminEmail() {
  const admin = db.prepare("SELECT email FROM usuarios WHERE rol='admin' AND activo=1 ORDER BY creado ASC LIMIT 1").get();
  return admin ? admin.email : null;
}
function getBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}
async function enviarCorreo(para, asunto, cuerpo, esHtml=false) {
  const cfg = getConfig();
  const transporter = nodemailer.createTransport({
    host:       cfg.smtp_host,
    port:       parseInt(cfg.smtp_puerto),
    secure:     cfg.smtp_puerto === '465',
    requireTLS: cfg.smtp_tls === 'true',
    auth:       { user: cfg.smtp_usuario, pass: cfg.smtp_password },
    tls:        { rejectUnauthorized: false }
  });
  
let htmlContenido = cuerpo;
  if (!esHtml) {
    const linhasHtml = cuerpo.replace(/\n/g, '<br/><br/>');
    htmlContenido = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<title>Horix - Horas Extra</title>
<style>
@media only screen and (max-width: 620px) {
  .email-container { width: 100% !important; padding: 20px 15px !important; }
  .email-content { font-size: 15px !important; }
  .email-title { font-size: 24px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background-color:#0d0f14;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0d0f14;min-height:100vh;">
<tr>
<td align="center" style="padding:20px 10px;">
<table class="email-container" width="600" cellpadding="0" cellspacing="0" style="background-color:#161a23;border-radius:12px;border:1px solid #2a3045;max-width:100%;" style="width:600px;">
<tr>
<td align="center" class="email-content" style="padding:30px 25px;color:#e8ecf5;font-size:15px;line-height:1.7;text-align:left;">
<h1 class="email-title" style="color:#4f8ef7;font-size:28px;margin:0 0 8px;font-weight:bold;">Horix</h1>
<p style="color:#7a85a0;font-size:13px;margin:0 0 25px;">Sistema de Control de Horas Extra</p>
<div>${linhasHtml}</div>
<div style="margin-top:25px;padding-top:18px;border-top:1px solid #2a3045;text-align:center;">
<a href="https://horixvitamar.fortiddns.com" style="color:#4f8ef7;text-decoration:none;font-size:13px;">horixvitamar.fortiddns.com</a>
</div>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
  }
  
  await transporter.sendMail({
    from: cfg.smtp_remitente,
    to: para,
    subject: asunto,
    html: htmlContenido
  });
}

// Migrar smtp_password a AES si aún está en texto plano
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
  // Seed centros
  const totalCentros = db.prepare('SELECT COUNT(*) as n FROM centros').get().n;
  if (totalCentros === 0) {
    db.prepare('INSERT INTO centros (id,nombre,activo,creado) VALUES (?,?,1,?)').run(uid(), 'Principal', new Date().toISOString());
    console.log('🏢 Centro de operación inicial creado: Principal');
  }
  // Seed admin
  const totalUsuarios = db.prepare('SELECT COUNT(*) as c FROM usuarios').get();
  if (totalUsuarios.c === 0) {
    const primerCentro = db.prepare('SELECT nombre FROM centros LIMIT 1').get()?.nombre || 'Principal';
    db.prepare('INSERT INTO usuarios (id,nombre,email,password,rol,sede,activo,creado) VALUES (?,?,?,?,?,?,?,?)').run(
      uid(), 'Administrador',
process.env.ADMIN_EMAIL || 'admin@tuempresa.com',
await hashPassword(process.env.ADMIN_PASS || 'Admin*2026!'),
'admin', primerCentro, 1, new Date().toISOString()
    );
    console.log('👤 Usuario admin creado: admin@empresa.com / Admin2025!');
  }
})();

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
const podeAprobar    = autenticar(['admin', 'gerencia']);
const todosRoles     = autenticar(['admin', 'rrhh', 'consulta', 'operador', 'gerencia']);


// ─────────────────────────────────────────────
// RATE LIMITING — protección fuerza bruta login
// ─────────────────────────────────────────────
const loginAttempts  = new Map();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS    = 5 * 60 * 1000;   // 5 min
const LOGIN_BLOCK_MS     = 30 * 60 * 1000;  // 30 min

setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of loginAttempts.entries()) {
    if (data.blockedUntil && now > data.blockedUntil) loginAttempts.delete(ip);
    else if (now - data.firstAttempt > LOGIN_WINDOW_MS) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000);

function getRealIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(s => s && s !== '127.0.0.1');
  return fwd[0] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
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
// AUTH
// ─────────────────────────────────────────────
app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Campos requeridos' });
  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ? AND activo = 1').get(email.toLowerCase().trim());
  if (!usuario) { loginRegisterFail(req._loginIp); return res.status(401).json({ error: 'Correo o contraseña incorrectos' }); }
  const check = await verificarPassword(password, usuario.password);
  if (!check.ok) { loginRegisterFail(req._loginIp); return res.status(401).json({ error: 'Correo o contraseña incorrectos' }); }
  // Migrar hash SHA-256 legacy a bcrypt automáticamente
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


// ─────────────────────────────────────────────
// RATE LIMITER STATUS — solo admin
// ─────────────────────────────────────────────
app.get('/api/auth/ratelimit-status', soloAdmin, (req, res) => {
  const now = Date.now();
  const bloqueadas = [];
  const enSeguimiento = [];
  for (const [ip, data] of loginAttempts.entries()) {
    if (data.blockedUntil && now < data.blockedUntil) {
      bloqueadas.push({
        ip,
        intentos:         data.count,
        bloqueadaHasta:   new Date(data.blockedUntil).toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
        minutosRestantes: Math.ceil((data.blockedUntil - now) / 60000)
      });
    } else if (data.count > 0) {
      enSeguimiento.push({
        ip,
        intentos:        data.count,
        ventanaExpiraEn: Math.ceil((LOGIN_WINDOW_MS - (now - data.firstAttempt)) / 60000)
      });
    }
  }
  res.json({
    configuracion: {
      maxIntentos:    LOGIN_MAX_ATTEMPTS,
      ventanaMinutos: LOGIN_WINDOW_MS / 60000,
      bloqueoMinutos: LOGIN_BLOCK_MS  / 60000
    },
    totalIpsEnSeguimiento: loginAttempts.size,
    totalBloqueadas:        bloqueadas.length,
    bloqueadas,
    enSeguimiento
  });
});

app.delete('/api/auth/ratelimit-status/:ip', soloAdmin, (req, res) => {
  const ip = decodeURIComponent(req.params.ip);
  if (loginAttempts.has(ip)) {
    loginAttempts.delete(ip);
    console.log(`🔓 IP desbloqueada manualmente por admin: ${ip}`);
    res.json({ ok: true, mensaje: 'IP desbloqueada correctamente' });
  } else {
    res.status(404).json({ error: 'IP no encontrada en el rate limiter' });
  }
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

// Cambio forzado — usuario autenticado con flag cambio_password=1
app.post('/api/auth/cambio-forzado', todosRoles, async (req, res) => {
  const { password } = req.body;
  const errores = validarPassword(password);
  if (errores.length) return res.status(400).json({ error: errores.join(', ') });
  const pwHashF = await hashPassword(password);
  db.prepare('UPDATE usuarios SET password = ?, cambio_password = 0 WHERE id = ?')
    .run(pwHashF, req.usuario.id);
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
// CONFIGURACIÓN SMTP (solo admin)
// ─────────────────────────────────────────────
app.get('/api/configuracion', soloAdmin, (req, res) => {
  const cfg  = getConfig();
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
      `Hola ${req.usuario.nombre},\n\nEsta es una prueba de conexión SMTP desde Horix.\n\nSi recibes este mensaje, la configuración es correcta ✓\n\nSaludos,\nEquipo HORIX`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/version — versión del sistema
app.get('/api/version', (req, res) => {
  res.json({ version: '2.3.4', rama: 'main' });
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
  const enUso = db.prepare("SELECT COUNT(*) as n FROM empleados WHERE sede=( SELECT nombre FROM centros WHERE id=?)").get(req.params.id);
  if (enUso?.n > 0) return res.status(400).json({ error: 'No se puede eliminar: hay empleados asignados a este centro' });
  db.prepare('DELETE FROM centros WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Mantener /api/sedes como alias para compatibilidad
app.get('/api/sedes', todosRoles, (req, res) => {
  res.json(db.prepare("SELECT nombre FROM centros WHERE activo=1 ORDER BY nombre ASC").all().map(c => c.nombre));
});

// ─────────────────────────────────────────────
// USUARIOS
// ─────────────────────────────────────────────
app.get('/api/usuarios', todosRoles, (req, res) =>
  res.json(db.prepare('SELECT id, nombre, email, rol, sede, activo, cambio_password, creado FROM usuarios ORDER BY creado DESC').all()));

app.post('/api/usuarios', soloAdmin, async (req, res) => {
  const { nombre, email, password, rol, sede } = req.body;
  if (!nombre || !email || !password || !rol || !sede) return res.status(400).json({ error: 'Todos los campos son requeridos' });
  const errPass = validarPassword(password);
  if (errPass.length) return res.status(400).json({ error: 'Contraseña inválida: ' + errPass.join(', ') });
  if (!['admin','rrhh','consulta','operador','gerencia'].includes(rol)) return res.status(400).json({ error: 'Rol inválido' });
  const centroValido = db.prepare('SELECT id FROM centros WHERE nombre=? AND activo=1').get(sede);
  if (!centroValido) return res.status(400).json({ error: 'Centro de operación inválido' });
  const existe = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email.toLowerCase().trim());
  if (existe) return res.status(400).json({ error: 'Ya existe un usuario con ese correo' });
  const id = uid();
  const pwHash = await hashPassword(password);
  db.prepare('INSERT INTO usuarios (id,nombre,email,password,rol,sede,activo,creado) VALUES (?,?,?,?,?,?,?,?)').run(
    id, nombre.trim(), email.toLowerCase().trim(), pwHash, rol, sede, 1, new Date().toISOString()
  );
  
  // Enviar correo de bienvenida
  try {
    const cfg = getConfig();
    if (cfg.smtp_host) {
      const rolTxt = {admin:'Admin',rrhh:'RRHH',gerencia:'Gerencia',consulta:'Consulta',operador:'Operador'}[rol]||rol;
      await enviarCorreo(email, '👋 Bienvenido a Horix - Credenciales',
        `Hola ${nombre},\n\nTu cuenta ha sido creada en Horix.\n\n📧 Correo: ${email}\n🔑 Rol: ${rolTxt}\n📍 Sede: ${sede}\n\nPor favor cambia tu contraseña en el primer acceso.\n\nIngresa en: https://horixvitamar.fortiddns.com\n\nSaludos,\nEquipo Horix`
      );
    }
  } catch (e) { console.log('Error enviando correo:', e.message); }
  
  res.json({ id });
});

// GET asignaciones de un usuario
app.get('/api/usuario_empleados/:id', soloAdmin, (req, res) => {
  const rows = db.prepare('SELECT empleadoId FROM usuario_empleados WHERE usuarioId = ?').all(req.params.id);
  res.json(rows.map(r => r.empleadoId));
});

// PUT asignaciones de un usuario (reemplaza todas)
app.put('/api/usuario_empleados/:id', soloAdmin, (req, res) => {
  const { empleados: lista } = req.body; // array de ids o [] para sin restricción
  db.transaction(() => {
    db.prepare('DELETE FROM usuario_empleados WHERE usuarioId = ?').run(req.params.id);
    if (Array.isArray(lista)) {
      const ins = db.prepare('INSERT OR IGNORE INTO usuario_empleados VALUES (?,?)');
      for (const eid of lista) ins.run(req.params.id, eid);
    }
  })();
  res.json({ ok: true });
});

app.post('/api/usuarios/:id/reset-password', soloAdmin, async (req, res) => {
  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ? AND activo = 1').get(req.params.id);
  if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });
  db.prepare('DELETE FROM tokens_reset WHERE usuarioId = ?').run(usuario.id);
  const token  = generateToken();
  const expira = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO tokens_reset VALUES (?,?,?)').run(token, usuario.id, expira);
  const cfg    = getConfig();
  const enlace = `${getBaseUrl(req)}/reset-password.html?token=${token}`;
  const cuerpo = `Hola ${usuario.nombre},\n\nUn administrador ha solicitado el restablecimiento de tu contraseña.\n\nPara crear una nueva contraseña, haz clic en el siguiente enlace:\n\n${enlace}\n\nEste enlace expira en 30 minutos.\n\nSi no solicitaste esto, ignora este correo.\n\n\nSaludos,\nEquipo Horix`;
  try {
    await enviarCorreo(usuario.email, '🔐 Restablecer contraseña - Horix', cuerpo);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo enviar el correo.' });
  }
});

app.put('/api/usuarios/:id', soloAdmin, async (req, res) => {
  const { nombre, email, rol, sede, activo, password } = req.body;
  if (!['admin','rrhh','consulta','operador','gerencia'].includes(rol)) return res.status(400).json({ error: 'Rol inválido' });
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

  // Verificar si el usuario tiene empleados asignados explícitamente
  const asignados = db.prepare('SELECT empleadoId FROM usuario_empleados WHERE usuarioId = ?')
    .all(u.id).map(r => r.empleadoId);

  // Si tiene asignación explícita → solo esos empleados (aplica a cualquier rol)
  if (asignados.length > 0) {
    const placeholders = asignados.map(() => '?').join(',');
    return res.json(db.prepare(`SELECT * FROM empleados WHERE id IN (${placeholders})`).all(...asignados));
  }

  // Sin asignación explícita: aplicar reglas por rol
  // Operador: solo empleados de su sede
  if (u.rol === 'operador') {
    return res.json(db.prepare('SELECT * FROM empleados WHERE sede = ?').all(u.sede));
  }
  // RRHH: puede filtrar por sede con query param, si no trae todos
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

// POST importar empleados — importa desde CSV, skip duplicados por cédula
app.post('/api/empleados/importar', soloAdmin, upload.single('archivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
  try {
    const texto = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
    const lineas = texto.split('\n').map(l => l.trim()).filter(l => l);
    if (lineas.length < 2) return res.status(400).json({ error: 'El archivo está vacío o no tiene datos' });

    const primeraLinea = lineas[0];
const separador = primeraLinea.includes('\t') ? '\t'
                : primeraLinea.includes(';')  ? ';'
                : ',';

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
      const nombre       = cols[idx('nombre')]?.trim();
      const cargo        = cols[idx('cargo')]?.trim();
      const departamento = cols[idx('departamento')]?.trim();
      const sede         = cols[idx('sede')]?.trim() || 'Principal';
      const email        = idx('email') !== -1 ? cols[idx('email')]?.trim() : '';
      const telefono     = idx('telefono') !== -1 ? cols[idx('telefono')]?.trim() : '';
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
  // Operador: solo registros que él mismo creó
  if (u.rol === 'operador') {
    return res.json(db.prepare(base + ' WHERE r.creadoPor = ? ORDER BY r.fecha DESC').all(u.id));
  }
  // RRHH: puede filtrar por sede
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
  const hoy = new Date().toISOString().split('T')[0];
  if (fecha > hoy) return res.status(400).json({ error: 'La fecha no puede ser futura.' });
  const u = req.usuario;
  // Validar que el usuario tiene permiso sobre este empleado
  if (u.rol !== 'admin') {
    const asignados = db.prepare('SELECT empleadoId FROM usuario_empleados WHERE usuarioId = ?').all(u.id).map(r => r.empleadoId);
    if (asignados.length > 0 && !asignados.includes(empleadoId)) {
      return res.status(403).json({ error: 'No tienes permiso para registrar horas a este empleado.' });
    }
  }
  const emp = db.prepare('SELECT sede FROM empleados WHERE id = ?').get(empleadoId);
  const sede = emp ? emp.sede : 'Principal';
  const id = uid();
  db.prepare('INSERT INTO registros (id,empleadoId,nominaId,fecha,horas,tipo,aprobador,motivo,creado,concepto,observaciones,transporte,sede,creadoPor, estado, aprobadoPor, fechaAprobado) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?, ?, ?)')
    .run(id, empleadoId, nominaId, fecha, horas, tipo, aprobador, motivo, new Date().toISOString(), concepto||'', observaciones||'', parseFloat(transporte||0), sede, req.usuario.id, 'pendiente', '', '');
  
  // Notificar a gerencia/admin de nuevo registro pendiente
  try {
    const cfg = getConfig();
    const gerentes = db.prepare("SELECT email FROM usuarios WHERE rol IN ('gerencia','admin') AND activo = 1").all();
    const emp = db.prepare('SELECT nombre FROM empleados WHERE id = ?').get(empleadoId);
    const nom = db.prepare('SELECT nombre FROM nominas WHERE id = ?').get(nominaId);
    if (gerentes.length && cfg.smtp_host) {
      const cuerpo = `📢 Nueva hora extra pendiente de aprobación\n\n` +
        `Empleado: ${emp?.nombre || '—'}\n` +
        `Fecha: ${fecha}\n` +
        `Horas: ${horas}\n` +
        `Tipo: ${tipo}\n` +
        `Aprobador: ${aprobador}\n` +
        `Motivo: ${motivo}\n\n` +
        `https://horixvitamar.fortiddns.com`;

      gerentes.forEach(g => enviarCorreo(g.email, `🔔 Nueva hora extra pendiente - ${emp?.nombre || '—'}`, cuerpo));
    }
  } catch (e) { console.log('Error notify gerencia:', e.message); }
  
  res.json({ id });
});

app.delete('/api/registros/:id', adminRrhh, (req, res) => {
  db.prepare('DELETE FROM registros WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/registros/:id/aprobar — aprobar o rechazar registro (solo admin/gerencia)
app.post('/api/registros/:id/aprobar', podeAprobar, async (req, res) => {
  const { aprobar, observaciones } = req.body;
  const estado = aprobar ? 'aprobado' : 'rechazado';
  
  db.prepare('UPDATE registros SET estado = ?, aprobadoPor = ?, fechaAprobado = ?, observaciones = COALESCE(?, observaciones) WHERE id = ?')
    .run(estado, req.usuario.id, new Date().toISOString(), observaciones || '', req.params.id);
  
  // Notificar al usuario que creó el registro
  try {
    const reg = db.prepare('SELECT r.*, u.email as creadorEmail FROM registros r JOIN usuarios u ON r.creadoPor = u.id WHERE r.id = ?').get(req.params.id);
    if (reg?.creadorEmail) {
      const cfg = getConfig();
      await enviarCorreo(reg.creadorEmail, `Tu hora extra fue ${estado === 'aprobado' ? 'aprobada' : 'rechazada'}`,
        `Hola,\n\nTu registro de hora extra ha sido ${estado === 'aprobado' ? 'aprobado' : 'rechazado'}:\n\nFecha: ${reg.fecha}\nHoras: ${reg.horas}\nTipo: ${reg.tipo}\n\n${observaciones ? 'Observaciones: ' + observaciones : ''}\n\nSaludos,\nHorix`
      );
    }
  } catch (e) { console.log('Error enviando notificación:', e.message); }
  
  res.json({ ok: true, estado });
});

// ─────────────────────────────────────────────
// BACKUP & RESTAURACIÓN
// ─────────────────────────────────────────────

// GET /api/backup — genera ZIP con JSON + CSVs
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

    // Helper CSV
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

// POST /api/restore — restaura desde JSON del ZIP
app.post('/api/restore', soloAdmin, upload.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
  try {
    let data;

    // Aceptar ZIP o JSON directamente
    if (req.file.originalname.endsWith('.zip')) {
      const zip  = new AdmZip(req.file.buffer);
      const entry = zip.getEntry('backup.json');
      if (!entry) return res.status(400).json({ error: 'El ZIP no contiene backup.json' });
      data = JSON.parse(entry.getData().toString('utf8'));
    } else {
      data = JSON.parse(req.file.buffer.toString('utf8'));
    }

    if (data.app !== 'HorasExtra') return res.status(400).json({ error: 'Archivo de backup inválido' });

    // Restaurar en transacción
    db.transaction(() => {
      // Configuración SMTP
      if (data.configuracion) {
        for (const [clave, valor] of Object.entries(data.configuracion)) {
          const stored = clave === 'smtp_password' ? encryptSmtp(valor) : valor;
          db.prepare('INSERT OR REPLACE INTO configuracion VALUES (?,?)').run(clave, stored);
        }
      }
      // Empleados
      if (data.empleados?.length) {
        db.prepare('DELETE FROM empleados').run();
        const ins = db.prepare('INSERT OR REPLACE INTO empleados (id,nombre,cedula,cargo,departamento,sede,email,telefono) VALUES (?,?,?,?,?,?,?,?)');
        for (const e of data.empleados) ins.run(e.id,e.nombre,e.cedula,e.cargo,e.departamento,e.sede||'Principal',e.email||'',e.telefono||'');
      }
      // Nóminas
      if (data.nominas?.length) {
        db.prepare('DELETE FROM nominas').run();
        const ins = db.prepare('INSERT OR REPLACE INTO nominas VALUES (?,?,?,?,?)');
        for (const n of data.nominas) ins.run(n.id,n.nombre,n.tipo,n.inicio,n.fin);
      }
      // Registros
      if (data.registros?.length) {
        db.prepare('DELETE FROM registros').run();
        const ins = db.prepare('INSERT OR REPLACE INTO registros (id,empleadoId,nominaId,fecha,horas,tipo,aprobador,motivo,creado,concepto,sede,creadoPor,observaciones,transporte) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const r of data.registros) ins.run(r.id,r.empleadoId,r.nominaId,r.fecha,r.horas,r.tipo,r.aprobador,r.motivo,r.creado,r.concepto||'',r.sede||'Principal',r.creadoPor||'',r.observaciones||'',parseFloat(r.transporte||0));
      }
      // Asignaciones usuario-empleados
      if (data.usuario_empleados?.length) {
        db.prepare('DELETE FROM usuario_empleados').run();
        const ins = db.prepare('INSERT OR IGNORE INTO usuario_empleados VALUES (?,?)');
        for (const r of data.usuario_empleados) ins.run(r.usuarioId, r.empleadoId);
      }
      // Usuarios (no sobreescribir al admin actual)
      if (data.usuarios?.length) {
        const insUser = db.prepare('INSERT OR REPLACE INTO usuarios (id,nombre,email,password,rol,sede,activo,cambio_password,creado) VALUES (?,?,?,?,?,?,?,?,?)');
        for (const u of data.usuarios) {
          if (u.id === req.usuario.id) continue; // proteger sesión actual
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
// ─────────────────────────────────────────────
// ALERTA DE BACKUP — llamado por el script bash
// ─────────────────────────────────────────────
app.post('/api/backup/alerta', soloAdmin, async (req, res) => {
  const { error, detalle } = req.body;
  const fecha = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  try {
    await enviarCorreo(
      getAdminEmail() || req.usuario.email,
      `⚠ Error en Backup Automático — HorasExtra ${fecha}`,
      `Hola,

El backup automático programado de HorasExtra falló el ${fecha}.

Error:
${error || 'Error desconocido'}

Detalle:
${detalle || 'Sin detalle adicional'}

Por favor revisa el log en el servidor:
  cat /var/log/backup_horasextra.log

Saludos,
Sistema Horix`
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'No se pudo enviar el correo: ' + e.message });
  }
});


// ─────────────────────────────────────────────
// BACKUPS AUTOMÁTICOS — lista y descarga
// ─────────────────────────────────────────────

// Obtiene el directorio de backups locales desde last_backup.json
function getBackupDir() {
  const candidatos = ['last_backup.json', '.ultimo_backup.json'].map(f => path.join(__dirname, f));
  for (const infoFile of candidatos) {
    try {
      if (!fs.existsSync(infoFile)) continue;
      const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
      if (info.archivo) {
        // Buscar el archivo en rutas conocidas
        const posibleDir = path.join(require('os').homedir(), 'backups', 'horix');
        if (fs.existsSync(posibleDir)) return posibleDir;
      }
    } catch {}
  }
  // Fallback: buscar directorio de backups en HOME
  const fallback = path.join(require('os').homedir(), 'backups', 'horix');
  return fs.existsSync(fallback) ? fallback : null;
}

// GET /api/backup/lista — lista los backups automáticos disponibles
app.get('/api/backup/lista', soloAdmin, (req, res) => {
  const dir = getBackupDir();
  if (!dir || !fs.existsSync(dir)) return res.json([]);
  try {
    const archivos = fs.readdirSync(dir)
      .filter(f => f.startsWith('horix_backup_') && f.endsWith('.zip'))
      .map(f => {
        const fullPath = path.join(dir, f);
        const stat = fs.statSync(fullPath);
        return {
          nombre:  f,
          tamaño:  stat.size,
          fecha:   stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha)) // más reciente primero
      .slice(0, 7);
    res.json(archivos);
  } catch (e) {
    res.status(500).json({ error: 'Error listando backups: ' + e.message });
  }
});

// GET /api/backup/descargar/:filename — descarga un backup automático específico
app.get('/api/backup/descargar/:filename', soloAdmin, (req, res) => {
  const { filename } = req.params;
  // Validar nombre — solo horix_backup_*.zip
  if (!/^horix_backup_[\w\-]+\.zip$/.test(filename)) {
    return res.status(400).json({ error: 'Nombre de archivo inválido' });
  }
  const dir = getBackupDir();
  if (!dir) return res.status(404).json({ error: 'Directorio de backups no encontrado' });
  const fullPath = path.join(dir, filename);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.download(fullPath, filename);
});

// POST /api/restore/local/:filename — restaura un backup automático sin subir archivo
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

// GET /api/backup/ultimo — info del último backup automático
app.get('/api/backup/ultimo', soloAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  // Buscar en ambos nombres por compatibilidad
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

// GET /logo — sirve el logo si existe
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

// POST /api/logo — sube el logo (solo admin)
app.post('/api/logo', soloAdmin, upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  const mime = req.file.mimetype;
  const ext  = mime === 'image/svg+xml' ? '.svg'
             : mime === 'image/webp'    ? '.webp'
             : mime === 'image/jpeg'    ? '.jpg'
             : '.png';
  // Borrar logos anteriores
  ['.png','.jpg','.jpeg','.svg','.webp'].forEach(e => {
    const p = LOGO_PATH + e;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  const dest = LOGO_PATH + ext;
  fs.writeFileSync(dest, req.file.buffer);
  res.json({ ok: true });
});

// DELETE /api/logo — elimina el logo (solo admin)
app.delete('/api/logo', soloAdmin, (req, res) => {
  ['.png','.jpg','.jpeg','.svg','.webp'].forEach(e => {
    const p = LOGO_PATH + e;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// ADJUNTOS
// ─────────────────────────────────────────────

// GET /api/registros/:id/adjuntos — lista adjuntos de un registro
app.get('/api/registros/:id/adjuntos', todosRoles, (req, res) => {
  const rows = db.prepare(
    'SELECT id, nombre, mime, tamano, subido, subidoPor FROM adjuntos WHERE registroId = ? ORDER BY subido ASC'
  ).all(req.params.id);
  res.json(rows);
});

// POST /api/registros/:id/adjuntos — sube un adjunto (admin, rrhh, operador)
app.post('/api/registros/:id/adjuntos', adminRrhhOp, (req, res, next) => {
  uploadAdjunto.single('archivo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
    const registro = db.prepare('SELECT id FROM registros WHERE id = ?').get(req.params.id);
    if (!registro) return res.status(404).json({ error: 'Registro no encontrado' });
    // Verificar que operador tiene acceso al registro
    if (req.usuario.rol === 'operador') {
      const reg = db.prepare('SELECT empleadoId FROM registros WHERE id = ?').get(req.params.id);
      const asignados = db.prepare('SELECT empleadoId FROM usuario_empleados WHERE usuarioId = ?').all(req.usuario.id).map(r => r.empleadoId);
      if (asignados.length > 0 && !asignados.includes(reg.empleadoId)) {
        return res.status(403).json({ error: 'No tienes permiso sobre este registro.' });
      }
    }
    const id = uid();
    db.prepare(
      'INSERT INTO adjuntos (id, registroId, nombre, mime, tamano, datos, subido, subidoPor) VALUES (?,?,?,?,?,?,?,?)'
    ).run(id, req.params.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer, new Date().toISOString(), req.usuario.id);
    res.json({ id, nombre: req.file.originalname, mime: req.file.mimetype, tamano: req.file.size });
  });
});

// GET /api/adjuntos/:id/descargar — descarga un adjunto
app.get('/api/adjuntos/:id/descargar', todosRoles, (req, res) => {
  const adj = db.prepare('SELECT * FROM adjuntos WHERE id = ?').get(req.params.id);
  if (!adj) return res.status(404).json({ error: 'Adjunto no encontrado' });
  res.setHeader('Content-Type', adj.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(adj.nombre)}"`);
  res.send(adj.datos);
});

// DELETE /api/adjuntos/:id — elimina un adjunto (admin, rrhh)
app.delete('/api/adjuntos/:id', adminRrhh, (req, res) => {
  const adj = db.prepare('SELECT id FROM adjuntos WHERE id = ?').get(req.params.id);
  if (!adj) return res.status(404).json({ error: 'Adjunto no encontrado' });
  db.prepare('DELETE FROM adjuntos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/version
app.get('/api/version', (req, res) => {
  try {
    const pkg  = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    const rama = require('child_process')
      .execSync('git branch --show-current 2>/dev/null || echo ""')
      .toString().trim();
    res.json({ version: pkg.version, rama: rama || 'main' });
  } catch { res.json({ version: '—', rama: '' }); }
});

// INICIAR
// ─────────────────────────────────────────────
app.listen(3000, '0.0.0.0', () => {
  console.log('✅ Servidor corriendo en http://0.0.0.0:3000');
});