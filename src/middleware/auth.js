const { getDb } = require('../db');

function autenticar(rolesPermitidos = []) {
  return (req, res, next) => {
    const db = getDb();
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No autenticado' });

    const sesion = db.prepare('SELECT * FROM sesiones WHERE token = ?').get(token);
    if (!sesion || new Date(sesion.expira) < new Date()) {
      if (sesion) db.prepare('DELETE FROM sesiones WHERE token = ?').run(token);
      return res.status(401).json({ error: 'Sesión expirada' });
    }

    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ? AND activo = 1').get(sesion.usuarioId);
    if (!usuario) return res.status(401).json({ error: 'Usuario inactivo' });

    if (rolesPermitidos.length && !rolesPermitidos.includes(usuario.rol)) {
      return res.status(403).json({ error: 'Sin permisos para esta acción' });
    }

    req.usuario = usuario;
    next();
  };
}

const soloAdmin = autenticar(['admin']);
const adminRrhh = autenticar(['admin', 'rrhh']);
const adminRrhhOp = autenticar(['admin', 'rrhh', 'operador']);
const todosRoles = autenticar(['admin', 'rrhh', 'consulta', 'operador']);

module.exports = { autenticar, soloAdmin, adminRrhh, adminRrhhOp, todosRoles };