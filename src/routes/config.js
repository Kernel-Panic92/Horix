const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { soloAdmin } = require('../middleware/auth');
const { encryptSmtp } = require('../services/crypto');
const { getConfig, enviarCorreo } = require('../services/mail');

router.get('/', soloAdmin, (req, res) => {
  const cfg = getConfig();
  res.json({ ...cfg, smtp_password: cfg.smtp_password ? '••••••••' : '' });
});

router.put('/', soloAdmin, (req, res) => {
  const db = getDb();
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

router.post('/test', soloAdmin, async (req, res) => {
  try {
    await enviarCorreo(req.usuario.email, 'Prueba SMTP — Horix',
      `Hola ${req.usuario.nombre},\n\nEsta es una prueba de conexión SMTP desde Horix.\n\nSi recibes este mensaje, la configuración es correcta ✓\n\nSaludos,\nEquipo HORIX`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;