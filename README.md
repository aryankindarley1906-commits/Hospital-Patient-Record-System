# CareTrack — Hospital Patient Record System

CareTrack is a secure Hospital Patient Record System featuring a modern web interface, encrypted patient record storage, database-backed authentication, session management for serverless deployments on **Vercel**, and a separate standalone **C++** console program that demonstrates parallel array algorithms.

---

## What Is Included

- **Web Dashboard**: Add, update, search, and sort patient records in an intuitive UI.
- **Vercel Serverless Ready**: Designed for Vercel functions (`api/index.js`) without running a blocking `server.listen()` in serverless environments.
- **Hosted PostgreSQL Persistence**: Patient data, user accounts, sessions, and audit logs persist reliably across serverless cold starts.
- **AES-256-GCM Field Encryption**: Sensitive patient details are encrypted before entering the database using a 32-byte key from `DATA_ENCRYPTION_KEY`.
- **Serverless Session Management**: Sessions are stored in the PostgreSQL database so users remain logged in across independent serverless requests.
- **Security & Hardening**:
  - Salted `scrypt` password hashing with `timingSafeEqual` comparison.
  - CSRF protection via same-origin verification.
  - HTTP-only, `SameSite=Strict` session cookies with 30-minute inactivity timeouts.
  - Automatic brute-force sign-in rate limiting (5 failed attempts trigger a 1-minute cooldown).
  - Comprehensive audit trail recording user logins, logouts, password changes, and patient modifications.
- **Standalone C++ Implementation**: `Hospital.cpp` uses parallel arrays, linear search, Bubble Sort, and text file persistence (`patients_cpp.txt`).

---

## Quick Vercel Deployment Guide (Beginner-Friendly)

Follow these steps to deploy CareTrack on Vercel with a free hosted PostgreSQL database:

### Step 1: Create a Free Hosted PostgreSQL Database

You can use any PostgreSQL provider (such as [Neon](https://neon.tech), [Supabase](https://supabase.com), or [Render](https://render.com)). Neon is recommended for serverless applications:

1. Go to [https://neon.tech](https://neon.tech) and create a free account.
2. Click **Create Project** (e.g., name it `caretrack-db`).
3. Neon will display your **Connection Details**.
4. Copy the connection string (looks like):
   ```text
   postgresql://alex:AbC123xyz@ep-cool-cloud-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
   *(Keep this connection string ready for Step 3).*

> **Note:** The application automatically runs `CREATE TABLE IF NOT EXISTS` and seeds initial demo records the very first time it connects. You do **not** need to run any manual SQL migration scripts.

---

### Step 2: Generate Your 32-Byte Encryption Key

Patient records are encrypted using AES-256-GCM, which requires a **32-byte key** (represented as a 64-character hexadecimal string).

Run this command in your computer terminal (PowerShell, Command Prompt, or Bash):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

You will see output similar to:
```text
3f8a42b98216c59b6574c8df63426e257e1b54a29a0b925b42c94c921789c0de
```

Copy your generated string. **Never share this key publicly or commit it to GitHub.**

---

### Step 3: Configure Environment Variables in Vercel

1. Log in to [Vercel](https://vercel.com) and go to your Project Dashboard.
2. Navigate to **Settings** → **Environment Variables**.
3. Add the following environment variables (all 4 are required for production):

| Variable Name | Required in Production? | Value / Description |
|---|---|---|
| `DATABASE_URL` | **Yes** | Your PostgreSQL connection string from Step 1 (e.g. `postgresql://...`) |
| `DATA_ENCRYPTION_KEY` | **Yes** | The 64-character hex string generated in Step 2 |
| `ADMIN_USERNAME` | **Yes** | Your desired initial admin username (3–40 alphanumeric/dot/underscore/hyphen characters) |
| `ADMIN_PASSWORD` | **Yes** | Your secure initial admin password (minimum 12 characters; default passwords are not allowed) |

4. Make sure the checkboxes for **Production**, **Preview**, and **Development** are checked, then click **Save**.

---

### Step 4: Deploy / Redeploy on Vercel

1. Push your updated code to your GitHub repository (see the checklist below).
2. In Vercel, go to the **Deployments** tab.
3. Click the three dots `...` next to the latest deployment and select **Redeploy** (or Vercel will automatically deploy the new commit from GitHub).
4. Once deployment finishes, open your Vercel production URL (e.g., `https://your-project.vercel.app`).

---

### Step 5: Sign In to the Dashboard

When the app launches for the first time, sign in with the credentials you configured in Vercel:

- **Username**: The value you set in `ADMIN_USERNAME`
- **Password**: The value you set in `ADMIN_PASSWORD`

> **Security Note**: Default demo credentials are blocked in production. You can change your password at any time using the **Change password** button in the dashboard header.

---

## Local Development & Testing

You can also run and test the project locally on your machine.

### 1. Install Dependencies

```powershell
npm install
```

### 2. Configure Local Environment Variables

Create a `.env` file in the project root:

```env
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/hospital_db
DATA_ENCRYPTION_KEY=3f8a42b98216c59b6574c8df63426e257e1b54a29a0b925b42c94c921789c0de
PORT=3000
```

### 3. Run Automated Tests

To test encryption, authentication, session persistence, and all API routes:

```powershell
npm test
```

### 4. Start Local Development Server

```powershell
npm start
```

Visit **http://127.0.0.1:3000** in your browser.

---

## Standalone C++ Console Program

The C++ program is an independent console implementation that stores data in `patients_cpp.txt`.

### Compile with g++:

```powershell
g++ -std=c++17 -Wall -Wextra Hospital.cpp -o Hospital.exe
.\Hospital.exe
```

*(On Linux / macOS: `g++ -std=c++17 -Wall -Wextra Hospital.cpp -o Hospital && ./Hospital`)*

---

## GitHub Upload Checklist

When pushing or uploading your project to GitHub, **only upload the files listed below**. Sensitive keys and generated binaries must remain excluded.

###  Files to Upload to GitHub:

- `api/index.js` *(Vercel Serverless function entry point)*
- `db.js` *(Database connection, schema setup, encryption, sessions)*
- `server.js` *(API route handlers & local development HTTP server)*
- `index.html` *(Dashboard user interface)*
- `style.css` *(Styling and design)*
- `script.js` *(Client-side logic & API interactions)*
- `Hospital.cpp` *(Standalone C++ implementation)*
- `vercel.json` *(Vercel routing and rewrite rules)*
- `package.json` *(Node.js dependencies and test scripts)*
- `package-lock.json` *(Pinned dependency versions)*
- `.gitignore` *(Excludes secret files and build artifacts)*
- `README.md` *(Documentation and setup guide)*
- `test/test.js` *(Automated test suite)*

### ❌ Files to NEVER Upload to GitHub (Already in `.gitignore`):

- `.env` or `.env.local` *(Contains your live database credentials and encryption keys!)*
- `node_modules/` *(Installed packages; Vercel installs these automatically during build)*
- `hospital.db`, `hospital.db-shm`, `hospital.db-wal` *(Old local SQLite database files)*
- `Hospital.exe` or `Hospital` *(Compiled C++ binary executable)*
- `patients_cpp.txt` *(Local C++ data file)*
