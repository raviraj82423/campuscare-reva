
# CampusCare — REVA University Grievance Portal

Full-stack version of the original single-file prototype. The original UI (`public/index.html`) is preserved; its
localStorage data layer was replaced by a real backend (`server/`) and database (SQLite).

## Requirements
* **Node.js 22.13 or newer** (check with `node -v`). No `npm install` is needed: the server uses only Node built-ins
  (`node:http`, `node:sqlite`, `node:crypto`). The browser loads Tailwind and Chart.js from CDNs, so the demo machine needs internet.

## Run it (Windows PowerShell shown; use `export` on macOS/Linux)
```powershell
cd campuscare
$env:ADMIN_EMAIL="admin@reva.example"; $env:ADMIN_PASSWORD="ChooseAStrongOne1"
node server/cli.js create-admin      # first administrator (bootstrap; there is no default admin)
node server/cli.js seed-demo         # optional: clearly-labelled DEMO students/complaints (password Demo@12345)
node server/index.js                 # http://localhost:3000
```
Students self-register in the UI. Admin signs in via **Admin Console → Admin sign in**.
Docker alternative: `docker compose up --build` then run `create-admin` inside the container (`docker compose exec campuscare node server/cli.js create-admin` with the env vars set).

## Tests
`npm test` — 11 API test groups (registration, duplicate SRN/email, login/role separation, complaint creation & ticket IDs,
idempotency, student isolation, CSRF, priority sorting/filtering/search, status transitions, history/audit, stats, notifications,
password reset, logout, rate limiting).

## Configuration (environment variables, see `.env.example`)
`PORT, DB_FILE, UPLOAD_DIR, SESSION_HOURS, STUDENT_EMAIL_DOMAIN, REQUIRE_VERIFICATION, REOPEN_WINDOW_DAYS, NODE_ENV=production` (adds `Secure` cookie flag; serve over HTTPS).

## Architecture
`server/db.js` schema + seed of departments and the category→department map (table `category_map`, editable in the DB) ·
`server/app.js` REST API, sessions, authorization, static hosting · `server/security.js` scrypt hashing, rate limiter, file sniffing ·
`public/index.html` original UI · `public/api-layer.js` replaces the prototype's data/auth functions with API calls.

## Security model
* Passwords hashed with scrypt; sessions are random tokens stored hashed in the DB, `HttpOnly; SameSite=Strict` cookie, 8 h expiry.
* The role is **never** taken from the client: the login form's "portal" only selects which account type may sign in, and the server checks the stored role.
* CSRF: every state-changing request needs the `X-CSRF-Token` returned at login.
* Student queries are always scoped by `user_id`; another student's ticket returns 404.
* Login rate limit: 8 attempts / 15 min per IP+identifier (in memory; use a shared store if you run several processes).
* Uploads: JPG/PNG/GIF/WEBP/PDF only, ≤5 MB, detected by magic bytes, stored under random names, served only to the owner or admins.
* Admin actions are validated (transition rules; reject needs a reason; resolve needs a note), written to `status_history` and `audit_log`. There is no delete.

## API summary
Auth: `POST /api/auth/{register,login,logout,forgot-password,reset-password}`, `GET /api/auth/me`.
Student: `GET /api/student/dashboard`, `GET|POST /api/student/complaints`, `GET /api/student/complaints/:ticket`, `POST …/:ticket/comments`, `POST …/:ticket/reopen`, notifications (`GET`, `PATCH :id/read`, `POST read-all`).
Admin: `GET /api/admin/{dashboard,analytics,departments,users,notifications}`, `GET /api/admin/complaints[?search&status&priority&department&from&to&sort&page&pageSize]`, `GET :ticket`, `PATCH :ticket/status|department`, `POST :ticket/comments`, `PATCH /api/admin/users/:id/verify`.
Other: `GET /api/config`, `GET /api/public/stats`, `GET /api/attachments/:id`.

## Known limitations (be upfront about these in your submission)
* **Database is SQLite, not PostgreSQL/Prisma**, and the backend is dependency-free Node rather than Express. This was a deliberate choice so it runs with no install step and could be tested end-to-end. Moving to PostgreSQL means rewriting `db.js` and the `q/one/run` helpers.
* **No email is sent.** No email provider is configured. Notifications are in-app only; password reset tokens are not emailed (set `EXPOSE_RESET_TOKEN=true` for demos only, or give the token to the student).
* **No REVA directory/SRN validation service.** SRN format is checked; an admin verifies accounts (`PATCH /api/admin/users/:id/verify`; set `REQUIRE_VERIFICATION=true` to block unverified students from submitting). There is no admin screen for verification yet — API only.
* Notifications update by **30-second polling**, not push.
* Student charts are computed in the browser from the student's last 100 complaints (fetched from the API).
* Admin analytics lacks a date-range picker (API supports `from`/`to`); the department filter applies to the charts.
* Subcategory, block/floor and contact preference fields are not in the form yet (API accepts `subcategory`).
* The UI was exercised in headless Chromium for the main flows, but with CDN assets blocked, so styling, charts and mobile layout were **not** visually verified.

# campuscare-reva
Smart Campus Complaint and Grievance Management System for REVA University with student dashboards, complaint tracking, status updates, and administrative analytics.
a2057f184a5eb38af79c8451bf22dddab9375db4
