require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const { init } = require('./db');
const { migrarSmtpPassword } = require('./services/mail');
const { hashPassword } = require('./services/crypto');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

init();
migrarSmtpPassword();

const authRoutes = require('./routes/auth');
const centrosRoutes = require('./routes/centros');
const sedesRoutes = require('./routes/sedes');
const usuariosRoutes = require('./routes/usuarios');
const empleadosRoutes = require('./routes/empleados');
const nominasRoutes = require('./routes/nominas');
const registrosRoutes = require('./routes/registros');
const configRoutes = require('./routes/config');
const backupRoutes = require('./routes/backup');

app.use('/api/auth', authRoutes);
app.use('/api/centros', centrosRoutes);
app.use('/api/sedes', sedesRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/usuario_empleados', usuariosRoutes);
app.use('/api/empleados', empleadosRoutes);
app.use('/api/nominas', nominasRoutes);
app.use('/api/registros', registrosRoutes);
app.use('/api/configuracion', configRoutes);
app.use('/api/backup', backupRoutes);

app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const PORT = process.env.PORT || 3000;

async function seedAdmin() {
  const { getDb } = require('./db');
  const db = getDb();
  const totalUsuarios = db.prepare('SELECT COUNT(*) as c FROM usuarios').get();
  if (totalUsuarios.c === 0) {
    const primerCentro = db.prepare('SELECT nombre FROM centros LIMIT 1').get()?.nombre || 'Principal';
    const bcrypt = require('bcrypt');
    const hash = await hashPassword(process.env.ADMIN_PASS || 'Admin*2026!');
    db.prepare('INSERT INTO usuarios (id,nombre,email,password,rol,sede,activo,creado) VALUES (?,?,?,?,?,?,?,?)').run(
      Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      'Administrador',
      process.env.ADMIN_EMAIL || 'admin@tuempresa.com',
      hash,
      'admin',
      primerCentro,
      1,
      new Date().toISOString()
    );
    console.log('👤 Usuario admin creado: admin@tuempresa.com / Admin*2026!');
  }
}

seedAdmin().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Horix corriendo en puerto ${PORT}`);
  });
});

module.exports = app;