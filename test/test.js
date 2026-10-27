'use strict';

const assert = require('node:assert');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { newDb } = require('pg-mem');

const db = require('../db');
const handle = require('../server');

// Mock request / response helper for testing Vercel serverless handler
function invokeHandler(options = {}) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = options.method || 'GET';
    req.url = options.url || '/';
    req.headers = {
      host: '127.0.0.1:3000',
      'content-type': 'application/json',
      ...(options.headers || {}),
    };
    req.socket = { remoteAddress: '127.0.0.1' };

    // Support both pre-parsed req.body (like Vercel) or stream body
    if (options.body !== undefined) {
      req.body = options.body;
    }

    const resHeaders = {};
    let statusCode = 200;
    const chunks = [];

    const res = {
      setHeader(name, value) {
        resHeaders[name.toLowerCase()] = value;
      },
      getHeader(name) {
        return resHeaders[name.toLowerCase()];
      },
      writeHead(status, headers = {}) {
        statusCode = status;
        for (const [k, v] of Object.entries(headers)) {
          resHeaders[k.toLowerCase()] = v;
        }
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        this.writableEnded = true;
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let jsonBody = null;
        try {
          jsonBody = JSON.parse(rawBody);
        } catch {
          // not JSON
        }
        resolve({
          status: statusCode,
          headers: resHeaders,
          body: jsonBody,
          rawBody,
        });
      },
      writableEnded: false,
    };

    handle(req, res).catch((err) => {
      console.error('Unhandled in test invokeHandler:', err);
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });
}

