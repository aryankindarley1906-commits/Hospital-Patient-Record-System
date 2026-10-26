'use strict';

// Local educational web app: Node.js HTTP server + SQLite + encrypted patient fields.
// Bind only to loopback. Do not expose this demo directly to a network.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_COOKIE = 'hospital_sid';
const MAX_BODY_BYTES = 32 * 1024;
const DATABASE_PATH = path.join(__dirname, 'hospital.db');
// On POSIX systems, create database and key files with user-only permissions.
try { process.umask(0o077); } catch { /* Not available on some platforms. */ }

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function getKeyPath() {
  const home = os.homedir();
  let base;
  if (process.env.APPDATA) {
    base = process.env.APPDATA;
  } else if (process.platform === 'darwin') {
    base = path.join(home, 'Library', 'Application Support');
  } else {
    base = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  }
  const directory = path.join(base, 'HospitalPatientSystem');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, 'data-key.bin');
}

function loadOrCreateDataKey() {
  const keyPath = getKeyPath();
  if (!fs.existsSync(keyPath)) {
    const newKey = randomBytes(32);
    try {
      fs.writeFileSync(keyPath, newKey, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const key = fs.readFileSync(keyPath);
  if (key.length !== 32) {
    throw new Error(`Encryption key at ${keyPath} must be exactly 32 bytes. Do not delete or edit this file.`);
  }
  try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows may not support POSIX modes. */ }
  return key;
}

const dataKey = loadOrCreateDataKey();
const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS patients (
    record_key TEXT PRIMARY KEY,
    encrypted_record TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    target_key TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL
  );
`);

function passwordHash(password, saltHex) {
  return scryptSync(password, Buffer.from(saltHex, 'hex'), 64).toString('hex');
}

function newPasswordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: passwordHash(password, salt) };
}

function verifyPassword(password, salt, expectedHex) {
  try {
    const actual = Buffer.from(passwordHash(password, salt), 'hex');
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const existingUsers = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
if (existingUsers === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username)) {
    throw new Error('ADMIN_USERNAME must be 3–40 letters, numbers, dots, underscores or hyphens.');
  }
  if (password.length < 12) {
    throw new Error('For first-time setup, ADMIN_PASSWORD must be at least 12 characters.');
  }
  const credentials = newPasswordRecord(password);
  db.prepare('INSERT INTO users (username, salt, password_hash) VALUES (?, ?, ?)')
    .run(username, credentials.salt, credentials.hash);
  console.log(`Created first admin account: ${username}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('FIRST-RUN DEMO PASSWORD: ChangeMe123! — sign in and change it immediately.');
  } else {
    console.log('The initial admin password was read from ADMIN_PASSWORD.');
  }
}

function encryptRecord(record) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(record), 'utf8'),
    cipher.final(),
  ]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

function decryptRecord(payload) {
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('Encrypted record has an invalid format.');
  const [ivText, tagText, encryptedText] = parts;
  const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plain);
}

// Seed clearly fictional demonstration patients only once for a new database.
const demoSeeded = db.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?').get('demo_seeded');
if (!demoSeeded) {
  const patientCount = db.prepare('SELECT COUNT(*) AS count FROM patients').get().count;
  if (patientCount === 0) {
    const insertDemo = db.prepare('INSERT INTO patients (record_key, encrypted_record) VALUES (?, ?)');
    const demoPatients = [
      { id: 101, name: 'Aarav Sharma', age: 25, disease: 'Fever', contact: '0000000001' },
      { id: 102, name: 'Priya Patel', age: 17, disease: 'Cold', contact: '0000000002' },
      { id: 103, name: 'Rohan Verma', age: 65, disease: 'Diabetes', contact: '0000000003' },
    ];
    for (const patient of demoPatients) insertDemo.run(randomUUID(), encryptRecord(patient));
  }
  db.prepare('INSERT OR REPLACE INTO app_settings (setting_key, setting_value) VALUES (?, ?)').run('demo_seeded', 'yes');
}

const sessionStore = new Map();
const loginAttempts = new Map();
const insertAudit = db.prepare('INSERT INTO audit_log (username, action, target_key) VALUES (?, ?, ?)');
function audit(username, action, targetKey = null) {
  insertAudit.run(username, action, targetKey);
}

