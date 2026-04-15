# NLTC Backend — Client-Side API Documentation

## Base URL

```
Production:  https://nltc-backend.onrender.com
Development: http://localhost:4000
```

---

## Authentication

All protected endpoints require a **Firebase ID token** in the `Authorization` header.

```js
Authorization: Bearer <firebase_id_token>
```

### How to get the token (Firebase JS SDK)

```js
import { getAuth } from 'firebase/auth';

async function getToken() {
  const user = getAuth().currentUser;
  if (!user) throw new Error('Not signed in');
  return await user.getIdToken(); // auto-refreshes when expired
}

// Helper — use this for every API call
async function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${await getToken()}`,
  };
}
```

---

## Error Responses

All errors follow this shape:

```json
{ "error": "Human-readable message" }
```

| HTTP Status | Meaning |
|---|---|
| `400` | Validation failed — check your request body |
| `401` | Missing or invalid Firebase token |
| `402` | Payment not successful |
| `403` | Insufficient permissions (e.g. non-admin requesting host token) |
| `404` | Resource not found |
| `429` | Rate limit hit — slow down requests |
| `500` | Server error |

---

## Endpoints

### 1. Health Check

> Verify the server is running. No auth required.

```
GET /api/health
```

**Response**
```json
{
  "status": "ok",
  "service": "nltc-backend",
  "timestamp": "2026-04-15T10:00:00.000Z"
}
```

**Example**
```js
const res = await fetch('https://nltc-backend.onrender.com/api/health');
const data = await res.json();
console.log(data.status); // "ok"
```

---

## Gamification

---

### 2. Award XP

> Call this when a user watches a lesson, joins a live class, or triggers a daily streak.
> Use `complete_cbt` only via endpoint #3 — it handles CBT + XP in one call.

```
POST /api/gamification/xp
```

**Headers:** `Authorization` required

**Body**

| Field | Type | Required | Values |
|---|---|---|---|
| `action` | string | ✅ | `watch_lesson`, `join_live`, `daily_streak`, `complete_cbt` |
| `meta` | object | ❌ | `{ score: 92 }` — only needed with `complete_cbt` for 90%+ bonus |

**Response**
```json
{
  "success": true,
  "xpEarned": 25,
  "newXP": 540,
  "newStreak": 3,
  "streakBonusAwarded": true,
  "level": 2,
  "nextLevelXP": 1500,
  "prevLevelXP": 500,
  "leveledUp": false
}
```

| Field | Description |
|---|---|
| `xpEarned` | XP added this call (including any bonuses) |
| `newXP` | User's total XP after this call |
| `newStreak` | Current day-streak count |
| `streakBonusAwarded` | `true` if streak incremented and bonus was added |
| `leveledUp` | `true` if this XP push crossed a level threshold |
| `level` | Current level (1–7) |
| `nextLevelXP` | XP needed to reach next level |

**XP Rewards Table**

| Action | Base XP | Bonus |
|---|---|---|
| `watch_lesson` | 15 XP | — |
| `complete_cbt` | 30 XP | +20 XP if score ≥ 90% |
| `join_live` | 50 XP | — |
| `daily_streak` | 10 XP | — |

**Example — award XP after watching a lesson**
```js
async function awardLessonXP() {
  const res = await fetch('https://nltc-backend.onrender.com/api/gamification/xp', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action: 'watch_lesson' }),
  });
  const data = await res.json();

  if (data.leveledUp) {
    showToast(`🎉 Level Up! You're now Level ${data.level}`);
  }
  updateXPBar(data.newXP, data.prevLevelXP, data.nextLevelXP);
}
```

**Example — award XP after joining a live class**
```js
async function awardLiveXP() {
  const res = await fetch('https://nltc-backend.onrender.com/api/gamification/xp', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action: 'join_live' }),
  });
  return await res.json();
}
```

---

### 3. Save CBT Session + Award XP

> Call this when a student finishes a CBT exam. Saves the result to their history
> AND awards XP in one request. Do NOT call `/xp` separately for CBT.

```
POST /api/gamification/cbt-session
```

**Headers:** `Authorization` required

**Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `subject` | string | ✅ | e.g. `"Mathematics"` |
| `score` | number | ✅ | Percentage score `0–100` |
| `correct` | number | ✅ | Number of correct answers |
| `total` | number | ✅ | Total number of questions |
| `exam` | string | ❌ | e.g. `"JAMB / UTME"` — defaults to `"JAMB / UTME"` |
| `topic` | string | ❌ | Optional topic name |

**Response**
```json
{
  "success": true,
  "sessionId": "abc123xyz",
  "xpEarned": 50,
  "newXP": 590,
  "newStreak": 3,
  "streakBonusAwarded": false,
  "level": 2,
  "nextLevelXP": 1500,
  "prevLevelXP": 500,
  "leveledUp": false
}
```

**Example — submit CBT result after exam**
```js
async function submitCBTResult({ subject, score, correct, total, exam }) {
  const res = await fetch('https://nltc-backend.onrender.com/api/gamification/cbt-session', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ subject, score, correct, total, exam }),
  });

  if (!res.ok) {
    const err = await res.json();
    console.error('CBT save failed:', err.error);
    return null;
  }

  const data = await res.json();

  if (data.leveledUp) {
    showToast(`🎉 Level Up! You're now Level ${data.level}`);
  }

  return data;
}

