const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { uid } = require('../utils/helpers');

const DB_PATH = process.env.DB_PATH || 'horas_extra.db';

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

function initTables() {
  const db = getDb();

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
      sede        TEXT NOT NULL DEFAULT 'Principal'
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
}

function runMigrations() {
  const db = getDb();

  const migrations = [
    'ALTER TABLE registros  ADD COLUMN concepto TEXT NOT NULL DEFAULT ""',
    'ALTER TABLE registros  ADD COLUMN creadoPor TEXT NOT NULL DEFAULT ""',
    'ALTER TABLE registros  ADD COLUMN sede TEXT NOT NULL DEFAULT "Principal"',
    'ALTER TABLE registros  ADD COLUMN observaciones TEXT NOT NULL DEFAULT ""',
    'ALTER TABLE registros  ADD COLUMN transporte REAL NOT NULL DEFAULT 0',
    'ALTER TABLE empleados  ADD COLUMN sede TEXT NOT NULL DEFAULT "Principal"',
    'ALTER TABLE usuarios   ADD COLUMN sede TEXT NOT NULL DEFAULT "Principal"',
    'ALTER TABLE usuarios   ADD COLUMN cambio_password INTEGER NOT NULL DEFAULT 0',
  ];

  for (const sql of migrations) {
    try { db.exec(sql); } catch {}
  }
}

function seedDefaults() {
  const db = getDb();

  const defaults = {
    smtp_host:      '',
    smtp_puerto:    '',
    smtp_tls:       '',
    smtp_usuario:   '',
    smtp_password:  '',
    smtp_remitente: 'Horix <mail@tuempresa.com>',
    reset_asunto:   'Recuperación de contraseña — Horix',
    reset_cuerpo:   `Hola {nombre},\n\nRecibimos una solicitud para restablecer tu contraseña.\n\nHaz clic en el siguiente enlace (válido por 30 minutos):\n{enlace}\n\nSi no solicitaste esto, ignora este correo.\n\nSaludos,\nEquipo Horix`,
  };

  for (const [clave, valor] of Object.entries(defaults)) {
    const existe = db.prepare('SELECT clave FROM configuracion WHERE clave = ?').get(clave);
    if (!existe) db.prepare('INSERT INTO configuracion VALUES (?,?)').run(clave, valor);
  }
}

function seedCentroInicial() {
  const db = getDb();
  const totalCentros = db.prepare('SELECT COUNT(*) as n FROM centros').get().n;
  if (totalCentros === 0) {
    db.prepare('INSERT INTO centros (id,nombre,activo,creado) VALUES (?,?,1,?)').run(uid(), 'Principal', new Date().toISOString());
    console.log('🏢 Centro de operación inicial creado: Principal');
  }
}

function init() {
  initTables();
  runMigrations();
  seedDefaults();
  seedCentroInicial();
  console.log('✅ Base de datos inicializada');
}

module.exports = { getDb, init };