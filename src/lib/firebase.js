import { parseDate, isNativeApp, getGroupDisplay, getGroupLeader, getGroupTeamName } from './utils.js';

// Firebase 설정은 schedule.json에서 동적 로드 (getFirebaseTargetConfig 참고)
// 하드코딩 제거 - schedule.json의 firebase.pastor / firebase.church 사용
export const FIREBASE_APP_ID = "pastor-prayer-v2-personal";
export const FIREBASE_WEEK1_START = "2026-01-06";

// scheduleData가 로드된 후 사용 (App 컴포넌트 내 scheduleData 참조)
let _scheduleDataRef = null;
export function setScheduleDataRef(data) { _scheduleDataRef = data; }

export function getFirebaseTargetConfig(prayerType) {
  const fb = _scheduleDataRef?.firebase;
  if(prayerType === "교회중보") return fb?.church || null;
  if(prayerType === "테스트") return fb?.test || null;
  return fb?.pastor || null;
}

let firebaseIdTokenCacheByProject = {};

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

const _pendingTokenRequests = new Map(); // 동시 중복 요청 방지

export async function getFirebaseIdToken(firebaseConfig) {
  if(!firebaseConfig) throw new Error("Firebase 설정이 없습니다. schedule.json을 확인해주세요.");
  const now = Date.now();
  const cacheKey = `fbToken_${firebaseConfig.projectId}`;

  // localStorage 캐시 확인
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if(cached?.idToken && cached.expiresAt > now + 300000) return cached.idToken;
  } catch {}

  // 동시 요청 중이면 같은 Promise 반환
  if(_pendingTokenRequests.has(cacheKey)) return _pendingTokenRequests.get(cacheKey);

  const tokenPromise = firebaseFetchJson(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
    { method: "POST", body: JSON.stringify({ returnSecureToken: true }) },
    15000
  ).then(json => {
    const idToken = json?.idToken;
    if(!idToken) throw new Error("Firebase 익명 로그인 토큰을 받지 못했습니다.");
    try { localStorage.setItem(cacheKey, JSON.stringify({ idToken, expiresAt: Date.now() + Number(json?.expiresIn || 3600) * 1000 })); } catch {}
    return idToken;
  }).finally(() => { _pendingTokenRequests.delete(cacheKey); });

  _pendingTokenRequests.set(cacheKey, tokenPromise);
  return tokenPromise;
}

export function toFirestoreValue(value) {
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (value && typeof value === "object") {
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toFirestoreValue(v)])) } };
  }
  return { stringValue: String(value ?? "") };
}

export function toFirestoreFields(data) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, toFirestoreValue(value)]));
}

export function getPastorPrayerWeekNumber(submitDate) {
  const start = parseDate(FIREBASE_WEEK1_START);
  const target = parseDate(submitDate);
  const diffDays = Math.floor((target - start) / (24 * 60 * 60 * 1000));
  return Math.min(Math.max(Math.floor(diffDays / 7) + 1, 1), 52);
}

export function normalizeTeamNumber(group) {
  const match = String(group || "").match(/\d+/);
  return match ? Number(match[0]) : String(group || "").trim();
}