// Usage — call this when student submits their exam
await submitCBTResult({
  subject: 'Mathematics',
  score: 87.5,
  correct: 35,
  total: 40,
  exam: 'JAMB / UTME',
});
```

---

### 4. Get Leaderboard

> Returns the top students ranked by XP. Also tells you the current user's rank.

```
GET /api/gamification/leaderboard?limit=20
```

**Headers:** `Authorization` required

**Query Params**

| Param | Type | Required | Default | Max |
|---|---|---|---|---|
| `limit` | number | ❌ | `20` | `50` |

**Response**
```json
{
  "success": true,
  "myRank": 4,
  "leaderboard": [
    {
      "rank": 1,
      "uid": "uid_abc",
      "firstName": "Amara",
      "lastName": "Osei",
      "state": "Lagos",
      "targetExam": "JAMB",
      "xp": 4500,
      "streak": 14,
      "plan": "pro"
    }
  ]
}
```

**Example — render leaderboard**
```js
async function loadLeaderboard(limit = 20) {
  const res = await fetch(
    `https://nltc-backend.onrender.com/api/gamification/leaderboard?limit=${limit}`,
    { headers: await authHeaders() }
  );
  const data = await res.json();

  data.leaderboard.forEach(entry => {
    const isMe = entry.rank === data.myRank;
    console.log(`#${entry.rank} ${entry.firstName} — ${entry.xp} XP ${isMe ? '(You)' : ''}`);
  });
}
```

---

### 5. Get My Rank

> Returns the current user's XP, rank, and level info only.

```
GET /api/gamification/rank
```

**Headers:** `Authorization` required

**Response**
```json
{
  "success": true,
  "rank": 4,
  "xp": 590,
  "level": 2,
  "nextLevelXP": 1500,
  "prevLevelXP": 500
}
```

**Example — populate sidebar XP bar**
```js
async function loadMyRank() {
  const res = await fetch('https://nltc-backend.onrender.com/api/gamification/rank', {
    headers: await authHeaders(),
  });
  const { rank, xp, level, nextLevelXP, prevLevelXP } = await res.json();

  document.getElementById('sbXpVal').textContent = `${xp} XP`;
  document.getElementById('st-rank').textContent = `#${rank}`;

  const progress = ((xp - prevLevelXP) / (nextLevelXP - prevLevelXP)) * 100;
  document.getElementById('sbXpFill').style.width = `${progress}%`;
}
```

---

## Payments

---

### 6. Initialize Payment

> Creates a Paystack checkout session and returns a URL to redirect the user to.

```
POST /api/paystack/initialize
```

**Headers:** `Authorization` required

**Body**

| Field | Type | Required | Values |
|---|---|---|---|
| `plan` | string | ✅ | `"pro"` or `"elite"` |
| `callbackUrl` | string | ✅ | Full URL Paystack redirects to after payment |

**Response**
```json
{
  "success": true,
  "authorizationUrl": "https://checkout.paystack.com/...",
  "accessCode": "abc123",
  "reference": "nltc_ref_xyz"
}
```

**Plan Prices**

| Plan | Amount |
|---|---|
| `pro` | ₦2,000 |
| `elite` | ₦5,000 |

**Example — upgrade button handler**
```js
async function startUpgrade(plan) {
  // The callback URL is where Paystack sends the user after payment
  const callbackUrl = 'https://nltc-backend.onrender.com/payment/callback';

  const res = await fetch('https://nltc-backend.onrender.com/api/paystack/initialize', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ plan, callbackUrl }),
  });

  if (!res.ok) {
    const err = await res.json();
    showToast(err.error, 'error');
    return;
  }

  const { authorizationUrl } = await res.json();
  window.location.href = authorizationUrl; // redirect to Paystack checkout
}

