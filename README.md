# CareTrack — Hospital Patient Record System

An intermediate student mini project with a web dashboard, local SQLite database, sign-in, encrypted patient fields, and a separate C++ console version that uses parallel arrays and saves records to a file.

## What is included

- Add, display, search, sort, and update patient records in the web interface.
- SQLite persistence: web records remain after page refreshes and server restarts.
- Sign-in, sign-out, and change-password forms.
- Patient fields encrypted in SQLite using AES-256-GCM; passwords stored as salted `scrypt` hashes.
- Server-side input validation, prepared SQL statements, same-origin checks, HTTP-only/SameSite session cookies, short idle sessions, basic sign-in rate limiting, and an audit log of account and record actions.
- Localhost-only server binding so the web app is not directly exposed to other devices on the network.
- A separate C++ implementation using parallel arrays, linear search, Bubble Sort, add/update functions, and persistent file storage.

## Run the web project

**Requirements:** Node.js 22.16 or newer. The server uses Node's built-in `node:sqlite` module, so no `npm install` or third-party packages are needed.

1. Extract this folder and open it in VS Code.
2. Open a terminal **in this folder**.
3. Check Node.js is available:

   ```powershell
   node --version
   ```

4. Start the local server:

   ```powershell
   node server.js
   ```

5. Open this address in Chrome or Edge: **http://127.0.0.1:3000**
6. Sign in with the first-run account below, then change the password using the button in the page header.
7. Use **Add patient**, search, the sort menu, and **Edit record** to test the features.
8. Refresh the page or stop the server with `Ctrl+C` and start it again. Web records should still be present.

**Do not open `index.html` directly.** The web interface must be served by `server.js` so that the database API and sign-in functions are available.

### First-run sign-in

Change it immediately after the first sign-in. The application also prints the first-run credentials in the server terminal. If you want to set your own initial credentials before the database is created, use PowerShell in the project folder:

```powershell
$env:ADMIN_USERNAME = "hospitaladmin"
$env:ADMIN_PASSWORD = "ChooseYourOwn12+CharPassword"
node server.js
```

Those environment variables are only used to create the account on the first launch. Once the database already contains a user, change the password in the web interface instead.

### Where web data is saved

- SQLite database: `hospital.db` in this project folder. It is created automatically when the server starts.
- Encryption key: stored separately in your operating-system user configuration folder:
  - Windows: `%APPDATA%\HospitalPatientSystem\data-key.bin`
  - Linux: `~/.config/HospitalPatientSystem/data-key.bin` (or `$XDG_CONFIG_HOME/HospitalPatientSystem/data-key.bin` if set)
  - macOS: `~/Library/Application Support/HospitalPatientSystem/data-key.bin`

The database stores the patient record payload encrypted. The key is deliberately kept outside the project folder. **Back up the database and key together.** If the key is lost or replaced, encrypted patient records cannot be recovered. Do not upload the database or key to a public repository.

## Run the C++ version

This is a separate console implementation of the same core operations. It stores patient records in `patients_cpp.txt` in the program's current working directory, so records can be loaded again after the program exits.

From the project folder, compile with g++:

```powershell
g++ -std=c++17 -Wall -Wextra Hospital.cpp -o Hospital.exe
.\Hospital.exe
```

To test persistence, add a record, choose Exit, then run `.\Hospital.exe` again on Windows (or `./Hospital` on Linux/macOS). The patient record should still be present. The `patients_cpp.txt` file is created automatically; keep it if you want to keep the C++ console records.

The C++ console program uses parallel arrays and a text file. It is a separate implementation and does not read from or write to the web app's encrypted SQLite database.

## Suggested test cases

1. Sign in with the demo credentials and change the password.
2. Sign out; verify that patient records cannot be viewed before signing in.
3. Add a patient with a new ID; verify it appears in the table.
4. Add the same ID again; verify the server rejects the duplicate.
5. Search by ID, name, and disease.
6. Sort by ID, name, and age.
7. Edit a record and confirm the updated values remain after page refresh.
8. Try an invalid age (such as `-1` or `131`) and an invalid contact number; verify validation rejects it.
9. Stop and restart the web server; verify records remain saved.
10. In the C++ console program, add a patient, exit, reopen, and verify the record is loaded from `patients_cpp.txt`.

## Security and deployment note

This is a **local educational project**, not a certified hospital information system. It improves the basic prototype with database persistence, encrypted patient fields, password hashing, sign-in, session handling, and audit logging, but it has not undergone professional security testing or healthcare compliance review. The server uses plain HTTP on loopback only; do not expose it to a network or use it for real patient information without a qualified security review, HTTPS, tested backups and recovery, access-management controls, and applicable legal/compliance safeguards.
