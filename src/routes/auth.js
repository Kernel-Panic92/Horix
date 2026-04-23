const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { hashPassword, verificarPassword, generarToken, validarPassword, encryptSmtp } = require('../services/crypto');
const { enviarCorreo, getConfig } = require('../services/mail');
const { soloAdmin, adminRrhh, adminRrhhOp, todosRoles } = require('../middleware/auth');
const { loginRateLimit, loginRegisterFail, loginRegisterSuccess, getRateLimitStatus, unlockIp } = require('../middleware/ratelimit');
const { getBaseUrl } = require('../utils/helpers');

router.post('/login', loginRateLimit, async (req, res) => {
  const db = getDb();
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
  const token = generarToken();
  const expira = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sesiones VALUES (?,?,?)').run(token, usuario.id, expira);
  loginRegisterSuccess(req._loginIp);

  res.json({ token, usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol, sede: usuario.sede, cambio_password: usuario.cambio_password || 0 } });
});

router.get('/ratelimit-status', soloAdmin, (req, res) => {
  res.json(getRateLimitStatus());
});

router.delete('/ratelimit-status/:ip', soloAdmin, (req, res) => {
  const ip = decodeURIComponent(req.params.ip);
  if (unlockIp(ip)) {
    res.json({ ok: true, mensaje: 'IP desbloqueada correctamente' });
  } else {
    res.status(404).json({ error: 'IP no encontrada en el rate limiter' });
  }
});

router.post('/logout', todosRoles, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM sesiones WHERE token = ?').run(req.headers['authorization']?.replace('Bearer ', ''));
  res.json({ ok: true });
});

router.get('/me', todosRoles, (req, res) => {
  const u = req.usuario;
  res.json({ id: u.id, nombre: u.nombre, email: u.email, rol: u.rol, sede: u.sede, cambio_password: u.cambio_password || 0 });
});

router.post('/forgot-password', async (req, res) => {
  const db = getDb();
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Correo requerido' });

  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ? AND activo = 1').get(email.toLowerCase().trim());
  if (!usuario) return res.json({ ok: true });

  db.prepare('DELETE FROM tokens_reset WHERE usuarioId = ?').run(usuario.id);
  const token = generarToken();
  const expira = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO tokens_reset VALUES (?,?,?)').run(token, usuario.id, expira);

  const cfg = getConfig();
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

router.post('/cambio-forzado', todosRoles, async (req, res) => {
  const db = getDb();
  const { password } = req.body;
  const errores = validarPassword(password);
  if (errores.length) return res.status(400).json({ error: errores.join(', ') });

  const pwHashF = await hashPassword(password);
  db.prepare('UPDATE usuarios SET password = ?, cambio_password = 0 WHERE id = ?').run(pwHashF, req.usuario.id);
  db.prepare('DELETE FROM sesiones WHERE usuarioId = ? AND token != ?').run(req.usuario.id, req.headers['authorization']?.replace('Bearer ', ''));
  res.json({ ok: true });
});

router.post('/reset-password', async (req, res) => {
  const db = getDb();
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

module.exports = router;