import { parseDate, isNativeApp, getGroupDisplay, getGroupLeader, getGroupTeamName } from './utils.js';
import {
  fetchSubmissionForDisplay,
  saveSubmissionToFirestore,
} from '../services/firebase/submissionRepository.js';
import {
  fetchTeamConfigMembers,
  fetchTeamsConfigCollection,
} from '../services/firebase/teamRepository.js';

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

export function withTimeout(promise, ms = 12000, message = "요청 시간이 초과되었습니다.") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
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
  const teamNumber = normalizeTeamNumber(recordData.teamName);
  const safeMemberName = buildFirebaseSafeMemberName(recordData.name);
  return saveSubmissionToFirestore(recordData, firebaseConfig, { appId: FIREBASE_APP_ID, teamNumber, safeMemberName });
}

export async function fetchFirebaseSubmissionForDisplay(docId, prayerType) {
  const config = getFirebaseTargetConfig(prayerType);
  if(!config) throw new Error("Firebase 설정이 없습니다.");
  return fetchSubmissionForDisplay(config, { appId: FIREBASE_APP_ID, docId });
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

  const promise = withTimeout(
    fetchTeamsConfigCollection(config, { appId: FIREBASE_APP_ID }),
    12000,
    "조 목록 조회 시간이 초과되었습니다."
  ).then(teams => {
    return teams.map(team => ({
      id: team.id,
      name: team.name,
      leader: team.leader || "",
      members: normalizeMemberNameList(team.members || []),
    }));
  }).finally(() => {
    // 완료 후 500ms 뒤 삭제 (결과 공유 후 재시도 허용)
    setTimeout(()=>_pendingTeamsConfigRequests.delete(prayerType), 500);
  });

  _pendingTeamsConfigRequests.set(prayerType, promise);
  return promise;
}

export async function fetchFirebaseTeamsConfig(prayerType) {
  try {
    const configTeams = await fetchFirebaseTeamsConfigCollection(prayerType);
    if (configTeams.length) return configTeams;
  } catch (e) {
    console.warn("teams_config 조 목록 조회 실패, 기본 목록으로 대체합니다.", e);
    throw e;
  }

  return [];
}

export async function fetchFirebaseTeamConfigMembers(prayerType, teamId) {
  const config = getFirebaseTargetConfig(prayerType);
  if(!config) throw new Error("Firebase 설정이 없습니다.");
  return fetchTeamConfigMembers(config, { appId: FIREBASE_APP_ID, teamId });
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
    const displayNo = String(Number(team.id) || team.id);
    return { no, leader, display:leader ? `${displayNo}조 (${leader})` : `${displayNo}조`, teamName:displayNo, members };
  } else {
    const partName = String(team.name || "").replace(/^\d+\.\s*/,"");
    return { no, partName, leader, display:partName, teamName:String(Number(team.id) || team.id), members };
  }
}

const FIREBASE_ROSTER_CACHE_PREFIX = "fbRosterMerged";
const FIREBASE_ROSTER_CACHE_VERSION = 2;

function getRosterCacheKey(prayerType) {
  return `${FIREBASE_ROSTER_CACHE_PREFIX}_${prayerType || ""}`;
}

export function loadFirebaseRosterCache(prayerType) {
  try {
    const cached = JSON.parse(localStorage.getItem(getRosterCacheKey(prayerType)) || "null");
    if (cached?.version !== FIREBASE_ROSTER_CACHE_VERSION) return null;
    if (cached?.groups?.length) return cached;
  } catch {}
  return null;
}

export function saveFirebaseRosterCache(prayerType, groups) {
  if (!prayerType || !Array.isArray(groups) || groups.length === 0) return;
  try {
    localStorage.setItem(getRosterCacheKey(prayerType), JSON.stringify({
      version: FIREBASE_ROSTER_CACHE_VERSION,
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