export function buildFirebaseSafeMemberName(name) {
  return String(name || "").replace(/[\/\\?%*:|"<> ]/g, "");
}

export function getAttendanceStatusForFirebase({ isChurchIntercession, weekData, isLate, isLeave, isAbsent }) {
  if (weekData.attendance === "excused") return ["출석 인정 결석"];
  if (isAbsent) return ["결석"];
  if (isChurchIntercession) {
    const status = ["출석"];
    if (isLate) status.push("지각");
    if (isLeave) status.push("조퇴");
    return status;
  }
  if (isLate) return ["지각"];
  if (isLeave) return ["조퇴"];
  if (weekData.attendance === "attend") return ["출석"];
  return ["결석"];
}

export function buildFirebaseChurchStatusString({ isChurchIntercession, weekData, isLate, isLeave, isAbsent }) {
  if (!isChurchIntercession) return null;
  if (weekData.attendance === "excused") return "출석 인정 결석";
  if (isAbsent) return "결석";
  const status = [];
  if (isLate) status.push("지각");
  if (isLeave) status.push("조퇴");
  if (status.length) return status.join(", ");
  if (weekData.attendance === "attend") return "출석";
  return "결석";
}

export function calcFirebaseScoreStatus(status) {
  const arr = Array.isArray(status) ? status : String(status || "").split(", ").map(v => v.trim()).filter(Boolean);
  if (arr.includes("출석") || arr.includes("출석 인정 결석")) return 1;
  if (arr.includes("지각") || arr.includes("조퇴")) return 0.5;
  return 0;
}

export function calcFirebaseMemoryScore(memoryDone, memoryErrors) {
  if (!memoryDone) return 0;
  const errors = Number(memoryErrors || 0);
  if (errors === 0) return 1;
  if (errors <= 3) return 0.5;
  return 0;
}

export async function submitPastorPrayerToFirebase(recordData, firebaseConfig) {
  const idToken = await getFirebaseIdToken(firebaseConfig);
  const teamNumber = normalizeTeamNumber(recordData.teamName);
  const safeMemberName = buildFirebaseSafeMemberName(recordData.name);
  const docId = `wk${recordData.week}_team${teamNumber}_${safeMemberName}`;
  const documentPath = `artifacts/${FIREBASE_APP_ID}/public/data/attendance/${docId}`;
  const documentName = `projects/${firebaseConfig.projectId}/databases/(default)/documents/${documentPath}`;

  const dataWithTimestamps = { ...recordData, updatedAt: new Date(), createdAt: new Date() };
  const fieldPaths = Object.keys(dataWithTimestamps).sort();

  await firebaseFetchJson(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseConfig.projectId)}/databases/(default)/documents:commit`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({
        writes: [{
          update: { name: documentName, fields: toFirestoreFields(dataWithTimestamps) },
          updateMask: { fieldPaths },
        }],
      }),
    },
    15000
  );
}

export const PRAYER_NOTIF_ID = 1001;

export async function ensureTimerNotificationChannel() {
  if(!isNativeApp()) return;
  try {
    const LN = window.Capacitor?.Plugins?.LocalNotifications;
    if(!LN?.createChannel) return;
    await LN.createChannel({
      id: 'prayer',
      name: '기도 타이머',
      importance: 4,
      vibration: true,
      sound: 'default',
      lights: true,
      visibility: 1,
    });
  } catch(e) {
  }
}

export async function scheduleTimerNotification(targetSeconds) {
  if(!isNativeApp()) return;
  try {
    const LN = window.Capacitor?.Plugins?.LocalNotifications;
    if(!LN) return;
    const perm = await LN.checkPermissions();
    if(perm.display !== 'granted') {
      const req = await LN.requestPermissions();
      if(req.display !== 'granted') return;
    }
    await ensureTimerNotificationChannel();
    await LN.cancel({ notifications: [{ id: PRAYER_NOTIF_ID }] });
    const h = Math.floor(targetSeconds/3600);
    const m = Math.floor((targetSeconds%3600)/60);
    await LN.schedule({
      notifications: [{
        id: PRAYER_NOTIF_ID,
        title: "🙏 기도 시간 완료!",
        body: `${h>0?h+"시간 ":""}${m>0?m+"분 ":""}기도를 완료했습니다.`,
        schedule: { at: new Date(Date.now() + targetSeconds * 1000) },
        sound: 'default',
        actionTypeId: 'PRAYER_TIMER',
        channelId: 'prayer',
      }]
    });
  } catch(e) {
  }
}

export async function cancelTimerNotification() {
  if(!isNativeApp()) return;
  try {
    const LN = window.Capacitor?.Plugins?.LocalNotifications;
    if(LN) await LN.cancel({ notifications: [{ id: PRAYER_NOTIF_ID }] });
  } catch {}
}

export async function registerNotificationActions() {
  if(!isNativeApp()) return;
  try {
    const LN = window.Capacitor?.Plugins?.LocalNotifications;
    if(!LN) return;
    await ensureTimerNotificationChannel();
    await LN.registerActionTypes({
      types: [{
        id: 'PRAYER_TIMER',
        actions: [{ id: 'dismiss', title: '확인', foreground: false }]
      }]
    });
  } catch(e){
  }
}

export function parseFirestoreValue(v) {
  if(!v) return null;
  if('stringValue' in v) return v.stringValue;
  if('integerValue' in v) return Number(v.integerValue);
  if('booleanValue' in v) return v.booleanValue;
  if('doubleValue' in v) return v.doubleValue;
  if('timestampValue' in v) return v.timestampValue; // ISO 문자열 그대로
  if('arrayValue' in v) return (v.arrayValue.values||[]).map(parseFirestoreValue);
  if('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,val])=>[k,parseFirestoreValue(val)]));
  return null;
}

export function extractTeamNoFromText(value = "") {
  const match = String(value || "").match(/(\d{1,2})\s*조/);
  if (match) return String(Number(match[1]));
  const raw = String(value || "").trim();
  return /^\d+$/.test(raw) ? String(Number(raw)) : "";
}

export function normalizeMemberNameList(members = []) {
  return [...new Set((members || [])
    .map(v => typeof v === "object" ? v?.name : v)
    .map(v => String(v || "").trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ko"));
}

export function buildTeamsFromAttendanceRows(rows = []) {
  const map = new Map();

  rows.forEach(row => {
    const memberName = String(row.name || "").trim();
    const rawTeamName = String(row.teamName || "").trim();
    const leader = String(row.leader || "").trim();
    const teamNo = extractTeamNoFromText(rawTeamName || row.id || "");

    if (!teamNo || !memberName) return;

    if (!map.has(teamNo)) {
      map.set(teamNo, {
        id: teamNo,
        name: `${String(teamNo).padStart(2, "0")}조`,
        leader: "",
        members: [],
      });
    }

    const team = map.get(teamNo);
    if (leader && !team.leader) team.leader = leader;
    if (!team.members.includes(memberName)) team.members.push(memberName);
  });

  return Array.from(map.values())
    .map(team => ({
      ...team,
      leader: team.leader || "",
      members: normalizeMemberNameList(team.members),
    }))
    .filter(team => team.id && team.members.length > 0)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

export async function fetchFirebaseAttendanceTeams(prayerType) {
  const config = getFirebaseTargetConfig(prayerType);
  if(!config) throw new Error("Firebase 설정이 없습니다.");
  const idToken = await getFirebaseIdToken(config);

  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: "attendance" }],
      orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
    },
    parent: `projects/${config.projectId}/databases/(default)/documents/artifacts/${FIREBASE_APP_ID}/public/data`,
  };

  const json = await firebaseFetchJson(
    url,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(body),
    },
    20000
  );

  const rows = (Array.isArray(json) ? json : [])
    .map(item => item?.document)
    .filter(Boolean)
    .map(doc => {
      const fields = Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, parseFirestoreValue(v)]));
      return { id: doc.name?.split("/").pop() || "", ...fields };
    });

  return buildTeamsFromAttendanceRows(rows);
}

const _pendingTeamsConfigRequests = new Map(); // teams_config 중복 요청 방지
export const _teamsDocCache = new Map(); // 개별 팀 문서 캐시 (N+1 방지)
export const TEAMS_DOC_CACHE_TTL = 5 * 60 * 1000;

export async function fetchFirebaseTeamsConfigCollection(prayerType) {
  // 모듈 레벨 중복 요청 방지 (React StrictMode 이중 호출 대응)
  if(_pendingTeamsConfigRequests.has(prayerType)) {
    return _pendingTeamsConfigRequests.get(prayerType);
  }

  const config = getFirebaseTargetConfig(prayerType);
  if(!config) throw new Error("Firebase 설정이 없습니다.");

  const promise = getFirebaseIdToken(config).then(idToken => {
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/databases/(default)/documents/artifacts/${FIREBASE_APP_ID}/public/data/teams_config`;
    return fetch(url, { headers:{ Authorization:`Bearer ${idToken}` } });
  }).then(res => {
    if(!res.ok) throw new Error(`조 목록 조회 실패: HTTP ${res.status}`);
    return res.json();
  }).then(json => {
    return (json.documents||[])
      .map(doc => {
        const f = Object.fromEntries(Object.entries(doc.fields||{}).map(([k,v])=>[k,parseFirestoreValue(v)]));
        return { id:f.id, name:f.name, leader:f.leader||"", members:normalizeMemberNameList(f.members||[]) };
      })
      .filter(d=>d.id&&d.name)
      .sort((a,b)=>Number(a.id)-Number(b.id));
  }).finally(() => {
    // 완료 후 500ms 뒤 삭제 (결과 공유 후 재시도 허용)
    setTimeout(()=>_pendingTeamsConfigRequests.delete(prayerType), 500);
  });

  _pendingTeamsConfigRequests.set(prayerType, promise);
  return promise;
}

