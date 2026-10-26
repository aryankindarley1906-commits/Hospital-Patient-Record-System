'use strict';

// The browser keeps patient records in an array while the SQLite database on
// the local server remains the durable source of truth.
const patients = [];
let editingId = null;
let currentUsername = '';

const $ = id => document.getElementById(id);

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'same-origin',
    cache: 'no-store'
  });
  let result = {};
  try { result = await response.json(); } catch { /* server may return an empty body */ }
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/login') {
      showLogin();
      $('loginError').textContent = 'Your session expired. Please sign in again.';
    }
    throw new Error(result.error || `Request failed (${response.status}).`);
  }
  return result;
}

function setStatus(message) {
  $('statusMessage').textContent = message;
}

function showLogin() {
  $('loginView').hidden = false;
  $('appView').hidden = true;
  $('appActions').hidden = true;
  closePatientForm();
  closePasswordForm();
}

function showApp(username) {
  currentUsername = username;
  $('signedInUser').textContent = username;
  $('loginView').hidden = true;
  $('appView').hidden = false;
  $('appActions').hidden = false;
  $('loginError').textContent = '';
}

async function loadPatients() {
  const result = await api('/api/patients');
  patients.splice(0, patients.length, ...result.patients);
  renderPatients();
}

function renderPatients() {
  const query = $('searchInput').value.trim().toLocaleLowerCase();
  const sortBy = $('sortSelect').value;
  const visible = patients.filter(patient =>
    String(patient.id).includes(query) ||
    patient.name.toLocaleLowerCase().includes(query) ||
    patient.disease.toLocaleLowerCase().includes(query)
  );

  visible.sort((left, right) => {
    if (sortBy === 'name') return left.name.localeCompare(right.name);
    if (sortBy === 'age') return left.age - right.age || left.id - right.id;
    return left.id - right.id;
  });

  const table = $('patientTable');
  table.replaceChildren();

  for (const patient of visible) {
    const row = document.createElement('tr');

    const patientCell = document.createElement('td');
    const name = document.createElement('div');
    name.className = 'patient-name';
    name.textContent = patient.name;
    const id = document.createElement('div');
    id.className = 'patient-id';
    id.textContent = `ID: ${patient.id}`;
    patientCell.append(name, id);

    const ageCell = document.createElement('td');
    const agePill = document.createElement('span');
    agePill.className = 'age-pill';
    agePill.textContent = patient.age;
    ageCell.appendChild(agePill);

    const diseaseCell = document.createElement('td');
    diseaseCell.textContent = patient.disease;
    const contactCell = document.createElement('td');
    contactCell.textContent = patient.contact;

    const actionCell = document.createElement('td');
    actionCell.className = 'action-cell';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'edit-button';
    edit.textContent = 'Edit record';
    edit.addEventListener('click', () => openEdit(patient.id));
    actionCell.appendChild(edit);

    row.append(patientCell, ageCell, diseaseCell, contactCell, actionCell);
    table.appendChild(row);
  }

  $('emptyState').hidden = visible.length !== 0;
  $('visibleCount').textContent = `${visible.length} record${visible.length === 1 ? '' : 's'}`;
  $('totalCount').textContent = patients.length;
  $('minorCount').textContent = patients.filter(patient => patient.age < 18).length;
  $('seniorCount').textContent = patients.filter(patient => patient.age >= 60).length;
}

function closePatientForm() {
  $('formPanel').hidden = true;
  $('patientForm').reset();
  $('patientId').disabled = false;
  $('formError').textContent = '';
  editingId = null;
}

function closePasswordForm() {
  $('passwordPanel').hidden = true;
  $('passwordForm').reset();
  $('passwordError').textContent = '';
}