function parseCookies(req) {
  const result = {};
  for (const item of String(req.headers.cookie || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator > -1) {
      const name = item.slice(0, separator).trim();
      const value = item.slice(separator + 1).trim();
      result[name] = value;
    }
  }
  return result;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function currentSession(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = sessionStore.get(token);
  if (!session) return null;
  if (Date.now() - session.lastActivity > SESSION_IDLE_MS) {
    sessionStore.delete(token);
    return null;
  }
  session.lastActivity = Date.now();
  setSessionCookie(res, token);
  return { ...session, token };
}

function createSession(username, res) {
  const token = randomBytes(32).toString('hex');
  sessionStore.set(token, { username, lastActivity: Date.now() });
  setSessionCookie(res, token);
  return token;
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function json(res, status, value) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      reject(new HttpError(415, 'Send data using application/json.'));
      return;
    }
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'Request body is too large.'));
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new HttpError(400, 'A JSON object is required.'));
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function checkSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${HOST}:${PORT}`) {
    throw new HttpError(403, 'Request origin was rejected. Open the site using the local address shown in the terminal.');
  }
}

function requireSession(req, res) {
  const session = currentSession(req, res);
  if (!session) {
    json(res, 401, { error: 'Your session expired. Please sign in again.' });
    return null;
  }
  return session;
}

function validatePatient(value, expectedId = null) {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'Patient details are required.');
  const id = expectedId === null ? Number(value.id) : expectedId;
  const age = Number(value.age);
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const disease = typeof value.disease === 'string' ? value.disease.trim() : '';
  const contact = typeof value.contact === 'string' ? value.contact.trim() : '';

  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'Patient ID must be a positive whole number.');
  if (!Number.isInteger(age) || age < 0 || age > 130) throw new HttpError(400, 'Age must be a whole number from 0 to 130.');
  if (!name || name.length > 80) throw new HttpError(400, 'Name is required and must be 80 characters or fewer.');
  if (!disease || disease.length > 100) throw new HttpError(400, 'Disease/condition is required and must be 100 characters or fewer.');
  if (!/^[0-9+() .-]{7,20}$/.test(contact)) throw new HttpError(400, 'Contact number must be 7–20 digits or common phone-number symbols.');
  return { id, name, age, disease, contact };
}

function loadStoredPatients() {
  return db.prepare('SELECT record_key, encrypted_record FROM patients ORDER BY created_at, record_key')
    .all()
    .map(row => ({ recordKey: row.record_key, ...decryptRecord(row.encrypted_record) }));
}

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/script.js': ['script.js', 'text/javascript; charset=utf-8'],
};

async function handle(req, res) {
  setSecurityHeaders(res);
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && staticFiles[pathname]) {
      const [filename, contentType] = staticFiles[pathname];
      const content = fs.readFileSync(path.join(__dirname, filename));
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
      return;
    }

    if (pathname === '/api/session' && req.method === 'GET') {
      const session = currentSession(req, res);
      json(res, 200, session
        ? { authenticated: true, username: session.username }
        : { authenticated: false });
      return;
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      checkSameOrigin(req);
      const body = await readJson(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (username.length > 40 || password.length > 256) {
        json(res, 400, { error: 'Invalid username or password format.' });
        return;
      }
      const attemptKey = `${req.socket.remoteAddress || 'local'}:${username.toLowerCase()}`;
      let attempt = loginAttempts.get(attemptKey);
      if (attempt && attempt.blockedUntil && attempt.blockedUntil > Date.now()) {
        json(res, 429, { error: 'Too many failed sign-in attempts. Wait one minute and try again.' });
        return;
      }
      if (attempt && attempt.blockedUntil && attempt.blockedUntil <= Date.now()) {
        loginAttempts.delete(attemptKey);
        attempt = null;
      }
      const user = db.prepare('SELECT username, salt, password_hash FROM users WHERE username = ?').get(username);
      if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
        const nextCount = (attempt ? attempt.count : 0) + 1;
        loginAttempts.set(attemptKey, {
          count: nextCount,
          blockedUntil: nextCount >= 5 ? Date.now() + 60_000 : 0
        });
        json(res, 401, { error: 'Invalid username or password.' });
        return;
      }
      loginAttempts.delete(attemptKey);
      createSession(username, res);
      audit(username, 'LOGIN');
      json(res, 200, { authenticated: true, username });
      return;
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      checkSameOrigin(req);
      const session = currentSession(req, res);
      if (session) {
        sessionStore.delete(session.token);
        audit(session.username, 'LOGOUT');
      }
      clearSessionCookie(res);
      json(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/change-password' && req.method === 'POST') {
      checkSameOrigin(req);
      const session = requireSession(req, res);
      if (!session) return;
      const body = await readJson(req);
      const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
      const user = db.prepare('SELECT salt, password_hash FROM users WHERE username = ?').get(session.username);
      if (!user || !verifyPassword(currentPassword, user.salt, user.password_hash)) {
        json(res, 400, { error: 'Current password is incorrect.' });
        return;
      }
      if (newPassword.length < 12 || newPassword.length > 256) {
        json(res, 400, { error: 'New password must be at least 12 characters long.' });
        return;
      }
      if (newPassword === currentPassword) {
        json(res, 400, { error: 'Choose a different password.' });
        return;
      }
      const credentials = newPasswordRecord(newPassword);
      db.prepare('UPDATE users SET salt = ?, password_hash = ? WHERE username = ?')
        .run(credentials.salt, credentials.hash, session.username);
      sessionStore.delete(session.token);
      createSession(session.username, res);
      audit(session.username, 'PASSWORD_CHANGED');
      json(res, 200, { ok: true, message: 'Password changed successfully.' });
      return;
    }

    if (pathname === '/api/patients' && req.method === 'GET') {
      const session = requireSession(req, res);
      if (!session) return;
      const patients = loadStoredPatients().map(({ recordKey, ...patient }) => patient);
      json(res, 200, { patients });
      return;
    }

    if (pathname === '/api/patients' && req.method === 'POST') {
      checkSameOrigin(req);
      const session = requireSession(req, res);
      if (!session) return;
      const patient = validatePatient(await readJson(req));
      const stored = loadStoredPatients();
      if (stored.some(item => item.id === patient.id)) {
        json(res, 409, { error: 'That patient ID already exists.' });
        return;
      }
      const recordKey = randomUUID();
      db.prepare('INSERT INTO patients (record_key, encrypted_record) VALUES (?, ?)')
        .run(recordKey, encryptRecord(patient));
      audit(session.username, 'PATIENT_CREATED', recordKey);
      json(res, 201, { patient });
      return;
    }

    const patientMatch = pathname.match(/^\/api\/patients\/(\d+)$/);
    if (patientMatch && req.method === 'PUT') {
      checkSameOrigin(req);
      const session = requireSession(req, res);
      if (!session) return;
      const pathId = Number(patientMatch[1]);
      const patient = validatePatient(await readJson(req), pathId);
      const stored = loadStoredPatients();
      const existing = stored.find(item => item.id === pathId);
      if (!existing) {
        json(res, 404, { error: 'Patient was not found.' });
        return;
      }
      db.prepare('UPDATE patients SET encrypted_record = ?, updated_at = CURRENT_TIMESTAMP WHERE record_key = ?')
        .run(encryptRecord(patient), existing.recordKey);
      audit(session.username, 'PATIENT_UPDATED', existing.recordKey);
      json(res, 200, { patient });
      return;
    }

    json(res, 404, { error: 'Page or API route not found.' });
  } catch (error) {
    if (error instanceof HttpError) {
      json(res, error.status, { error: error.message });
      return;
    }
    console.error(error);
    json(res, 500, { error: 'An internal error occurred. Check the server terminal for details.' });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: 'Unexpected server error.' });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Hospital Patient Record System is running at http://${HOST}:${PORT}`);
  console.log(`SQLite database: ${DATABASE_PATH}`);
  console.log('Patient details are encrypted in the database. Access is restricted to this computer.');
  console.log('Keep the database and the separate data-key.bin file backed up together.');
});

function shutDown() {
  server.close(() => {
    try { db.close(); } finally { process.exit(0); }
  });
}
process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);