// Attach to your upgrade buttons
document.getElementById('btnUpgradePro').addEventListener('click', () => startUpgrade('pro'));
document.getElementById('btnUpgradeElite').addEventListener('click', () => startUpgrade('elite'));
```

---

### 7. Verify Payment (manual fallback)

> Verifies a payment by reference. Use this as a fallback if the webhook didn't fire.
> The `/payment/callback` redirect (endpoint #8) does this automatically — you usually
> don't need to call this directly.

```
GET /api/paystack/verify?reference=<reference>
```

**Headers:** `Authorization` required

**Query Params**

| Param | Type | Required |
|---|---|---|
| `reference` | string | ✅ |

**Response**
```json
{
  "success": true,
  "plan": "pro",
  "message": "🎉 Welcome to pro! Your plan is now active."
}
```

**Example — call from payment result page if webhook hasn't fired yet**
```js
async function verifyPayment(reference) {
  const res = await fetch(
    `https://nltc-backend.onrender.com/api/paystack/verify?reference=${reference}`,
    { headers: await authHeaders() }
  );

  if (!res.ok) {
    const err = await res.json();
    showToast(`Payment failed: ${err.error}`, 'error');
    return false;
  }

  const data = await res.json();
  showToast(data.message, 'success');
  return true;
}
```

---

### 8. Payment Callback (Paystack Redirect)

> Paystack redirects the user here after checkout. No auth required.
> It verifies the payment and redirects to your frontend result page.

```
GET /payment/callback?reference=<reference>
```

> This is handled automatically — you don't call it from JS.
> Set `callbackUrl` in endpoint #6 to:
> ```
> https://nltc-backend.onrender.com/payment/callback
> ```
> After verifying the payment it will redirect the user to:
> ```
> https://nltc-online.vercel.app/payment/result?status=success&plan=pro&reference=xxx
> https://nltc-online.vercel.app/payment/result?status=failed&reference=xxx
> https://nltc-online.vercel.app/payment/result?status=error&message=...
> ```

**Example — handle the result on your frontend `/payment/result` page**
```js
// On your /payment/result page — read the query params
const params = new URLSearchParams(window.location.search);
const status    = params.get('status');    // "success" | "failed" | "error"
const plan      = params.get('plan');      // "pro" | "elite"
const reference = params.get('reference');
const message   = params.get('message');

if (status === 'success') {
  showToast(`🎉 Welcome to ${plan}! Your plan is now active.`, 'success');
  // Reload user profile so the UI reflects the new plan
  await loadUserProfile();
} else if (status === 'failed') {
  showToast('Payment was not completed. Please try again.', 'error');
} else {
  showToast(message || 'Something went wrong.', 'error');
}
```

---

### 9. Paystack Webhook

> Paystack calls this automatically for payment events.
> You do not call this from the client — it is for Paystack only.

```
POST /api/paystack/webhook
```

**Events handled automatically:**

| Event | Action |
|---|---|
| `charge.success` | Upgrades user plan |
| `subscription.create` | Activates subscription |
| `subscription.disable` | Downgrades user to free |
| `invoice.payment_failed` | Downgrades user to free |

---

## Live Classes (Agora)

---

### 10. Get Agora RTC Token

> Returns a token to join a live class channel via Agora RTC.
> Students always join as `audience`. Only admins/teachers can request `host`.

```
POST /api/agora/token
```

**Headers:** `Authorization` required

**Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `channelName` | string | ✅ | Must be alphanumeric, underscores/hyphens allowed |
| `role` | string | ❌ | `"audience"` (default) or `"host"` (admin/teacher only) |

**Response**
```json
{
  "success": true,
  "token": "007eJxTYBBf...",
  "channelName": "math_live_001",
  "uid": 1234567890,
  "appId": "5eae75b2cc3d48cc84446b94d3877f88",
  "expiresAt": 1713189600000
}
```

| Field | Description |
|---|---|
| `token` | Pass directly to `AgoraRTC.join()` |
| `uid` | Numeric UID derived from your Firebase UID — use this in Agora |
| `appId` | Agora App ID — pass to `AgoraRTC.createClient()` |
| `expiresAt` | Unix ms timestamp — refresh the token before this time |

**Example — join a live class as a student**
```js
let agoraClient = null;