function openAdd() {
  closePasswordForm();
  closePatientForm();
  $('formHeading').textContent = 'Add patient';
  $('saveBtn').textContent = 'Save patient';
  $('formPanel').hidden = false;
  $('patientId').disabled = false;
  $('formPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('patientId').focus();
}

function openEdit(patientId) {
  const patient = patients.find(item => item.id === patientId);
  if (!patient) return;
  closePasswordForm();
  closePatientForm();
  editingId = patientId;
  $('formHeading').textContent = `Update patient #${patientId}`;
  $('saveBtn').textContent = 'Save changes';
  $('patientId').value = patient.id;
  $('patientId').disabled = true;
  $('patientName').value = patient.name;
  $('patientAge').value = patient.age;
  $('patientDisease').value = patient.disease;
  $('patientContact').value = patient.contact;
  $('formPanel').hidden = false;
  $('formPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openPasswordForm() {
  closePatientForm();
  $('passwordPanel').hidden = false;
  $('passwordPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('currentPassword').focus();
}

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('loginError').textContent = '';
  $('loginBtn').disabled = true;
  try {
    const result = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('loginUsername').value.trim(),
        password: $('loginPassword').value
      })
    });
    $('loginPassword').value = '';
    showApp(result.username);
    await loadPatients();
    setStatus('Signed in. Your records are loaded from the local database.');
  } catch (error) {
    $('loginError').textContent = error.message;
  } finally {
    $('loginBtn').disabled = false;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch { /* clear local view regardless */ }
  patients.length = 0;
  $('searchInput').value = '';
  $('loginPassword').value = '';
  showLogin();
});

$('addBtn').addEventListener('click', openAdd);
$('closeFormBtn').addEventListener('click', closePatientForm);
$('cancelBtn').addEventListener('click', closePatientForm);
$('changePasswordBtn').addEventListener('click', openPasswordForm);
$('closePasswordBtn').addEventListener('click', closePasswordForm);
$('cancelPasswordBtn').addEventListener('click', closePasswordForm);
$('searchInput').addEventListener('input', renderPatients);
$('sortSelect').addEventListener('change', renderPatients);

$('patientForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('formError').textContent = '';
  const id = Number($('patientId').value);
  const age = Number($('patientAge').value);
  const patient = {
    id,
    name: $('patientName').value.trim(),
    age,
    disease: $('patientDisease').value.trim(),
    contact: $('patientContact').value.trim()
  };

  if (!Number.isSafeInteger(patient.id) || patient.id < 1) {
    $('formError').textContent = 'Patient ID must be a positive whole number.';
    return;
  }
  if (!Number.isInteger(patient.age) || patient.age < 0 || patient.age > 130) {
    $('formError').textContent = 'Age must be a whole number from 0 to 130.';
    return;
  }
  if (!patient.name || !patient.disease || !/^[0-9+() .-]{7,20}$/.test(patient.contact)) {
    $('formError').textContent = 'Enter a name, disease/condition and a valid contact number.';
    return;
  }

  $('saveBtn').disabled = true;
  try {
    if (editingId === null) {
      await api('/api/patients', { method: 'POST', body: JSON.stringify(patient) });
      setStatus('Patient added and saved to the database.');
    } else {
      await api(`/api/patients/${editingId}`, { method: 'PUT', body: JSON.stringify(patient) });
      setStatus('Patient details updated and saved to the database.');
    }
    closePatientForm();
    await loadPatients();
  } catch (error) {
    $('formError').textContent = error.message;
  } finally {
    $('saveBtn').disabled = false;
  }
});

$('passwordForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('passwordError').textContent = '';
  const currentPassword = $('currentPassword').value;
  const newPassword = $('newPassword').value;
  const confirmPassword = $('confirmPassword').value;

  if (newPassword.length < 12) {
    $('passwordError').textContent = 'Choose a new password with at least 12 characters.';
    return;
  }
  if (newPassword !== confirmPassword) {
    $('passwordError').textContent = 'The new password and confirmation do not match.';
    return;
  }

  $('changePasswordSubmit').disabled = true;
  try {
    const result = await api('/api/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword })
    });
    closePasswordForm();
    setStatus(result.message);
  } catch (error) {
    $('passwordError').textContent = error.message;
  } finally {
    $('changePasswordSubmit').disabled = false;
  }
});

async function initialise() {
  try {
    const session = await api('/api/session');
    if (session.authenticated) {
      showApp(session.username);
      await loadPatients();
    } else {
      showLogin();
    }
  } catch (error) {
    showLogin();
    $('loginError').textContent = `Cannot connect to the local server. Start it using the instructions in README.md. (${error.message})`;
  }
}

initialise();
