import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const projectId =
  process.env.FIREBASE_PROJECT_ID?.trim() ||
  "kipris-firebase-platform";

const storageBucket =
  process.env.FIREBASE_STORAGE_BUCKET?.trim() ||
  "kipris-firebase-platform.firebasestorage.app";

function getCredential() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();

  if (clientEmail && privateKey) {
    return cert({
      projectId,
      clientEmail,
      privateKey,
    });
  }

  return applicationDefault();
}

const firebaseApp =
  getApps()[0] ??
  initializeApp({
    credential: getCredential(),
    projectId,
    storageBucket,
  });

export const adminDb = getFirestore(firebaseApp);
export const adminStorage = getStorage(firebaseApp);
export const adminBucket = adminStorage.bucket();