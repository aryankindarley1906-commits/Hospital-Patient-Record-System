'use strict';

try {
  require('dotenv').config();
} catch {
  // dotenv is optional in environments where variables are already injected (e.g. Vercel)
}

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  ensureDbInit,
  verifyPassword,
  newPasswordRecord,
  currentSession,
  createSession,
  destroySession,
  clearSessionCookie,
  audit,
  checkLoginAttempt,
  recordFailedLogin,
  clearLoginAttempts,
  getUserByUsername,
  updateUserPassword,
  loadStoredPatients,
  addPatient,
  updatePatientRecord,
} = require('./db');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const MAX_BODY_BYTES = 32 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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
  // If Vercel or upstream middleware has already parsed the body:
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Array.isArray(req.body)) {
      return Promise.resolve(req.body);
    }
    if (typeof req.body === 'string') {
      try {
        const parsed = JSON.parse(req.body || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return Promise.resolve(parsed);
        }
      } catch {
        return Promise.reject(new HttpError(400, 'Invalid JSON.'));
      }
    }
    return Promise.reject(new HttpError(400, 'A JSON object is required.'));
  }

  // Otherwise, read from incoming request stream (for local Node HTTP server):
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
  if (!origin) return; // Same-origin GET or internal requests
  try {
    const originHost = new URL(origin).host;
    const reqHost = req.headers['x-forwarded-host'] || req.headers.host;
    if (reqHost && originHost === reqHost) {
      return;
    }
    if (originHost === `${HOST}:${PORT}` || originHost === `localhost:${PORT}`) {
      return;
    }
  } catch {
    // Malformed origin
  }
  throw new HttpError(403, 'Request origin was rejected.');
}

async function requireSession(req, res) {
  const session = await currentSession(req, res);
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

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/script.js': ['script.js', 'text/javascript; charset=utf-8'],
};

async function handle(req, res) {
  setSecurityHeaders(res);
  try {
    // Initialize database tables and seed initial records if needed
    await ensureDbInit();

    const host = req.headers['x-forwarded-host'] || req.headers.host || `${HOST}:${PORT}`;
    const parsedUrl = new URL(req.url || '/', `http://${host}`);
    const pathname = parsedUrl.pathname;

    // Serve static files when running the local server
    if (req.method === 'GET' && staticFiles[pathname]) {
      const [filename, contentType] = staticFiles[pathname];
      const filePath = path.join(__dirname, filename);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
        return;
      }
    }

    // GET /api/session
    if (pathname === '/api/session' && req.method === 'GET') {
      const session = await currentSession(req, res);
      json(res, 200, session
        ? { authenticated: true, username: session.username }
        : { authenticated: false });
      return;
    }

    // POST /api/login
    if (pathname === '/api/login' && req.method === 'POST') {
      checkSameOrigin(req);
      const body = await readJson(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (username.length > 40 || password.length > 256) {
        json(res, 400, { error: 'Invalid username or password format.' });
        return;
      }

      const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
                       req.socket?.remoteAddress ||
                       'local';
      const attemptKey = `${clientIp}:${username.toLowerCase()}`;
      const attempt = await checkLoginAttempt(attemptKey);
      if (attempt && attempt.blocked) {
        json(res, 429, { error: 'Too many failed sign-in attempts. Wait one minute and try again.' });
        return;
      }

      const user = await getUserByUsername(username);
      if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
        await recordFailedLogin(attemptKey);
        json(res, 401, { error: 'Invalid username or password.' });
        return;
      }

      await clearLoginAttempts(attemptKey);
      await createSession(username, req, res);
      await audit(username, 'LOGIN');
      json(res, 200, { authenticated: true, username });
      return;
    }

    // POST /api/logout
    if (pathname === '/api/logout' && req.method === 'POST') {
      checkSameOrigin(req);
      const session = await currentSession(req, res);
      if (session) {
        await destroySession(session.token);
        await audit(session.username, 'LOGOUT');
      }
      const isSecure = req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
      clearSessionCookie(res, isSecure);
      json(res, 200, { ok: true });
      return;
    }

    // POST /api/change-password
    if (pathname === '/api/change-password' && req.method === 'POST') {
      checkSameOrigin(req);
      const session = await requireSession(req, res);
      if (!session) return;
      const body = await readJson(req);
      const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

      const user = await getUserByUsername(session.username);
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
      await updateUserPassword(session.username, credentials.salt, credentials.hash);
      await destroySession(session.token);
      await createSession(session.username, req, res);
      await audit(session.username, 'PASSWORD_CHANGED');
      json(res, 200, { ok: true, message: 'Password changed successfully.' });
      return;
    }

    // GET /api/patients
    if (pathname === '/api/patients' && req.method === 'GET') {
      const session = await requireSession(req, res);
      if (!session) return;
      const stored = await loadStoredPatients();
      const patients = stored.map(({ recordKey, ...patient }) => patient);
      json(res, 200, { patients });
      return;
    }

    // POST /api/patients
    if (pathname === '/api/patients' && req.method === 'POST') {
      checkSameOrigin(req);
      const session = await requireSession(req, res);
      if (!session) return;
      const patient = validatePatient(await readJson(req));
      const stored = await loadStoredPatients();
      if (stored.some(item => item.id === patient.id)) {
        json(res, 409, { error: 'That patient ID already exists.' });
        return;
      }
      const recordKey = await addPatient(patient);
      await audit(session.username, 'PATIENT_CREATED', recordKey);
      json(res, 201, { patient });
      return;
    }

    // PUT /api/patients/:id
    const patientMatch = pathname.match(/^\/api\/patients\/(\d+)$/);
    if (patientMatch && req.method === 'PUT') {
      checkSameOrigin(req);
      const session = await requireSession(req, res);
      if (!session) return;
      const pathId = Number(patientMatch[1]);
      const patient = validatePatient(await readJson(req), pathId);
      const stored = await loadStoredPatients();
      const existing = stored.find(item => item.id === pathId);
      if (!existing) {
        json(res, 404, { error: 'Patient was not found.' });
        return;
      }
      await updatePatientRecord(existing.recordKey, patient);
      await audit(session.username, 'PATIENT_UPDATED', existing.recordKey);
      json(res, 200, { patient });
      return;
    }

    json(res, 404, { error: 'Page or API route not found.' });
  } catch (error) {
    if (error instanceof HttpError) {
      json(res, error.status, { error: error.message });
      return;
    }
    console.error('Request handler error:', error);
    json(res, 500, { error: error.message || 'An internal error occurred.' });
  }
}

module.exports = handle;

// When run directly with `node server.js`, start local HTTP server
if (require.main === module) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      console.error('Unhandled server error:', error);
      if (!res.headersSent) json(res, 500, { error: 'Unexpected server error.' });
      else res.end();
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`Hospital Patient Record System is running at http://${HOST}:${PORT}`);
    console.log('Connected to PostgreSQL database configured via DATABASE_URL.');
    console.log('Encryption key loaded from DATA_ENCRYPTION_KEY.');
  });

  function shutDown() {
    server.close(() => {
      const { closeDb } = require('./db');
      closeDb().finally(() => process.exit(0));
    });
  }

  process.on('SIGINT', shutDown);
  process.on('SIGTERM', shutDown);
}
