# CareTrack — Hospital Patient Record System

CareTrack is a web-based Hospital Patient Record System designed to manage patient information through a simple and user-friendly dashboard. It combines patient record management, database-backed authentication, encrypted data storage, and cloud deployment using Vercel and PostgreSQL.

## ✨ Features

- **Patient Management:** Add, update, search, and sort patient records.
- **Secure Authentication:** Login system with password hashing and session management.
- **Encrypted Records:** AES-256-GCM encryption for sensitive patient information.
- **PostgreSQL Database:** Persistent storage for patient records and application data.
- **Session Management:** Database-backed sessions for serverless deployment.
- **Security Measures:** Login attempt limits, HTTP-only cookies, and audit logging.
- **Cloud Deployment:** Configured for deployment on Vercel.
- **C++ Console Application:** A separate program demonstrating patient management using parallel arrays, linear search, bubble sort, and text-file storage.

## 🛠️ Technologies Used

| Technology | Purpose                                      |
| ---------- | -------------------------------------------- |
| HTML       | Web page structure                           |
| CSS        | User interface and styling                   |
| JavaScript | Frontend functionality and API communication |
| Node.js    | Backend and API logic                        |
| PostgreSQL | Persistent database                          |
| Vercel     | Web application deployment                   |
| C++        | Standalone console application               |

## 🚀 Live Demo

**Website:** [https://hospital-patient-record-system-y42l.vercel.app/](https://hospital-patient-record-system-y42l.vercel.app/)

**GitHub Repository:** [Hospital Patient Record System](https://github.com/aryankindarley1906-commits/Hospital-Patient-Record-System)

## 💻 Run Locally

### Prerequisites

- Node.js and npm
- PostgreSQL database
- Git (optional)

### 1. Clone the repository

```bash
git clone https://github.com/aryankindarley1906-commits/Hospital-Patient-Record-System.git
cd Hospital-Patient-Record-System
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a `.env` file in the project root and configure the following values:

```env
DATABASE_URL=your_postgresql_connection_string
DATA_ENCRYPTION_KEY=your_64_character_hex_key
ADMIN_USERNAME=your_admin_username
ADMIN_PASSWORD=your_strong_admin_password
PORT=3000
```

Generate a 32-byte encryption key using:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use your own database connection string and credentials. Never commit `.env` files or actual secrets to GitHub.

### 4. Start the application

```bash
npm start
```

Open `http://localhost:3000` in your browser.

### 5. Run tests

```bash
npm test
```

Run the tests to check the functionality implemented in the project.

## ☁️ Deployment on Vercel

1. Push the project to GitHub.
2. Import the repository into Vercel.
3. Create a PostgreSQL database using a provider such as Neon.
4. Add the required environment variables in **Vercel → Settings → Environment Variables**.
5. Deploy the project and open the generated URL.
6. Test login and patient record operations.

Vercel requires environment variables to be configured separately from the source code. Redeploy after adding or changing production environment variables.

## 🖥️ Standalone C++ Program

The project also contains `Hospital.cpp`, a console-based implementation of patient management.

Compile with a C++17-compatible compiler:

```bash
g++ -std=c++17 -Wall -Wextra Hospital.cpp -o Hospital.exe
```

Run on Windows:

```powershell
.\Hospital.exe
```

This standalone program is separate from the web application and uses its own local text-file storage.

## 🔐 Security Notice

- Never upload database passwords, admin credentials, encryption keys, or `.env` files to a public repository.
- Use dummy patient information when testing.
- This project is intended for educational and demonstration purposes. A security and privacy review is necessary before storing real patient or medical information
  
Developed as a Hospital Patient Record System project to demonstrate web development, database management, authentication, encryption, and C++ programming.