async function runTests() {
  console.log('--- Starting CareTrack Test Suite ---');

  // ==========================================
  // 1. DATA_ENCRYPTION_KEY validation tests
  // ==========================================
  console.log('\n[1] Testing DATA_ENCRYPTION_KEY handling...');

  delete process.env.DATA_ENCRYPTION_KEY;
  db.resetDataKey();
  assert.throws(
    () => db.getDataKey(),
    /DATA_ENCRYPTION_KEY environment variable is required/,
    'Should throw error when DATA_ENCRYPTION_KEY is missing'
  );

  process.env.DATA_ENCRYPTION_KEY = 'short_key';
  db.resetDataKey();
  assert.throws(
    () => db.getDataKey(),
    /must be exactly 32 bytes/,
    'Should throw error when key length is invalid'
  );

  // Test 64-char hex key
  const testHexKey = randomBytes(32).toString('hex');
  process.env.DATA_ENCRYPTION_KEY = testHexKey;
  db.resetDataKey();
  const hexKeyBuffer = db.getDataKey();
  assert.strictEqual(hexKeyBuffer.length, 32, 'Hex key must parse to 32 bytes');

  // Test base64 key
  const testB64Key = randomBytes(32).toString('base64');
  process.env.DATA_ENCRYPTION_KEY = testB64Key;
  db.resetDataKey();
  const b64KeyBuffer = db.getDataKey();
  assert.strictEqual(b64KeyBuffer.length, 32, 'Base64 key must parse to 32 bytes');

  // Keep a stable 32-byte hex key for remaining tests
  process.env.DATA_ENCRYPTION_KEY = testHexKey;
  db.resetDataKey();
  console.log('✔ DATA_ENCRYPTION_KEY validation passed.');

  // ==========================================
  // 2. Encryption & Decryption tests
  // ==========================================
  console.log('\n[2] Testing AES-256-GCM record encryption & decryption...');
  const samplePatient = {
    id: 999,
    name: 'Ada Lovelace',
    age: 36,
    disease: 'Analytical Engine Fever',
    contact: '+1-555-0199',
  };

  const encrypted = db.encryptRecord(samplePatient);
  assert.strictEqual(typeof encrypted, 'string');
  const parts = encrypted.split('.');
  assert.strictEqual(parts.length, 3, 'Encrypted format must be IV.TAG.CIPHERTEXT');

  const decrypted = db.decryptRecord(encrypted);
  assert.deepStrictEqual(decrypted, samplePatient, 'Decrypted record must match original');

  // Test tampering detection
  const tampered = encrypted.slice(0, -4) + 'AAAA';
  assert.throws(
    () => db.decryptRecord(tampered),
    'Tampered ciphertext must fail authentication'
  );
  console.log('✔ AES-256-GCM encryption & decryption passed.');

  // ==========================================
  // 3. Password Hashing tests
  // ==========================================
  console.log('\n[3] Testing scrypt password hashing & verification...');
  const testPassword = 'InitialSecurePassword123!';
  const record = db.newPasswordRecord(testPassword);
  assert(record.salt && record.hash, 'Must generate salt and hash');
  assert.strictEqual(
    db.verifyPassword(testPassword, record.salt, record.hash),
    true,
    'Correct password must verify'
  );
  assert.strictEqual(
    db.verifyPassword('WrongPassword', record.salt, record.hash),
    false,
    'Wrong password must fail'
  );
  console.log('✔ Password hashing & timing-safe verification passed.');

  // ==========================================
  // 4. PostgreSQL In-Memory Database Setup
  // ==========================================
  console.log('\n[4] Initializing in-memory PostgreSQL instance (pg-mem)...');

  // Test production credential enforcement
  process.env.NODE_ENV = 'production';
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;

  const prodTestDb = newDb();
  const prodTestPool = new (prodTestDb.adapters.createPg().Pool)();
  db.setPool(prodTestPool);
  await assert.rejects(
    async () => { await db.ensureDbInit(); },
    /ADMIN_USERNAME and ADMIN_PASSWORD environment variables are required in production/,
    'Production must reject missing admin credentials'
  );

  // Test that production rejects default demo password
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'ChangeMe123!';
  await db.closeDb();
  const prodDefaultDb = newDb();
  const prodDefaultPool = new (prodDefaultDb.adapters.createPg().Pool)();
  db.setPool(prodDefaultPool);
  await assert.rejects(
    async () => { await db.ensureDbInit(); },
    /In production, ADMIN_PASSWORD cannot be a default demo password/,
    'Production must reject default demo password'
  );

  // Now initialize with valid production credentials
  const initialPassword = 'SecureAdminPass_2026!';
  process.env.ADMIN_USERNAME = 'hospital_admin';
  process.env.ADMIN_PASSWORD = initialPassword;

  await db.closeDb();
  const memDb = newDb();
  const memPg = memDb.adapters.createPg();
  const testPool = new memPg.Pool();
  db.setPool(testPool);

  await db.ensureDbInit();

  // Verify users table seeded with custom username
  const userCheck = await testPool.query('SELECT username FROM users WHERE username = $1', ['hospital_admin']);
  assert.strictEqual(userCheck.rows.length, 1, 'Custom admin user must be seeded in users table');

  // Verify demo patients seeded
  const patientsCheck = await testPool.query('SELECT COUNT(*) AS count FROM patients');
  assert.strictEqual(Number(patientsCheck.rows[0].count), 3, 'Demo patients must be seeded');

  // Verify app_settings recorded demo_seeded
  const settingsCheck = await testPool.query('SELECT setting_value FROM app_settings WHERE setting_key = $1', ['demo_seeded']);
  assert.strictEqual(settingsCheck.rows[0].setting_value, 'yes', 'demo_seeded setting must be "yes"');

  // Idempotency check: running ensureDbInit again must not throw or duplicate
  await db.ensureDbInit();
  const patientsCheck2 = await testPool.query('SELECT COUNT(*) AS count FROM patients');
  assert.strictEqual(Number(patientsCheck2.rows[0].count), 3, 'Idempotent: patient count unchanged');
  console.log('✔ Database schema initialization and production credential enforcement verified.');

  // ==========================================
  // 5. Full API Endpoints Flow
  // ==========================================
  console.log('\n[5] Testing Serverless API routes, auth, session persistence, and patient management...');

  // 5.1 GET /api/session unauthenticated
  const sessionRes1 = await invokeHandler({ method: 'GET', url: '/api/session' });
  assert.strictEqual(sessionRes1.status, 200);
  assert.strictEqual(sessionRes1.body.authenticated, false, 'Unauthenticated user check');

  // 5.2 POST /api/login with wrong credentials
  const badLoginRes = await invokeHandler({
    method: 'POST',
    url: '/api/login',
    body: { username: 'hospital_admin', password: 'WrongPassword999' },
  });
  assert.strictEqual(badLoginRes.status, 401);
  assert.strictEqual(badLoginRes.body.error, 'Invalid username or password.');

  // 5.3 Rate limiting test: perform 4 more bad attempts (total 5)
  for (let i = 0; i < 4; i++) {
    await invokeHandler({
      method: 'POST',
      url: '/api/login',
      body: { username: 'hospital_admin', password: 'WrongPassword999' },
    });
  }
  const rateLimitedRes = await invokeHandler({
    method: 'POST',
    url: '/api/login',
    body: { username: 'hospital_admin', password: initialPassword },
  });
  assert.strictEqual(rateLimitedRes.status, 429, '5 failed attempts should trigger 429 rate limit');
  assert.match(rateLimitedRes.body.error, /Too many failed sign-in attempts/);

  // Clear rate limit for continuing test
  await db.clearLoginAttempts('127.0.0.1:hospital_admin');

  // 5.4 POST /api/login with valid credentials
  const loginRes = await invokeHandler({
    method: 'POST',
    url: '/api/login',
    body: { username: 'hospital_admin', password: initialPassword },
  });
  assert.strictEqual(loginRes.status, 200);
  assert.strictEqual(loginRes.body.authenticated, true);
  assert.strictEqual(loginRes.body.username, 'hospital_admin');

  const setCookieHeader = loginRes.headers['set-cookie'];
  assert(setCookieHeader, 'Must set session cookie');
  const sessionTokenMatch = setCookieHeader.match(/hospital_sid=([0-9a-fA-F]+);/);
  assert(sessionTokenMatch, 'Cookie must contain hospital_sid token');
  const sessionCookie = `hospital_sid=${sessionTokenMatch[1]}`;

  // 5.5 GET /api/session with session cookie
  const sessionRes2 = await invokeHandler({
    method: 'GET',
    url: '/api/session',
    headers: { cookie: sessionCookie },
  });
  assert.strictEqual(sessionRes2.status, 200);
  assert.strictEqual(sessionRes2.body.authenticated, true);
  assert.strictEqual(sessionRes2.body.username, 'hospital_admin');

  // 5.6 GET /api/patients
  const patientsRes = await invokeHandler({
    method: 'GET',
    url: '/api/patients',
    headers: { cookie: sessionCookie },
  });
  assert.strictEqual(patientsRes.status, 200);
  assert.strictEqual(Array.isArray(patientsRes.body.patients), true);
  assert.strictEqual(patientsRes.body.patients.length, 3, 'Must return 3 decrypted demo patients');
  const patient101 = patientsRes.body.patients.find(p => p.id === 101);
  assert(patient101, 'Patient 101 must be present');
  assert.strictEqual(patient101.name, 'Aarav Sharma');

  // 5.7 POST /api/patients (add patient)
  const newPatientData = {
    id: 104,
    name: 'Maya Lin',
    age: 29,
    disease: 'Migraine',
    contact: '+1-555-0104',
  };
  const addPatientRes = await invokeHandler({
    method: 'POST',
    url: '/api/patients',
    headers: { cookie: sessionCookie },
    body: newPatientData,
  });
  assert.strictEqual(addPatientRes.status, 201);
  assert.deepStrictEqual(addPatientRes.body.patient, newPatientData);

  // 5.8 POST /api/patients with duplicate ID
  const dupPatientRes = await invokeHandler({
    method: 'POST',
    url: '/api/patients',
    headers: { cookie: sessionCookie },
    body: newPatientData,
  });
  assert.strictEqual(dupPatientRes.status, 409);
  assert.strictEqual(dupPatientRes.body.error, 'That patient ID already exists.');

  // 5.9 PUT /api/patients/:id (update patient)
  const updatedData = {
    id: 104,
    name: 'Maya Lin Updated',
    age: 30,
    disease: 'Tension Headache',
    contact: '+1-555-0199',
  };
  const updateRes = await invokeHandler({
    method: 'PUT',
    url: '/api/patients/104',
    headers: { cookie: sessionCookie },
    body: updatedData,
  });
  assert.strictEqual(updateRes.status, 200);
  assert.deepStrictEqual(updateRes.body.patient, updatedData);

  // Verify updated list
  const patientsResAfterUpdate = await invokeHandler({
    method: 'GET',
    url: '/api/patients',
    headers: { cookie: sessionCookie },
  });
  assert.strictEqual(patientsResAfterUpdate.body.patients.length, 4);
  const found = patientsResAfterUpdate.body.patients.find(p => p.id === 104);
  assert.deepStrictEqual(found, updatedData);

  // 5.10 POST /api/change-password
  const changePassRes = await invokeHandler({
    method: 'POST',
    url: '/api/change-password',
    headers: { cookie: sessionCookie },
    body: {
      currentPassword: initialPassword,
      newPassword: 'MyNewSecurePassword123!',
    },
  });
  assert.strictEqual(changePassRes.status, 200);
  assert.strictEqual(changePassRes.body.ok, true);

  // Get new session cookie from change-password response
  const newSetCookie = changePassRes.headers['set-cookie'];
  assert(newSetCookie, 'Must set new session cookie upon password change');
  const newSessionTokenMatch = newSetCookie.match(/hospital_sid=([0-9a-fA-F]+);/);
  const newSessionCookie = `hospital_sid=${newSessionTokenMatch[1]}`;

  // Verify old password fails login
  const oldLoginCheck = await invokeHandler({
    method: 'POST',
    url: '/api/login',
    body: { username: 'hospital_admin', password: initialPassword },
  });
  assert.strictEqual(oldLoginCheck.status, 401);

  // Verify new password succeeds login
  const newLoginCheck = await invokeHandler({
    method: 'POST',
    url: '/api/login',
    body: { username: 'hospital_admin', password: 'MyNewSecurePassword123!' },
  });
  assert.strictEqual(newLoginCheck.status, 200);

  // 5.11 CSRF / Origin Check
  const evilOriginRes = await invokeHandler({
    method: 'POST',
    url: '/api/patients',
    headers: {
      cookie: newSessionCookie,
      origin: 'https://malicious-attacker-site.com',
    },
    body: { id: 105, name: 'Attacker', age: 20, disease: 'None', contact: '1234567890' },
  });
  assert.strictEqual(evilOriginRes.status, 403, 'Foreign Origin header must be blocked with 403');

  // 5.12 POST /api/logout
  const logoutRes = await invokeHandler({
    method: 'POST',
    url: '/api/logout',
    headers: { cookie: newSessionCookie },
    body: {},
  });
  assert.strictEqual(logoutRes.status, 200);
  assert.strictEqual(logoutRes.body.ok, true);
  assert.match(logoutRes.headers['set-cookie'], /Max-Age=0/, 'Logout must clear cookie');

  // 5.13 Verify session is invalid after logout
  const sessionAfterLogout = await invokeHandler({
    method: 'GET',
    url: '/api/session',
    headers: { cookie: newSessionCookie },
  });
  assert.strictEqual(sessionAfterLogout.body.authenticated, false);

  // 5.14 Verify patient access blocked after logout
  const patientsAfterLogout = await invokeHandler({
    method: 'GET',
    url: '/api/patients',
    headers: { cookie: newSessionCookie },
  });
  assert.strictEqual(patientsAfterLogout.status, 401);

  // 5.15 Audit log check
  const auditRes = await testPool.query('SELECT action, username, target_key FROM audit_log ORDER BY id');
  const actions = auditRes.rows.map(r => r.action);
  console.log('Recorded audit actions:', actions);
  assert(actions.includes('LOGIN'), 'Audit log must record LOGIN');
  assert(actions.includes('PATIENT_CREATED'), 'Audit log must record PATIENT_CREATED');
  assert(actions.includes('PATIENT_UPDATED'), 'Audit log must record PATIENT_UPDATED');
  assert(actions.includes('PASSWORD_CHANGED'), 'Audit log must record PASSWORD_CHANGED');
  assert(actions.includes('LOGOUT'), 'Audit log must record LOGOUT');

  // ==========================================
  // 6. Test api/index.js entry point export
  // ==========================================
  console.log('\n[6] Testing api/index.js Vercel entry point...');
  const vercelEntry = require('../api/index');
  assert.strictEqual(typeof vercelEntry, 'function', 'api/index.js must export a handler function');

  console.log('\n=============================================');
  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! (100% OK)');
  console.log('=============================================');
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
