const path = require('path');
const fs = require('fs');
const os = require('os');
const AdmZip = require('adm-zip');

const APP_DIR = process.cwd();
const BACKUP_DIR = path.join(os.homedir(), 'backups', 'horix');

function getConfig() {
  const db = require('./db');
  const cfgDb = db.prepare('SELECT clave, valor FROM configuracion').all();
  return Object.fromEntries(cfgDb.map(r => [r.clave, r.valor]));
}

async function generarBackup() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const cfg = getConfig();
  const fecha = new Date().toISOString().slice(0, 10);
  const filename = `horix_backup_${fecha}_${Date.now()}.zip`;
  const fullPath = path.join(BACKUP_DIR, filename);

  const zip = new AdmZip();
  const db = require('./db');

  const agregar = (sql, nombre) => {
    try {
      const data = db.prepare(sql).all();
      zip.addFile(`${nombre}.json`, Buffer.from(JSON.stringify(data, null, 2), 'utf8');
      console.log(`[Backup] ${nombre}: ${data.length} registros`);
    } catch (e) {
      console.log(`[Backup] Error ${nombre}: ${e.message}`);
    }
  };

  agregar('SELECT * FROM usuarios', 'usuarios');
  agregar('SELECT * FROM empleados', 'empleados');
  agregar('SELECT * FROM nominas', 'nominas');
  agregar('SELECT * FROM registros', 'registros');
  agregar('SELECT clave, valor FROM configuracion', 'configuracion');

  zip.writeZip(fullPath);
  console.log(`[Backup] Guardado: ${filename}`);

  // Retención
  const retention = parseInt(cfg.backup_auto_retention || 7);
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('horix_backup_') && f.endsWith('.zip')).sort().reverse();
  for (const f of files.slice(retention)) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      console.log(`[Backup] Eliminado: ${f}`);
    } catch (e) {}
  }

  console.log(`[Backup] Completado`);
}

generarBackup().catch(e => {
  console.error(`[Backup] Error: ${e.message}`);
  process.exit(1);
});