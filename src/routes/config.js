const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const { getDb } = require('../db');
const { soloAdmin } = require('../middleware/auth');
const { encryptSmtp } = require('../services/crypto');
const { getConfig, enviarCorreo } = require('../services/mail');
const { loginRateLimit } = require('../middleware/ratelimit');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const logoDir = path.join(process.cwd(), 'public', 'logos');
      if (!fs.existsSync(logoDir)) fs.mkdirSync(logoDir, { recursive: true });
      cb(null, logoDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `logo_${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo imágenes'));
  }
});

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

// LOGO EMPRESA
router.post('/logo', soloAdmin, upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  const url = `/logos/${req.file.filename}`;
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO configuracion (clave, valor) VALUES (?,?)').run('empresa_logo', url);
  res.json({ ok: true, url });
});

// SEGURIDAD
router.get('/seguridad', soloAdmin, (req, res) => {
  const db = getDb();
  const cfg = getConfig();
  res.json({
    rate_limit_window: cfg.rate_limit_window || '300',
    rate_limit_max: cfg.rate_limit_max || '5',
    fail2ban_enabled: cfg.fail2ban_enabled || 'false',
    fail2ban_bantime: cfg.fail2ban_bantime || '3600',
    fail2ban_findtime: cfg.fail2ban_findtime || '300',
    fail2ban_maxretry: cfg.fail2ban_maxretry || '5'
  });
});

router.put('/seguridad', soloAdmin, (req, res) => {
  const db = getDb();
  const { rate_limit_window, rate_limit_max, fail2ban_enabled, fail2ban_bantime, fail2ban_findtime, fail2ban_maxretry } = req.body;
  
  const updates = [
    ['rate_limit_window', Math.max(60, Math.min(86400, parseInt(rate_limit_window) || 300).toString()],
    ['rate_limit_max', Math.max(3, Math.min(100, parseInt(rate_limit_max) || 5).toString()],
    ['fail2ban_enabled', fail2ban_enabled === 'true' ? 'true' : 'false'],
    ['fail2ban_bantime', Math.max(60, Math.min(604800, parseInt(fail2ban_bantime) || 3600).toString()],
    ['fail2ban_findtime', Math.max(60, Math.min(86400, parseInt(fail2ban_findtime) || 300).toString()],
    ['fail2ban_maxretry', Math.max(1, Math.min(20, parseInt(fail2ban_maxretry) || 5).toString()]
  ];
  
  for (const [clave, valor] of updates) {
    db.prepare('INSERT OR REPLACE INTO configuracion (clave, valor) VALUES (?,?)').run(clave, valor);
  }
  
  res.json({ ok: true, message: 'Configuración de seguridad guardada' });
});

// UPDATER
const APP_DIR = process.cwd();
const HOMEDIR = os.homedir();

router.get('/updater/status', soloAdmin, (req, res) => {
  try {
    const gitBranch = execSync('git branch --show-current 2>/dev/null || echo "-"', { cwd: APP_DIR }).toString().trim();
    const gitCommit = execSync('git rev-parse --short HEAD 2>/dev/null || echo "-"', { cwd: APP_DIR }).toString().trim();
    const remote = execSync('git remote get-url origin 2>/dev/null || echo "-"', { cwd: APP_DIR }).toString().trim();
    const lastUpdate = fs.existsSync(path.join(APP_DIR, '.last-update')) 
      ? fs.readFileSync(path.join(APP_DIR, '.last-update'), 'utf8').trim() 
      : null;
    res.json({ ok: true, branch: gitBranch, commit: gitCommit, remote, lastUpdate });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post('/updater/check', loginRateLimit, soloAdmin, async (req, res) => {
  try {
    execSync('git fetch origin', { cwd: APP_DIR, stdio: 'pipe' });
    const current = execSync('git rev-parse --short HEAD', { cwd: APP_DIR }).toString().trim();
    const behind = parseInt(execSync('git rev-list HEAD..origin/main --count 2>/dev/null || echo 0', { cwd: APP_DIR }).toString().trim());
    let changes = [];
    if (behind > 0) {
      changes = execSync('git log HEAD..origin/main --oneline 2>/dev/null', { cwd: APP_DIR }).toString().trim().split('\n').filter(l => l.trim()).slice(0, 5);
    }
    res.json({ ok: true, hasUpdates: behind > 0, commitsBehind: behind, currentCommit: current, changes });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post('/updater/update', loginRateLimit, soloAdmin, async (req, res) => {
  try {
    execSync('git fetch origin && git reset --hard origin/main', { cwd: APP_DIR, stdio: 'pipe' });
    execSync('npm install --production', { cwd: APP_DIR, stdio: 'pipe' });
    const newCommit = execSync('git rev-parse --short HEAD', { cwd: APP_DIR }).toString().trim();
    fs.writeFileSync(path.join(APP_DIR, '.last-update'), new Date().toISOString());
    res.json({ ok: true, newCommit, message: 'Actualización completada' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post('/updater/restart', soloAdmin, (req, res) => {
  try {
    execSync('pm2 restart horix', { stdio: 'pipe' });
    res.json({ ok: true, message: 'Servicio reiniciado' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// BACKUPS AUTOMÁTICOS
const BACKUP_DIR = path.join(HOMEDIR, 'backups', 'horix');

router.get('/backups-auto', soloAdmin, (req, res) => {
  const cfg = getConfig();
  res.json({
    backup_auto_enabled: cfg.backup_auto_enabled || 'false',
    backup_auto_cron: cfg.backup_auto_cron || '0 2 * * *',
    backup_auto_path: cfg.backup_auto_path || BACKUP_DIR,
    backup_auto_retention: cfg.backup_auto_retention || '7',
    backup_auto_type: cfg.backup_auto_type || 'local',
    backup_auto_host: cfg.backup_auto_host || '',
    backup_auto_user: cfg.backup_auto_user || ''
  });
});

router.put('/backups-auto', soloAdmin, (req, res) => {
  const db = getDb();
  const { backup_auto_enabled, backup_auto_cron, backup_auto_path, backup_auto_retention, backup_auto_type, backup_auto_host, backup_auto_user, backup_auto_pass } = req.body;
  
  const updates = [
    ['backup_auto_enabled', backup_auto_enabled === 'true' ? 'true' : 'false'],
    ['backup_auto_cron', backup_auto_cron || '0 2 * * *'],
    ['backup_auto_path', backup_auto_path || BACKUP_DIR],
    ['backup_auto_retention', parseInt(backup_auto_retention) || 7],
    ['backup_auto_type', backup_auto_type || 'local'],
    ['backup_auto_host', backup_auto_host || ''],
    ['backup_auto_user', backup_auto_user || '']
  ];
  
  for (const [clave, valor] of updates) {
    db.prepare('INSERT OR REPLACE INTO configuracion (clave, valor) VALUES (?,?)').run(clave, valor);
  }
  
  // Configurar cron si está habilitado
  if (backup_auto_enabled === 'true' && backup_auto_cron) {
    const cronCmd = `cd ${APP_DIR} && node src/scripts/backup-auto.js >> ${APP_DIR}/logs/backup.log 2>&1`;
    execSync(`(crontab -l 2>/dev/null | grep -v 'backup-auto'; echo "${backup_auto_cron} ${cronCmd}") | crontab -`, { stdio: 'pipe' });
  } else {
    execSync(`crontab -l 2>/dev/null | grep -v 'backup-auto' | crontab -`, { stdio: 'pipe' });
  }
  
  res.json({ ok: true, message: 'Configuración guardada' });
});

router.get('/backups-auto/ultimo', soloAdmin, (req, res) => {
  const cfg = getConfig();
  const dir = cfg.backup_auto_path || BACKUP_DIR;
  if (!fs.existsSync(dir)) return res.json({});
  try {
    const files = fs.readdirSync(dir).filter(f => f.startsWith('horix_backup_') && f.endsWith('.zip'));
    if (!files.length) return res.json({});
    const latest = files.sort().reverse()[0];
    const stat = fs.statSync(path.join(dir, latest));
    res.json({ nombre: latest, fecha: stat.mtime.toISOString(), tamano: stat.size });
  } catch (e) {
    res.json({});
  }
});

// CRON
router.get('/cron', soloAdmin, (req, res) => {
  const cfg = getConfig();
  let crons = [];
  try {
    crons = execSync('crontab -l 2>/dev/null || echo ""').toString().split('\n').filter(l => l.trim() && !l.startsWith('#'));
  } catch (e) {}
  res.json({ backup_cron: cfg.backup_auto_cron || '0 2 * * *', crontab: crons });
});

module.exports = router;