async function joinLiveClass(channelName) {
  // 1. Get token from your backend
  const res = await fetch('https://nltc-backend.onrender.com/api/agora/token', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ channelName, role: 'audience' }),
  });

  if (!res.ok) {
    showToast('Could not join live class', 'error');
    return;
  }

  const { token, uid, appId } = await res.json();

  // 2. Join via Agora SDK
  agoraClient = AgoraRTC.createClient({ mode: 'live', codec: 'vp8' });
  agoraClient.setClientRole('audience');

  await agoraClient.join(appId, channelName, token, uid);

  // 3. Subscribe to the host's video/audio
  agoraClient.on('user-published', async (user, mediaType) => {
    await agoraClient.subscribe(user, mediaType);
    if (mediaType === 'video') {
      user.videoTrack.play('lvRemoteVideo'); // your video div ID
    }
    if (mediaType === 'audio') {
      user.audioTrack.play();
    }
  });
}

async function leaveLiveClass() {
  await agoraClient?.leave();
  agoraClient = null;
}
```

---

## Complete API Client (copy-paste ready)

```js
// api.js — drop this in your project and import where needed

const API_BASE = 'https://nltc-backend.onrender.com';

import { getAuth } from 'firebase/auth';

async function getToken() {
  const user = getAuth().currentUser;
  if (!user) throw new Error('Not signed in');
  return await user.getIdToken();
}

async function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${await getToken()}`,
  };
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...(await authHeaders()), ...(options.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── Gamification ───────────────────────────────────
export const api = {
  health: () =>
    fetch(`${API_BASE}/api/health`).then(r => r.json()),

  awardXP: (action, meta = {}) =>
    apiFetch('/api/gamification/xp', {
      method: 'POST',
      body: JSON.stringify({ action, meta }),
    }),

  saveCBTSession: (subject, score, correct, total, exam) =>
    apiFetch('/api/gamification/cbt-session', {
      method: 'POST',
      body: JSON.stringify({ subject, score, correct, total, exam }),
    }),

  getLeaderboard: (limit = 20) =>
    apiFetch(`/api/gamification/leaderboard?limit=${limit}`),

  getMyRank: () =>
    apiFetch('/api/gamification/rank'),

  // ── Payments ─────────────────────────────────────
  initializePayment: (plan) =>
    apiFetch('/api/paystack/initialize', {
      method: 'POST',
      body: JSON.stringify({
        plan,
        callbackUrl: 'https://nltc-backend.onrender.com/payment/callback',
      }),
    }),

  verifyPayment: (reference) =>
    apiFetch(`/api/paystack/verify?reference=${reference}`),

  // ── Agora ─────────────────────────────────────────
  getAgoraToken: (channelName, role = 'audience') =>
    apiFetch('/api/agora/token', {
      method: 'POST',
      body: JSON.stringify({ channelName, role }),
    }),
};
```

**Usage examples:**
```js
import { api } from './api.js';

// Award XP after watching lesson
const xp = await api.awardXP('watch_lesson');
if (xp.leveledUp) showToast(`Level Up! You're Level ${xp.level} 🎉`);

// Save CBT result
const result = await api.saveCBTSession('Physics', 85, 34, 40, 'WAEC SSCE');

// Load leaderboard
const { leaderboard, myRank } = await api.getLeaderboard(10);

// Start upgrade flow
const { authorizationUrl } = await api.initializePayment('pro');
window.location.href = authorizationUrl;

// Join live class
const { token, uid, appId } = await api.getAgoraToken('physics_live_001');
```

---

## Rate Limits

| Route group | Window | Max requests |
|---|---|---|
| All `/api/*` routes | 15 minutes | 100 |
| `/api/paystack/*` | 15 minutes | 10 |
| `/api/agora/token` | 1 minute | 20 |
| `/api/paystack/webhook` | 1 minute | 30 |

When a rate limit is hit the server returns `429 Too Many Requests`.

---

## Level Thresholds

| Level | XP Required | Title |
|---|---|---|
| 1 | 0 XP | Beginner |
| 2 | 500 XP | Scholar |
| 3 | 1,500 XP | Achiever |
| 4 | 3,500 XP | Expert |
| 5 | 7,000 XP | Master |
| 6 | 12,000 XP | Champion |
| 7 | 20,000 XP | Legend |
