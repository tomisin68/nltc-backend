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
| `meta.videoId` | string | ✅ with `watch_lesson` | Which lesson. A lesson pays out **once per video, ever** — see below |

**`watch_lesson` is idempotent per video.** The first award for a video writes a
receipt at `users/{uid}/lessonXp/{videoId}`; every later call for the same video
returns `xpEarned: 0` and `alreadyAwarded: true` instead of paying again. Send
the award when the lesson opens as before — the server decides whether it counts.
A call with no `meta.videoId` is rejected with `400`.

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
| `watch_lesson` | 15 XP | — (once per video, ever) |
| `complete_cbt` | 30 XP | +20 XP if score ≥ 90% |
| `join_live` | 50 XP | — |
| `daily_streak` | 10 XP | — |

**Example — award XP after watching a lesson**
```js
async function awardLessonXP() {
  const res = await fetch('https://nltc-backend.onrender.com/api/gamification/xp', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action: 'watch_lesson', meta: { videoId } }),
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

> **There is no payment gateway.** Fees are paid by bank transfer to the NLTC
> account, the student uploads a receipt, and an admin confirms it. The approval
> is the only thing that grants access — nothing a client sends does.
>
> The old Paystack/Flutterwave routes (`/api/flutterwave/*`, `/payment/*`) were
> removed; they now 404.

**Flow**

1. `GET /api/payments/bank-account` &rarr; where to transfer.
2. `GET /api/payments/quote` &rarr; how much (priced server-side).
3. Student transfers, then uploads the receipt to Firebase Storage at
   `paymentProofs/{uid}/{file}` (storage rules confine that path to them).
4. `POST /api/payments/proof` with the storage URL + path &rarr; creates a
   `paymentProofs/{reference}` document at `status: "pending"`, a matching
   pending row under `users/{uid}/payments/{reference}`, and notifies every
   admin (in-app + push).
5. An admin calls `POST /api/payments/proofs/:id/approve`, which grants 30 days
   of access, flips the payment record to `success`, and notifies the student.

---

### 6. Get Bank Account

> The account to transfer to. **Public** — the details are payment instructions,
> not a secret. Overridable from the `settings/bankAccount` Firestore document;
> falls back to `src/config/bankAccount.js`.

```
GET /api/payments/bank-account
```

```json
{
  "success": true,
  "bankAccount": {
    "accountNumber": "8270157607",
    "bankName": "Moniepoint",
    "accountName": "NLTC Global Service- Next level tutorial",
    "note": "Transfer the exact amount, then upload your receipt below. Confirmation usually takes under 2 hours."
  }
}
```

---

### 7. Get Quote

> What the student will be asked to transfer. Priced by the same code that
> prices the submission, so the figure on the transfer screen cannot drift from
> the one an admin reviews.

```
GET /api/payments/quote?type=lesson_fee&classId=<id>&source=app
Authorization: Bearer <idToken>
```

| Query | Notes |
|---|---|
| `type` | `lesson_fee` (default) or `plan_upgrade` |
| `plan` | `pro` — required for `plan_upgrade` |
| `classId` | required for `lesson_fee`; the price is read from that class document |
| `source` | `web` or `app` — the app has its own activation price (`settings.fees.appActivation`) |

```json
{ "success": true, "type": "lesson_fee", "amount": 15000, "description": "Evening Class" }
```

---

### 8. Submit Payment Proof

> Uploads nothing itself — the client puts the file in Storage first and sends
> the resulting URL and path here. **No `amount` is accepted**: the price comes
> from the class document / `settings.fees`.

```
POST /api/payments/proof
Authorization: Bearer <idToken>
```

```json
{
  "type": "lesson_fee",
  "receiptUrl": "https://firebasestorage.googleapis.com/...",
  "receiptPath": "paymentProofs/<uid>/1730900000-receipt.pdf",
  "receiptName": "receipt.pdf",
  "receiptType": "application/pdf",
  "note": "paid from my mum's account",
  "source": "app",
  "metadata": { "classId": "<id>" }
}
```

| Status | Meaning |
|---|---|
| `201` | Accepted; returns the created proof |
| `400` | Receipt path/URL is not this student's, or not an image/PDF |
| `409` | A receipt is already awaiting review (returns the existing one) |

---

### 9. My Proofs / History

```
GET /api/payments/proofs/mine     # this student's receipts, newest first
GET /api/payments/history         # users/{uid}/payments rows
Authorization: Bearer <idToken>
```

---

### 10. Review Queue (admin)

```
GET  /api/payments/proofs?status=pending|approved|rejected|all
POST /api/payments/proofs/:id/approve      { "note": "optional" }
POST /api/payments/proofs/:id/reject       { "reason": "required — shown to the student" }
Authorization: Bearer <adminIdToken>
```

Approve and reject both claim the proof in a transaction, so two admins hitting
Approve on the same receipt cannot grant two 30-day windows for one payment —
the second gets `409`.

Approving runs `markLessonFeePaid` (lesson fee) or `upgradePlan` (plan upgrade),
writes the `success` payment record, and notifies the student in-app and by push.

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

  // ── Payments (bank transfer + receipt) ───────────
  getBankAccount: () =>
    apiFetch('/api/payments/bank-account'),

  getQuote: ({ type = 'lesson_fee', plan, classId, source = 'web' }) =>
    apiFetch(`/api/payments/quote?${new URLSearchParams({
      type, source, ...(plan && { plan }), ...(classId && { classId }),
    })}`),

  // `receiptUrl`/`receiptPath` come from uploading the file to Storage at
  // paymentProofs/{uid}/… first. No amount — the server prices it.
  submitProof: (body) =>
    apiFetch('/api/payments/proof', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  myProofs: () =>
    apiFetch('/api/payments/proofs/mine'),

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

// Award XP after watching lesson — only the first viewing of a video pays
const xp = await api.awardXP('watch_lesson', { videoId });
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
| `/api/payments/proof` | 15 minutes | 10 |
| `/api/agora/token` | 1 minute | 20 |

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
