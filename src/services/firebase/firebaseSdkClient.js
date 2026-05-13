const _sdkAuthPromises = new Map();
let _firebaseSdkModulesPromise = null;

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

export async function getFirebaseSdkContext(firebaseConfig) {
  const sdk = await loadFirebaseSdkModules();
  const app = getFirebaseSdkApp(firebaseConfig, sdk);
  const auth = sdk.getAuth(app);
  const authKey = firebaseConfig.projectId;

  if (!auth.currentUser) {
    if (!_sdkAuthPromises.has(authKey)) {
      _sdkAuthPromises.set(authKey, sdk.signInAnonymously(auth).finally(() => {
        _sdkAuthPromises.delete(authKey);
      }));
    }
    await _sdkAuthPromises.get(authKey);
  }

  return { sdk, db: sdk.getFirestore(app) };
}
