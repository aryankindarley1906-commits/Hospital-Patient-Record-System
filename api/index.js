
'use strict';

const db = require('../db');

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body || '{}');
    } catch {
      throw new HttpError(400, 'Invalid JSON.');
    }
  }

  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 32768) {
        reject(new HttpError(413, 'Request body is too large.'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new HttpError(400, 'Invalid JSON.'));
      }
    });

    req.on('error', reject);
  });
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;

  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const expected = `${protocol}://${host}`;

  if (!host || origin !== expected) {
    throw new HttpError(403, 'Request origin rejected.');
  }
}

function validatePatient(value, expectedId = null) {
  if (!value || typeof value !== 'object') {
    throw new HttpError(400, 'Patient details are required.');
  }

  const id = expectedId === null ? Number(value.id) : expectedId;
  const age = Number(value.age);
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const disease = typeof value.disease === 'string'
    ? value.disease.trim() : '';
  const contact = typeof value.contact === 'string'
    ? value.contact.trim() : '';

  if (!Number.isSafeInteger(id) || id < 1) {
    throw new HttpError(400, 'Patient ID must be a positive whole number.');
  }
  if (!Number.isInteger(age) || age < 0 || age > 130) {
    throw new HttpError(400, 'Age must be between 0 and 130.');
  }
  if (!name || name.length > 80) {
    throw new HttpError(400, 'Enter a valid patient name.');
  }
  if (!disease || disease.length > 100) {
    throw new HttpError(400, 'Enter a valid disease or condition.');
  }
  if (!/^[0-9+() .-]{7,20}$/.test(contact)) {
    throw new HttpError(400, 'Enter a valid contact number.');
  }

  return { id, name, age, disease, contact };
}

module.exports = async function handler(req, res) {
  try {
    // Create the PostgreSQL tables on the first request.
    await db.ensureDbInit();

    const url = new URL(
      req.url,
      `https://${req.headers.host || 'localhost'}`
    );
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/api/session' && req.method === 'GET') {
      const session = await db.currentSession(req, res);
      return sendJson(res, 200, session
        ? { authenticated: true, username: session.username }
        : { authenticated: false });
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      checkOrigin(req);

      const body = await readJson(req);
      const username = typeof body.username === 'string'
        ? body.username.trim() : '';
      const password = typeof body.password === 'string'
        ? body.password : '';

      if (username.length > 40 || password.length > 256) {
        throw new HttpError(400, 'Invalid username or password format.');
      }

      const forwarded = req.headers['x-forwarded-for'];
      const ip = typeof forwarded === 'string'
        ? forwarded.split(',')[0].trim()
        : 'unknown';
      const attemptKey = `${ip}:${username.toLowerCase()}`;

      const attempt = await db.checkLoginAttempt(attemptKey);
      if (attempt && attempt.blocked) {
        throw new HttpError(429, 'Too many failed attempts. Try again later.');
      }

      const user = await db.getUserByUsername(username);
      if (!user || !db.verifyPassword(
        password, user.salt, user.password_hash
      )) {
        await db.recordFailedLogin(attemptKey);
        throw new HttpError(401, 'Invalid username or password.');
      }

      await db.clearLoginAttempts(attemptKey);
      await db.createSession(username, req, res);
      await db.audit(username, 'LOGIN');

      return sendJson(res, 200, {
        authenticated: true,
        username
      });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      checkOrigin(req);
      const session = await db.currentSession(req, res);

      if (session) {
        await db.destroySession(session.token);
        await db.audit(session.username, 'LOGOUT');
      }

      db.clearSessionCookie(
        res,
        process.env.VERCEL === '1' ||
        process.env.NODE_ENV === 'production'
      );

      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/change-password' && req.method === 'POST') {
      checkOrigin(req);

      const session = await db.currentSession(req, res);
      if (!session) {
        throw new HttpError(401, 'Please sign in again.');
      }

      const body = await readJson(req);
      const currentPassword = typeof body.currentPassword === 'string'
        ? body.currentPassword : '';
      const newPassword = typeof body.newPassword === 'string'
        ? body.newPassword : '';

      const user = await db.getUserByUsername(session.username);

      if (!user || !db.verifyPassword(
        currentPassword, user.salt, user.password_hash
      )) {
        throw new HttpError(400, 'Current password is incorrect.');
      }
      if (newPassword.length < 12 || newPassword.length > 256) {
        throw new HttpError(400, 'New password must be at least 12 characters.');
      }
      if (newPassword === currentPassword) {
        throw new HttpError(400, 'Choose a different password.');
      }

      const credentials = db.newPasswordRecord(newPassword);
      await db.updateUserPassword(
        session.username,
        credentials.salt,
        credentials.hash
      );

      await db.destroySession(session.token);
      await db.createSession(session.username, req, res);
      await db.audit(session.username, 'PASSWORD_CHANGED');

      return sendJson(res, 200, {
        ok: true,
        message: 'Password changed successfully.'
      });
    }

    if (pathname === '/api/patients' && req.method === 'GET') {
      const session = await db.currentSession(req, res);
      if (!session) throw new HttpError(401, 'Please sign in again.');

      const patients = (await db.loadStoredPatients())
        .map(({ recordKey, ...patient }) => patient);

      return sendJson(res, 200, { patients });
    }

    if (pathname === '/api/patients' && req.method === 'POST') {
      checkOrigin(req);

      const session = await db.currentSession(req, res);
      if (!session) throw new HttpError(401, 'Please sign in again.');

      const patient = validatePatient(await readJson(req));
      const stored = await db.loadStoredPatients();

      if (stored.some(item => item.id === patient.id)) {
        throw new HttpError(409, 'That patient ID already exists.');
      }

      const recordKey = await db.addPatient(patient);
      await db.audit(session.username, 'PATIENT_CREATED', recordKey);

      return sendJson(res, 201, { patient });
    }

    const match = pathname.match(/^\/api\/patients\/(\d+)$/);
    if (match && req.method === 'PUT') {
      checkOrigin(req);

      const session = await db.currentSession(req, res);
      if (!session) throw new HttpError(401, 'Please sign in again.');

      const id = Number(match[1]);
      const patient = validatePatient(await readJson(req), id);
      const stored = await db.loadStoredPatients();
      const existing = stored.find(item => item.id === id);

      if (!existing) {
        throw new HttpError(404, 'Patient was not found.');
      }

      await db.updatePatientRecord(existing.recordKey, patient);
      await db.audit(
        session.username, 'PATIENT_UPDATED', existing.recordKey
      );

      return sendJson(res, 200, { patient });
    }

    return sendJson(res, 404, { error: 'API route not found.' });
  } catch (error) {
    console.error('API error:', error);

    return sendJson(
      res,
      error.status || 500,
      { error: error.status
          ? error.message
          : 'Server error. Check the Vercel runtime logs.' }
    );
  }
};
