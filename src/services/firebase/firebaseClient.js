import { buildFirebaseAuthSignUpUrl } from './firebasePaths.js';

export function withTimeout(promise, ms = 12000, message = "요청 시간이 초과되었습니다.") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

export async function firebaseFetchJson(url, options = {}, timeoutMs = 15000) {
  const res = await withTimeout(
    fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    }),
    timeoutMs,
    "Firebase 서버 응답 시간이 초과되었습니다. 네트워크 상태를 확인해 주세요."
  );

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return json;
}

const pendingTokenRequests = new Map();

export async function getFirebaseIdToken(firebaseConfig) {
  if(!firebaseConfig) throw new Error("Firebase 설정이 없습니다. schedule.json을 확인해주세요.");
  const now = Date.now();
  const cacheKey = `fbToken_${firebaseConfig.projectId}`;

  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if(cached?.idToken && cached.expiresAt > now + 300000) return cached.idToken;
  } catch {}

  if(pendingTokenRequests.has(cacheKey)) return pendingTokenRequests.get(cacheKey);

  const tokenPromise = firebaseFetchJson(
    buildFirebaseAuthSignUpUrl(firebaseConfig.apiKey),
    { method: "POST", body: JSON.stringify({ returnSecureToken: true }) },
    15000
  ).then(json => {
    const idToken = json?.idToken;
    if(!idToken) throw new Error("Firebase 익명 로그인 토큰을 받지 못했습니다.");
    try {
      localStorage.setItem(cacheKey, JSON.stringify({
        idToken,
        expiresAt: Date.now() + Number(json?.expiresIn || 3600) * 1000,
      }));
    } catch {}
    return idToken;
  }).finally(() => {
    pendingTokenRequests.delete(cacheKey);
  });

  pendingTokenRequests.set(cacheKey, tokenPromise);
  return tokenPromise;
}

export async function fetchFirebaseJsonWithAuth(firebaseConfig, url, options = {}, timeoutMs = 15000) {
  const idToken = await getFirebaseIdToken(firebaseConfig);
  return firebaseFetchJson(
    url,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${idToken}`,
        ...(options.headers || {}),
      },
    },
    timeoutMs
  );
}

export async function fetchFirebaseDocumentWithAuth(firebaseConfig, url) {
  const idToken = await getFirebaseIdToken(firebaseConfig);
  const res = await fetch(url, { headers:{ Authorization:`Bearer ${idToken}` } });
  if(res.status === 404) return null;
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

