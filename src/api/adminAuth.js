const REGION = 'asia-northeast3';

let _projectId = null;
let _useEmulator = false;

/** schedule.json 로드 후 firebase.users config 를 주입 */
export function setUsersConfig(firebaseUsersConfig) {
  _projectId = firebaseUsersConfig?.projectId || null;
  _useEmulator = firebaseUsersConfig?.useEmulator === true;
}

function getBaseUrl() {
  if (!_projectId) throw new Error('관리자 서버 설정이 아직 로드되지 않았습니다. 잠시 후 다시 시도해주세요.');
  return _useEmulator
    ? `http://localhost:5001/${_projectId}/${REGION}`
    : `https://${REGION}-${_projectId}.cloudfunctions.net`;
}

const SESSION_TOKEN_KEY = 'admin_session_token';
const USER_INFO_KEY = 'admin_user_info';
const PIN_REGISTERED_KEY = 'admin_pin_registered';

async function request(path, options = {}) {
  const token = localStorage.getItem(SESSION_TOKEN_KEY);
  const res = await fetch(`${getBaseUrl()}/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '서버 오류가 발생했습니다.');
  return data;
}

function saveSession(sessionToken, name, role) {
  localStorage.setItem(SESSION_TOKEN_KEY, sessionToken);
  localStorage.setItem(USER_INFO_KEY, JSON.stringify({ name, role }));
}

export function getUserInfo() {
  const raw = localStorage.getItem(USER_INFO_KEY);
  return raw ? JSON.parse(raw) : null;
}

export function clearSession() {
  localStorage.removeItem(SESSION_TOKEN_KEY);
  localStorage.removeItem(USER_INFO_KEY);
}

export function isPinRegistered() {
  return localStorage.getItem(PIN_REGISTERED_KEY) === 'true';
}

export function clearPinRegistered() {
  localStorage.removeItem(PIN_REGISTERED_KEY);
}

// JWT payload를 파싱해 만료 여부 확인 (서명 검증 없이 클라이언트 side 체크)
export function isLoggedIn() {
  const token = localStorage.getItem(SESSION_TOKEN_KEY);
  if (!token) return false;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

export function isAdmin() {
  const u = getUserInfo();
  return u ? ['root', 'admin'].includes(u.role) : false;
}

/** 1단계: 신원 확인 (비밀번호) — PIN 미등록 시에만 사용 */
export async function verifyUser(intercessionType, group, name, password) {
  return request('verifyUser', {
    method: 'POST',
    body: JSON.stringify({ intercessionType, group, name, password }),
  });
}

/** 2단계-A: PIN 최초 등록 */
export async function registerPin(verifyToken, pin) {
  const data = await request('registerPin', {
    method: 'POST',
    body: JSON.stringify({ verifyToken, pin }),
  });
  if (data.success) {
    saveSession(data.sessionToken, data.name, data.role);
    localStorage.setItem(PIN_REGISTERED_KEY, 'true');
  }
  return data;
}

/** 2단계-B: PIN 로그인 */
export async function loginWithPin(intercessionType, group, name, pin) {
  const data = await request('loginWithPin', {
    method: 'POST',
    body: JSON.stringify({ intercessionType, group, name, pin }),
  });
  if (data.success) saveSession(data.sessionToken, data.name, data.role);
  return data;
}

export async function checkMe() {
  return request('me', { method: 'GET' });
}
