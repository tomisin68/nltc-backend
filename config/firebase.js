require('dotenv').config();
const admin = require('firebase-admin');

let db, auth;

function initFirebase() {
  if (admin.apps.length > 0) {
    db = admin.firestore();
    auth = admin.auth();
    return;
  }
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : undefined;

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
  db   = admin.firestore();
  auth = admin.auth();
  console.log('✅ Firebase Admin initialised');
}

function getDb()   { return db; }
function getAuth() { return auth; }

module.exports = { initFirebase, getDb, getAuth };