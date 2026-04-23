const bcrypt = require('bcrypt');
const crypto = require('crypto');
require('dotenv').config();

const BCRYPT_ROUNDS = 12;
const AES_KEY = crypto.scryptSync(process.env.HE_SECRET || 'horasextra_aes_key_default_2025', 'he_salt_aes', 32);

async function hashPassword(p) {
  return bcrypt.hash(p, BCRYPT_ROUNDS);
}

async function verificarPassword(plain, hash) {
  if (hash.length === 64 && !hash.startsWith('$2')) {
    const legacyHash = crypto.createHash('sha256').update(plain + 'horasextra_salt_2025').digest('hex');
    if (legacyHash === hash) {
      return { ok: true, migrar: true };
    }
    return { ok: false };
  }
  return { ok: await bcrypt.compare(plain, hash), migrar: false };
}

function encryptSmtp(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', AES_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
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
  if (!p || p.length < 8) errores.push('Mínimo 8 caracteres');
  if (!/[A-Z]/.test(p)) errores.push('Al menos una mayúscula');
  if (!/[0-9]/.test(p)) errores.push('Al menos un número');
  if (!/[!@#$%^&*(),.?":{}|<>_\-+=/\\[\]~`]/.test(p)) errores.push('Al menos un carácter especial');
  return errores;
}

function generateToken() {
  return crypto.randomBytes(48).toString('hex');
}

module.exports = {
  hashPassword,
  verificarPassword,
  encryptSmtp,
  decryptSmtp,
  validarPassword,
  generateToken,
  BCRYPT_ROUNDS
};