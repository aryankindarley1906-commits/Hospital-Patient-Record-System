'use strict';

const {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} = require('node:crypto');
const { Pool } = require('pg');

let pool = null;
let cachedDataKey = null;
let initPromise = null;

const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_COOKIE = 'hospital_sid';

/**
 * Loads and validates the 32-byte encryption key from DATA_ENCRYPTION_KEY.
 * Accepts:
 *   - 64-char hex string (32 bytes)
 *   - 44-char base64 string (32 bytes)
 *   - 32-character raw UTF-8 string (32 bytes)
 */
function getDataKey() {
  if (cachedDataKey) return cachedDataKey;

  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    throw new Error(
      'DATA_ENCRYPTION_KEY environment variable is required. It must be exactly 32 bytes.\n' +
      'Generate one using: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  const trimmed = raw.trim();

  // 64-character hex string -> 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    cachedDataKey = Buffer.from(trimmed, 'hex');
    return cachedDataKey;
  }

  // Base64 string that decodes to 32 bytes
  if (/^[A-Za-z0-9+/=]{43,44}$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length === 32) {
      cachedDataKey = buf;
      return cachedDataKey;
    }
  }

  // Raw UTF-8 string of exactly 32 bytes
  const utf8Buf = Buffer.from(trimmed, 'utf8');
  if (utf8Buf.length === 32) {
    cachedDataKey = utf8Buf;
    return cachedDataKey;
  }

  throw new Error(
    `DATA_ENCRYPTION_KEY must be exactly 32 bytes (received ${utf8Buf.length} UTF-8 bytes).\n` +
    'Provide a 64-character hex string generated with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}

function setDataKey(keyBuffer) {
  if (!Buffer.isBuffer(keyBuffer) || keyBuffer.length !== 32) {
    throw new Error('Key must be a 32-byte Buffer.');
  }
  cachedDataKey = keyBuffer;
}

function resetDataKey() {
  cachedDataKey = null;
}

/**
 * Gets or creates the PostgreSQL connection pool.
 */
function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL environment variable is required to connect to PostgreSQL.\n' +
      'Example: postgresql://username:password@hostname:5432/dbname?sslmode=require'
    );
  }

  const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
  const sslConfig = isLocal ? false : { rejectUnauthorized: false };

  pool = new Pool({
    connectionString,
    ssl: sslConfig,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    console.error('Unexpected error on idle PostgreSQL client:', err);
  });

  return pool;
}

function setPool(customPool) {
  pool = customPool;
}

async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
  initPromise = null;
}

/**
 * Encrypts a record using AES-256-GCM and the 32-byte data key.
 */
function encryptRecord(record) {
  const key = getDataKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(record), 'utf8'),
    cipher.final(),
  ]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

/**
 * Decrypts a record using AES-256-GCM and the 32-byte data key.
 */
function decryptRecord(payload) {
  const key = getDataKey();
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('Encrypted record has an invalid format.');
  const [ivText, tagText, encryptedText] = parts;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plain);
}

/**
 * Password hashing using scrypt.
 */
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

/**
 * Ensures database schema tables exist and initial admin / demo data is seeded.
 */
