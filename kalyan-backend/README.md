# Kalyan Games — Backend API

Node.js + Express + Prisma (PostgreSQL). Covers auth (no OTP), wallet, markets,
bids, results, and an admin panel API with **Google Authenticator (TOTP)** 2-step login.

## Run locally

```bash
cd kalyan-games/server
cp .env.example .env          # then edit DATABASE_URL + JWT_SECRET
npm install
npx prisma migrate dev --name init
npm run seed
npm run dev                   # http://localhost:4000
```

You need a local PostgreSQL, or just deploy straight to Railway (below) which
gives you a managed one.

## Deploy on Railway

1. Push this repo to GitHub (already done if you're reading this in the repo).
2. Railway → **New Project → Deploy from GitHub repo** → pick this repo.
   - Set the service **Root Directory** to `kalyan-games/server`.
3. **New → Database → PostgreSQL.** Railway injects `DATABASE_URL` automatically.
4. Service → **Variables**, add:
   - `JWT_SECRET` = a long random string
   - `ADMIN_TOTP_ISSUER` = `Kalyan Games`
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD` = your admin login
   - `NODE_ENV` = `production`
5. Deploy. `railway.json` runs `prisma migrate deploy` then starts the server.
6. Seed once: Railway service → **Shell** → `npm run seed`.
7. Settings → Networking → **Generate Domain** → `https://<app>.up.railway.app`.
8. Point the web app's `API_BASE` at that domain.

> Railway sets `PORT` for you; the app already reads `process.env.PORT`.

## API

### Auth (no OTP)
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/register` | `{phone,name,password}` | → `{token,user}` |
| POST | `/auth/login` | `{phone,password}` | → `{token,user}` |
| GET | `/auth/me` | — | Bearer user token |

### Wallet (Bearer user token)
| Method | Path | Body |
|---|---|---|
| GET | `/wallet` | — |
| POST | `/wallet/add-fund` | `{amount}` (demo/mock credit) |
| POST | `/wallet/withdraw` | `{amount}` (creates a pending request) |

### Play
| Method | Path | Body |
|---|---|---|
| GET | `/markets` | — |
| POST | `/bids` | `{marketId,gameType,selections}` (Bearer) |
| GET | `/bids/history` | — (Bearer) |
| GET | `/results` | — |

### Admin — Google Authenticator 2-step
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/admin/login` | `{username,password,token?}` | If TOTP is on and `token` is missing → `{totpRequired:true}` |
| POST | `/admin/totp/setup` | — | Returns a QR (data URL) to scan in Google Authenticator |
| POST | `/admin/totp/enable` | `{token}` | Confirms the first code, then it's required every login |
| GET | `/admin/users` | — | |
| POST/PATCH | `/admin/markets` `/admin/markets/:id` | | create / open-close |
| POST | `/admin/results` | `{marketId,value}` | declare a result |
| GET | `/admin/withdrawals` | — | |
| POST | `/admin/withdrawals/:id/approve` \| `/reject` | — | |

**Enabling Google Authenticator (one time):**
`/admin/login` (password only) → `/admin/totp/setup` (scan the QR) →
`/admin/totp/enable` with the 6-digit code. After that every admin login needs
the current code.

## Payments — read before promising real money

`/wallet/add-fund` credits the wallet directly for the **demo only**. Real
add-fund/withdraw needs a payment gateway, and mainstream gateways
(Razorpay/Stripe) reject Satta-Matka/betting merchants; real-money gaming is
also legally restricted in many Indian states. Keep the wallet mock/manual for
the client demo and settle the payments + legal question before going live.
