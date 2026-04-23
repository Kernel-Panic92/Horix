function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function getBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

module.exports = { uid, getBaseUrl };