async function ensureDbInit() {
  if (!initPromise) {
    initPromise = (async () => {
      const db = getPool();

      // Create tables if they do not exist
      await db.query(`
        CREATE TABLE IF NOT EXISTS users (
          username TEXT PRIMARY KEY,
          salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS patients (
          record_key TEXT PRIMARY KEY,
          encrypted_record TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS audit_log (
          id SERIAL PRIMARY KEY,
          username TEXT NOT NULL,
          action TEXT NOT NULL,
          target_key TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS app_settings (
          setting_key TEXT PRIMARY KEY,
          setting_value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          last_activity BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS login_attempts (
          ip_username TEXT PRIMARY KEY,
          count INT NOT NULL,
          blocked_until BIGINT NOT NULL
        );
      `);

      // Seed initial admin user if none exists
      const userRes = await db.query('SELECT COUNT(*) AS count FROM users');
      if (Number(userRes.rows[0].count) === 0) {
        const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
        const rawUsername = (process.env.ADMIN_USERNAME || '').trim();
        const rawPassword = process.env.ADMIN_PASSWORD || '';

        if (isProduction) {
          if (!rawUsername || !rawPassword) {
            throw new Error(
              'ADMIN_USERNAME and ADMIN_PASSWORD environment variables are required in production.\n' +
              'Default credentials are strictly not permitted in production.'
            );
          }
          if (rawPassword === 'ChangeMe123!' || rawPassword.toLowerCase().includes('changeme')) {
            throw new Error('In production, ADMIN_PASSWORD cannot be a default demo password.');
          }
        }

        const username = rawUsername || 'admin';
        const password = rawPassword || (isProduction ? '' : 'DevDemoPassword123!');

        if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username)) {
          throw new Error('ADMIN_USERNAME must be 3–40 letters, numbers, dots, underscores or hyphens.');
        }
        if (password.length < 12) {
          throw new Error('ADMIN_PASSWORD must be at least 12 characters long.');
        }

        const credentials = newPasswordRecord(password);
        await db.query(
          'INSERT INTO users (username, salt, password_hash) VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING',
          [username, credentials.salt, credentials.hash]
        );
        console.log(`Created initial admin account: ${username}`);
      }

      // Seed demo patients once if table is empty
      const demoRes = await db.query('SELECT setting_value FROM app_settings WHERE setting_key = $1', ['demo_seeded']);
      if (demoRes.rows.length === 0) {
        const patientCountRes = await db.query('SELECT COUNT(*) AS count FROM patients');
        if (Number(patientCountRes.rows[0].count) === 0) {
          const demoPatients = [
            { id: 101, name: 'Aarav Sharma', age: 25, disease: 'Fever', contact: '0000000001' },
            { id: 102, name: 'Priya Patel', age: 17, disease: 'Cold', contact: '0000000002' },
            { id: 103, name: 'Rohan Verma', age: 65, disease: 'Diabetes', contact: '0000000003' },
          ];
          for (const patient of demoPatients) {
            await db.query(
              'INSERT INTO patients (record_key, encrypted_record) VALUES ($1, $2) ON CONFLICT (record_key) DO NOTHING',
              [randomUUID(), encryptRecord(patient)]
            );
          }
        }
        await db.query(
          'INSERT INTO app_settings (setting_key, setting_value) VALUES ($1, $2) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value',
          ['demo_seeded', 'yes']
        );
      }
    })().catch(err => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
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

function setSessionCookie(res, token, isSecure) {
  const secureFlag = isSecure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800${secureFlag}`
  );
}

function clearSessionCookie(res, isSecure) {
  const secureFlag = isSecure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureFlag}`
  );
}

async function currentSession(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;

  const db = getPool();
  const result = await db.query('SELECT username, last_activity FROM sessions WHERE token = $1', [token]);
  if (result.rows.length === 0) return null;

  const session = result.rows[0];
  const lastActivity = Number(session.last_activity);
  if (Date.now() - lastActivity > SESSION_IDLE_MS) {
    await db.query('DELETE FROM sessions WHERE token = $1', [token]);
    return null;
  }

  const isSecure = req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
  await db.query('UPDATE sessions SET last_activity = $1 WHERE token = $2', [Date.now(), token]);
  setSessionCookie(res, token, isSecure);
  return { username: session.username, token };
}

async function createSession(username, req, res) {
  const token = randomBytes(32).toString('hex');
  const db = getPool();
  await db.query('INSERT INTO sessions (token, username, last_activity) VALUES ($1, $2, $3)', [
    token,
    username,
    Date.now(),
  ]);
  const isSecure = req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
  setSessionCookie(res, token, isSecure);
  return token;
}

