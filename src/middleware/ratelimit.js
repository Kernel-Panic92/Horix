const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_BLOCK_MS = 30 * 60 * 1000;

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
  const ip = getRealIp(req);
  const now = Date.now();
  let data = loginAttempts.get(ip) || { count: 0, firstAttempt: now, blockedUntil: null };

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
  const now = Date.now();
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

function getRateLimitStatus() {
  const now = Date.now();
  const Bloqueadas = [];
  const enSeguimiento = [];

  for (const [ip, data] of loginAttempts.entries()) {
    if (data.blockedUntil && now < data.blockedUntil) {
      Bloqueadas.push({
        ip,
        intentos: data.count,
        bloqueadaHasta: new Date(data.blockedUntil).toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
        minutosRestantes: Math.ceil((data.blockedUntil - now) / 60000)
      });
    } else if (data.count > 0) {
      enSeguimiento.push({
        ip,
        intentos: data.count,
        ventanaExpiraEn: Math.ceil((LOGIN_WINDOW_MS - (now - data.firstAttempt)) / 60000)
      });
    }
  }

  return {
    configuracion: {
      maxIntentos: LOGIN_MAX_ATTEMPTS,
      ventanaMinutos: LOGIN_WINDOW_MS / 60000,
      bloqueoMinutos: LOGIN_BLOCK_MS / 60000
    },
    totalIpsEnSeguimiento: loginAttempts.size,
    totalBloqueadas: Bloqueadas.length,
    Bloqueadas,
    enSeguimiento
  };
}

function unlockIp(ip) {
  if (loginAttempts.has(ip)) {
    loginAttempts.delete(ip);
    console.log(`🔓 IP desbloqueada manualmente: ${ip}`);
    return true;
  }
  return false;
}

module.exports = {
  loginRateLimit,
  loginRegisterFail,
  loginRegisterSuccess,
  getRateLimitStatus,
  unlockIp,
  getRealIp
};