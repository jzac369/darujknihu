// Konfigurácia Firebase projektu. Tieto hodnoty nie sú tajné – prístup k dátam
// strážia pravidlá vo firestore.rules a storage.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyDqXwkOvRj8mje5DemAwgZSU1cA6QBbOkI",
  authDomain: "darujknihu-c44b7.firebaseapp.com",
  projectId: "darujknihu-c44b7",
  storageBucket: "darujknihu-c44b7.firebasestorage.app",
  messagingSenderId: "465662340680",
  appId: "1:465662340680:web:149d094d0998d4f430f27d",
};

// Na localhost sa web pripojí na lokálne emulátory Firebase (firebase emulators:start).
export const useEmulators = ["localhost", "127.0.0.1"].includes(location.hostname);