async function destroySession(token) {
  if (!token) return;
  const db = getPool();
  await db.query('DELETE FROM sessions WHERE token = $1', [token]);
}

async function audit(username, action, targetKey = null) {
  try {
    const db = getPool();
    await db.query('INSERT INTO audit_log (username, action, target_key) VALUES ($1, $2, $3)', [
      username,
      action,
      targetKey,
    ]);
  } catch (err) {
    console.error('Audit logging error:', err);
  }
}

async function checkLoginAttempt(attemptKey) {
  const db = getPool();
  const res = await db.query('SELECT count, blocked_until FROM login_attempts WHERE ip_username = $1', [attemptKey]);
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  const blockedUntil = Number(row.blocked_until);
  if (blockedUntil > Date.now()) {
    return { blocked: true, count: Number(row.count) };
  }
  if (blockedUntil > 0 && blockedUntil <= Date.now()) {
    await db.query('DELETE FROM login_attempts WHERE ip_username = $1', [attemptKey]);
    return null;
  }
  return { blocked: false, count: Number(row.count) };
}

async function recordFailedLogin(attemptKey) {
  const db = getPool();
  const res = await db.query('SELECT count FROM login_attempts WHERE ip_username = $1', [attemptKey]);
  const currentCount = res.rows.length > 0 ? Number(res.rows[0].count) : 0;
  const nextCount = currentCount + 1;
  const blockedUntil = nextCount >= 5 ? Date.now() + 60_000 : 0;
  await db.query(`
    INSERT INTO login_attempts (ip_username, count, blocked_until)
    VALUES ($1, $2, $3)
    ON CONFLICT (ip_username)
    DO UPDATE SET count = EXCLUDED.count, blocked_until = EXCLUDED.blocked_until
  `, [attemptKey, nextCount, blockedUntil]);
}

async function clearLoginAttempts(attemptKey) {
  const db = getPool();
  await db.query('DELETE FROM login_attempts WHERE ip_username = $1', [attemptKey]);
}

async function getUserByUsername(username) {
  const db = getPool();
  const res = await db.query('SELECT username, salt, password_hash FROM users WHERE username = $1', [username]);
  return res.rows[0] || null;
}

async function updateUserPassword(username, salt, passwordHash) {
  const db = getPool();
  await db.query('UPDATE users SET salt = $1, password_hash = $2 WHERE username = $3', [
    salt,
    passwordHash,
    username,
  ]);
}

async function loadStoredPatients() {
  const db = getPool();
  const res = await db.query('SELECT record_key, encrypted_record FROM patients ORDER BY created_at, record_key');
  return res.rows.map(row => ({
    recordKey: row.record_key,
    ...decryptRecord(row.encrypted_record),
  }));
}

async function addPatient(patient) {
  const db = getPool();
  const recordKey = randomUUID();
  await db.query('INSERT INTO patients (record_key, encrypted_record) VALUES ($1, $2)', [
    recordKey,
    encryptRecord(patient),
  ]);
  return recordKey;
}

async function updatePatientRecord(recordKey, patient) {
  const db = getPool();
  await db.query(
    'UPDATE patients SET encrypted_record = $1, updated_at = CURRENT_TIMESTAMP WHERE record_key = $2',
    [encryptRecord(patient), recordKey]
  );
}

module.exports = {
  SESSION_IDLE_MS,
  SESSION_COOKIE,
  getDataKey,
  setDataKey,
  resetDataKey,
  getPool,
  setPool,
  closeDb,
  ensureDbInit,
  encryptRecord,
  decryptRecord,
  passwordHash,
  newPasswordRecord,
  verifyPassword,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  currentSession,
  createSession,
  destroySession,
  audit,
  checkLoginAttempt,
  recordFailedLogin,
  clearLoginAttempts,
  getUserByUsername,
  updateUserPassword,
  loadStoredPatients,
  addPatient,
  updatePatientRecord,
};
