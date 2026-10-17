# ZapShift API

REST API for [ZapShift](https://github.com/afzalhossainraju100/ZAP-SHIFT-CLIENT),
a parcel delivery app for Bangladesh.

**Live API:** https://zapshift-api.vercel.app (health check: `/health`)

## Tech stack

Node.js 22 · Express 5 · MongoDB Atlas · Firebase Admin (token verification) ·
Stripe Checkout · Helmet · express-rate-limit

## How it works

- Every protected request sends a Firebase ID token (`Authorization: Bearer …`).
  The server verifies it and loads the user's profile and role from MongoDB.
- Roles are layered: **admin** ⊇ **rider** ⊇ **user**.
- The first account to request admin access becomes the admin; later requests
  need approval by an existing admin.
- A new parcel sends a request to every approved rider in the sender's district;
  the first rider to accept is assigned. Admins can assign, change or remove
  riders, including part-time riders who don't use the app.

## Endpoints

| Area | Endpoints |
|---|---|
| Health | `GET /health`, `GET /exchange-rate` |
| Auth | `POST /auth/check-email`, `POST /auth/register`, `POST /auth/login`, `GET /auth/me` |
| Admin access | `GET/POST /auth/admin/request`, `GET /admin/requests`, `PATCH /admin/requests/:id` |
| Users | `GET/PATCH /users/me`, `GET /users` (admin) |
| Riders | `POST /riders`, `GET /riders/me`, `GET /riders`, `GET /riders/available`, `PATCH /riders/:id/status` |
| Parcels | `GET/POST /parcels`, `GET/DELETE /parcels/:id` |
| Delivery (admin) | `PATCH /parcels/:id/assign-rider`, `/remove-rider`, `/confirm-step`, `/status`, `POST /parcels/:id/dispatch`, `GET /admin/part-time-riders` |
| Rider tasks | `GET /rider/requests`, `PATCH /rider/requests/:id/accept`, `/decline`, `GET /rider/parcels`, `PATCH /rider/parcels/:id/confirm` |
| Tracking | `GET /trackings`, `GET /trackings/:trackingId`, `GET /public/track/:trackingId` |
| Payments | `POST /create-checkout-session`, `GET/PATCH /payment-success`, `GET /payments` |
| Dashboards | `GET /stats/user`, `/stats/rider`, `/stats/admin`, `GET /admin/overview`, `GET /admin/shipments` |
| Contact | `POST /contact`, `GET /admin/messages`, `PATCH /admin/messages/:id` |

## Run locally

```bash
cp .env.example .env   # fill in the values
npm install
npm run dev            # http://localhost:3000
```

Locally the Firebase service account JSON file next to `index.js` is used.
It is git-ignored and must never be committed.

## Deployment

Deployed on **Vercel** with zero configuration: `index.js` exports the Express
app, which runs as one serverless function. MongoDB connects once per instance
and requests wait for it.

Environment variables are listed in [`.env.example`](.env.example). In
production the Firebase key goes in `FB_SERVICE_KEY` as one base64 line, and
MongoDB Atlas must allow connections from anywhere (`0.0.0.0/0`) because
Vercel uses changing IP addresses.
