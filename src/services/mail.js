const nodemailer = require('nodemailer');
const { getDb } = require('../db');
const { decryptSmtp } = require('./crypto');

function getConfig() {
  const db = getDb();
  const rows = db.prepare('SELECT clave, valor FROM configuracion').all();
  const cfg = Object.fromEntries(rows.map(r => [r.clave, r.valor]));
  if (cfg.smtp_password) cfg.smtp_password = decryptSmtp(cfg.smtp_password);
  return cfg;
}

function getAdminEmail() {
  const db = getDb();
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

function migrarSmtpPassword() {
  const db = getDb();
  const row = db.prepare("SELECT valor FROM configuracion WHERE clave='smtp_password'").get();
  if (row && row.valor && !row.valor.startsWith('aes:')) {
    const { encryptSmtp } = require('./crypto');
    const encrypted = encryptSmtp(row.valor);
    db.prepare("UPDATE configuracion SET valor=? WHERE clave='smtp_password'").run(encrypted);
    console.log('🔐 smtp_password migrado a AES-256-GCM');
  }
}

module.exports = { enviarCorreo, getConfig, getAdminEmail, migrarSmtpPassword };