# NLTC Backend

Secure Node.js/Express backend for the **Next Level Tutorial Centre** student platform.  
Handles Agora token generation, Paystack payments, gamification (XP/streaks/achievements), and leaderboards — keeping all secrets off the client.

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Database | Firebase Firestore (via Admin SDK) |
| Auth | Firebase Auth (ID token verification) |
| Live Video | Agora RTC token generation |
| Payments | Paystack NGN checkout + webhooks |
| Rate Limiting | express-rate-limit |
| Security | helmet, cors |
| Hosting | Render (free tier works) |

---

## Project Structure

```
nltc-backend/
├── config/
│   └── firebase.js          # Firebase Admin SDK init
├── src/
│   ├── middleware/
│   │   ├── auth.js          # Firebase token verification
│   │   ├── rateLimiter.js   # Per-route rate limits
│   │   └── validate.js      # express-validator error formatter
│   ├── routes/
│   │   ├── health.js        # GET /api/health
│   │   ├── agora.js         # POST /api/agora/token
│   │   ├── gamification.js  # POST /api/gamification/xp etc.
│   │   └── paystack.js      # POST /api/paystack/initialize etc.
│   ├── services/
│   │   ├── agoraService.js       # RTC token builder
│   │   ├── paystackService.js    # Paystack API + webhook verification
│   │   └── gamificationService.js # XP, streaks, achievements, leaderboard
│   └── server.js            # Express app entry point
├── .env.example             # Copy to .env — fill in your keys
├── .gitignore
└── package.json
```

---

## Local Setup

```bash
# 1. Clone and install
git clone <your-repo>
cd nltc-backend
npm install

# 2. Configure environment
cp .env.example .env
# Fill in all values in .env (see below)

# 3. Run in development
npm run dev
```

---

## Environment Variables

Copy `.env.example` → `.env` and fill in every value.

### Firebase Admin SDK
1. Go to Firebase Console → **Project Settings** → **Service Accounts**
2. Click **"Generate new private key"** → download the JSON
3. Copy `project_id`, `client_email`, and `private_key` into your `.env`

> ⚠️ The private key has literal `\n` characters — keep them as `\n` in `.env`, not real newlines.

### Agora
1. Go to [Agora Console](https://console.agora.io) → **Project Management**
2. Create a project → copy **App ID** and **App Certificate**
3. Enable **APP ID + Token** authentication mode

### Paystack
1. Go to [Paystack Dashboard](https://dashboard.paystack.com) → **Settings → API Keys**
2. Copy **Secret Key** (starts with `sk_live_` or `sk_test_`)
3. Under **Webhooks**, add your Render URL: `https://your-app.onrender.com/api/paystack/webhook`
4. Copy the webhook secret Paystack shows you

---

## API Endpoints

### Health
```
GET /api/health
```
Returns service status. Render uses this for uptime checks.

---

### Gamification
All routes require `Authorization: Bearer <firebase-id-token>` header.

```
POST /api/gamification/xp
Body: { "action": "watch_lesson" | "complete_cbt" | "join_live" | "daily_streak", "meta": {} }
Returns: { newXP, xpEarned, newStreak, newAchievements, level }

POST /api/gamification/cbt-session
Body: { "subject": "Mathematics", "score": 85, "correct": 34, "total": 40, "topic": "Algebra" }
Returns: { sessionId, newXP, xpEarned, newStreak, level }

GET /api/gamification/leaderboard?limit=20
Returns: { leaderboard: [...], myRank }

GET /api/gamification/rank
Returns: { rank }
```

---

### Agora
```
POST /api/agora/token
Headers: Authorization: Bearer <token>
Body: { "channelName": "class_abc123", "role": "audience" }
Returns: { token, channelName, uid, appId, expiresAt }
```
- Students always get `"audience"` role
- Only users with `admin: true` or `teacher: true` custom claim get `"host"`

---

### Paystack
```
POST /api/paystack/initialize
Headers: Authorization: Bearer <token>
Body: { "plan": "pro" | "elite", "callbackUrl": "https://yoursite.com/payment-success" }
Returns: { authorizationUrl, accessCode, reference }

GET /api/paystack/verify?reference=xxx
Headers: Authorization: Bearer <token>
Returns: { success, plan }

POST /api/paystack/webhook
(Called by Paystack directly — no auth header, HMAC-verified)
```

---

## Calling the Backend from Your Frontend

Replace your direct Firestore CBT writes with backend calls:

```javascript
// Get the current user's ID token
const token = await firebase.auth().currentUser.getIdToken();

// Save a CBT session (awards XP automatically)
const res = await fetch('https://your-backend.onrender.com/api/gamification/cbt-session', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify({ subject: 'Mathematics', score: 85, correct: 34, total: 40 }),
});
const data = await res.json();
// data.xpEarned, data.newAchievements etc.

// Get an Agora token to join a live class
const agoraRes = await fetch('https://your-backend.onrender.com/api/agora/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({ channelName: 'class_abc123' }),
});
const { token: agoraToken, uid, appId } = await agoraRes.json();

// Start Paystack checkout
const paystackRes = await fetch('https://your-backend.onrender.com/api/paystack/initialize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({ plan: 'pro', callbackUrl: 'https://yoursite.com/success' }),
});
const { authorizationUrl } = await paystackRes.json();
window.location.href = authorizationUrl; // redirect to Paystack checkout
```

---

## Deploying to Render

1. Push your code to a GitHub repo (`.env` must NOT be committed)
2. Go to [render.com](https://render.com) → **New → Web Service**
3. Connect your GitHub repo
4. Set:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Environment:** `Node`
5. Add all environment variables from `.env.example` under **Environment → Add Env Var**
6. Click **Deploy**

Render's free tier spins down after 15 min of inactivity. Add a health-check ping using [cron-job.org](https://cron-job.org) hitting `GET /api/health` every 10 minutes to keep it awake.

---

## Rate Limits

| Route group | Window | Max requests |
|---|---|---|
| All `/api/*` | 15 min | 100 per IP |
| Auth-sensitive (Paystack init) | 15 min | 10 per IP |
| Agora token | 1 min | 20 per IP |
| Paystack webhook | 1 min | 30 per IP |

All limits are configurable via `.env`.

---

## Security Notes

- Firebase ID tokens are verified on **every request** — the backend never trusts the client
- Agora App Certificate never leaves the server — clients only get short-lived tokens
- Paystack webhooks are validated with HMAC-SHA512 before any plan upgrade happens
- `helmet` sets security headers (XSS protection, HSTS, etc.)
- The `.env` file is in `.gitignore` — never commit it