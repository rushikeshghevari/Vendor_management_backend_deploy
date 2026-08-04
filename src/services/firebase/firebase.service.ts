import admin from 'firebase-admin';

let initialized = false;

function getApp(): admin.app.App | null {
  if (initialized) return admin.app();

  const projectId  = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    console.warn('[firebase] FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY not set — push notifications disabled');
    return null;
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      // Railway / Render store the key with literal \n — replace them so the PEM is valid.
      privateKey: privateKey.replace(/\\n/g, '\n'),
    }),
  });

  initialized = true;
  return admin.app();
}

export const firebaseService = {
  getMessaging(): admin.messaging.Messaging | null {
    const app = getApp();
    return app ? admin.messaging(app) : null;
  },
};