export async function fetchFirebaseTeamsConfig(prayerType) {
  // 조 목록은 작은 teams_config 컬렉션을 먼저 조회합니다.
  // attendance 전체 조회는 문서 수가 많아 pastor 프로젝트에서 429가 쉽게 발생하므로
  // 조 선택 이후 해당 조의 이름 목록을 보강할 때만 제한적으로 사용합니다.
  try {
    const configTeams = await fetchFirebaseTeamsConfigCollection(prayerType);
    if (configTeams.length) return configTeams;
  } catch (e) {
    console.warn("teams_config 조 목록 조회 실패, 기본 목록 또는 조별 attendance 조회로 대체합니다.", e);
  }

  return [];
}

export function buildAttendanceTeamNameVariants(group, prayerType) {
  const display = getGroupDisplay(group);
  const noRaw = String(group?.no || extractTeamNoFromText(display) || getGroupTeamName(group) || "").trim();
  const no = String(Number(noRaw || 0) || noRaw).replace(/^0+/, "") || noRaw;
  const no2 = String(no).padStart(2, "0");
  const leader = getGroupLeader(group);

  const values = new Set();
  if (display) values.add(display);
  if (no) {
    values.add(`${no}조`);
    values.add(`${no} 조`);
  }
  if (no2) {
    values.add(`${no2}조`);
    values.add(`${no2} 조`);
  }
  if (leader) {
    if (no) values.add(`${no}조 ${leader}`);
    if (no2) values.add(`${no2}조 ${leader}`);
  }

  // 교회중보의 schedule display는 "01. 나라와 민족(옥광정)" 형태이고,
  // Firestore attendance에는 teamName이 "1" 또는 "1조"처럼 저장될 수 있어 함께 허용합니다.
  if (prayerType === "교회중보") {
    const teamName = String(getGroupTeamName(group) || "").trim();
    if (teamName) {
      values.add(teamName);
      values.add(`${Number(teamName) || teamName}조`);
    }
  }

  return [...values].map(v => String(v || "").trim()).filter(Boolean).slice(0, 10);
}

