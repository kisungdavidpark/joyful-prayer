const _sdkAuthPromises = new Map();
const _sdkFirestoreInstances = new Map();
let _firebaseSdkModulesPromise = null;

function withSdkTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function loadFirebaseSdkModules() {
  if (!_firebaseSdkModulesPromise) {
    _firebaseSdkModulesPromise = Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('firebase/firestore'),
    ]).then(([app, auth, firestore]) => ({ ...app, ...auth, ...firestore }));
  }
  return _firebaseSdkModulesPromise;
}

function getFirebaseSdkApp(firebaseConfig, sdk) {
  const appName = `joyful-prayer-${firebaseConfig.projectId}`;
  if (sdk.getApps().some(app => app.name === appName)) return sdk.getApp(appName);
  return sdk.initializeApp(firebaseConfig, appName);
}

function getFirebaseSdkAuth(app, firebaseConfig, sdk) {
  try {
    return sdk.initializeAuth(app, {
      persistence: sdk.indexedDBLocalPersistence,
    });
  } catch {
    return sdk.getAuth(app);
  }
}

function getFirebaseSdkFirestore(app, firebaseConfig, sdk) {
  const dbKey = firebaseConfig.projectId;
  if (_sdkFirestoreInstances.has(dbKey)) return _sdkFirestoreInstances.get(dbKey);

  try {
    const db = sdk.initializeFirestore(app, {
      experimentalForceLongPolling: true,
      useFetchStreams: false,
    });
    _sdkFirestoreInstances.set(dbKey, db);
    return db;
  } catch {
    const db = sdk.getFirestore(app);
    _sdkFirestoreInstances.set(dbKey, db);
    return db;
  }
}

export async function getFirebaseSdkContext(firebaseConfig) {
  const sdk = await loadFirebaseSdkModules();
  const app = getFirebaseSdkApp(firebaseConfig, sdk);
  const auth = getFirebaseSdkAuth(app, firebaseConfig, sdk);
  const authKey = firebaseConfig.projectId;

  if (!auth.currentUser) {
    if (!_sdkAuthPromises.has(authKey)) {
      _sdkAuthPromises.set(authKey, withSdkTimeout(
        sdk.signInAnonymously(auth),
        10000,
        "Firebase 익명 인증 시간이 초과되었습니다."
      ).finally(() => {
        _sdkAuthPromises.delete(authKey);
      }));
    }
    await _sdkAuthPromises.get(authKey);
  }

  return { sdk, db: getFirebaseSdkFirestore(app, firebaseConfig, sdk) };
}
