# Miya Kebabs ERP - preview

A browser-only preview of the ERP: plain HTML, CSS and JavaScript on a sample dataset. There is no build step, no
database and no application backend. Everything is computed in the browser, and what you change (approvals, dials,
the persona) is kept in that browser's localStorage. **The figures are illustrative.**

Served over the web, the preview sits behind a sign-in (see below). Opened as a file, it needs no server at all.

## Run it

- Double-click `index.html`, or
- serve it with the sign-in in front, as the live site runs it:

  ```
  LOGIN_USER=you@example.com LOGIN_PASSWORD=choose-one npm start
  ```

  and open http://localhost:8347. The first start writes `server/users.json`; after that `npm start` alone is enough.
  `node tools/serve.js 9000` picks another port; `LOGIN=off npm start` serves it without a sign-in, for local work only.

Node 20 or later; no packages to install.

## The sign-in

One username and password, checked on the server (`tools/serve.js`) against a file on the server:

- `server/users.json` holds the username and a **salted scrypt hash** of the password. The password itself is
  written nowhere. The file is created at start-up from the variables `LOGIN_USER` and `LOGIN_PASSWORD` and is not
  in this repository (`.gitignore`); on later starts without the variables the file on disk is used.
- Without a file and without the variables the server refuses to start, so the app is never served unprotected by
  accident.
- Until a browser has signed in it gets the sign-in screen and nothing else: not the page, not a script, not the data.
- A session lasts 12 hours (an HttpOnly cookie, Secure over https). "More options" in the top bar has **Sign out**.
- Eight refused attempts from one address pause that address for ten minutes.
- Changing the password (the variable, then a restart) signs everybody out. `SESSION_SECRET` is optional: set it to
  sign the cookie with a key of its own.

This is a door for a demo, not an identity system: one shared account, no password reset, no user management.

## What is in it

| Area | Screens |
|---|---|
| Overview | management cockpit: headline figures, the forecast outlook, "Needs attention" |
| Revenue | sales explorer, time slots, dishes, tax and commission audit, recent orders |
| Costs | unit economics, food cost, budget tracking |
| Approvals | bills (two-tier maker-checker), payment batches, payables |
| Vendors, Factory, Banking | onboarding and verification; production, dispatch, inventory with suggested purchases; account structure |
| System | audit trail, data sources, the rules behind "Needs attention" with a dial on every threshold |

Switch persona from the top bar to see the same screens as the director, the finance checker, the maker, the payer,
an outlet manager or the factory manager. "More options" resets the demo data and switches the simulated loading
off; adding `?instant` to the address does the same for one session.

## Checks

`npm run check` runs the data-layer checks (`tools/check-data.js`): reconciliations, calibration bands, persona
scope, determinism, the forecast and the rules catalogue. Run it after touching anything under `js/data`.

The documents for people changing the code are in `docs/` (`API.md` is the entry point).

## Deploy (Railway)

1. New Project, Deploy from GitHub repo, pick this repository.
2. In the service's **Variables** add `LOGIN_USER` and `LOGIN_PASSWORD` (and, if you like, `SESSION_SECRET`).
   Without the first two the deploy fails with "No login is configured" in the log, by design.
3. Railway builds with Railpack and starts `node tools/serve.js` (`railway.json`); the server listens on the `PORT`
   Railway injects and answers the health check at `/healthz`.
4. Settings, Networking, Generate Domain. Every push to `main` redeploys.

What the server does (`tools/serve.js`, no dependencies): after the sign-in it serves `index.html`, `css/`, `js/` and
`vendor/` and nothing else, so `docs/`, `tools/`, the configuration and `server/` are never part of the site; files
revalidate by ETag, so a deploy shows at once; text is sent with brotli or gzip; and search engines are told not to
index the preview (`X-Robots-Tag`, the robots meta tag and `/robots.txt`).

Note that this repository is public: the sign-in protects the deployed site, not the code, which anyone can
download from here and open locally.