export async function fetchFirebaseAttendanceMembersForGroup(prayerType, group) {
  const config = getFirebaseTargetConfig(prayerType);
  if(!config) throw new Error("Firebase 설정이 없습니다.");
  const idToken = await getFirebaseIdToken(config);
  const variants = buildAttendanceTeamNameVariants(group, prayerType);
  if (!variants.length) return [];

  const filters = variants.map(value => ({
    fieldFilter: {
      field: { fieldPath: "teamName" },
      op: "EQUAL",
      value: { stringValue: value },
    },
  }));

  const where = filters.length === 1
    ? filters[0]
    : { compositeFilter: { op: "OR", filters } };

  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: "attendance" }],
      where,
    },
    parent: `projects/${config.projectId}/databases/(default)/documents/artifacts/${FIREBASE_APP_ID}/public/data`,
  };

  const json = await firebaseFetchJson(
    url,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(body),
    },
    12000
  );

  const names = (Array.isArray(json) ? json : [])
    .map(item => item?.document?.fields?.name)
    .filter(Boolean)
    .map(parseFirestoreValue);

  return normalizeMemberNameList(names);
}

export function convertTeamsConfigToGroup(team, prayerType) {
  const isPastor = prayerType === "목회자중보";
  const no = String(team.id).padStart(2,"0");
  const leader = String(team.leader || "").trim();
  const rawMembers = normalizeMemberNameList(team.members || []);
  // 조장을 맨 앞에 추가 (중복 제거)
  const members = leader
    ? [leader, ...rawMembers.filter(m => m !== leader)]
    : rawMembers;
  if(isPastor) {
    return { no, leader, display:leader ? `${no}조 ${leader}` : `${no}조`, teamName:String(Number(team.id) || team.id), members };
  } else {
    const partName = String(team.name || "").replace(/^\d+\.\s*/,"");
    return { no, partName, leader, display:leader ? `${no}. ${partName}(${leader})` : `${no}. ${partName}`, teamName:String(Number(team.id) || team.id), members };
  }
}

