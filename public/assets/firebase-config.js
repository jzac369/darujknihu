// Konfigurácia Firebase projektu. Tieto hodnoty nie sú tajné – prístup k dátam
// strážia pravidlá vo firestore.rules a storage.rules.
// Doplňte ich z Firebase Console → Project settings → Your apps → Web app.
export const firebaseConfig = {
  apiKey: "DOPLNIT",
  authDomain: "darujknihu.firebaseapp.com",
  projectId: "darujknihu",
  storageBucket: "darujknihu.firebasestorage.app",
  messagingSenderId: "DOPLNIT",
  appId: "DOPLNIT",
};

// Na localhost sa web pripojí na lokálne emulátory Firebase (firebase emulators:start).
export const useEmulators = ["localhost", "127.0.0.1"].includes(location.hostname);
