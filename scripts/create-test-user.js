require('dotenv').config();
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

async function createTestUser() {
  const uid = 'FES4KykA0CMFyhi3y76BgFz6rNs1';
  await db.collection('users').doc(uid).set({
    email: 'test@gmail.com',
    firstName: 'Test',
    lastName: 'User',
    displayName: 'Test User',
    xp: 0,
    streak: 0,
    plan: 'free',
    role: 'student',
    achievements: [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  console.log('✅ Test user document created successfully');
  process.exit(0);
}

createTestUser().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