const FIREBASE_ROSTER_CACHE_PREFIX = "fbRosterMerged";

function getRosterCacheKey(prayerType) {
  return `${FIREBASE_ROSTER_CACHE_PREFIX}_${prayerType || ""}`;
}

export function loadFirebaseRosterCache(prayerType) {
  try {
    const cached = JSON.parse(localStorage.getItem(getRosterCacheKey(prayerType)) || "null");
    if (cached?.groups?.length) return cached;
  } catch {}
  return null;
}

export function saveFirebaseRosterCache(prayerType, groups) {
  if (!prayerType || !Array.isArray(groups) || groups.length === 0) return;
  try {
    localStorage.setItem(getRosterCacheKey(prayerType), JSON.stringify({
      savedAt: new Date().toISOString(),
      prayerType,
      groups,
    }));
  } catch {}
}

export function mergeGroupsPreservingLocalMembers(baseGroups = [], incomingGroups = []) {
  const byNo = new Map();

  baseGroups.forEach(g => {
    const no = String(g?.no || extractTeamNoFromText(getGroupDisplay(g) || getGroupTeamName(g) || "")).padStart(2, "0");
    if (!no) return;
    byNo.set(no, { ...g, no, members: normalizeMemberNameList(g?.members || []) });
  });

  incomingGroups.forEach(g => {
    const no = String(g?.no || extractTeamNoFromText(getGroupDisplay(g) || getGroupTeamName(g) || "")).padStart(2, "0");
    if (!no) return;
    const prev = byNo.get(no);
    const mergedMembers = normalizeMemberNameList([...(prev?.members || []), ...(g?.members || [])]);

    byNo.set(no, {
      ...(prev || {}),
      ...g,
      no,
      leader: g?.leader || prev?.leader || "",
      partName: g?.partName || prev?.partName || "",
      display: g?.display || prev?.display || getGroupDisplay(g),
      teamName: g?.teamName || prev?.teamName || getGroupTeamName(g),
      members: mergedMembers,
    });
  });

  return Array.from(byNo.values()).sort((a, b) => Number(a.no || 0) - Number(b.no || 0));
}

export function getCachedOrScheduleGroups(prayerType, scheduleData) {
  const scheduleGroups = scheduleData?.groupsByType?.[prayerType] || [];
  const cached = loadFirebaseRosterCache(prayerType);
  if (cached?.groups?.length) return mergeGroupsPreservingLocalMembers(scheduleGroups, cached.groups);
  return scheduleGroups;
}

export function mergeFirebaseGroupsWithSchedule(firebaseGroups = [], prayerType, scheduleData) {
  if(firebaseGroups.length > 0) {
    // Firebase에서 데이터를 받았으면 Firebase 데이터만 사용 (schedule.json merge 안 함)
    saveFirebaseRosterCache(prayerType, firebaseGroups);
    return firebaseGroups;
  }
  // Firebase 실패 시 캐시 또는 schedule.json fallback
  const cachedGroups = loadFirebaseRosterCache(prayerType)?.groups || [];
  if(cachedGroups.length) return cachedGroups;
  return scheduleData?.groupsByType?.[prayerType] || [];
}
