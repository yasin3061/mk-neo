# Miya Kebabs ERP - preview

A browser-only preview of the ERP: plain HTML, CSS and JavaScript on a sample dataset. There is no build step, no
backend and no database. Everything is computed in the browser, and what you change (approvals, dials, the persona)
is kept in that browser's localStorage. **The figures are illustrative.**

## Run it

- Double-click `index.html`, or
- `npm start` and open http://localhost:8347 (`node tools/serve.js 9000` for another port).

Node 20 or later; no packages to install.

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

## Deploy

The site is static, so any host works. For Railway the repository is ready as it is:

1. New Project, Deploy from GitHub repo, pick this repository. No variables are needed.
2. Railway builds with Railpack and starts `node tools/serve.js` (`railway.json`); the server listens on the `PORT`
   Railway injects and answers the health check at `/healthz`.
3. Settings, Networking, Generate Domain. Every push to `main` redeploys.

What the server does (`tools/serve.js`, no dependencies): it serves `index.html`, `css/`, `js/` and `vendor/` and
nothing else, so `docs/` and `tools/` are not part of the site; files revalidate by ETag, so a deploy shows at once;
text is sent with brotli or gzip; and search engines are told not to index the preview (`X-Robots-Tag`, the robots
meta tag and `/robots.txt`).
