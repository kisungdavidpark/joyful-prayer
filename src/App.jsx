import { useState, useEffect, useRef, useMemo } from "react";
import SHA256 from "crypto-js/sha256";

// Capacitor 네이티브 환경 감지
const isNativeApp = () => {
  return typeof window !== "undefined" &&
    (window.Capacitor?.isNativePlatform?.() ||
     window.Capacitor?.platform === "ios" ||
     window.Capacitor?.platform === "android");
};

async function haptic(style = "light") {
  if(!isNativeApp()) return;
  try {
    const H = window.Capacitor?.Plugins?.Haptics;
    if(!H) return;
    const styleMap = { light:"LIGHT", medium:"MEDIUM", heavy:"HEAVY" };
    await H.impact({ style: styleMap[style] || "LIGHT" });
  } catch {}
}



// Firebase 설정은 schedule.json에서 동적 로드 (getFirebaseTargetConfig 참고)
// 하드코딩 제거 - schedule.json의 firebase.pastor / firebase.church 사용
const FIREBASE_APP_ID = "pastor-prayer-v2-personal";
const FIREBASE_WEEK1_START = "2026-01-06";

// scheduleData가 로드된 후 사용 (App 컴포넌트 내 scheduleData 참조)
let _scheduleDataRef = null;
function setScheduleDataRef(data) { _scheduleDataRef = data; }

function getFirebaseTargetConfig(prayerType) {
  const fb = _scheduleDataRef?.firebase;
  if(prayerType === "교회중보") return fb?.church || null;
  return fb?.pastor || null;
}

let firebaseIdTokenCacheByProject = {};

function withTimeout(promise, ms = 12000, message = "요청 시간이 초과되었습니다.") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

async function firebaseFetchJson(url, options = {}, timeoutMs = 15000) {
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

async function getFirebaseIdToken(firebaseConfig) {
  if(!firebaseConfig) throw new Error("Firebase 설정이 없습니다. schedule.json을 확인해주세요.");
  const now = Date.now();
  const cacheKey = `fbToken_${firebaseConfig.projectId}`;

  // localStorage 캐시 확인
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if(cached?.idToken && cached.expiresAt > now + 60000) return cached.idToken;
  } catch {}

  const json = await firebaseFetchJson(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
    { method: "POST", body: JSON.stringify({ returnSecureToken: true }) },
    15000
  );

  const idToken = json?.idToken;
  if (!idToken) throw new Error("Firebase 익명 로그인 토큰을 받지 못했습니다.");

  // localStorage에 캐시 저장
  const cacheData = {
    idToken,
    expiresAt: now + Number(json?.expiresIn || 3600) * 1000,
  };
  try { localStorage.setItem(cacheKey, JSON.stringify(cacheData)); } catch {}

  return idToken;
}

function toFirestoreValue(value) {
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (value && typeof value === "object") {
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toFirestoreValue(v)])) } };
  }
  return { stringValue: String(value ?? "") };
}

function toFirestoreFields(data) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, toFirestoreValue(value)]));
}

function getPastorPrayerWeekNumber(submitDate) {
  const start = parseDate(FIREBASE_WEEK1_START);
  const target = parseDate(submitDate);
  const diffDays = Math.floor((target - start) / (24 * 60 * 60 * 1000));
  return Math.min(Math.max(Math.floor(diffDays / 7) + 1, 1), 52);
}

function normalizeTeamNumber(group) {
  const match = String(group || "").match(/\d+/);
  return match ? match[0] : String(group || "").trim();
}

function buildFirebaseSafeMemberName(name) {
  return String(name || "").replace(/[\/\\?%*:|"<> ]/g, "");
}

function getAttendanceStatusForFirebase({ isChurchIntercession, weekData, isLate, isLeave, isAbsent }) {
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

function buildFirebaseChurchStatusString({ isChurchIntercession, weekData, isLate, isLeave, isAbsent }) {
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

function calcFirebaseScoreStatus(status) {
  const arr = Array.isArray(status) ? status : String(status || "").split(", ").map(v => v.trim()).filter(Boolean);
  if (arr.includes("출석") || arr.includes("출석 인정 결석")) return 1;
  if (arr.includes("지각") || arr.includes("조퇴")) return 0.5;
  return 0;
}

function calcFirebaseMemoryScore(memoryDone, memoryErrors) {
  if (!memoryDone) return 0;
  const errors = Number(memoryErrors || 0);
  if (errors === 0) return 1;
  if (errors <= 3) return 0.5;
  return 0;
}

async function submitPastorPrayerToFirebase(recordData, firebaseConfig = FIREBASE_PASTOR_CONFIG) {
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

const PRAYER_NOTIF_ID = 1001;

async function ensureTimerNotificationChannel() {
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

async function scheduleTimerNotification(targetSeconds) {
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

async function cancelTimerNotification() {
  if(!isNativeApp()) return;
  try {
    const LN = window.Capacitor?.Plugins?.LocalNotifications;
    if(LN) await LN.cancel({ notifications: [{ id: PRAYER_NOTIF_ID }] });
  } catch {}
}

async function registerNotificationActions() {
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

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

// 테스트용 날짜 지정 또는 오프셋으로 현재 날짜 반환
function getNow() {
  const testDate = localStorage.getItem("__testDate") || "";
  if (testDate) {
    const parsed = parseDate(testDate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const offset = Number(localStorage.getItem("__testDateOffset") || 0);
  if (!offset) return new Date();
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d;
}

// 로컬 날짜를 YYYY-MM-DD 문자열로 변환 (UTC 변환 없이)
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
};

// 날짜 문자열 → 로컬 Date (UTC 파싱 방지)
function parseDate(str) {
  const [y,m,d] = str.split("-").map(Number);
  return new Date(y, m-1, d);
};

function getWeekKey(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay(); // 0=일, 1=월, 2=화~6=토
  const diff = day < 2 ? day + 5 : day - 2; // 해당 주 화요일까지의 거리
  d.setDate(d.getDate() - diff);
  return toDateStr(d);
};

function getSubmitDate(wk) {
  const d = parseDate(wk);
  d.setDate(d.getDate() + 7);
  return toDateStr(d);
};

const fmtTime = (sec) => `${String(Math.floor(sec/3600)).padStart(2,"0")}:${String(Math.floor((sec%3600)/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`;
const fmtHM = (sec) => { const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60); return h>0&&m>0?`${h}시간 ${m}분`:h>0?`${h}시간`:`${m}분`; };
const WEEK_DAYS = ["화","수","목","금","토","일","월"];

function getWeekDates(wk) {
  return Array.from({length:7}, (_,i) => {
    const d = parseDate(wk);
    d.setDate(d.getDate() + i);
    return d;
  });
}
const load = (k,d) => { try { return JSON.parse(localStorage.getItem(k))??d; } catch { return d; } };
const save = (k,v) => localStorage.setItem(k, JSON.stringify(v));

// ─── schedule.json 원격+내장 로딩 유틸 ─────────────────────────────
const REMOTE_SCHEDULE_URL = import.meta.env.VITE_REMOTE_SCHEDULE_URL;

async function loadScheduleJson() {
  const localUrl = `${import.meta.env.BASE_URL}schedule.json?v=${Date.now()}`;

  // iOS/Android Capacitor 앱에서는 GitHub Pages의 schedule.json을 우선 사용한다.
  // 원격 로딩 실패 시 앱에 내장된 schedule.json으로 fallback 한다.
  if (isNativeApp() && REMOTE_SCHEDULE_URL) {
    try {
      const remoteUrl = `${REMOTE_SCHEDULE_URL}${REMOTE_SCHEDULE_URL.includes("?") ? "&" : "?"}v=${Date.now()}`;
      const remoteRes = await fetch(remoteUrl, { cache: "no-store" });
      if (!remoteRes.ok) throw new Error(`Remote schedule load failed: ${remoteRes.status}`);
      return await remoteRes.json();
    } catch (err) {
    }
  }

  const localRes = await fetch(localUrl, { cache: "no-store" });
  if (!localRes.ok) throw new Error(`Local schedule load failed: ${localRes.status}`);
  return await localRes.json();
}

/* supabase 관련 유틸 - 현재는 사용하지 않지만 향후 데이터 동기화 기능 등에 활용 가능 */
const getSupabaseConfig = () => ({
  url: import.meta.env.VITE_SUPABASE_URL || "",
  key: import.meta.env.VITE_SUPABASE_ANON_KEY || "",
});

function collectLocalStorageData(year = String(new Date().getFullYear())) {
  const data = {};

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);

    // 서버 백업에는 해당 연도의 사용자 입력 기록만 포함한다.
    // profile 정보는 백업하지 않는다.
    // 이전 연도 데이터는 로컬에 보관하고 다른 연도 백업에 섞지 않는다.
    if (isWeekKeyInYear(key, year)) {
      data[key] = localStorage.getItem(key);
    }
  }

  data.__backupYear = year;
  return data;
}

function hasValidBackupData(data) {
  if (!data || typeof data !== "object") return false;

  const backupYear = data.__backupYear || String(new Date().getFullYear());
  const hasWeekData = Object.keys(data).some(key => isWeekKeyInYear(key, backupYear));

  // 초기화 직후 빈 데이터가 서버 백업을 덮어쓰는 것 방지
  return hasWeekData;
}

function getBackupUserId(profile) {
  return [profile?.prayerType, profile?.group, profile?.name]
    .map(v => String(v || "").trim())
    .filter(Boolean)
    .join("_");
}

// PIN SHA-256 해시 (Web Crypto API)
async function hashPin(pin) {
  const encoder = new TextEncoder();
  const data = encoder.encode(pin);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

async function backupProfileToSupabase(profile) {
  const { url, key } = getSupabaseConfig();
  if (!url || !key) throw new Error("Supabase 설정이 없습니다.");

  const trimmedName = String(profile?.name || "").trim();
  const group = String(profile?.group || "").trim();

  if (!profile?.prayerType) throw new Error("중보 유형을 선택해 주세요.");
  if (!group) throw new Error("조를 선택해 주세요.");
  if (!trimmedName) throw new Error("이름을 입력해 주세요.");

  const userId = getBackupUserId({ ...profile, group, name: trimmedName });
  if (!userId) throw new Error("백업할 사용자 정보가 부족합니다.");

  const year = String(getNow().getFullYear());
  const backupData = collectLocalStorageData(year);
  if (!hasValidBackupData(backupData)) {
    throw new Error("백업할 사용자 기록이 없습니다. 초기화 직후의 빈 데이터는 서버 백업하지 않습니다.");
  }

  const res = await fetch(`${url}/rest/v1/prayer_backups?on_conflict=user_id`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{
      user_id: userId,
      prayer_type: profile?.prayerType || "",
      group_name: group,
      name: trimmedName,
      data: backupData,
      updated_at: new Date().toISOString(),
    }]),
  });

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || `HTTP ${res.status}`);
  }
}

function getDayEff(wd, key) {
  return wd.dailySeconds?.[key]||0;
};
function filterByDate(list, wk) {
  return (Array.isArray(list)?list:[]).filter(r=>r.startDate<=wk && r.endDate>=wk);
}

function getPrevWeekKey(wk) {
  const d = parseDate(wk);
  d.setDate(d.getDate() - 7);
  return toDateStr(d);
}

function getYearFromWeekKey(wk) {
  return String(parseDate(wk).getFullYear());
}

function isWeekKeyInYear(key, year) {
  return key.startsWith(`week_${year}-`);
}

function filterByRange(list, startDate, endDate) {
  return (Array.isArray(list)?list:[]).filter(r => r.startDate <= endDate && r.endDate >= startDate);
}

function uniqueVerses(verses) {
  const seen = new Set();
  return (Array.isArray(verses)?verses:[]).filter(v => {
    const key = v.reference || v.text || JSON.stringify(v);
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getMemoryVersesForWeek(scheduleVerse, wk) {
  const dates = getWeekDates(wk);
  const startDate = wk;
  const endDate = toDateStr(dates[6]);
  const groups = filterByRange(scheduleVerse, startDate, endDate);

  // 암송 JSON은 기본적으로 { startDate, endDate, reference, text } 형태를 사용한다.
  // 이전 데이터 호환을 위해 verses 배열이 있으면 함께 읽는다.
  return uniqueVerses(groups.flatMap(g => {
    if (g.reference || g.text) {
      return [{ reference: g.reference || "", text: g.text || "" }];
    }
    return Array.isArray(g.verses) ? g.verses : [];
  }));
}

// ─── 테마 ─────────────────────────────────────────────────────────────────────

// Prefill URL → {base, entries} 파싱 유틸
function parsePrefillUrl(urlStr) {
  try {
    const url = new URL(urlStr.trim());
    const base = url.origin + url.pathname;
    const entries = {};
    url.searchParams.forEach((v,k)=>{ if(k.startsWith("entry.")) entries[k]=v; });
    if (!Object.keys(entries).length) return null;
    return {base, entries};
  } catch { return null; }
}
const THEMES = {
  dark: {
    bg:"#0D1117", surface:"#161B22", surface2:"#1C2128", border:"#30363D",
    accent:"#C8973A", accentLight:"#E5B96A", gold:"#F0C060",
    text:"#E6EDF3", muted:"#8B949E",
    green:"#3FB950", red:"#F85149", blue:"#58A6FF", purple:"#BC8CFF",
    gradientEnd:"#111827", gradientEndBlue:"#0f1a2e", gradientEndWarm:"#111827",
  },
  light: {
    bg:"#F0F2F5", surface:"#FFFFFF", surface2:"#E8ECF0", border:"#C8D0DA",
    accent:"#8B5E1A", accentLight:"#B07828", gold:"#7A4D0A",
    text:"#0D1117", muted:"#4A5568",
    green:"#166534", red:"#B91C1C", blue:"#1D4ED8", purple:"#6D28D9",
    gradientEnd:"#FFFDF8", gradientEndBlue:"#F8FBFF", gradientEndWarm:"#FFFDF8",
  },
};
// C는 App 렌더 시 동적으로 덮어씀 — 초기값은 dark
let C = {...THEMES.dark};
const getInp = () => ({width:"100%",background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 12px",color:C.text,fontSize:"0.875rem",outline:"none",boxSizing:"border-box"});
const getCard = () => ({background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:16,marginBottom:12});
const getLbl = () => ({fontSize:"0.69rem",color:C.muted,fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:10,display:"block"});
const getInputCard = () => ({...getCard(),borderLeft:`3px solid ${C.accent}`,paddingLeft:13});
const SectionLabel = ({text}) => (
  <div style={{display:"flex",alignItems:"center",gap:8,margin:"4px 0 8px",padding:"0 2px"}}>
    <div style={{flex:1,height:1,background:C.border}}/>
    <div style={{fontSize:"0.625rem",fontWeight:700,color:C.accent,letterSpacing:"1.5px",whiteSpace:"nowrap"}}>{text}</div>
    <div style={{flex:1,height:1,background:C.border}}/>
  </div>
);
const btn = (v="primary") => ({
  background:v==="primary"?C.accent:v==="danger"?C.red:v==="green"?C.green:"transparent",
  color:v==="ghost"?C.muted:"#fff",
  border:v==="ghost"?`1px solid ${C.border}`:"none",
  borderRadius:8, padding:"9px 16px", fontSize:"0.81rem", fontWeight:600, cursor:"pointer",
});

const ADMIN_PW_HASH = import.meta.env.VITE_ADMIN_PW_HASH || "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4"; // SHA256 of "1234"

const EASY_MODE_LEVELS = [
  {value:"100", label:"작게"},
  {value:"120", label:"기본"},
  {value:"130", label:"크게"},
  {value:"140", label:"더 크게"},
  {value:"150", label:"아주 크게"},
];

const getEasyModeLabel = (level) => {
  const n = Number(level);
  if (n <= 110) return "작게";
  if (n <= 125) return "기본";
  if (n <= 135) return "크게";
  if (n <= 145) return "더 크게";
  return "아주 크게";
};

const THEME_MODE_OPTIONS = [
  {value:"system", label:"시스템"},
  {value:"light", label:"라이트"},
  {value:"dark", label:"다크"},
];

// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [tab,setTab] = useState("prayer");
  const [prevTab,setPrevTab] = useState("prayer");
  const [profile,setProfile] = useState(()=>load("profile",{group:"",name:"",prayerType:"",setupDone:false}));
  const [privacyAgreed,setPrivacyAgreed] = useState(()=>load("privacyAgreed",false));
  const [easyModeLevel,setEasyModeLevel] = useState(()=>load("easyModeLevel", "120"));
  const easyMode = easyModeLevel !== "120";
  const [themeMode,setThemeModeState] = useState(()=>load("themeMode", "system"));
  const [systemDark,setSystemDark] = useState(()=>{
    if(typeof window === "undefined" || !window.matchMedia) return true;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const activeTheme = themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;

  // C를 현재 테마로 업데이트 (렌더 시점에 동기화)
  C = THEMES[activeTheme];

  const setThemeMode = (mode) => {
    setThemeModeState(mode);
    save("themeMode", mode);
  };
  const setEasyMode = (level) => {
    setEasyModeLevel(level);
    save("easyModeLevel", level);
    save("easyMode", level !== "120");
  };

  const [installPrompt,setInstallPrompt] = useState(null);
  const [isIOS,setIsIOS] = useState(false);
  const [isStandalone,setIsStandalone] = useState(false);
  const [showIOSInstallGuide,setShowIOSInstallGuide] = useState(false);

  useEffect(()=>{
    const ua = window.navigator.userAgent || "";
    const ios = /iphone|ipad|ipod/i.test(ua);
    const standalone = window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
    setIsIOS(ios);
    setIsStandalone(standalone);

    const handleBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setInstallPrompt(e);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return ()=>window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  },[]);

  const handleInstallApp = async () => {
    if(isStandalone) return;

    if(installPrompt){
      installPrompt.prompt();
      await installPrompt.userChoice.catch(()=>null);
      setInstallPrompt(null);
      return;
    }

    if(isIOS){
      setShowIOSInstallGuide(true);
      return;
    }

    alert("브라우저 메뉴에서 '앱 설치' 또는 '홈 화면에 추가'를 선택해주세요.");
  };

  // schedule.json fetch 로드
  const [scheduleData,setScheduleData] = useState(()=>load("scheduleCache",null));
  const [scheduleLoading,setScheduleLoading] = useState(false);
  const [scheduleError,setScheduleError] = useState(null);


  // 기도 타이머 state - 탭 전환 시에도 유지
  const [timerRunning,setTimerRunning] = useState(false);
  const [timerElapsed,setTimerElapsed] = useState(0);
  const [timerMode,setTimerMode] = useState("stopwatch");
  const [timerTarget,setTimerTarget] = useState(3600);
  const [timerActiveDay,setTimerActiveDay] = useState("");
  const [timerAlarming,setTimerAlarming] = useState(false);

  // 타이머 ref - App 레벨에서 관리해야 탭 전환 시 유지
  const timerStartTsRef = useRef(null);
  const timerBaseElapsedRef = useRef(0);
  const timerIntervalRef = useRef(null);
  const timerAutoSavedElapsedRef = useRef(0); // 분 단위 자동 저장 기준 elapsed
  const timerAlarmPlayedRef = useRef(false);  // 타이머 완료 알람 중복 방지
  const audioCtxRef = useRef(null); // 사용자 인터랙션 시 초기화
  const timerAlarmIntervalRef = useRef(null);
  const timerAlarmStopAtRef = useRef(0);
  const timerAlarmNotificationIdsRef = useRef([]);
  const ALARM_REPEAT_INTERVAL_SECONDS = 30;
  const ALARM_REPEAT_MAX_SECONDS = 180;

  useEffect(()=>{
    setScheduleLoading(true);
    loadScheduleJson()
      .then(data=>{
        setScheduleData(data);
        setScheduleDataRef(data); // Firebase 설정 참조 등록
        save("scheduleCache", data); // 오프라인 대비 캐시
        setScheduleError(null);
      })
      .catch(e=>{
        setScheduleError(e.message);
        // 캐시된 데이터로 폴백
      })
      .finally(()=>setScheduleLoading(false));
  },[]);

  // 시스템 테마 변경 감지
  useEffect(()=>{
    if(typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => setSystemDark(e.matches);
    setSystemDark(media.matches);
    media.addEventListener?.("change", handler);
    media.addListener?.(handler);
    return ()=>{
      media.removeEventListener?.("change", handler);
      media.removeListener?.(handler);
    };
  },[]);

  // 테마 변경 시 body 배경색 동기화 및 스크롤
  useEffect(()=>{
    document.body.style.background = C.bg;
    document.body.style.color = C.text;
    document.body.style.overflowY = "auto";
    document.body.style.webkitOverflowScrolling = "touch";
    document.documentElement.style.overflowY = "auto";
  },[activeTheme]);
  useEffect(()=>{
    document.documentElement.style.fontSize = `${easyModeLevel}%`;
  },[easyModeLevel]);

  const playAlarmSound = () => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if(!AudioCtx) return;
      const ctx = audioCtxRef.current || new AudioCtx();
      audioCtxRef.current = ctx;
      if(ctx.state === "suspended") ctx.resume();

      const playBeep = (freq, start, dur) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = "sine";
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(0.8, ctx.currentTime + start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + dur + 0.05);
      };

      playBeep(880, 0.0, 0.45);
      playBeep(1100, 0.55, 0.45);
      playBeep(880, 1.10, 0.45);
      playBeep(1320, 1.65, 0.70);
    } catch (e) {
    }
  };

  const cancelTimerNotification = async () => {
    if(!isNativeApp()) return;
    try {
      const LN = window.Capacitor?.Plugins?.LocalNotifications;
      if(!LN) return;
      const ids = [...new Set([PRAYER_NOTIF_ID, ...timerAlarmNotificationIdsRef.current])];
      if(ids.length){
        await LN.cancel({ notifications: ids.map(id=>({id})) });
      }
      timerAlarmNotificationIdsRef.current = [];
    } catch (e) {
    }
  };

  const timerAlarmRef = useRef(false); // 알람 실행 중 여부

  const stopTimerAlarm = async () => {
    timerAlarmRef.current = false;
    clearInterval(timerAlarmIntervalRef.current);
    timerAlarmIntervalRef.current = null;
    setTimerAlarming(false);
    // 오디오 정지
    try {
      if(audioCtxRef.current && audioCtxRef.current.state !== "closed"){
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
    } catch {}
    if(navigator.vibrate) navigator.vibrate(0); // 진동 중지
  };

  const startTimerAlarm = async () => {
    if(timerAlarmRef.current) return;
    timerAlarmRef.current = true;
    setTimerAlarming(true);
    // 1회만 알림 + 소리 + 진동
    await notifyTimerDone();
    // 자동 종료
    await stopTimerAlarm();
  };

  const notifyTimerDone = async () => {
    // 네이티브: 예약 알림(scheduleTimerNotification)이 이미 발동됨 → 중복 알림 제거
    // 웹: Notification API로 1회 알림
    if(!isNativeApp() && "Notification" in window && Notification.permission === "granted"){
      new Notification("⏰ 기도 시간 완료!", {
        body: "설정한 기도 시간이 끝났습니다 🙏",
        icon: "icons/icon-192.png",
        tag: "prayer-timer",
      });
    }
    if(navigator.vibrate) navigator.vibrate([600,200,600,200,600]);
    playAlarmSound();
  };

  // ── 타이머 완료 감지 (App 레벨 - 탭 전환해도 동작) ──
  useEffect(()=>{
    if(timerMode==="timer" && timerRunning && timerElapsed>=timerTarget && timerTarget>0){
      setTimerRunning(false);
      setTimerElapsed(timerTarget);

      const activeDay = timerActiveDay || toDateStr(getNow());
      const weekKey_ = getWeekKey(new Date(activeDay));
      const wd = load(`week_${weekKey_}`, {dailySeconds:{}});
      const cur = wd.dailySeconds?.[activeDay]||0;
      save(`week_${weekKey_}`, {
        ...wd,
        dailySeconds:{ ...wd.dailySeconds, [activeDay]: cur + timerTarget }
      });

      // 예약 알림은 이미 발동됨 → 중복 방지를 위해 취소 후 소리/진동만 실행
      (async () => {
        await cancelTimerNotification();
        startTimerAlarm();
      })();
    }
  },[timerMode, timerRunning, timerElapsed, timerTarget, timerActiveDay]);
  useEffect(()=>{
    if("Notification" in window && Notification.permission==="default"){
      Notification.requestPermission();
    }
    registerNotificationActions();
  },[]);

  // running 변경 시 interval 관리
  useEffect(()=>{
    if(timerRunning){
      timerAlarmPlayedRef.current = false;
      timerAutoSavedElapsedRef.current = Math.floor(timerElapsed / 60) * 60;

      // 사용자 인터랙션(시작 버튼) 직후 AudioContext 초기화 + 무음으로 잠금 해제
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if(AudioCtx){
          if(!audioCtxRef.current || audioCtxRef.current.state==="closed"){
            audioCtxRef.current = new AudioCtx();
          }
          if(audioCtxRef.current.state==="suspended"){
            audioCtxRef.current.resume();
          }
          const osc = audioCtxRef.current.createOscillator();
          const gain = audioCtxRef.current.createGain();
          gain.gain.value = 0.0001;
          osc.connect(gain);
          gain.connect(audioCtxRef.current.destination);
          osc.start();
          osc.stop(audioCtxRef.current.currentTime + 0.02);
        }
      } catch {}
      timerStartTsRef.current = Date.now();
      timerBaseElapsedRef.current = timerElapsed;
      timerIntervalRef.current = setInterval(()=>{
        setTimerElapsed(Math.floor((Date.now()-timerStartTsRef.current)/1000)+timerBaseElapsedRef.current);
      },500);
    } else {
      clearInterval(timerIntervalRef.current);
    }
    return ()=>clearInterval(timerIntervalRef.current);
  },[timerRunning]);

  // 탭/화면 복귀 시 즉시 보정 - App 레벨에서 처리
  useEffect(()=>{
    const sync=()=>{
      if(timerRunning && timerStartTsRef.current){
        setTimerElapsed(Math.floor((Date.now()-timerStartTsRef.current)/1000)+timerBaseElapsedRef.current);
      }
    };
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    return ()=>{
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
    };
  },[timerRunning]);

  // prayerType에 따라 조목록 선택
  const groups = scheduleData?.groupsByType?.[profile.prayerType] || [];
  const scheduleReading = scheduleData?.reading || [];
  const scheduleVerse   = scheduleData?.verses || [];

  const thisWeekKey = getWeekKey(getNow());
  const prevWeekKey = useMemo(()=>{ const d=new Date(thisWeekKey); d.setDate(d.getDate()-7); return toDateStr(d); },[thisWeekKey]);
  const [selectedWeekKey,setSelectedWeekKey] = useState(thisWeekKey);

  const todayDow = getNow().getDay();
  const todayStr2 = toDateStr(getNow());
  const _prevWeekData = load(`week_${prevWeekKey}`, {submitted:false, submittedDate:""});
  // 제출 탭 노출 주차:
  // - 목요일(4)~월요일(1): thisWeekKey (차주 제출 대상 미리보기)
  // - 화(2)~수(3): prevWeekKey (지난 주 제출)
  // - 단, 제출 완료 다음날부터도 thisWeekKey 노출
  const prevSubmittedYesterday = _prevWeekData.submitted && _prevWeekData.submittedDate && _prevWeekData.submittedDate < todayStr2;
  const showThisWeek = todayDow >= 5 || todayDow === 0 || todayDow === 1 || prevSubmittedYesterday;
  const submitWeekKey = showThisWeek ? thisWeekKey : prevWeekKey;
  const weekKey = tab === "home" ? submitWeekKey : thisWeekKey;
  const submitDate = getSubmitDate(weekKey);
  const weekDates = getWeekDates(weekKey);
  const weekEnd = toDateStr(weekDates[6]);

  // ── App 레벨 제출 활성화 여부 ──
  // 제출 활성화는 항상 지난 주(prevWeekKey) 기준으로 화~수인지 판단
  const _todayDow = getNow().getDay(); // 0=일,1=월,2=화,3=수,4=목...
  const _todayStr = toDateStr(getNow());
  const _weekDataForSubmit = load(`week_${prevWeekKey}`, {submitted:false, submittedDate:""});
  const _submitted = _weekDataForSubmit.submitted;
  const _submittedToday = _submitted && _weekDataForSubmit.submittedDate === _todayStr;
  const isSubmitActive = _todayDow === 2                          // 화요일: 항상 활성
    || (_todayDow === 3 && !_submitted)                           // 수요일: 미제출이면 활성
    || (_todayDow === 3 && _submitted && _submittedToday)         // 수요일: 당일 제출이면 재제출 허용
    || (_todayDow === 4 && !_submitted)                           // 목요일: 미제출이면 활성
    || (_todayDow === 4 && _submitted && _submittedToday);        // 목요일: 당일 제출이면 재제출 허용

  const isSubmitTab = tab === "home";
  const isStatsTab = tab === "stats";
  const isSettingsTab = tab === "settings";
  const headerWeekType = "대상주간";
  const headerWeekRange = `${weekKey.slice(5)} ~ ${weekEnd.slice(5)}`;
  const activeYear = getYearFromWeekKey(weekKey);

  const openSettingsTab = () => {
    if (tab !== "settings") setPrevTab(tab);
    setTab("settings");
  };

  const goBackFromSettings = () => {
    setTab(prevTab && prevTab !== "settings" ? prevTab : "prayer");
  };

  const weekReadingSections = filterByDate(scheduleReading, weekKey);
  const bibleReading = Object.values(weekReadingSections.reduce((acc,r)=>{
    if(!acc[r.book]) acc[r.book]={book:r.book,chapters:[]};
    acc[r.book].chapters=[...new Set([...acc[r.book].chapters,...r.chapters])].sort((a,b)=>a-b);
    return acc;
  },{}));
  // 암송 JSON은 하루 1절 기준으로 기록하고, 화면에는 이전 암송 대상이 있으면 함께 표시
  const memoryVersesThisWeek = getMemoryVersesForWeek(scheduleVerse, weekKey);

  // 현재 주 이전 중 가장 최근 암송 1절 찾기
  const prevVerses = (() => {
    const pastGroups = scheduleVerse
      .filter(v => v.endDate < weekKey)
      .sort((a, b) => b.endDate.localeCompare(a.endDate));
    if (!pastGroups.length) return [];
    const latest = pastGroups[0];
    if (latest.reference || latest.text) return [{ reference: latest.reference, text: latest.text }];
    if (Array.isArray(latest.verses) && latest.verses.length) return [latest.verses[latest.verses.length - 1]];
    return [];
  })();

  const memoryVerseGroup = {
    verses: uniqueVerses([...prevVerses, ...memoryVersesThisWeek]),
    currentVerses: memoryVersesThisWeek,
    previousVerses: prevVerses,
  };

  const [weekData,setWeekData] = useState(()=>load(`week_${weekKey}`,{
    dailySeconds:{},readingChecked:{},wholeReadingDone:false,
    memoryDone:false,memoryErrors:0,spiritNotes:"",
    attendance:null,attendReason:"",attendLateTime:"",
    churchLate:false,churchLeave:false,churchLateTime:"",churchLateReason:"",churchLeaveTime:"",churchLeaveReason:"",
    prayerFile:false,submitted:false,dawnService:{},fridayService:false,
  }));

  useEffect(()=>{
    setWeekData(load(`week_${weekKey}`,{
      dailySeconds:{},readingChecked:{},wholeReadingDone:false,
      memoryDone:false,memoryErrors:0,spiritNotes:"",
      attendance:null,attendReason:"",attendLateTime:"",
      prayerFile:false,submitted:false,dawnService:{},fridayService:false,
    }));
  },[weekKey]);

  const autoBackupToSupabase = async (reason="auto") => {
    try {
      const backupYear = getYearFromWeekKey(weekKey);
      await backupProfileToSupabase(profile);
      save("lastSupabaseBackup", {at:new Date().toISOString(), reason, year:backupYear});
    } catch (e) {
    }
  };

  const updateWeek = (patch) => {
    const n = {...weekData, ...patch};
    setWeekData(n);
    save(`week_${weekKey}`, n);
  };

  // 타이머/스톱워치가 1분 단위로 넘어갈 때마다 자동 누적 저장
  useEffect(()=>{
    if(!timerRunning) return;

    const savedElapsed = Math.floor(timerElapsed / 60) * 60;
    const diff = savedElapsed - timerAutoSavedElapsedRef.current;
    if(diff < 60) return;

    const activeDay = timerActiveDay || toDateStr(getNow());
    const weekKey_ = getWeekKey(new Date(activeDay));
    const wd = load(`week_${weekKey_}`, {dailySeconds:{}});
    const cur = wd.dailySeconds?.[activeDay] || 0;
    const updated = {
      ...wd,
      dailySeconds:{
        ...(wd.dailySeconds || {}),
        [activeDay]: cur + diff,
      },
    };

    save(`week_${weekKey_}`, updated);
    timerAutoSavedElapsedRef.current = savedElapsed;

    if(weekKey_ === weekKey) setWeekData(updated);

  },[timerElapsed, timerRunning, timerActiveDay, weekKey]);

  if (!profile.setupDone) return <SetupScreen scheduleData={scheduleData} installPrompt={installPrompt} isIOS={isIOS} isStandalone={isStandalone} showIOSInstallGuide={showIOSInstallGuide} onInstallApp={handleInstallApp} onSave={(p)=>{ const np={...p,setupDone:true}; setProfile(np); save("profile",np); }}/>;

  // 데이터 로딩 중 (캐시도 없을 때만)
  if (scheduleLoading && !scheduleData) return (
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12}}>
      <div style={{fontSize:"2rem"}}>🙏</div>
      <div style={{color:C.gold,fontSize:"0.875rem",fontWeight:700}}>데이터 로딩 중...</div>
    </div>
  );

  const totalSec = weekDates.reduce((s,d)=>s+getDayEff(weekData,toDateStr(d)),0);
  const rawPrayDays = weekDates.filter(d=>getDayEff(weekData,toDateStr(d))>=3600).length;
  const prayDays = Math.min(rawPrayDays, 6);
  const totalChapters = bibleReading.reduce((a,b)=>a+b.chapters.length,0);
  const checkedCount = Object.values(weekData.readingChecked||{}).filter(Boolean).length;

  const allDates = [...scheduleReading,...scheduleVerse].map(r=>r.startDate).sort();
  const scheduleRange = allDates.length>0?`${allDates[0]} ~ ${[...scheduleReading,...scheduleVerse].map(r=>r.endDate).sort().at(-1)}`:null;

  const O = v=>v?"O":"X";
  const isChurchIntercessionForShare = profile.prayerType === "교회중보";
  const hasAttendanceForShare = isChurchIntercessionForShare
    ? weekData.attendance === "attend"
    : (weekData.attendance==="attend"||weekData.attendance==="late"||weekData.attendance==="leave");
  const hasLateLeaveForShare = isChurchIntercessionForShare
    ? !!(weekData.churchLate || weekData.churchLeave)
    : (weekData.attendance==="late"||weekData.attendance==="leave");
  const shareText = [
    `1. 설문제출완료 : ${O(weekData.submitted)}`,
    `2. 출석 : ${O(hasAttendanceForShare)}`,
    `3. 지각/조퇴 : ${O(hasLateLeaveForShare)}`,
    `4. 매일 기도 : ${prayDays}/6`,
    `5. 총기도 시간: ${Math.floor(totalSec/3600)}`,
    `6. 기도 파일 : ${O(weekData.prayerFile)}`,
    `7. 성경통독 : ${O(checkedCount>=totalChapters&&totalChapters>0)}`,
    `8. 성경 암송 : ${O(weekData.memoryDone)}`,
    `9. 성령의 인도하심 : ${O(!!weekData.spiritNotes)}`,
    profile.prayerType === "교회중보" ? `10. 파일링 담당 : ${O(!!weekData.isFilingManager)}` : null,
    weekData.spiritNotes?`${weekData.spiritNotes}`:null,
  ].filter(Boolean).join("\n");

  const TABS = [
    {id:"prayer",icon:"🙏",label:"기도"},
    {id:"reading",icon:"📖",label:"통독"},
    {id:"memory",icon:"🗣️ ",label:"암송"},
    {id:"home",icon:"📤",label:"제출"},
    {id:"stats",icon:"📊",label:"통계"},
  ];

  return (
    <div style={{minHeight:"100vh",backgroundColor:C.bg,color:C.text,fontFamily:"'Noto Sans KR',sans-serif",paddingBottom:"calc(84px + env(safe-area-inset-bottom, 0px))",overflowY:"auto",WebkitOverflowScrolling:"touch",touchAction:"pan-y"}}>
      <div style={{
        background:`linear-gradient(135deg,${C.accent}22 0%,${C.surface} 52%,${C.bg} 100%)`,
        borderBottom:`1px solid ${C.accent}66`,
        padding:"calc(12px + env(safe-area-inset-top, 0px)) 14px 12px",
        minHeight:"calc(72px + env(safe-area-inset-top, 0px))",
        boxSizing:"border-box",
        display:"flex",
        justifyContent:"space-between",
        alignItems:"center",
        gap:12,
      }}>
        <div style={{minWidth:0,flex:1}}>
          <div style={{fontSize:18.75,fontWeight:800,color:(isSubmitTab||isStatsTab)?C.accentLight:C.gold,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,whiteSpace:"nowrap"}}>
            <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
              <span>{isSubmitTab?"📤":isStatsTab?"📊":isSettingsTab?"⚙️":tab==="reading"?"📖":tab==="memory"?"🗣️":"🙏"}</span>
              <span style={{overflow:"hidden",textOverflow:"ellipsis"}}>
                {isSubmitTab
                  ? "주간 제출"
                  : isStatsTab
                    ? "통계"
                    : isSettingsTab
                      ? "설정"
                      : tab === "reading"
                        ? "통독 기록"
                        : tab === "memory"
                          ? "암송 기록"
                          : "기도 기록"}
              </span>
            </div>
            {(isSubmitTab||isStatsTab||isSettingsTab)&&(
              <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                <div style={{display:"flex",alignItems:"baseline",gap:4,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                  <span style={{fontSize:13.5,fontWeight:800,color:C.text,opacity:0.85,overflow:"hidden",textOverflow:"ellipsis"}}>[{profile.group}]</span>
                  <span style={{fontSize:16,fontWeight:900,color:C.accentLight,overflow:"hidden",textOverflow:"ellipsis"}}>{profile.name}</span>
                </div>
                {isSettingsTab ? (
                  <button
                    style={{
                      width:30,
                      height:30,
                      borderRadius:9,
                      border:`1px solid ${C.accent}55`,
                      background:`${C.accent}20`,
                      color:C.accentLight,
                      cursor:"pointer",
                      fontSize:16,
                      lineHeight:1,
                      display:"flex",
                      alignItems:"center",
                      justifyContent:"center",
                      flexShrink:0,
                    }}
                    onClick={goBackFromSettings}
                    aria-label="뒤로가기"
                  >&#8249;</button>
                ) : (
                  <button
                    style={{
                      width:30,
                      height:30,
                      borderRadius:9,
                      border:`1px solid ${C.accent}55`,
                      background:`${C.accent}20`,
                      color:C.accentLight,
                      cursor:"pointer",
                      fontSize:16,
                      lineHeight:1,
                      display:"flex",
                      alignItems:"center",
                      justifyContent:"center",
                      flexShrink:0,
                    }}
                    onClick={openSettingsTab}
                    aria-label="설정"
                  >⚙️</button>
                )}
              </div>
            )}
            {(!isSubmitTab&&!isStatsTab&&!isSettingsTab)&&(
              <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                <div style={{display:"flex",alignItems:"baseline",gap:4,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                  <span style={{fontSize:13.5,fontWeight:800,color:C.text,opacity:0.85,overflow:"hidden",textOverflow:"ellipsis"}}>[{profile.group}]</span>
                  <span style={{fontSize:16,fontWeight:900,color:C.accentLight,overflow:"hidden",textOverflow:"ellipsis"}}>{profile.name}</span>
                </div>
                <button
                  style={{
                    width:30,
                    height:30,
                    borderRadius:9,
                    border:`1px solid ${C.accent}55`,
                    background:`${C.accent}20`,
                    color:C.accentLight,
                    cursor:"pointer",
                    fontSize:16,
                    lineHeight:1,
                    display:"flex",
                    alignItems:"center",
                    justifyContent:"center",
                    flexShrink:0,
                  }}
                  onClick={openSettingsTab}
                  aria-label="설정"
                >⚙️</button>
              </div>
            )}
          </div>
          {isSubmitTab ? (
            <div style={{marginTop:6,display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"4px 9px",borderRadius:999,background:`${C.accent}18`,border:`1px solid ${C.accent}33`,width:"100%",boxSizing:"border-box"}}>
              <div style={{display:"flex",alignItems:"center",gap:5,minWidth:0}}>
                <span style={{fontSize:12.5,color:C.accentLight,fontWeight:900,whiteSpace:"nowrap"}}>대상주간</span>
                <span style={{fontSize:12.5,color:C.text,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{headerWeekRange}</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
                <span style={{fontSize:12.5,color:C.accentLight,fontWeight:900,whiteSpace:"nowrap"}}>제출기준일</span>
                <span style={{fontSize:12.5,color:C.text,fontWeight:700,whiteSpace:"nowrap"}}>{submitDate}</span>
              </div>
            </div>
          ) : isStatsTab ? (
            <div style={{marginTop:6,display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"4px 9px",borderRadius:999,background:`${C.accent}18`,border:`1px solid ${C.accent}33`,width:"100%",boxSizing:"border-box"}}>
              <div style={{display:"flex",alignItems:"center",gap:5,minWidth:0}}>
                <span style={{fontSize:12.5,color:C.accentLight,fontWeight:900,whiteSpace:"nowrap"}}>연간기록</span>
                <span style={{fontSize:12.5,color:C.text,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{activeYear}년</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
                <span style={{fontSize:12.5,color:C.accentLight,fontWeight:900,whiteSpace:"nowrap"}}>누적통계</span>
              </div>
            </div>
          ) : isSettingsTab ? (
            <div style={{marginTop:6,display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"4px 9px",borderRadius:999,background:`${C.accent}18`,border:`1px solid ${C.accent}33`,width:"100%",boxSizing:"border-box"}}>
              <div style={{display:"flex",alignItems:"center",gap:5,minWidth:0}}>
                <span style={{fontSize:12.5,color:C.accentLight,fontWeight:900,whiteSpace:"nowrap"}}>사용자정보</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
                <span style={{fontSize:12.5,color:C.accentLight,fontWeight:900,whiteSpace:"nowrap"}}>데이터 관리</span>
              </div>
            </div>
          ) : (
            <div style={{marginTop:6,display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"4px 9px",borderRadius:999,background:`${C.accent}18`,border:`1px solid ${C.accent}33`,width:"100%",boxSizing:"border-box"}}>
              <div style={{display:"flex",alignItems:"center",gap:5,minWidth:0}}>
                <span style={{fontSize:12.5,color:C.accentLight,fontWeight:900,whiteSpace:"nowrap"}}>대상주간</span>
                <span style={{fontSize:12.5,color:C.text,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{headerWeekRange}</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
                <span style={{fontSize:12.5,color:C.accentLight,fontWeight:900,whiteSpace:"nowrap"}}>제출기준일</span>
                <span style={{fontSize:12.5,color:C.text,fontWeight:700,whiteSpace:"nowrap"}}>{submitDate}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{padding:"14px 14px 24px"}}>
        {!privacyAgreed ? (
          // 프라이버시 정책 동의 화면
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"60vh",gap:20,padding:"20px"}}>
            <div style={{fontSize:"2rem",textAlign:"center"}}>🙏</div>
            <h2 style={{fontSize:"1rem",fontWeight:700,color:C.text,textAlign:"center"}}>개인정보 처리에 동의해주세요</h2>
            <div style={{background:C.surface2,padding:"15px",borderRadius:10,maxHeight:"40vh",overflowY:"auto",fontSize:"0.75rem",lineHeight:1.6,color:C.muted}}>
              <p><strong>본 앱은 다음의 개인정보를 수집합니다:</strong></p>
              <ul style={{marginLeft:20}}>
                <li>기도 기록 및 시간</li>
                <li>성경 통독 진행 현황</li>
                <li>암송 기록 및 음성 녹음</li>
                <li>프로필 정보 (이름, 조, 중보 유형)</li>
              </ul>
              <p><strong>데이터 보관:</strong></p>
              <ul style={{marginLeft:20}}>
                <li>모든 데이터는 기기의 로컬 저장소에 저장됩니다</li>
                <li>구글 폼 제출 시에만 외부로 전송됩니다</li>
                <li>마이크 권한은 암송 녹음에만 사용됩니다</li>
              </ul>
              <p><strong>자세한 내용:</strong></p>
              <p>개인정보 처리방침을 읽고 동의하시기 바랍니다.</p>
            </div>
            <div style={{display:"flex",gap:10,width:"100%",justifyContent:"center"}}>
              <button style={{...btn("ghost"),padding:"10px 20px",fontSize:"0.81rem",flex:1,maxWidth:120}}
                onClick={()=>window.open('privacy-ko.html','_blank')}>
                정책 보기
              </button>
              <button style={{...btn("primary"),padding:"10px 20px",fontSize:"0.81rem",flex:1,maxWidth:120}}
                onClick={()=>{
                  setPrivacyAgreed(true);
                  save("privacyAgreed",true);
                }}>
                동의합니다
              </button>
            </div>
          </div>
        ) : (
          <>
            {tab==="home"    && <HomeTab weekDates={weekDates} weekData={weekData} totalSec={totalSec} prayDays={prayDays} updateWeek={updateWeek} setTab={setTab} checkedCount={checkedCount} totalChapters={totalChapters} shareText={shareText} submitDate={submitDate} weekKey={weekKey} scheduleData={scheduleData} bibleReading={bibleReading} memoryVerseGroup={memoryVerseGroup} autoBackupToSupabase={autoBackupToSupabase} isSubmitActive={isSubmitActive}/>}
            {tab==="prayer"  && <PrayerTab weekDates={weekDates} weekData={weekData} updateWeek={updateWeek} timerRunning={timerRunning} setTimerRunning={setTimerRunning} timerElapsed={timerElapsed} setTimerElapsed={setTimerElapsed} timerMode={timerMode} setTimerMode={setTimerMode} timerTarget={timerTarget} setTimerTarget={setTimerTarget} timerActiveDay={timerActiveDay} setTimerActiveDay={setTimerActiveDay}/>}
            {tab==="reading" && <ReadingTab weekData={weekData} updateWeek={updateWeek} bibleReading={bibleReading} weekKey={weekKey}/>}
            {tab==="memory"  && <MemoryTab weekData={weekData} updateWeek={updateWeek} memoryVerseGroup={memoryVerseGroup} weekKey={weekKey} scheduleData={scheduleData} weekDates={weekDates}/>}
            {tab==="stats"   && <StatsTab thisWeekKey={thisWeekKey} weekKey={weekKey} weekData={weekData} scheduleData={scheduleData} activeYear={activeYear}/>}
            {tab==="settings"&& <SettingsTab profile={profile} groups={groups} scheduleRange={scheduleRange} weekKey={weekKey} activeYear={activeYear} bibleReading={bibleReading} memoryVerseGroup={memoryVerseGroup} easyMode={easyMode} easyModeLevel={easyModeLevel} setEasyMode={setEasyMode} themeMode={themeMode} activeTheme={activeTheme} setThemeMode={setThemeMode} scheduleData={scheduleData} onSave={(p)=>{setProfile(p);save("profile",p);setTab("home");}} onBack={()=>setTab("home")}/>}
          </>
        )}
      </div>

      <nav style={{position:"fixed",bottom:0,left:0,right:0,background:C.surface,borderTop:`1px solid ${C.border}`,display:"flex",justifyContent:"space-around",padding:"6px 0 max(6px, calc(env(safe-area-inset-bottom, 0px) - 10px))",zIndex:100}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"5px 10px",borderRadius:8,background:tab===t.id?`${C.accent}22`:"transparent",cursor:"pointer",border:"none",color:tab===t.id?C.accent:C.muted,fontSize:13.125,fontWeight:tab===t.id?700:400}}>
            <span style={{fontSize:27.5}}>{t.icon}</span>{t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

// 핀 읽기 - 이전에 JSON.stringify로 저장된 경우 따옴표 제거
function getPin() {
  const raw = localStorage.getItem("backupPin");
  if(!raw) return null;
  // "1234" → 1234 형태로 저장된 경우 파싱
  try {
    const parsed = JSON.parse(raw);
    return String(parsed);
  } catch {
    return raw;
  }
}

// ── 핀패드 컴포넌트 ────────────────────────────────────────────────────────────
function PinPad({title, subtitle, onSuccess, onCancel, expectedPin=null}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [shake, setShake] = useState(false);

  const handleKey = (k) => {
    if(pin.length >= 4) return;
    const next = pin + k;
    setPin(next);
    setError("");
    if(next.length === 4) {
      setTimeout(async () => {
        if(expectedPin === null) {
          onSuccess(next);
        } else if(expectedPin.startsWith("__hash__")) {
          // 해시 비교 모드
          const targetHash = expectedPin.slice(8);
          const inputHash = await hashPin(next);
          if(inputHash === targetHash) {
            onSuccess(next);
          } else {
            setShake(true);
            setTimeout(() => { setShake(false); setPin(""); setError("비밀번호가 틀렸습니다."); }, 400);
          }
        } else if(next === expectedPin) {
          onSuccess(next);
        } else {
          setShake(true);
          setTimeout(() => { setShake(false); setPin(""); setError("비밀번호가 틀렸습니다."); }, 400);
        }
      }, 100);
    }
  };

  const handleDel = () => { setPin(p => p.slice(0,-1)); setError(""); };

  const dots = Array(4).fill(0).map((_,i) => (
    <div key={i} style={{
      width:18, height:18, borderRadius:"50%",
      background: i < pin.length ? C.accent : "transparent",
      border: `2px solid ${i < pin.length ? C.accent : C.border}`,
      transition:"all 0.15s"
    }}/>
  ));

  const keys = ["1","2","3","4","5","6","7","8","9","","0","⌫"];

  return (
    <div style={{position:"fixed",inset:0,background:C.bg,zIndex:9999,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}>
      <div style={{fontSize:"2rem",marginBottom:8}}>🔐</div>
      <div style={{fontSize:"1rem",fontWeight:800,color:C.text,marginBottom:4}}>{title}</div>
      {subtitle&&<div style={{fontSize:"0.75rem",color:C.muted,marginBottom:24,textAlign:"center",lineHeight:1.6}}>{subtitle}</div>}

      {/* 핀 점 표시 */}
      <div style={{display:"flex",gap:16,marginBottom:error?12:28,
        animation:shake?"shake 0.4s ease":"none"}}
        // shake 애니메이션은 CSS 없이 opacity 변화로 대체
      >
        {dots}
      </div>

      {error&&<div style={{fontSize:"0.75rem",color:C.red,marginBottom:16,fontWeight:700}}>{error}</div>}

      {/* 숫자패드 */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,width:"100%",maxWidth:260}}>
        {keys.map((k,i) => (
          k === "" ? <div key={i}/> :
          <button key={i}
            onClick={k==="⌫" ? handleDel : ()=>handleKey(k)}
            style={{
              height:64, borderRadius:16,
              border:`1px solid ${C.border}`,
              background:k==="⌫"?C.bg:C.surface,
              color:k==="⌫"?C.red:C.text,
              fontSize:k==="⌫"?"1.25rem":"1.5rem",
              fontWeight:700, cursor:"pointer",
              transition:"all 0.1s",
              opacity: k===""?0:1,
            }}>
            {k}
          </button>
        ))}
      </div>

      {onCancel&&(
        <button onClick={onCancel}
          style={{marginTop:28,fontSize:"0.81rem",color:C.muted,background:"transparent",border:"none",cursor:"pointer"}}>
          취소
        </button>
      )}
    </div>
  );
}

// ── 핀 설정 (2단계: 입력 → 확인) ──────────────────────────────────────────────
function PinSetup({onSave, onCancel}) {
  const [step, setStep] = useState(1);
  const [first, setFirst] = useState("");

  if(step === 1) return (
    <PinPad
      key="pinsetup-step1"
      title="비밀번호 설정"
      subtitle={"백업 복원 시 사용할\n4자리 비밀번호를 입력하세요"}
      expectedPin={null}
      onSuccess={(p)=>{ setFirst(p); setStep(2); }}
      onCancel={onCancel}
    />
  );

  return (
    <PinPad
      key="pinsetup-step2"
      title="비밀번호 확인"
      subtitle="한 번 더 입력해주세요"
      expectedPin={first}
      onSuccess={()=>onSave(first)}
      onCancel={()=>{ setStep(1); setFirst(""); }}
    />
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────
function SetupScreen({scheduleData, installPrompt, isIOS, isStandalone, showIOSInstallGuide, onInstallApp, onSave}) {
  const [prayerType,setPrayerType]=useState("");
  const [group,setGroup]=useState("");
  const [name,setName]=useState("");
  const [showPinSetup,setShowPinSetup]=useState(false);

  const groups = scheduleData?.groupsByType?.[prayerType] || [];
  const handleTypeChange = (t) => { setPrayerType(t); setGroup(""); };
  const canSubmit = prayerType && group && name.trim();

  const handleStart = () => {
    if(!prayerType){ alert("중보 유형을 선택해 주세요."); return; }
    if(!group){ alert("조를 선택해 주세요."); return; }
    if(!name.trim()){ alert("이름을 입력해 주세요."); return; }
    setShowPinSetup(true);
  };

  if(showPinSetup) return (
    <PinSetup
      onSave={(pin)=>{
        localStorage.setItem("backupPin", pin);
        onSave({prayerType, group, name:name.trim()});
      }}
      onCancel={()=>setShowPinSetup(false)}
    />
  );

  return (
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}>
      <div style={{fontSize:"2.875rem"}}>🙏</div>
      <div style={{fontSize:"1.31rem",fontWeight:800,color:C.gold,marginTop:8}}>중보기도 기록앱</div>
      <div style={{fontSize:"0.75rem",color:C.muted,marginBottom:30,marginTop:4}}>처음 사용하시는군요. 정보를 입력해주세요.</div>
      <div style={{width:"100%",maxWidth:340}}>

        {/* 중보 유형 선택 */}
        <div style={{marginBottom:16}}>
          <label style={getLbl()}>중보 유형</label>
          <div style={{display:"flex",gap:10}}>
            {["교회중보","목회자중보"].map(t=>(
              <button key={t} onClick={()=>handleTypeChange(t)}
                style={{flex:1,padding:"12px 0",borderRadius:10,border:`2px solid ${prayerType===t?C.accent:C.border}`,background:prayerType===t?`${C.accent}22`:C.bg,color:prayerType===t?C.accent:C.muted,fontSize:"0.875rem",fontWeight:prayerType===t?700:400,cursor:"pointer"}}>
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* 조 선택 - 유형 선택 후 표시 */}
        {prayerType&&(
          <div style={{marginBottom:12}}>
            <label style={getLbl()}>조 선택</label>
            <select style={getInp()} value={group} onChange={e=>setGroup(e.target.value)}>
              <option value="">조를 선택하세요</option>
              {groups.map(g=><option key={g} value={g}>{g}</option>)}
            </select>
          </div>
        )}

        {/* 이름 */}
        <div style={{marginBottom:22}}>
          <label style={getLbl()}>이름</label>
          <input style={getInp()} placeholder="이름을 입력하세요" value={name} onChange={e=>setName(e.target.value)}/>
        </div>

        <button style={{...btn("primary"),width:"100%",padding:14,fontSize:"0.94rem",opacity:canSubmit?1:0.5}}
          onClick={handleStart}>
          시작하기
        </button>

        {/* PWA 설치 안내 */}
        {!isNativeApp()&&(
          <div style={{marginTop:14}}>
            {isStandalone ? (
              <div style={{...getCard(),marginBottom:0,padding:12,border:`1px solid ${C.green}44`,background:`${C.green}10`}}>
                <div style={{fontSize:"0.81rem",fontWeight:700,color:C.green}}>✅ 앱으로 실행 중</div>
                <div style={{fontSize:"0.69rem",color:C.muted,marginTop:4,lineHeight:1.6}}>홈 화면에서 실행되고 있습니다.</div>
              </div>
            ) : isIOS ? (
              <div style={{...getCard(),marginBottom:0,padding:12,border:`1px solid ${C.blue}44`,background:`${C.blue}0d`}}>
                <div style={{fontSize:"0.81rem",fontWeight:700,color:C.blue,marginBottom:6}}>📱 홈 화면에 추가하면 앱처럼 사용할 수 있어요</div>
                <div style={{fontSize:"0.69rem",color:C.muted,lineHeight:1.75}}>
                  Safari 하단 <b style={{color:C.text}}>공유 버튼(□↑)</b> → <b style={{color:C.text}}>홈 화면에 추가</b>
                </div>
              </div>
            ) : installPrompt ? (
              <button style={{...btn("ghost"),width:"100%",padding:12,fontSize:"0.81rem",color:C.blue,border:`1px solid ${C.blue}55`}}
                onClick={onInstallApp}>
                📱 홈 화면에 앱 설치하기
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Home ──────────────────────────────────────────────────────────────────────
function HomeTab({weekDates,weekData,totalSec,prayDays,updateWeek,setTab,checkedCount,totalChapters,shareText,submitDate,weekKey,scheduleData,bibleReading,memoryVerseGroup,autoBackupToSupabase,isSubmitActive}) {
  const [copied,setCopied]=useState(false);
  const [showShare,setShowShare]=useState(false);
  const [editingSubmitPrayerDay,setEditingSubmitPrayerDay]=useState(null);
  const [showSubmitPrayerList,setShowSubmitPrayerList]=useState(false);

  const profileForHome = load("profile", {group:"", name:"", prayerType:""});
  const isChurchIntercession = profileForHome.prayerType === "교회중보";
  const submitConfirmUrl = isChurchIntercession
    ? "https://prayer-for-the-church.vercel.app/"
    : "https://prayer-for-the-pastor.vercel.app/";
  const churchFilingManager = !!weekData.isFilingManager;
  const tuesdayKey = toDateStr(weekDates.find(d => d.getDay() === 2) || weekDates[0]);
  const attendanceBonusApplied = weekData.attendancePrayerBonus === tuesdayKey;
  const readingDone = totalChapters > 0 && checkedCount >= totalChapters;
  const hagadaTarget = Number(scheduleData?.hagadaTarget || 700);
  const hasReading = checkedCount > 0;
  const weekRangeLabel = `${weekDates[0].getMonth()+1}/${weekDates[0].getDate()} ~ ${weekDates[6].getMonth()+1}/${weekDates[6].getDate()}`;

  const todayStr = toDateStr(getNow());
  const todayDowHome = getNow().getDay();
  const submitDateObj = parseDate(submitDate);
  const submitDeadline = new Date(submitDateObj);
  submitDeadline.setDate(submitDeadline.getDate() + 1);
  const submitDeadlineStr = toDateStr(submitDeadline);
  const submittedDate = weekData.submittedDate || null;
  const showSummaryMode = weekData.submitted && submittedDate && submittedDate < todayStr;
  const isPreviewMode = todayDowHome === 1 && !weekData.submitted;

  const copy=()=>{
    if(!weekData.submitted){ alert("⚠️ 구글 폼 제출 후 복사할 수 있습니다."); return; }
    navigator.clipboard.writeText(shareText).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000);});
  };

  const share=async()=>{
    if(!weekData.submitted){ alert("⚠️ 구글 폼 제출 후 공유할 수 있습니다."); return; }
    if(navigator.share){
      try{ await navigator.share({title:"중보기도 기록",text:shareText}); }
      catch{}
    } else { copy(); }
  };

  const toggleReadingDone = () => {
    const nextChecked = {...(weekData.readingChecked || {})};
    const next = !readingDone;
    bibleReading.forEach(section => section.chapters.forEach(ch => {
      nextChecked[`${section.book}_${ch}`] = next;
    }));
    updateWeek({readingChecked:nextChecked});
  };

  const applyAttendance = (val) => {
    const currentlyBonusApplied = weekData.attendancePrayerBonus === tuesdayKey;
    const currentTuesdaySeconds = weekData.dailySeconds?.[tuesdayKey] || 0;

    let nextTuesdaySeconds = currentTuesdaySeconds;
    let nextBonusKey = weekData.attendancePrayerBonus || "";
    const patch = {
      attendReason: "",
      attendLateTime: "",
      dailySeconds: {...(weekData.dailySeconds || {})},
    };

    const addBonusIfNeeded = () => {
      if(!currentlyBonusApplied){
        nextTuesdaySeconds = currentTuesdaySeconds + 3600;
        nextBonusKey = tuesdayKey;
      }
    };

    const removeBonusIfNeeded = () => {
      if(currentlyBonusApplied){
        nextTuesdaySeconds = Math.max(0, currentTuesdaySeconds - 3600);
        nextBonusKey = "";
      }
    };

    if(isChurchIntercession){
      if(val === "attend"){
        addBonusIfNeeded();
        Object.assign(patch, {
          attendance: "attend",
          churchLate: false,
          churchLeave: false,
          churchLateTime: "",
          churchLateReason: "",
          churchLeaveTime: "",
          churchLeaveReason: "",
        });
      } else if(val === "excused"){
        addBonusIfNeeded();
        Object.assign(patch, {
          attendance: "excused",
          attendReason: "",
          churchLate: false,
          churchLeave: false,
          churchLateTime: "",
          churchLateReason: "",
          churchLeaveTime: "",
          churchLeaveReason: "",
        });
      } else if(val === "absent"){
        removeBonusIfNeeded();
        Object.assign(patch, {
          attendance: "absent",
          churchLate: false,
          churchLeave: false,
          churchLateTime: "",
          churchLateReason: "",
          churchLeaveTime: "",
          churchLeaveReason: "",
        });
      } else if(val === "late"){
        addBonusIfNeeded();
        Object.assign(patch, {
          attendance: "attend",
          churchLate: !weekData.churchLate,
        });
      } else if(val === "leave"){
        addBonusIfNeeded();
        Object.assign(patch, {
          attendance: "attend",
          churchLeave: !weekData.churchLeave,
        });
      }
    } else {
      const bonusEligible = ["attend", "excused", "late", "leave"].includes(val);

      if (bonusEligible && !currentlyBonusApplied) {
        nextTuesdaySeconds = currentTuesdaySeconds + 3600;
        nextBonusKey = tuesdayKey;
      }

      if (val === "absent" && currentlyBonusApplied) {
        nextTuesdaySeconds = Math.max(0, currentTuesdaySeconds - 3600);
        nextBonusKey = "";
      }

      Object.assign(patch, { attendance: val, ...(val === "attend" ? { attendReason: "", attendLateTime: "" } : {}) });
    }

    patch.attendancePrayerBonus = nextBonusKey;
    patch.dailySeconds[tuesdayKey] = nextTuesdaySeconds;
    updateWeek(patch);
  };

  const submit = async () => {
    if (!weekData.attendance) {
      alert("⚠️ 출석 체크를 선택해주세요.\n(출석 / 지각 / 조퇴 / 결석)");
      return;
    }

    if (isChurchIntercession) {
      if (weekData.attendance === "excused" && !weekData.attendReason) {
        alert("⚠️ 출석 인정 결석 사유를 입력해주세요.\n예) 출석인정-ㅇㅇ장례"); return;
      }
      if (weekData.attendance === "absent" && !weekData.attendReason) {
        alert("⚠️ 결석 사유를 입력해주세요."); return;
      }
      if (weekData.churchLate) {
        if (!weekData.churchLateTime) { alert("⚠️ 지각 시간을 입력해주세요. (예: 10분)"); return; }
        if (!weekData.churchLateReason) { alert("⚠️ 지각 사유를 입력해주세요."); return; }
      }
      if (weekData.churchLeave) {
        if (!weekData.churchLeaveTime) { alert("⚠️ 조퇴 시간을 입력해주세요. (예: 30분)"); return; }
        if (!weekData.churchLeaveReason) { alert("⚠️ 조퇴 사유를 입력해주세요."); return; }
      }
    } else {
      if (weekData.attendance==="late") {
        if (!weekData.attendLateTime) { alert("⚠️ 지각 시간을 입력해주세요. (예: 10분)"); return; }
        if (!weekData.attendReason)   { alert("⚠️ 지각 사유를 입력해주세요."); return; }
      }
      if (weekData.attendance==="leave") {
        if (!weekData.attendLateTime) { alert("⚠️ 조퇴 시간을 입력해주세요. (예: 30분)"); return; }
        if (!weekData.attendReason)   { alert("⚠️ 조퇴 사유를 입력해주세요."); return; }
      }
      if (weekData.attendance==="excused" && !weekData.attendReason) {
        alert("⚠️ 출석 인정 결석 사유를 입력해주세요.\n예) 출석인정-ㅇㅇ장례"); return;
      }
      if (weekData.attendance==="absent" && !weekData.attendReason) {
        alert("⚠️ 결석 사유를 입력해주세요."); return;
      }
    }

    const profile  = profileForHome;
    const isLate   = isChurchIntercession ? !!weekData.churchLate : weekData.attendance === "late";
    const isLeave  = isChurchIntercession ? !!weekData.churchLeave : weekData.attendance === "leave";
    const isAbsent = weekData.attendance === "absent";

    const churchLateLeaveLabel = [isLate?`지각 ${weekData.churchLateTime||""}`:null, isLeave?`조퇴 ${weekData.churchLeaveTime||""}`:null].filter(Boolean).join(" / ");
    const attendLabel = isChurchIntercession
      ? (weekData.attendance === "excused" ? "출석 인정 결석" : isAbsent ? "결석" : "출석")
      : ({attend:"출석", excused:"출석 인정 결석", late:"지각", leave:"조퇴", absent:"결석"}[weekData.attendance] || "-");
    const memoryLabel = weekData.memoryDone ? `완료 (${weekData.memoryErrors??0}자 틀림)` : "미완";
    const readingLabel = totalChapters > 0 ? `${checkedCount}/${totalChapters}장` : "-";
    const confirmMsg = [
      `📋 제출 내용을 확인해주세요`,
      ``,
      `👤 ${profile.group}  ${profile.name}`,
      `📅 제출일: ${submitDate}`,
      ``,
      `✅ 출석: ${attendLabel}${isChurchIntercession && churchLateLeaveLabel ? ` (${churchLateLeaveLabel})` : !isChurchIntercession && isLate ? ` (${weekData.attendLateTime} 지각)` : !isChurchIntercession && isLeave ? ` (${weekData.attendLateTime} 조퇴)` : ""}`,
      `🙏 기도시간: ${fmtHM(totalSec)} (${prayDays}일 1시간↑)`,
      `📖 통독: ${readingLabel}`,
      `📜 성경 전체 1독: ${weekData.wholeReadingDone ? "완료" : "미완"}`,
      `🗣️  암송: ${memoryLabel}`,
      `📄 파일기도: ${weekData.prayerFile?"완료":"미완"}`,
      `💫 성령인도: ${weekData.spiritNotes?"기록함":"미기록"}`,
      isChurchIntercession ? `🗂️ 파일링 담당: ${churchFilingManager ? "예" : "아니오"}` : null,
      ``,
      `제출하시겠습니까?`,
    ].filter(l => l !== undefined && !(l === "" && false)).join("\n");

    if (!window.confirm(confirmMsg)) return;

    const status = getAttendanceStatusForFirebase({
      isChurchIntercession,
      weekData,
      isLate,
      isLeave,
      isAbsent,
    });

    const churchStatus = buildFirebaseChurchStatusString({
      isChurchIntercession,
      weekData,
      isLate,
      isLeave,
      isAbsent,
    });

    const reasonExcused = weekData.attendance === "excused" ? (weekData.attendReason || "") : "";
    const tardyReason = isChurchIntercession
      ? (isLate ? [weekData.churchLateReason, weekData.churchLateTime].filter(Boolean).join(" ") : "")
      : (isLate ? [weekData.attendReason, weekData.attendLateTime].filter(Boolean).join(" ") : "");
    const earlyLeaveReason = isChurchIntercession
      ? (isLeave ? [weekData.churchLeaveReason, weekData.churchLeaveTime].filter(Boolean).join(" ") : "")
      : (isLeave ? [weekData.attendReason, weekData.attendLateTime].filter(Boolean).join(" ") : "");
    const reasonAbsent = isAbsent ? (weekData.attendReason || "") : "";
    const combinedReason = isChurchIntercession
      ? (reasonExcused ? `${reasonExcused}` : isAbsent ? reasonAbsent : "")
      : [
          reasonExcused ? `${reasonExcused}` : "",
          tardyReason ? `지각: ${tardyReason}` : "",
          earlyLeaveReason ? `조퇴: ${earlyLeaveReason}` : "",
          reasonAbsent ? `결석: ${reasonAbsent}` : "",
        ].filter(Boolean).join(", ");

    const firebaseStatus = isChurchIntercession ? churchStatus : status;
    const firebaseRecord = {
      teamName: profile.group,
      leader: "",
      name: profile.name,
      date: submitDate,
      week: getPastorPrayerWeekNumber(submitDate),
      status: firebaseStatus,
      reason: combinedReason,
      ...(isChurchIntercession
        ? {
            tardyReason,
            earlyLeaveReason,
          }
        : {
            reasonExcused,
            reasonLate: tardyReason,
            reasonEarly: earlyLeaveReason,
            reasonAbsent,
          }),
      filePrayer: weekData.prayerFile ? "완료" : "미완료",
      bibleReading: checkedCount >= totalChapters && totalChapters > 0 ? "완료" : "미완료",
      spiritGuidance: weekData.spiritNotes ? "있음" : "없음",
      bibleMemory: weekData.memoryDone
        ? Number(weekData.memoryErrors || 0) === 0
          ? "완료"
          : Number(weekData.memoryErrors || 0) <= 3
            ? "1~3글자 틀림"
            : "미완료"
        : "미완료",
      dailyPrayer: prayDays,
      totalPrayerTime: Math.floor(totalSec / 3600),
      fullBibleReading: !!weekData.wholeReadingDone,
      fullBibleReadingDate: weekData.wholeReadingDone ? submitDate : "",
      spiritGuidanceText: weekData.spiritNotes || "",
      isFilingManager: isChurchIntercession ? churchFilingManager : false,
      scoreStatus: calcFirebaseScoreStatus(firebaseStatus),
      scoreFilePrayer: weekData.prayerFile ? 1 : 0,
      scoreBibleReading: checkedCount >= totalChapters && totalChapters > 0 ? 1 : 0,
      scoreSpiritGuidance: weekData.spiritNotes ? 1 : 0,
      scoreBibleMemory: calcFirebaseMemoryScore(weekData.memoryDone, weekData.memoryErrors),
      scoreDailyPrayer: prayDays,
      scoreFullBibleReading: weekData.wholeReadingDone ? 1 : 0,
    };

    try {
      const firebaseConfig = getFirebaseTargetConfig(profile.prayerType);
      if(!firebaseConfig) throw new Error("Firebase 설정이 없습니다.\nschedule.json의 firebase 항목을 확인해주세요.");
      await withTimeout(
        submitPastorPrayerToFirebase(firebaseRecord, firebaseConfig),
        15000,
        "제출 시간이 초과되었습니다. 네트워크 상태를 확인해 주세요."
      );
      updateWeek({submitted:true, submittedDate:toDateStr(getNow())});
      setTimeout(() => autoBackupToSupabase?.("submit"), 0);
      alert("제출이 완료되었습니다.");
    } catch (e) {
      alert(`제출에 실패했습니다.\n${e?.message || "Firebase 제출 중 알 수 없는 오류가 발생했습니다."}`);
    }
  };

  return (
    <div>
      <div style={{...getCard(),padding:"12px 16px"}}>
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
            <div>
              <div style={{fontWeight:800,fontSize:"0.875rem",color:C.text}}>📅 총 기도시간</div>
              <div style={{marginTop:4,fontSize:"0.69rem",color:C.muted,lineHeight:1.4}}>
                요일별 기도시간을 수정할 수 있습니다.
              </div>
            </div>
            <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8}}>
              <span style={{fontSize:"1.3rem",fontWeight:900,color:C.gold,whiteSpace:"nowrap",letterSpacing:"-0.02em"}}>{fmtHM(totalSec)}</span>
              <button type="button"
                style={{padding:"5px 12px",fontSize:"0.69rem",fontWeight:800,borderRadius:8,
                  border:`1.5px solid ${showSubmitPrayerList?C.red:C.accent}`,
                  background:showSubmitPrayerList?`${C.red}18`:`${C.accent}24`,
                  color:showSubmitPrayerList?C.red:C.accent,
                  cursor:"pointer",
                  boxShadow:showSubmitPrayerList?`0 0 0 1px ${C.red}18 inset`:`0 0 0 1px ${C.accent}18 inset`,
                  whiteSpace:"nowrap"}}
                onClick={()=>setShowSubmitPrayerList(v=>!v)}>
                {showSubmitPrayerList?"닫기":"수정"}
              </button>
            </div>
          </div>
          {showSubmitPrayerList&&(
            <div style={{marginTop:10}}>
              {weekDates.map((d,i)=>{
                const key=toDateStr(d);
                const eff=weekData.dailySeconds?.[key]||0;
                const hasDawn=weekData.dawnService?.[key]&&weekData.dailySeconds?.[key]>0;
                const hasFri=d.getDay()===5&&weekData.fridayService;
                const isTuesday=d.getDay()===2;
                const weekDateKeys=weekDates.map(d2=>toDateStr(d2));
                const hagadaInWeek=weekDateKeys.includes(weekData.hagadaBonusKey);
                const hasHagada=weekData.hagadaDone&&(hagadaInWeek?weekData.hagadaBonusKey===key:isTuesday);
                const hasAttend=isTuesday&&!!weekData.attendancePrayerBonus;
                const isEd=editingSubmitPrayerDay===key;
                return (
                  <div key={key} style={{borderBottom:i<6?`1px solid ${C.border}`:"none"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0"}}>
                      <div style={{display:"flex",alignItems:"center",gap:5}}>
                        <span style={{fontSize:"0.81rem",color:C.muted,minWidth:24}}>{WEEK_DAYS[i]}</span>
                        <span style={{fontSize:"0.625rem",color:C.muted}}>{d.getMonth()+1}/{d.getDate()}</span>
                        {hasDawn&&<span style={{fontSize:"0.625rem",color:C.blue,fontWeight:700}}>{d.getDay()===6?"🙏":"🌅"}</span>}
                        {hasFri&&<span style={{fontSize:"0.625rem",color:C.purple,fontWeight:700}}>🔥</span>}
                        {hasHagada&&<span style={{fontSize:"0.625rem",color:C.gold,fontWeight:700}}>🗣️</span>}
                        {hasAttend&&<span style={{fontSize:"0.625rem",color:C.green,fontWeight:700}}>{weekData.attendance==="late"?"⏰":"⛪"}</span>}
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <span style={{fontSize:"0.81rem",fontWeight:700,color:eff>=3600?C.green:eff>0?C.accent:C.muted}}>
                          {eff>0?fmtHM(eff):"-"}{eff>=3600?" ✓":""}
                        </span>
                        <button style={{...btn("ghost"),padding:"2px 10px",fontSize:"0.625rem"}}
                          onClick={e=>{e.stopPropagation();setEditingSubmitPrayerDay(isEd?null:key);}}>
                          {isEd?"닫기":"수정"}
                        </button>
                      </div>
                    </div>
                    {isEd&&(
                      <div style={{paddingBottom:10}} onClick={e=>e.stopPropagation()}>
                        <DayTimePicker effSecs={eff} dawnB={0} friB={0}
                          onSave={(newEff)=>{updateWeek({dailySeconds:{...(weekData.dailySeconds||{}),[key]:newEff}});setEditingSubmitPrayerDay(null);}}/>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div style={{...getCard(),borderLeft:`3px solid ${C.accent}`,paddingLeft:13,position:"relative"}}>
        <div style={{fontWeight:700,fontSize:"0.81rem",color:C.text,marginBottom:10}}>📋 출석 체크</div>
        {isChurchIntercession ? (
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,minmax(0,1fr))",gap:6,marginBottom:(weekData.churchLate||weekData.churchLeave||weekData.attendance)?10:0}}>
            {[
              ["attend", "출석", C.green],
              ["excused", "출석\n인정\n결석", C.blue],
              ["late", "지각", C.accent],
              ["leave", "조퇴", C.blue],
              ["absent", "결석", C.red]
            ].map(([val,label,color])=>{
              const selected =
                val === "attend" ? weekData.attendance === "attend"
                : val === "excused" ? weekData.attendance === "excused"
                : val === "absent" ? weekData.attendance === "absent"
                : val === "late" ? !!weekData.churchLate
                : !!weekData.churchLeave;

              return (
                <button
                  key={val}
                  onClick={()=>applyAttendance(val)}
                  style={{
                    width:"100%",
                    minWidth:0,
                    minHeight:58,
                    padding:"8px 3px",
                    borderRadius:8,
                    fontSize:"0.7rem",
                    fontWeight:700,
                    cursor:"pointer",
                    border:`1px solid ${selected?color:C.border}`,
                    background:selected?`${color}22`:C.bg,
                    color:selected?color:C.muted,
                    whiteSpace:"pre-line",
                    lineHeight:1.15,
                    overflow:"hidden",
                    textOverflow:"ellipsis",
                    display:"flex",
                    alignItems:"center",
                    justifyContent:"center",
                    textAlign:"center"
                  }}
                >
                  {label}{((val==="late"&&weekData.churchLate)||(val==="leave"&&weekData.churchLeave))?"\n✓":""}
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,minmax(0,1fr))",gap:6,marginBottom:weekData.attendance?10:0}}>
            {[
              ["attend", "출석", C.green],
              ["excused", "출석\n인정\n결석", C.blue],
              ["late", "지각", C.accent],
              ["leave", "조퇴", C.blue],
              ["absent", "결석", C.red]
            ].map(([val,label,color])=>{
              const selected = weekData.attendance === val;

              return (
                <button
                  key={val}
                  onClick={()=>applyAttendance(val)}
                  style={{
                    width:"100%",
                    minWidth:0,
                    minHeight:58,
                    padding:"8px 3px",
                    borderRadius:8,
                    fontSize:"0.7rem",
                    fontWeight:700,
                    cursor:"pointer",
                    border:`1px solid ${selected?color:C.border}`,
                    background:selected?`${color}22`:C.bg,
                    color:selected?color:C.muted,
                    whiteSpace:"pre-line",
                    lineHeight:1.15,
                    overflow:"hidden",
                    textOverflow:"ellipsis",
                    display:"flex",
                    alignItems:"center",
                    justifyContent:"center",
                    textAlign:"center"
                  }}
                >
                  {label}{selected&&(val==="late"||val==="leave")?"\n✓":""}
                </button>
              );
            })}
          </div>
        )}

        {attendanceBonusApplied&&(
          <div style={{fontSize:"0.69rem",color:C.accentLight,marginBottom:10}}>화요일 기도시간 +1시간 반영됨</div>
        )}

        {isChurchIntercession && weekData.churchLate&&(
          <div style={{display:"grid",gridTemplateColumns:"0.9fr 2fr",gap:6,marginBottom:8}}>
            <input
              style={{...getInp(),padding:"8px 9px",fontSize:"0.75rem",borderColor:!weekData.churchLateTime?C.red:C.border}}
              placeholder="시간 예) 10분"
              value={weekData.churchLateTime||""}
              onChange={e=>updateWeek({churchLateTime:e.target.value})}
            />
            <input
              style={{...getInp(),padding:"8px 9px",fontSize:"0.75rem",borderColor:!weekData.churchLateReason?C.red:C.border}}
              placeholder="지각 사유 예) 교통체증"
              value={weekData.churchLateReason||""}
              onChange={e=>updateWeek({churchLateReason:e.target.value})}
            />
          </div>
        )}

        {isChurchIntercession && weekData.churchLeave&&(
          <div style={{display:"grid",gridTemplateColumns:"0.9fr 2fr",gap:6,marginBottom:8}}>
            <input
              style={{...getInp(),padding:"8px 9px",fontSize:"0.75rem",borderColor:!weekData.churchLeaveTime?C.red:C.border}}
              placeholder="시간 예) 10분"
              value={weekData.churchLeaveTime||""}
              onChange={e=>updateWeek({churchLeaveTime:e.target.value})}
            />
            <input
              style={{...getInp(),padding:"8px 9px",fontSize:"0.75rem",borderColor:!weekData.churchLeaveReason?C.red:C.border}}
              placeholder="조퇴 사유 예) 개인사정"
              value={weekData.churchLeaveReason||""}
              onChange={e=>updateWeek({churchLeaveReason:e.target.value})}
            />
          </div>
        )}

        {isChurchIntercession && weekData.attendance === "excused" && (
          <div style={{marginBottom:8}}>
            <input
              style={{...getInp(),padding:"8px 9px",fontSize:"0.75rem",borderColor:!weekData.attendReason?C.red:C.border}}
              placeholder="예) 출석인정-ㅇㅇ장례"
              value={weekData.attendReason||""}
              onChange={e=>updateWeek({attendReason:e.target.value})}
            />
          </div>
        )}

        {isChurchIntercession && weekData.attendance === "absent" && (
          <div style={{marginBottom:8}}>
            <input
              style={{...getInp(),padding:"8px 9px",fontSize:"0.75rem",borderColor:!weekData.attendReason?C.red:C.border}}
              placeholder="결석 사유"
              value={weekData.attendReason||""}
              onChange={e=>updateWeek({attendReason:e.target.value})}
            />
          </div>
        )}

        {!isChurchIntercession && ["excused","late","leave","absent"].includes(weekData.attendance)&&(
          <div style={{display:"grid",gridTemplateColumns:(weekData.attendance==="late"||weekData.attendance==="leave")?"0.9fr 2fr":"1fr",gap:6,marginBottom:8}}>
            {(weekData.attendance==="late"||weekData.attendance==="leave")&&(
              <input
                style={{...getInp(),padding:"8px 9px",fontSize:"0.75rem",borderColor:!weekData.attendLateTime?C.red:C.border}}
                placeholder="시간 예) 10분"
                value={weekData.attendLateTime||""}
                onChange={e=>updateWeek({attendLateTime:e.target.value})}
              />
            )}
            <input
              style={{...getInp(),padding:"8px 9px",fontSize:"0.75rem",borderColor:!weekData.attendReason?C.red:C.border}}
              placeholder={
                weekData.attendance==="excused"
                  ? "예) 출석인정-ㅇㅇ장례"
                  : weekData.attendance==="late"
                    ? "지각 사유"
                    : weekData.attendance==="leave"
                      ? "조퇴 사유"
                      : "결석 사유"
              }
              value={weekData.attendReason||""}
              onChange={e=>updateWeek({attendReason:e.target.value})}
            />
          </div>
        )}
      </div>

      <div style={{...getCard(),borderLeft:`3px solid ${C.green}`,paddingLeft:13,paddingTop:13,paddingBottom:13,opacity:isSubmitActive?1:0.5,pointerEvents:isSubmitActive?"auto":"none"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
          <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text}}>
            <span style={{fontSize:"1rem"}}>📁</span>
            <span>기도파일</span>
          </div>
          <button onClick={()=>updateWeek({prayerFile:!weekData.prayerFile})}
            style={{minHeight:34,borderRadius:999,border:`1.5px solid ${weekData.prayerFile?C.green:C.border}`,background:weekData.prayerFile?`${C.green}20`:C.bg,color:weekData.prayerFile?C.green:C.muted,cursor:"pointer",padding:"6px 12px",display:"flex",alignItems:"center",justifyContent:"center",gap:5,fontSize:"0.75rem",fontWeight:800,boxShadow:weekData.prayerFile?`0 0 0 1px ${C.green}18 inset`:"none",whiteSpace:"nowrap",flexShrink:0}}>
            <span style={{fontSize:"0.875rem"}}>{weekData.prayerFile?"✅":"○"}</span>
            <span>{weekData.prayerFile?"완료":"미완료"}</span>
          </button>
        </div>
      </div>

      <div style={{...getCard(),borderLeft:`3px solid ${C.accent}`,paddingLeft:13,opacity:isSubmitActive?1:0.5,pointerEvents:isSubmitActive?"auto":"none"}}>
        <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text,marginBottom:8}}>
          <span style={{fontSize:"1rem"}}>🕊</span>
          <span>성령의 인도하심</span>
        </div>
        <textarea style={{...getInp(),minHeight:86,resize:"vertical",lineHeight:"1.65",fontSize:"0.75rem",background:C.surface,border:`1px solid ${C.accent}44`}}
          placeholder="이번 주 기도 중 주신 성령의 인도하심을 기록하세요..."
          value={weekData.spiritNotes || ""}
          onChange={e=>updateWeek({spiritNotes:e.target.value})}/>
      </div>

      {isChurchIntercession && (
        <div style={{...getCard(),borderLeft:`3px solid ${C.purple}`,paddingLeft:13,opacity:isSubmitActive?1:0.5,pointerEvents:isSubmitActive?"auto":"none"}}>
          <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text,marginBottom:8}}>
            <span style={{fontSize:"1rem"}}>🗂️</span>
            <span>파일링 담당</span>
          </div>
          <div style={{fontSize:"0.69rem",color:C.muted,marginBottom:10,lineHeight:1.55}}>
            이번 주 교회중보 파일링 담당자라면 체크해주세요.
          </div>
          <button
            type="button"
            onClick={() => updateWeek({isFilingManager: !churchFilingManager})}
            style={{
              width:"100%",
              minHeight:44,
              borderRadius:10,
              border:`1.5px solid ${churchFilingManager ? C.purple : C.border}`,
              background:churchFilingManager ? `${C.purple}20` : C.bg,
              color:churchFilingManager ? C.purple : C.muted,
              cursor:"pointer",
              padding:"7px 8px",
              display:"flex",
              alignItems:"center",
              justifyContent:"center",
              gap:8,
              fontSize:"0.81rem",
              fontWeight:800,
              boxShadow:churchFilingManager ? `0 0 0 1px ${C.purple}18 inset` : "none",
              whiteSpace:"nowrap",
            }}
          >
            <span style={{fontSize:"1rem",lineHeight:1}}>{churchFilingManager ? "✅" : "○"}</span>
            <span>{churchFilingManager ? "파일링 담당" : "파일링 담당 체크"}</span>
          </button>
        </div>
      )}

      <div style={{...getCard(),borderLeft:`3px solid ${C.blue}`,paddingLeft:13,opacity:isSubmitActive?1:0.5,pointerEvents:isSubmitActive?"auto":"none"}}>
        <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text,marginBottom:8}}>
          <span style={{fontSize:"1rem"}}>📖</span>
          <span>통독 / 전체 1독</span>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <button onClick={toggleReadingDone}
            style={{minHeight:44,borderRadius:10,border:`1.5px solid ${readingDone?C.blue:C.border}`,background:readingDone?`${C.blue}24`:C.bg,color:readingDone?C.blue:C.muted,cursor:"pointer",padding:"7px 8px",display:"flex",alignItems:"center",justifyContent:"center",gap:8,boxShadow:readingDone?`0 0 0 1px ${C.blue}22 inset`:"none"}}>
            <span style={{fontSize:"1rem",lineHeight:1}}>{readingDone?"✅":"📖"}</span>
            <span style={{fontSize:"0.81rem",fontWeight:800}}>{readingDone?"통독 완료":"통독 미완"}</span>
          </button>
          <button onClick={()=>updateWeek({wholeReadingDone:!weekData.wholeReadingDone})}
            style={{minHeight:44,borderRadius:10,border:`1.5px solid ${weekData.wholeReadingDone?C.gold:C.border}`,background:weekData.wholeReadingDone?`${C.gold}24`:C.bg,color:weekData.wholeReadingDone?C.gold:C.muted,cursor:"pointer",padding:"7px 8px",display:"flex",alignItems:"center",justifyContent:"center",gap:8,boxShadow:weekData.wholeReadingDone?`0 0 0 1px ${C.gold}22 inset`:"none"}}>
            <span style={{fontSize:"1rem",lineHeight:1}}>{weekData.wholeReadingDone?"✅":"📜"}</span>
            <span style={{fontSize:"0.81rem",fontWeight:800}}>{weekData.wholeReadingDone?"1독 완료":"1독 미완"}</span>
          </button>
        </div>
      </div>

      <div style={{...getCard(),borderLeft:`3px solid ${C.purple}`,paddingLeft:13,paddingTop:13,paddingBottom:13,opacity:isSubmitActive?1:0.5,pointerEvents:isSubmitActive?"auto":"none"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginBottom:weekData.memoryDone?10:0}}>
          <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text}}>
            <span style={{fontSize:"1rem"}}>🗣️</span>
            <span>암송</span>
          </div>
          <button onClick={()=>updateWeek({memoryDone:!weekData.memoryDone})}
            style={{minHeight:34,borderRadius:999,border:`1.5px solid ${weekData.memoryDone?C.purple:C.border}`,background:weekData.memoryDone?`${C.purple}20`:C.bg,color:weekData.memoryDone?C.purple:C.muted,cursor:"pointer",padding:"6px 12px",display:"flex",alignItems:"center",justifyContent:"center",gap:5,fontSize:"0.75rem",fontWeight:800,boxShadow:weekData.memoryDone?`0 0 0 1px ${C.purple}18 inset`:"none",whiteSpace:"nowrap",flexShrink:0}}>
            <span style={{fontSize:"0.875rem"}}>{weekData.memoryDone?"✅":"○"}</span>
            <span>{weekData.memoryDone?"완료":"미완료"}</span>
          </button>
        </div>
        {weekData.memoryDone&&(
          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:2}}>
            <div style={{fontSize:"0.69rem",color:C.muted,fontWeight:700,whiteSpace:"nowrap",flexShrink:0}}>틀린 글자 수</div>
            <div style={{display:"flex",gap:5,flex:1,justifyContent:"flex-end"}}>
              {[0,1,2,3,4].map(n=>(
                <button key={n} onClick={()=>updateWeek({memoryErrors:n})}
                  style={{height:28,minWidth:32,padding:"0 7px",borderRadius:7,border:`1px solid ${weekData.memoryErrors===n?C.purple:C.border}`,background:weekData.memoryErrors===n?`${C.purple}22`:C.bg,color:weekData.memoryErrors===n?C.purple:C.muted,fontSize:"0.69rem",fontWeight:800,cursor:"pointer",whiteSpace:"nowrap"}}>
                  {n===4?"4+":n}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 하가다 카드 */}
      <div style={{...getCard(),borderLeft:`3px solid ${C.gold}`,paddingLeft:13,paddingTop:13,paddingBottom:13,opacity:isSubmitActive?1:0.5,pointerEvents:isSubmitActive?"auto":"none"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
          <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text}}>
            <span style={{fontSize:"1rem"}}>🔁</span>
            <span>하가다</span>
            {weekData.hagadaDone&&<span style={{fontSize:"0.625rem",color:C.gold,fontWeight:700}}>({weekData.hagadaCount||0}회)</span>}
          </div>
          <button
            onClick={()=>{
              const done = weekData.hagadaDone;
              if(!done){
                const patch = {hagadaDone:true, hagadaCount:Math.max(weekData.hagadaCount||0, hagadaTarget)};
                if(!weekData.hagadaBonus){
                  const todayKey = toDateStr(getNow());
                  const tuesdayKey = toDateStr(weekDates[0]);
                  const weekDateKeys = weekDates.map(d=>toDateStr(d));
                  const bonusKey = weekDateKeys.includes(todayKey) ? todayKey : tuesdayKey;
                  patch.hagadaBonus = true;
                  patch.hagadaBonusKey = bonusKey;
                  patch.dailySeconds = {...(weekData.dailySeconds||{}), [bonusKey]:((weekData.dailySeconds||{})[bonusKey]||0)+3600};
                }
                updateWeek(patch);
              } else {
                const patch = {hagadaDone:false};
                if(weekData.hagadaBonus && weekData.hagadaBonusKey){
                  const bonusKey = weekData.hagadaBonusKey;
                  patch.hagadaBonus = false;
                  patch.hagadaBonusKey = null;
                  patch.dailySeconds = {...(weekData.dailySeconds||{}), [bonusKey]:Math.max(0,((weekData.dailySeconds||{})[bonusKey]||0)-3600)};
                }
                updateWeek(patch);
              }
            }}
            style={{minHeight:34,borderRadius:999,border:`1.5px solid ${weekData.hagadaDone?C.green:C.border}`,background:weekData.hagadaDone?`${C.green}20`:C.bg,color:weekData.hagadaDone?C.green:C.muted,cursor:"pointer",padding:"6px 12px",display:"flex",alignItems:"center",justifyContent:"center",gap:5,fontSize:"0.75rem",fontWeight:800,whiteSpace:"nowrap",flexShrink:0}}>
            <span style={{fontSize:"0.875rem"}}>{weekData.hagadaDone?"✅":"○"}</span>
            <span>{weekData.hagadaDone?"완료":"미완료"}</span>
          </button>
        </div>
      </div>

      <div style={{...getCard(),borderLeft:`3px solid ${C.accent}`,border:`1px solid ${C.gold}44`,paddingLeft:13,background:`linear-gradient(135deg,${C.surface} 0%,${C.surface} 100%)`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:10}}>
          <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text}}>
            <span style={{fontSize:"1rem"}}>📤</span>
            <span>주간 제출</span>
          </div>
        </div>
        <button onClick={()=>setShowShare(s=>!s)} style={{...btn("ghost"),width:"100%",marginBottom:10,fontSize:"0.75rem"}}>
          {showShare?"▲ 공유 텍스트 접기":"▼ 공유 텍스트 미리보기"}
        </button>
        {showShare&&(
          <pre style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:12,fontSize:"0.75rem",color:C.text,lineHeight:1.9,whiteSpace:"pre-wrap",wordBreak:"break-word",margin:"0 0 10px",fontFamily:"'Noto Sans KR',sans-serif"}}>
            {shareText}
          </pre>
        )}
        {/* 제출완료 다음날~ : 기록 요약 표시 */}
        <div style={{display:"flex",gap:8}}>
          <button onClick={copy} style={{...btn("ghost"),flex:1,fontSize:"0.81rem",color:copied?C.green:weekData.submitted?C.muted:"#444",border:`1px solid ${copied?C.green:C.border}`,opacity:weekData.submitted?1:0.5}}>
            {copied?"✓ 복사됨":"복사"}
          </button>
          <button onClick={share} style={{...btn("ghost"),flex:1,fontSize:"0.81rem",color:weekData.submitted?C.blue:"#444",border:`1px solid ${weekData.submitted?C.blue:C.border}44`,opacity:weekData.submitted?1:0.5}}>
            📨 공유
          </button>
          <button onClick={isSubmitActive?submit:undefined}
            style={{...btn(weekData.submitted?"green":"primary"),flex:1,fontSize:"0.81rem",opacity:isSubmitActive?1:0.4,cursor:isSubmitActive?"pointer":"not-allowed",minWidth:0,padding:"7px 4px",minHeight:44,lineHeight:1.12,whiteSpace:"normal"}}>
            {weekData.submitted ? (
              <span style={{display:"inline-block",lineHeight:1.12}}>다시<br/>제출</span>
            ) : (
              <span style={{display:"inline-block",lineHeight:1.12}}>📤<br/>제출</span>
            )}
          </button>
          <button
            onClick={() => window.open(submitConfirmUrl, "_blank")}
            style={{...btn("ghost"),flex:1,fontSize:"0.81rem",color:C.purple,border:`1px solid ${C.purple}55`,opacity:1,cursor:"pointer",minWidth:0,padding:"7px 4px",minHeight:44,lineHeight:1.12,whiteSpace:"normal"}}
          >
            <span style={{display:"inline-block",lineHeight:1.12}}>확인<br/>하기</span>
          </button>
        </div>
        {!isSubmitActive&&!weekData.submitted&&(
          <div style={{fontSize:"0.625rem",color:C.muted,textAlign:"center",marginTop:6}}>
            {isPreviewMode
              ? `제출 가능일: ${submitDate} (화) ~ ${submitDeadlineStr} (수)`
              : `제출 가능일: ${submitDate} (화) ~ ${submitDeadlineStr} (수)`}
          </div>
        )}
        {weekData.submitted&&isSubmitActive&&(
          <div style={{fontSize:"0.69rem",color:C.muted,textAlign:"center",marginTop:8}}>제출 완료 · 당일 다시 제출 가능</div>
        )}
        {weekData.submitted&&!isSubmitActive&&(
          <div style={{fontSize:"0.69rem",color:C.green,textAlign:"center",marginTop:8}}>✓ 제출 완료</div>
        )}
      </div>
    </div>
  );
}

// ── 드럼롤 시간 선택 ──────────────────────────────────────────────────────────
function DayTimePicker({effSecs,onSave}) {
  const initH=Math.floor(effSecs/3600);
  const initM=Math.floor((effSecs%3600)/60);
  const [selH,setSelH]=useState(initH);
  const [selM,setSelM]=useState(Math.floor(initM/10)*10);
  const hours=Array.from({length:13},(_,i)=>i);
  const mins=[0,10,20,30,40,50];
  const newEff=selH*3600+selM*60;
  const wrapRef = useRef(null);
  const saveBtnRef = useRef(null);

  // 시간 수정 패널이 열릴 때 저장 버튼이 하단 네비게이션에 가리지 않도록 더 아래까지 자동 스크롤
  useEffect(()=>{
    const t = setTimeout(()=>{
      if(saveBtnRef.current){
        saveBtnRef.current.scrollIntoView({ behavior:"smooth", block:"center", inline:"nearest" });
        setTimeout(()=>window.scrollBy({ top: 80, behavior:"smooth" }), 180);
      }
    }, 150);
    return ()=>clearTimeout(t);
  },[]);

  const Drum=({items,sel,onSel,fmt})=>{
    const ref=useRef(null);
    useEffect(()=>{
      if(ref.current){
        const idx=items.indexOf(sel);
        if(idx>=0) ref.current.scrollTop=idx*38;
      }
    },[]);
    return (
      <div style={{flex:1,position:"relative",height:128,overflow:"hidden"}}>
        <div style={{position:"absolute",top:"50%",left:0,right:0,height:38,transform:"translateY(-50%)",background:`${C.accent}22`,borderTop:`1px solid ${C.accent}55`,borderBottom:`1px solid ${C.accent}55`,pointerEvents:"none",zIndex:1}}/>
        <div ref={ref} style={{height:"100%",overflowY:"scroll",scrollSnapType:"y mandatory",paddingTop:45,paddingBottom:45,scrollbarWidth:"none"}}
          onScroll={e=>{
            const idx=Math.round(e.target.scrollTop/38);
            if(items[idx]!==undefined) onSel(items[idx]);
          }}>
          {items.map(v=>(
            <div key={v} style={{height:38,display:"flex",alignItems:"center",justifyContent:"center",scrollSnapAlign:"center",fontSize:v===sel?20:15,fontWeight:v===sel?800:400,color:v===sel?C.gold:C.muted,transition:"font-size 0.1s"}}>
              {fmt(v)}
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div ref={wrapRef} style={{marginTop:6,background:C.bg,borderRadius:12,padding:"8px 12px",border:`1px solid ${C.border}`}}>
      <div style={{fontSize:"0.69rem",color:C.muted,marginBottom:4}}>
        총 기도시간 선택
      </div>
      <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:6}}>
        <Drum items={hours} sel={selH} onSel={setSelH} fmt={v=>`${v}시간`}/>
        <div style={{fontSize:"1.125rem",color:C.muted,flexShrink:0}}>:</div>
        <Drum items={mins} sel={selM} onSel={setSelM} fmt={v=>`${String(v).padStart(2,"0")}분`}/>
      </div>
      <button ref={saveBtnRef} style={{...btn("primary"),width:"100%",padding:"9px 0"}} onClick={()=>onSave(newEff)}>저장</button>
    </div>
  );
}

// ── Prayer ────────────────────────────────────────────────────────────────────
function PrayerTab({weekDates,weekData,updateWeek,timerRunning,setTimerRunning,timerElapsed,setTimerElapsed,timerMode,setTimerMode,timerTarget,setTimerTarget,timerActiveDay,setTimerActiveDay}) {
  const todayKey=toDateStr(getNow());
  const validKey=weekDates.find(d=>toDateStr(d)===todayKey)?todayKey:toDateStr(weekDates[0]);
  // activeDay 초기값: 저장된 값 있으면 유지, 없으면 오늘
  const [activeDay,setActiveDay]=useState(()=>timerActiveDay||validKey);
  const running=timerRunning, setRunning=setTimerRunning;
  const elapsed=timerElapsed, setElapsed=setTimerElapsed;
  const mode=timerMode, setMode=setTimerMode;
  const [editingDay,setEditingDay]=useState(null);
  const dayBase=weekData.dailySeconds?.[activeDay]||0;

  const handleSetActiveDay=(key)=>{
    setActiveDay(key);
    setTimerActiveDay(key);
    if(running){ setRunning(false); setElapsed(0); }
    setEditingDay(null);
  };

  const fridayDate=weekDates.find(d=>d.getDay()===5);
  const fridayKey=fridayDate?toDateStr(fridayDate):"";
  const tuesdayDate=weekDates.find(d=>d.getDay()===2);
  const tuesdayKey=tuesdayDate?toDateStr(tuesdayDate):"";
  // 새벽예배 / 예배중보 계산
  // - 월~금: 카운트 +1, 시간 +1
  // - 토요일: 카운트 제외, 시간 +1
  // - 일요일: 선택 불가, 카운트/시간 제외
  const dawnHours=weekDates.filter(d=>{
    const key=toDateStr(d);
    const day=d.getDay();
    return weekData.dawnService?.[key] && day !== 0;
  }).length;
  const weekTotalEff=weekDates.reduce((s,d)=>s+getDayEff(weekData,toDateStr(d)),0);

  const toggleDawn=(key)=>{
    const d=parseDate(key);
    if(d.getDay()===0) return; // 일요일은 선택 불가
    const wasOn = weekData.dawnService?.[key];
    const cur = weekData.dailySeconds?.[key]||0;
    updateWeek({
      dawnService:{...(weekData.dawnService||{}),[key]:!wasOn},
      dailySeconds:{...(weekData.dailySeconds||{}),[key]: wasOn ? Math.max(0,cur-3600) : cur+3600},
    });
  };

  const handleStop=()=>{
    setRunning(false);
    setElapsed(0);
    cancelTimerNotification();
  };

  const [showPrayList, setShowPrayList] = useState(false);

  // 타이머 모드: "stopwatch"(스톱워치) | "timer"(역카운트)
  const isTimerMode = timerMode === "timer";
  const canUseCountdownTimer = isNativeApp();
  // 역카운트 표시 시간
  const remaining = Math.max(0, timerTarget - elapsed);
  // 진행률: 스톱워치=경과/목표, 타이머=남은/목표
  const progressPct = isTimerMode
    ? Math.min((remaining / timerTarget) * 100, 100)
    : Math.min((elapsed / timerTarget) * 100, 100);

  const statusLabel = running
    ? (isTimerMode ? "⏳ 기도 중..." : "⏱ 기도 중...")
    : elapsed > 0
      ? "⏸ 일시정지됨"
      : isTimerMode ? "⏳ 타이머" : "⏱ 스톱워치";

  const timerDisplaySeconds = isTimerMode ? remaining : elapsed;

  const timerStatusMessage = running
    ? "기도중"
    : elapsed > 0
      ? "일시정지"
      : isTimerMode
        ? "타이머 대기"
        : "스톱워치 대기";

  const renderTimeParts = (sec) => {
    const h = String(Math.floor(sec / 3600)).padStart(2, "0");
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    return (
      <span>
        <span>{h}:{m}</span>
        <span style={{fontSize:"0.62em",opacity:0.82}}>:{s}</span>
      </span>
    );
  };

  useEffect(()=>{
    if(!canUseCountdownTimer && timerMode === "timer" && !running){
      setTimerMode("stopwatch");
      setElapsed(0);
    }
  },[canUseCountdownTimer,timerMode,running,setTimerMode,setElapsed]);

  return (
    <div>
      {/* 타이머 카드 */}
      <div style={{...getCard(),padding:"12px 16px"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
          <div style={{display:"flex",flexDirection:"column",minWidth:0}}>
            {/* 스톱워치/타이머 토글 - 네이티브 앱에서만 표시 */}
            {isNativeApp() && (
            <div style={{display:"flex",justifyContent:"flex-start",marginBottom:7}}>
              <div style={{display:"flex",alignItems:"center",gap:4,padding:3,borderRadius:999,background:C.bg,border:`1px solid ${C.border}`}}>
                <button
                  type="button"
                  onClick={()=>{ if(!running){ setTimerMode("stopwatch"); setElapsed(0); } }}
                  style={{border:"none",borderRadius:999,padding:"5px 10px",fontSize:"0.69rem",fontWeight:900,cursor:running?"default":"pointer",background:!isTimerMode?C.accent:"transparent",color:!isTimerMode?"#fff":C.muted,opacity:running&&isTimerMode?0.45:1}}
                >
                  스톱워치
                </button>
                <button
                  type="button"
                  onClick={()=>{ if(!running && canUseCountdownTimer){ setTimerMode("timer"); if(timerTarget<=0) setTimerTarget(3600); setElapsed(0); } }}
                  style={{border:"none",borderRadius:999,padding:"5px 10px",fontSize:"0.69rem",fontWeight:900,cursor:(!canUseCountdownTimer||running)?"not-allowed":"pointer",background:isTimerMode?C.purple:"transparent",color:isTimerMode?"#fff":C.muted,opacity:!canUseCountdownTimer?0.38:(running&&!isTimerMode?0.45:1)}}
                >
                  타이머
                </button>
              </div>
            </div>
            )}
            <div style={{fontSize:"1.4rem",fontWeight:800,fontVariantNumeric:"tabular-nums",lineHeight:1,letterSpacing:"0.02em",
              color: running ? (remaining < 60 && isTimerMode ? C.red : C.green) : C.gold}}>
              {renderTimeParts(timerDisplaySeconds)}
            </div>
            {/* 진행 바 - 시간 바로 아래 */}
            <div style={{height:6,background:C.bg,borderRadius:999,overflow:"hidden",border:`1px solid ${C.border}`,margin:"6px 0 5px"}}>
              <div style={{height:"100%",width:`${progressPct}%`,
                background: running
                  ? (remaining < 60 && isTimerMode ? C.red : C.green)
                  : (isTimerMode ? C.purple : C.accent),
                borderRadius:999,transition:"width 0.25s"}}/>
            </div>
            <div style={{
              textAlign:"left",
              fontSize:"0.69rem",
              fontWeight:500,
              color:C.muted,
              margin:"2px 0 8px",
              lineHeight:1.45
            }}>
              {timerStatusMessage}
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,flexShrink:0,width:154,alignItems:"center"}}>
            <button
              type="button"
              disabled={!running}
              style={{height:73,borderRadius:12,border:`1px solid ${running?C.accent:C.border}`,background:running?`${C.accent}18`:C.bg,color:running?C.accent:C.muted,fontSize:"0.75rem",fontWeight:800,cursor:running?"pointer":"default",opacity:running?1:0.55,display:"flex",alignItems:"center",justifyContent:"center",boxSizing:"border-box",padding:0,whiteSpace:"nowrap"}}
              onClick={()=>{haptic("light");setRunning(false);cancelTimerNotification();}}
            >
              일시정지
            </button>
            <button
              type="button"
              style={{height:73,borderRadius:12,border:`1px solid ${running?C.red:C.green}`,background:running?`${C.red}18`:`${C.green}18`,color:running?C.red:C.green,fontSize:"0.75rem",fontWeight:900,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxSizing:"border-box",padding:0,whiteSpace:"nowrap"}}
              onClick={()=>{
                haptic(running ? "heavy" : "medium");
                if(running){
                  handleStop();
                  return;
                }
                if(isTimerMode && !canUseCountdownTimer){
                  alert("앱으로 설치된 환경에서만 타이머를 사용할 수 있습니다.");
                  return;
                }
                if(isTimerMode && timerTarget <= 0){
                  alert("타이머 시간을 설정해주세요.");
                  return;
                }
                const today = toDateStr(getNow());
                setActiveDay(today);
                setTimerActiveDay(today);
                setRunning(true);
                const rem = timerTarget - elapsed;
                if(rem > 0) scheduleTimerNotification(rem);
              }}
            >
              {running?"종료":"기도시작"}
            </button>
          </div>
        </div>

        {/* 시간 설정 버튼 - 네이티브 앱 타이머 모드에서만 표시 */}
        {isNativeApp()&&isTimerMode&&(
        <div style={{display:"flex",alignItems:"center",gap:5,marginTop:8,height:26}}>
            {[[600,"10분"],[1800,"30분"],[3600,"1h"]].map(([sec,label])=>(
              <button key={sec}
                onClick={()=>{if(!running)setTimerTarget(p=>p+sec);}}
                style={{flex:1,height:30,padding:"0 1px",borderRadius:7,fontSize:"0.625rem",fontWeight:700,cursor:"pointer",
                  border:`1px solid ${C.purple}55`,background:`${C.purple}14`,color:C.purple,
                  opacity:running?0.3:1}}>
                ＋{label}
              </button>
            ))}
            <button onClick={()=>{if(!running){setTimerTarget(0);setElapsed(0);}}}
              style={{height:30,padding:"0 8px",borderRadius:7,fontSize:"0.625rem",fontWeight:700,cursor:"pointer",flexShrink:0,
                border:`1px solid ${C.border}`,background:C.bg,color:C.muted,
                opacity:running?0.3:1}}>
              초기화
            </button>
          </div>
        )}

        <div style={{borderTop:`1px solid ${C.border}`,marginTop:12,paddingTop:10}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
            <div>
              <div style={{fontWeight:700,fontSize:"0.81rem",color:C.text}}>📅 총 기도시간</div>
              <div style={{marginTop:4,fontSize:"0.69rem",color:C.muted,lineHeight:1.4}}>
                요일별 기도시간을 수정할 수 있습니다.
              </div>
            </div>
            <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8}}>
              <span style={{fontSize:"1.3rem",fontWeight:900,color:C.gold,whiteSpace:"nowrap",letterSpacing:"-0.02em"}}>{fmtHM(weekTotalEff)}</span>
              <button
                type="button"
                style={{
                  padding:"5px 12px",
                  fontSize:"0.69rem",
                  fontWeight:800,
                  borderRadius:8,
                  border:`1.5px solid ${showPrayList?C.red:C.accent}`,
                  background:showPrayList?`${C.red}18`:`${C.accent}24`,
                  color:showPrayList?C.red:C.accent,
                  cursor:"pointer",
                  boxShadow:showPrayList?`0 0 0 1px ${C.red}18 inset`:`0 0 0 1px ${C.accent}18 inset`,
                  whiteSpace:"nowrap",
                }}
                onClick={()=>setShowPrayList(v=>!v)}
              >
                {showPrayList?"닫기":"요일별 보기"}
              </button>
            </div>
          </div>

          {showPrayList&&(
            <div style={{marginTop:10}}>
              {weekDates.map((d,i)=>{
                const key=toDateStr(d);
                const eff=weekData.dailySeconds?.[key]||0;
                const hasDawn=weekData.dawnService?.[key]&&weekData.dailySeconds?.[key]>0;
                const hasFri=d.getDay()===5&&weekData.fridayService;
                const isTuesday=d.getDay()===2;
                const weekDateKeys=weekDates.map(d2=>toDateStr(d2));
                const hagadaInWeek=weekDateKeys.includes(weekData.hagadaBonusKey);
                const hasHagada=weekData.hagadaDone&&(hagadaInWeek?weekData.hagadaBonusKey===key:isTuesday);
                const hasAttendance=isTuesday&&!!weekData.attendancePrayerBonus;
                const attendanceIcon=weekData.attendance==="late"?"⏰":"⛪";
                const hasPrayerFile=weekData.prayerFile&&eff>0;
                const hasSpiritNotes=Boolean(weekData.spiritNotes)&&eff>0;
                const hasReading=Object.values(weekData.readingChecked||{}).some(Boolean)&&eff>0;
                const hasWhole=weekData.wholeReadingDone&&eff>0;
                const isEd=editingDay===key;
                return (
                  <div key={key} style={{borderBottom:i<6?`1px solid ${C.border}`:"none"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0"}}>
                      <div style={{display:"flex",alignItems:"center",gap:5}}>
                        <span style={{fontSize:"0.81rem",color:C.muted,minWidth:24}}>{WEEK_DAYS[i]}</span>
                        <span style={{fontSize:"0.625rem",color:C.muted}}>{d.getMonth()+1}/{d.getDate()}</span>
                        {hasDawn&&<span style={{fontSize:"0.625rem",color:C.blue,fontWeight:700}}>{d.getDay()===6?"🙏":"🌅"}</span>}
                        {hasFri&&<span style={{fontSize:"0.625rem",color:C.purple,fontWeight:700}}>🔥</span>}
                        {hasHagada&&<span style={{fontSize:"0.625rem",color:C.gold,fontWeight:700}}>🗣️</span>}
                        {hasAttendance&&<span style={{fontSize:"0.625rem",color:C.green,fontWeight:700}}>{attendanceIcon}</span>}
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <span style={{fontSize:"0.81rem",fontWeight:700,color:eff>=3600?C.green:eff>0?C.accent:C.muted}}>
                          {eff>0?fmtHM(eff):"-"}{eff>=3600?" ✓":""}
                        </span>
                        <button style={{...btn("ghost"),padding:"2px 10px",fontSize:"0.625rem"}}
                          onClick={e=>{e.stopPropagation();setEditingDay(isEd?null:key);}}>
                          {isEd?"닫기":"수정"}
                        </button>
                      </div>
                    </div>
                    {isEd&&(
                      <div style={{paddingBottom:10}}>
                        <DayTimePicker effSecs={eff} dawnB={0} friB={0}
                          onSave={(newEff)=>{updateWeek({dailySeconds:{...weekData.dailySeconds,[key]:newEff}});setEditingDay(null);}}/>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div style={{...getCard(),borderLeft:`3px solid ${C.green}`,paddingLeft:13,paddingTop:13,paddingBottom:13}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
          <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text}}>
            <span style={{fontSize:"1rem"}}>📁</span>
            <span>기도파일</span>
          </div>
          <button onClick={()=>updateWeek({prayerFile:!weekData.prayerFile})}
            style={{minHeight:34,borderRadius:999,border:`1.5px solid ${weekData.prayerFile?C.green:C.border}`,background:weekData.prayerFile?`${C.green}20`:C.bg,color:weekData.prayerFile?C.green:C.muted,cursor:"pointer",padding:"6px 12px",display:"flex",alignItems:"center",justifyContent:"center",gap:5,fontSize:"0.75rem",fontWeight:800,boxShadow:weekData.prayerFile?`0 0 0 1px ${C.green}18 inset`:"none",whiteSpace:"nowrap",flexShrink:0}}>
            <span style={{fontSize:"0.875rem"}}>{weekData.prayerFile?"✅":"○"}</span>
            <span>{weekData.prayerFile?"완료":"미완료"}</span>
          </button>
        </div>
      </div>

      <div style={{...getCard(),borderLeft:`3px solid ${C.accent}`,paddingLeft:13,background:C.surface}}>
        <div style={{fontWeight:800,fontSize:"0.875rem",color:C.text,marginBottom:8}}>🕊 성령의 인도하심</div>
        <textarea style={{...getInp(),minHeight:86,resize:"vertical",lineHeight:"1.65",fontSize:"0.75rem",background:C.surface,border:`1px solid ${C.accent}44`}}
          placeholder="이번 주 기도 중 주신 성령의 인도하심을 기록하세요..."
          value={weekData.spiritNotes || ""}
          onChange={e=>updateWeek({spiritNotes:e.target.value})}/>
      </div>

      {/* 예배 출석 */}
      <div style={{...getInputCard(),border:`1px solid ${C.border}`,background:C.surface2}}>
        <div style={{display:"flex",alignItems:"baseline",gap:6,marginBottom:10}}>
          <span style={{fontWeight:800,fontSize:"0.875rem",color:C.text}}>⛪ 예배 출석</span>
          <span style={{fontSize:"0.625rem",color:C.muted,fontWeight:700}}>(기도시간 자동 반영)</span>
        </div>
        <div style={{background:weekData.fridayService?`${C.purple}18`:C.bg,border:`1px solid ${weekData.fridayService?C.purple:C.border}`,borderRadius:10,padding:"9px 12px",marginBottom:8}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:"0.81rem",fontWeight:700,color:weekData.fridayService?C.purple:C.text}}>🔥 금요HR예배</div>
              <div style={{fontSize:"0.625rem",color:C.muted,marginTop:2}}>11시까지 +1h / 12시까지 +2h</div>
              {weekData.fridayService&&<div style={{fontSize:"0.625rem",color:C.purple,marginTop:2,fontWeight:700}}>✓ 총 기도시간 +{weekData.fridayBonus===3600?"1":"2"}시간 반영됨</div>}
            </div>
            <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:5}}>
              {!weekData.fridayService
                ?<div style={{display:"flex",gap:6}}>
                  {[[3600,"~11시"],[7200,"~12시"]].map(([sec,lbl])=>(
                    <button key={sec} style={{padding:"5px 10px",borderRadius:7,border:`1px solid ${C.purple}55`,background:"transparent",color:C.purple,fontSize:"0.69rem",fontWeight:700,cursor:"pointer"}}
                      onClick={()=>{
                        const friKey=weekDates.find(d=>d.getDay()===5)?toDateStr(weekDates.find(d=>d.getDay()===5)):null;
                        if(!friKey)return;
                        const cur=weekData.dailySeconds?.[friKey]||0;
                        updateWeek({fridayService:true,fridayBonus:sec,dailySeconds:{...(weekData.dailySeconds||{}),[friKey]:cur+sec}});
                      }}>{lbl}</button>
                  ))}
                </div>
                :<button style={{padding:"5px 10px",borderRadius:7,border:`1px solid ${C.red}44`,background:"transparent",color:C.red,fontSize:"0.69rem",fontWeight:700,cursor:"pointer"}}
                  onClick={()=>{
                    const friKey=weekDates.find(d=>d.getDay()===5)?toDateStr(weekDates.find(d=>d.getDay()===5)):null;
                    if(!friKey)return;
                    const bonus=weekData.fridayBonus||7200;
                    const cur=weekData.dailySeconds?.[friKey]||0;
                    updateWeek({fridayService:false,fridayBonus:0,dailySeconds:{...(weekData.dailySeconds||{}),[friKey]:Math.max(0,cur-bonus)}});
                  }}>취소</button>}
            </div>
          </div>
        </div>
        <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"9px 12px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div><div style={{fontSize:"0.81rem",fontWeight:700}}>🙏 새벽예배/예배중보</div><div style={{fontSize:"0.625rem",color:C.muted,marginTop:2}}>새벽예배/예배중보 참석시 체크</div></div>
            
          </div>
          <div style={{display:"flex",gap:5}}>
            {weekDates.map((d,i)=>{
              const key=toDateStr(d),checked=weekData.dawnService?.[key];
              const isSunday=d.getDay()===0;
              const isSaturday=d.getDay()===6;
              const activeColor=isSaturday?C.purple:C.blue;
              return (
                <div key={key} onClick={isSunday?undefined:()=>{
                  const wasOn=weekData.dawnService?.[key];
                  const cur=weekData.dailySeconds?.[key]||0;
                  updateWeek({dawnService:{...(weekData.dawnService||{}),[key]:!wasOn},dailySeconds:{...(weekData.dailySeconds||{}),[key]:wasOn?Math.max(0,cur-3600):cur+3600}});
                }}
                  style={{flex:1,padding:"5px 2px",borderRadius:7,textAlign:"center",cursor:isSunday?"not-allowed":"pointer",opacity:isSunday?0.45:1,background:checked?`${activeColor}25`:C.surface,border:`1px solid ${checked?activeColor:C.border}`,transition:"all 0.15s"}}>
                  <div style={{fontSize:"0.69rem",color:checked?activeColor:C.muted,fontWeight:checked?700:400}}>{WEEK_DAYS[i]}</div>
                </div>
              );
            })}
          </div>
          {dawnHours>0&&(
            <div style={{fontSize:"0.625rem",color:C.blue,marginTop:8,fontWeight:700,textAlign:"left"}}>
              ✓ 총 기도시간 +{dawnHours}시간 반영됨
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

// ── Reading ───────────────────────────────────────────────────────────────────
function ReadingTab({weekData,updateWeek,bibleReading,weekKey}) {
  const totalChapters=bibleReading.reduce((a,b)=>a+b.chapters.length,0);
  const checkedCount=Object.values(weekData.readingChecked||{}).filter(Boolean).length;
  const allDone=totalChapters>0&&checkedCount>=totalChapters;
  // Modified: update auto-backup conditions for reading
  const toggle=(book,ch)=>{
    const next = {...weekData.readingChecked,[`${book}_${ch}`]:!weekData.readingChecked[`${book}_${ch}`]};
    updateWeek({readingChecked:next});
  };
  const checkAll=()=>{ const n={...weekData.readingChecked}; bibleReading.forEach(s=>s.chapters.forEach(c=>{n[`${s.book}_${c}`]=true;})); updateWeek({readingChecked:n}); };
  // 통독 범위 요약 (열왕기상 9~22장 형식)
  const readingRangeLabel = bibleReading.map(s=>{
    const chs = s.chapters;
    return `${s.book} ${chs[0]}~${chs[chs.length-1]}장`;
  }).join(', ');

  return (
    <div>
      <div style={{...getInputCard(),background:`linear-gradient(135deg,${C.surface2} 0%,${C.surface} 100%)`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{minWidth:0,flex:1}}>
            <div style={{fontSize:"0.69rem",color:C.muted,marginBottom:2,wordBreak:"keep-all"}}>{readingRangeLabel||"통독 현황"}</div>
            <div style={{fontSize:"1.875rem",fontWeight:800,color:allDone?C.green:C.blue,marginTop:4,lineHeight:1}}>{checkedCount}<span style={{fontSize:"0.94rem",color:C.muted}}>/{totalChapters}장</span></div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6,alignItems:"flex-end",flexShrink:0,marginLeft:8}}>
            {!allDone&&<button style={{...btn("ghost"),padding:"6px 14px",fontSize:"0.69rem",whiteSpace:"nowrap"}} onClick={checkAll}>전체체크</button>}
            {allDone&&<div style={{fontSize:"0.75rem",color:C.green,fontWeight:700}}>✓ 완료!</div>}
          </div>
        </div>
        <div style={{height:5,background:C.border,borderRadius:3,margin:"10px 0 0"}}>
          <div style={{height:"100%",width:`${totalChapters>0?(checkedCount/totalChapters)*100:0}%`,background:allDone?C.green:C.blue,borderRadius:3,transition:"width 0.3s"}}/>
        </div>
      </div>
      {bibleReading.length===0
        ?<div style={{...getCard(),textAlign:"center",padding:32}}><div style={{fontSize:"2rem",marginBottom:8}}>📂</div><div style={{color:C.muted}}>이번 주 통독 데이터 없음</div><div style={{color:C.muted,fontSize:"0.75rem",marginTop:4}}>설정 → 엑셀 업로드</div></div>
        :bibleReading.map((section,si)=>(
          <div key={si} style={getInputCard()}>
            <label style={getLbl()}>{section.book}</label>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,2.75rem)",gap:4,justifyContent:"start"}}>
              {section.chapters.map(ch=>{
                const checked=weekData.readingChecked[`${section.book}_${ch}`];
                return <button key={ch} onClick={()=>toggle(section.book,ch)} style={{width:"2.75rem",height:"1.8rem",borderRadius:6,border:`1px solid ${checked?C.blue:C.border}`,background:checked?`${C.blue}22`:C.bg,color:checked?C.blue:C.muted,fontSize:"0.72rem",fontWeight:checked?700:400,cursor:"pointer",padding:"0 2px",whiteSpace:"nowrap",boxSizing:"border-box",textAlign:"center",display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>{ch}장</button>;
              })}
            </div>
          </div>
        ))}
      <div style={getInputCard()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><div style={{fontWeight:700,fontSize:"0.875rem"}}>📜 성경 전체 1독</div><div style={{fontSize:"0.69rem",color:C.muted,marginTop:2}}>창세기~요한계시록 완독</div></div>
          <button onClick={()=>{
            const next = !weekData.wholeReadingDone;
            updateWeek({wholeReadingDone:next});
          }}
            style={{width:44,height:44,borderRadius:22,border:`2px solid ${weekData.wholeReadingDone?C.gold:C.border}`,background:weekData.wholeReadingDone?`${C.gold}22`:C.bg,fontSize:"1.125rem",cursor:"pointer",color:C.gold}}>
            {weekData.wholeReadingDone?"✓":""}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── TimeScrollPicker: 원 안에서 위아래 스크롤로 시간 선택 ────────────────────
function TimeScrollPicker({value, min, max, step=1, onChange, label}) {
  const containerRef = useRef(null);
  const startYRef = useRef(null);
  const startValRef = useRef(null);
  const vals = [];
  for(let v=min; v<=max; v+=step) vals.push(v);

  const clamp = (v) => {
    const closest = vals.reduce((a,b)=>Math.abs(b-v)<Math.abs(a-v)?b:a, vals[0]);
    return closest;
  };

  const handleStart = (clientY) => {
    startYRef.current = clientY;
    startValRef.current = value;
  };

  const handleMove = (clientY) => {
    if(startYRef.current === null) return;
    const dy = startYRef.current - clientY;
    const sensitivity = 18; // px per step
    const steps = Math.round(dy / sensitivity);
    const newVal = clamp(startValRef.current + steps * step);
    if(newVal !== value) onChange(newVal);
  };

  const handleEnd = () => { startYRef.current = null; };

  // 마우스
  const onMouseDown = (e) => { e.preventDefault(); handleStart(e.clientY); };
  useEffect(()=>{
    const onMove = (e) => handleMove(e.clientY);
    const onUp = () => handleEnd();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return ()=>{ window.removeEventListener("mousemove",onMove); window.removeEventListener("mouseup",onUp); };
  },[value]);

  // 터치
  const onTouchStart = (e) => handleStart(e.touches[0].clientY);
  const onTouchMove = (e) => { e.preventDefault(); handleMove(e.touches[0].clientY); };

  // 휠
  const onWheel = (e) => {
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1;
    const idx = vals.indexOf(value);
    const newIdx = Math.max(0, Math.min(vals.length-1, idx+dir));
    onChange(vals[newIdx]);
  };

  const prevVal = vals[Math.max(0, vals.indexOf(value)-1)];
  const nextVal = vals[Math.min(vals.length-1, vals.indexOf(value)+1)];

  return (
    <div ref={containerRef}
      style={{display:"flex",flexDirection:"column",alignItems:"center",cursor:"ns-resize",userSelect:"none",width:44}}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={handleEnd}
      onWheel={onWheel}>
      <div style={{fontSize:"0.69rem",color:C.muted,opacity:0.4,lineHeight:1,marginBottom:1}}>
        {String(prevVal).padStart(2,"0")}
      </div>
      <div style={{fontSize:"1.5rem",fontWeight:800,color:C.gold,lineHeight:1,fontVariantNumeric:"tabular-nums"}}>
        {String(value).padStart(2,"0")}
      </div>
      <div style={{fontSize:"0.625rem",color:C.muted,marginTop:1}}>{label}</div>
      <div style={{fontSize:"0.69rem",color:C.muted,opacity:0.4,lineHeight:1,marginTop:1}}>
        {String(nextVal).padStart(2,"0")}
      </div>
    </div>
  );
}

function MemoryTab({weekData,updateWeek,memoryVerseGroup,weekKey,scheduleData,weekDates}) {
  const [recording,setRecording] = useState(false);
  const [audioUrl,setAudioUrl] = useState(weekData.memoryAudioDataUrl || "");
  const [showAudioPlayer,setShowAudioPlayer] = useState(false);
  const [playbackRate,setPlaybackRate] = useState(1);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioRef = useRef(null);
  const blobToDataUrl = (blob) => new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  useEffect(()=>{
    if(weekData.memoryAudioDataUrl && weekData.memoryAudioDataUrl !== audioUrl){
      setAudioUrl(weekData.memoryAudioDataUrl);
    }
  },[weekData.memoryAudioDataUrl]);
  const hagadaTarget = Number(scheduleData?.hagadaTarget || 700);
  const hagadaCount = Number(weekData.hagadaCount || 0);
  const addHagadaCount = (amount = 1) => {
    const nextCount = Math.max(0, hagadaCount + amount);
    const patch = { hagadaCount: nextCount };

    // {hagadaTarget}회 달성 시 기도시간 +1시간 (1회만)
    if (nextCount >= hagadaTarget && !weekData.hagadaBonus) {
      const todayKey = toDateStr(getNow());
      const tuesdayKey = toDateStr(weekDates[0]);
      const weekDateKeys = weekDates.map(d2 => toDateStr(d2));
      // 오늘이 이번 주(화~월) 범위 안이면 해당 요일, 아니면 화요일에 반영
      const bonusKey = weekDateKeys.includes(todayKey) ? todayKey : tuesdayKey;
      patch.hagadaBonus = true;
      patch.hagadaBonusKey = bonusKey;
      patch.dailySeconds = { ...(weekData.dailySeconds||{}), [bonusKey]: ((weekData.dailySeconds||{})[bonusKey]||0) + 3600 };
    }

    updateWeek(patch);
  };
    
  const [loopPlay, setLoopPlay] = useState(false);
  const toggleLoopPlay = () => {
    const next = !loopPlay;
    setLoopPlay(next);
    if(audioRef.current) audioRef.current.loop = next;
  };
  const blobRef = useRef(null);

  const startRec = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        alert("현재 환경에서 마이크 녹음을 지원하지 않습니다.");
        return;
      }

      if (typeof MediaRecorder === "undefined") {
        alert("현재 환경에서 녹음 저장 기능을 지원하지 않습니다.");
        return;
      }

      if (audioUrl && audioUrl.startsWith("blob:")) {
        URL.revokeObjectURL(audioUrl);
      }
      setAudioUrl("");
      setShowAudioPlayer(false);
      updateWeek({memoryAudioDataUrl:""});

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const mimeCandidates = [
        "audio/mp4",
        "audio/aac",
        "audio/webm;codecs=opus",
        "audio/webm",
      ];

      const supportedMimeType = mimeCandidates.find(type =>
        MediaRecorder.isTypeSupported?.(type)
      );

      const recorder = supportedMimeType
        ? new MediaRecorder(stream, { mimeType: supportedMimeType })
        : new MediaRecorder(stream);

      audioChunksRef.current = [];
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        const blob = new Blob(audioChunksRef.current, {
          type: supportedMimeType || "audio/mp4",
        });

        blobRef.current = blob;
        const dataUrl = await blobToDataUrl(blob);
        setAudioUrl(dataUrl);
        updateWeek({memoryAudioDataUrl:dataUrl});
        setShowAudioPlayer(true);

        stream.getTracks().forEach(track => track.stop());
      };

      recorder.start();
      setRecording(true);
    } catch (e) {

      if (e?.name === "NotAllowedError" || e?.name === "PermissionDeniedError") {
        alert("마이크 권한이 거부되었습니다. iPhone 설정에서 마이크 권한을 허용해 주세요.");
      } else if (e?.name === "NotFoundError") {
        alert("사용 가능한 마이크를 찾을 수 없습니다.");
      } else if (e?.name === "NotSupportedError") {
        alert("현재 iOS 환경에서 지원되지 않는 녹음 형식입니다. 앱을 다시 실행한 뒤 시도해 주세요.");
      } else {
        alert(`녹음 시작 중 오류가 발생했습니다: ${e?.message || e?.name || "알 수 없는 오류"}`);
      }
    }
  };

  const stopRec = () => {
    try {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
    } catch (e) {
    } finally {
      setRecording(false);
    }
  };

  const shareAudio = async () => {
    try {
      if (!audioUrl) {
        alert("공유할 녹음 파일이 없습니다.");
        return;
      }

      const blob = blobRef.current || await (await fetch(audioUrl)).blob();
      const file = new File([blob], "memory-recording.m4a", {
        type: blob.type || "audio/mp4",
      });

      if (navigator.canShare?.({ files: [file] }) && navigator.share) {
        try {
          await navigator.share({
            title: "암송 녹음",
            text: "암송 녹음 파일입니다.",
            files: [file],
          });
          return;
        } catch (e) {
        }
      }

      const objectUrl = audioUrl.startsWith("blob:")
        ? audioUrl
        : URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = "memory-recording.m4a";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      if (!audioUrl.startsWith("blob:")) {
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
    } catch (e) {
      alert("공유를 바로 실행할 수 없어 녹음 파일을 다운로드 방식으로 저장해 주세요.");
    }
  };

  const verses = memoryVerseGroup?.verses || [];

  if(!verses.length) return (
    <div style={{...getCard(),textAlign:"center",padding:32}}><div style={{fontSize:"2rem",marginBottom:8}}>📂</div><div style={{color:C.muted,fontSize:"0.875rem"}}>이번 주 암송 데이터 없음</div><div style={{color:C.muted,fontSize:"0.75rem",marginTop:4}}>schedule.json을 확인하세요</div></div>
  );

  return (
    <div>
      {/* 1. 암송 구절 */}
      <div style={{...getCard(),background:`linear-gradient(135deg,${C.surface2} 0%,${C.surface} 100%)`,border:`1px solid ${C.purple}44`}}>
        {verses.map((v,i)=>(
          <div key={i} style={{marginBottom: i < verses.length-1 ? 16 : 0}}>
            <div style={{fontSize:"0.75rem",color:C.purple,fontWeight:700,marginBottom:6}}>{v.reference}</div>
            <div style={{fontSize:"0.875rem",lineHeight:1.25,color:C.text}}>{v.text}</div>
            {i < verses.length-1 && <div style={{height:1,background:`${C.purple}33`,marginTop:16}}/>}
          </div>
        ))}
      </div>

      {/* 2. 하가다 */}
      <div style={{...getCard(),borderLeft:`3px solid ${C.gold}`,paddingLeft:13}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
          <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text}}>
            <span style={{fontSize:"1rem"}}>🔁</span><span>하가다</span>
          </div>
          <button onClick={()=>{
            const done=weekData.hagadaDone;
            if(!done){
              const patch={hagadaDone:true,hagadaCount:Math.max(hagadaCount,hagadaTarget)};
              if(!weekData.hagadaBonus){
                const todayKey=toDateStr(getNow());const tuesdayKey=toDateStr(weekDates[0]);
                const weekDateKeys=weekDates.map(d2=>toDateStr(d2));
                const bonusKey=weekDateKeys.includes(todayKey)?todayKey:tuesdayKey;
                patch.hagadaBonus=true;patch.hagadaBonusKey=bonusKey;
                patch.dailySeconds={...(weekData.dailySeconds||{}),[bonusKey]:((weekData.dailySeconds||{})[bonusKey]||0)+3600};
              }
              updateWeek(patch);
            } else {
              const patch={hagadaDone:false,hagadaCount:Math.max(0,hagadaCount-hagadaTarget)};
              if(weekData.hagadaBonus&&weekData.hagadaBonusKey){
                const bonusKey=weekData.hagadaBonusKey;
                patch.hagadaBonus=false;patch.hagadaBonusKey=null;
                patch.dailySeconds={...(weekData.dailySeconds||{}),[bonusKey]:Math.max(0,((weekData.dailySeconds||{})[bonusKey]||0)-3600)};
              }
              updateWeek(patch);
            }
          }} style={{minHeight:32,borderRadius:999,border:`1.5px solid ${weekData.hagadaDone?C.green:C.border}`,background:weekData.hagadaDone?`${C.green}20`:C.bg,color:weekData.hagadaDone?C.green:C.muted,cursor:"pointer",padding:"5px 14px",display:"flex",alignItems:"center",gap:5,fontSize:"0.75rem",fontWeight:800,whiteSpace:"nowrap"}}>
            <span>{weekData.hagadaDone?"✅":"○"}</span><span>{weekData.hagadaDone?"완료":"미완료"}</span>
          </button>
        </div>
        <div style={{display:"flex",alignItems:"stretch",gap:10,marginBottom:8}}>
          <div style={{flex:1,borderRadius:14,border:`1px solid ${hagadaCount>=hagadaTarget?C.green:C.gold}55`,background:hagadaCount>=hagadaTarget?`${C.green}14`:`${C.gold}14`,padding:"10px 12px",display:"flex",flexDirection:"column",justifyContent:"center",minWidth:0}}>
            <div style={{fontSize:"0.625rem",color:C.muted,fontWeight:800,marginBottom:4}}>읊조리기 횟수 <span style={{fontSize:"0.56rem",fontWeight:400,marginLeft:4}}>✏️ 직접입력</span></div>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <input type="number" min={0} value={hagadaCount}
                onChange={e=>{
                  const v=Math.max(0,Number(e.target.value)||0);
                  const patch={hagadaCount:v};
                  if(v>=hagadaTarget&&!weekData.hagadaBonus){
                    const todayKey=toDateStr(getNow());
                    patch.hagadaBonus=true;patch.hagadaBonusKey=todayKey;
                    patch.dailySeconds={...(weekData.dailySeconds||{}),[todayKey]:((weekData.dailySeconds||{})[todayKey]||0)+3600};
                  }
                  updateWeek(patch);
                }}
                style={{width:88,fontSize:"1.75rem",fontWeight:900,color:hagadaCount>=hagadaTarget?C.green:C.gold,background:"transparent",border:`1px dashed ${hagadaCount>=hagadaTarget?C.green:C.gold}55`,borderRadius:6,outline:"none",letterSpacing:"-0.04em",lineHeight:1,padding:"2px 4px",MozAppearance:"textfield",textAlign:"center"}}
              />
              <span style={{fontSize:"0.875rem",fontWeight:900,color:C.text}}>/ {hagadaTarget}회</span>
            </div>
          </div>
          <button type="button" onClick={()=>{haptic("medium");addHagadaCount(1);}}
            style={{width:118,borderRadius:14,border:`2px solid ${hagadaCount>=hagadaTarget?C.green:C.gold}`,background:hagadaCount>=hagadaTarget?`${C.green}24`:`${C.gold}24`,color:hagadaCount>=hagadaTarget?C.green:C.gold,cursor:"pointer",fontWeight:900,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:3,flexShrink:0,touchAction:"manipulation"}}>
            <span style={{fontSize:"1.35rem",lineHeight:1}}>＋1</span>
            <span style={{fontSize:"0.69rem",fontWeight:800}}>읊조리기</span>
          </button>
        </div>
        {hagadaCount>=hagadaTarget&&<div style={{fontSize:"0.69rem",color:C.green,fontWeight:800,marginTop:8,textAlign:"center"}}>✓ {hagadaTarget}회 이상! 기도시간 +1시간이 반영됩니다.</div>}
      </div>

      {/* 3. 암송 완료 */}
      <div style={{...getInputCard(),paddingTop:13,paddingBottom:13}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginBottom:weekData.memoryDone?12:0}}>
          <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text}}>
            <span style={{fontSize:"1rem"}}>🗣️</span><span>암송</span>
          </div>
          <button onClick={()=>updateWeek({memoryDone:!weekData.memoryDone})}
            style={{minHeight:34,borderRadius:999,border:`1.5px solid ${weekData.memoryDone?C.purple:C.border}`,background:weekData.memoryDone?`${C.purple}20`:C.bg,color:weekData.memoryDone?C.purple:C.muted,cursor:"pointer",padding:"6px 12px",display:"flex",alignItems:"center",justifyContent:"center",gap:5,fontSize:"0.75rem",fontWeight:800,boxShadow:weekData.memoryDone?`0 0 0 1px ${C.purple}18 inset`:"none",whiteSpace:"nowrap",flexShrink:0}}>
            <span style={{fontSize:"0.875rem"}}>{weekData.memoryDone?"✅":"○"}</span>
            <span>{weekData.memoryDone?"완료":"미완료"}</span>
          </button>
        </div>
        {weekData.memoryDone&&(
          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:2}}>
            <div style={{fontSize:"0.69rem",color:C.muted,fontWeight:700,whiteSpace:"nowrap",flexShrink:0}}>
              틀린 글자 수
            </div>
            <div style={{display:"flex",gap:5,flex:1,justifyContent:"flex-end"}}>
              {[0,1,2,3,4].map(n=>(
                <button
                  key={n}
                  onClick={()=>updateWeek({memoryErrors:n})}
                  style={{
                    height:28,
                    minWidth:32,
                    padding:"0 7px",
                    borderRadius:7,
                    border:`1px solid ${weekData.memoryErrors===n?C.purple:C.border}`,
                    background:weekData.memoryErrors===n?`${C.purple}22`:C.bg,
                    color:weekData.memoryErrors===n?C.purple:C.muted,
                    fontSize:"0.69rem",
                    fontWeight:800,
                    cursor:"pointer",
                    whiteSpace:"nowrap"
                  }}
                >
                  {n===4?"4+":n}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 4. 암송 녹음 */}
      <div style={getCard()}>
        <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text,marginBottom:10}}>
          <span style={{fontSize:"1rem"}}>🎙</span><span>암송 녹음</span>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {!recording
            ? <button style={{...btn("primary"),flex:1,padding:11}} onClick={startRec}>● 녹음 시작</button>
            : <button style={{...btn("danger"),flex:1,padding:11}} onClick={stopRec}>■ 녹음 중지</button>}
          {audioUrl&&(
            <button
              type="button"
              onClick={()=>setShowAudioPlayer(v=>!v)}
              style={{width:42,height:42,borderRadius:10,border:`1px solid ${C.purple}55`,background:showAudioPlayer?`${C.purple}22`:C.bg,color:showAudioPlayer?C.purple:C.muted,fontSize:"1rem",fontWeight:800,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}
              title={showAudioPlayer?"녹음 접기":"녹음 펼치기"}
            >
              {showAudioPlayer?"▲":"🎧"}
            </button>
          )}
        </div>

        {audioUrl&&showAudioPlayer&&(
          <div style={{background:C.bg,borderRadius:8,marginTop:10,border:`1px solid ${C.border}`,overflow:"hidden",padding:"12px"}}>
            <audio
              ref={audioRef}
              src={audioUrl}
              controls
              style={{width:"100%",marginBottom:4}}
              onPlay={()=>{ if(audioRef.current) audioRef.current.playbackRate=playbackRate; }}
            />
            <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
              <div style={{display:"flex",alignItems:"center",gap:5,marginRight:8,flexWrap:"wrap"}}>
                {[0.7,1,1.3,1.5,2].map(r=>(
                  <button
                    key={r}
                    onClick={()=>{setPlaybackRate(r);if(audioRef.current)audioRef.current.playbackRate=r;}}
                    style={{padding:"3px 8px",borderRadius:6,border:`1px solid ${playbackRate===r?C.purple:C.border}`,background:playbackRate===r?`${C.purple}22`:C.bg,color:playbackRate===r?C.purple:C.muted,fontSize:"0.69rem",cursor:"pointer"}}
                  >{r}x</button>
                ))}
              </div>
              <button
                type="button"
                onClick={toggleLoopPlay}
                title="반복 재생"
                style={{width:28,height:28,borderRadius:8,border:`1px solid ${loopPlay?C.green:C.border}`,background:loopPlay?`${C.green}18`:C.bg,color:loopPlay?C.green:C.muted,fontSize:"0.875rem",fontWeight:800,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}
              >
                🔁
              </button>
              <button
                type="button"
                onClick={shareAudio}
                title="녹음 공유"
                style={{
                  width:28,
                  height:28,
                  borderRadius:8,
                  border:`1px solid ${C.blue}55`,
                  background:`${C.blue}14`,
                  color:C.blue,
                  // fontSize intentionally omitted/removed as per instruction
                  fontWeight:800,
                  cursor:"pointer",
                  display:"flex",
                  alignItems:"center",
                  justifyContent:"center"
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 16V4" />
                  <path d="M7 9l5-5 5 5" />
                  <path d="M5 14v5h14v-5" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

// ── 월간 카드 (useState를 최상위 함수 컴포넌트에서 호출) ──────────────────────
function MonthCard({mg,now}) {
  const isCurrentMonth=mg.month===(now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0"));
  const [expanded,setExpanded]=useState(isCurrentMonth);
  return (
    <div style={{...getCard(),padding:0,overflow:"hidden"}}>
      <div onClick={()=>setExpanded(e=>!e)}
        style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 14px",cursor:"pointer",background:C.surface}}>
        <div>
          <span style={{fontSize:"0.875rem",fontWeight:700,color:C.text}}>{mg.month}</span>
          <span style={{fontSize:"0.69rem",color:C.muted,marginLeft:8}}>{mg.weeks.length}주</span>
        </div>
        <div style={{display:"flex",gap:12,alignItems:"center"}}>
          <span style={{fontSize:"0.75rem",color:C.gold,fontWeight:700}}>{fmtHM(mg.sec)}</span>
          <span style={{fontSize:"0.75rem",color:C.blue}}>{mg.read}장</span>
          <span style={{fontSize:"0.69rem",color:C.muted}}>{expanded?"▲":"▼"}</span>
        </div>
      </div>
      {expanded&&(
        <div style={{padding:"10px 14px",borderTop:`1px solid ${C.border}`}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr 1fr",gap:6,marginBottom:10}}>
            {[
              {l:"총기도",v:fmtHM(mg.sec),c:C.gold},
              {l:"기도일수",v:`${mg.prayD}일`,c:C.accent},
              {l:"하가다",v:`${mg.hagada||0}회`,c:(mg.hagada||0)>0?C.blue:C.muted},
              {l:"통독",v:`${mg.read}장`,c:C.blue},
              {l:"완독",v:`${mg.whole}독`,c:mg.whole>0?C.green:C.muted},
              {l:"암송",v:`${mg.uniqueVerses||0}절`,c:(mg.uniqueVerses||0)>0?C.purple:C.muted},
            ].map(s=>(
              <div key={s.l} style={{textAlign:"center",background:C.bg,borderRadius:8,padding:"8px 3px"}}>
                <div style={{fontSize:"0.5rem",color:C.muted}}>{s.l}</div>
                <div style={{fontSize:"0.81rem",fontWeight:800,color:s.c,marginTop:3}}>{s.v}</div>
              </div>
            ))}
          </div>
          {mg.weeks.map(ws=>(
            <div key={ws.wk} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:`1px solid ${C.border}33`,fontSize:"0.69rem"}}>
              <span style={{color:C.muted}}>{ws.wk.slice(5)} ~ {ws.end.slice(5)}</span>
              <div style={{display:"flex",gap:10}}>
                <span style={{color:C.gold}}>{fmtHM(ws.sec)}</span>
                <span style={{color:C.blue}}>{ws.read}장</span>
                {ws.submitted&&<span style={{color:C.green}}>✓제출</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Stats 집계 ────────────────────────────────────────────────────────────────
function StatsTab({thisWeekKey,weekKey,weekData,scheduleData}) {
  const [period,setPeriod]=useState("week");
  const now=new Date();
  const thisYear=String(now.getFullYear());

  const allWeekKeys=useMemo(()=>{
    const keys=[];
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k&&k.startsWith("week_")) keys.push(k.replace("week_",""));
    }
    return keys.sort().reverse();
  },[period]);

  const weekStats=useMemo(()=>allWeekKeys.map(wk=>{
    const wd=load(`week_${wk}`,{dailySeconds:{},dawnService:{},fridayService:false,readingChecked:{},wholeReadingDone:false,memoryDone:false,attendance:null,submitted:false});
    const dates=getWeekDates(wk);
    const sec=dates.reduce((s,d)=>s+getDayEff(wd,toDateStr(d)),0);
    const prayD=Math.min(dates.filter(d=>getDayEff(wd,toDateStr(d))>=3600).length, 6);
    const read=Object.values(wd.readingChecked||{}).filter(Boolean).length;
    const dawn=dates.filter(d=>{
      const key=toDateStr(d);
      return d.getDay()!==0 && d.getDay()!==6 && wd.dawnService?.[key];
    }).length;
    const hagada=Number(wd.hagadaCount||0);
    const end=toDateStr(dates[6]);
    const verseRefs=wd.memoryDone ? getMemoryVersesForWeek(scheduleData?.verses||[], wk).map(v=>v.reference) : [];
    return {wk,end,sec,prayD,read,dawn,hagada,whole:wd.wholeReadingDone?1:0,memory:wd.memoryDone?1:0,verseRefs,submitted:wd.submitted||false};
  }),[period]);

  // 중복 없는 실제 암송 구절 수 계산 (같은 reference는 1번만)
  const countUniqueVerses = (statsList) => {
    const seen = new Set();
    statsList.forEach(ws=>ws.verseRefs.forEach(r=>seen.add(r)));
    return seen.size;
  };

  const monthGroups=useMemo(()=>{
    const map={};
    weekStats.forEach(ws=>{
      const m=ws.wk.slice(0,7);
      if(!map[m]) map[m]={month:m,weeks:[],sec:0,read:0,whole:0,memory:0,prayD:0,dawn:0,hagada:0};
      map[m].weeks.push(ws);
      map[m].sec+=ws.sec;map[m].read+=ws.read;map[m].whole+=ws.whole;
      map[m].memory+=ws.memory;map[m].prayD+=ws.prayD;map[m].dawn+=ws.dawn;map[m].hagada+=ws.hagada;
    });
    // 월별 실제 암송 구절 수 계산
    Object.values(map).forEach(mg=>{ mg.uniqueVerses=countUniqueVerses(mg.weeks); });
    return Object.values(map).sort((a,b)=>b.month.localeCompare(a.month));
  },[weekStats]);

  const yearStats=useMemo(()=>{
    const map={};
    weekStats.forEach(ws=>{
      const y=ws.wk.slice(0,4);
      if(!map[y]) map[y]={year:y,sec:0,read:0,whole:0,memory:0,prayD:0,dawn:0,hagada:0,weeks:0,weeksList:[]};
      map[y].sec+=ws.sec;map[y].read+=ws.read;map[y].whole+=ws.whole;
      map[y].memory+=ws.memory;map[y].prayD+=ws.prayD;map[y].dawn+=ws.dawn;map[y].hagada+=ws.hagada;map[y].weeks++;
      map[y].weeksList.push(ws);
    });
    // 연별 실제 암송 구절 수 계산
    Object.values(map).forEach(ys=>{ ys.uniqueVerses=countUniqueVerses(ys.weeksList); });
    return Object.values(map).sort((a,b)=>b.year.localeCompare(a.year));
  },[weekStats]);

  const periodLabel={week:"주간",month:"월간",year:"연간"};
  const [selectedYear,setSelectedYear]=useState(thisYear);

  return (
    <div>
      <div style={{display:"flex",gap:6,marginBottom:14}}>
        {["week","month","year"].map(p=>(
          <button key={p} onClick={()=>setPeriod(p)} style={{...btn(period===p?"primary":"ghost"),flex:1,padding:"8px 0",fontSize:"0.81rem"}}>
            {periodLabel[p]}
          </button>
        ))}
      </div>

      {/* 연간 - 연도 선택 */}
      {period==="year"&&yearStats.length>1&&(
        <div style={{display:"flex",gap:8,marginBottom:12,overflowX:"auto",paddingBottom:4}}>
          {yearStats.map(ys=>(
            <button key={ys.year} onClick={()=>setSelectedYear(ys.year)}
              style={{...btn(selectedYear===ys.year?"primary":"ghost"),whiteSpace:"nowrap",padding:"6px 14px",fontSize:"0.75rem",
                      border:`1px solid ${ys.year===thisYear?C.gold:C.border}`,
                      color:selectedYear===ys.year?C.bg:ys.year===thisYear?C.gold:C.muted}}>
              {ys.year}년{ys.year===thisYear?" 🔸":""}
            </button>
          ))}
        </div>
      )}

      {/* ── 주간 목록 ── */}
      {period==="week"&&(
        weekStats.length===0
          ?<div style={{...getCard(),textAlign:"center",padding:32,color:C.muted}}>기록된 주간 데이터가 없습니다</div>
          :weekStats.map(ws=>{
            const isCur=ws.wk===weekKey;
            return (
              <div key={ws.wk} style={{...getCard(),border:`1px solid ${isCur?C.accent:C.border}`,background:isCur?`${C.accent}0a`:C.surface}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <div>
                    <span style={{fontSize:"0.75rem",fontWeight:700,color:isCur?C.accent:C.text}}>{ws.wk} ~ {ws.end}</span>
                    {isCur&&<span style={{marginLeft:6,fontSize:"0.625rem",color:C.accent,background:`${C.accent}22`,padding:"1px 6px",borderRadius:8}}>현재</span>}
                  </div>
                  {ws.submitted&&<span style={{fontSize:"0.625rem",color:C.green,background:`${C.green}18`,padding:"2px 8px",borderRadius:10,border:`1px solid ${C.green}44`}}>제출완료</span>}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr",gap:5}}>
                  {[
                    {label:"기도",value:fmtHM(ws.sec),color:C.gold},
                    {label:"기도일수",value:`${ws.prayD}/6`,color:ws.prayD>=6?C.green:C.accent},
                    {label:"하가다",value:`${ws.hagada}회`,color:ws.hagada>0?C.blue:C.muted},
                    {label:"통독",value:`${ws.read}장`,color:C.blue},
                    {label:"완독",value:`${ws.whole}독`,color:ws.whole>0?C.green:C.muted},
                  ].map(s=>(
                    <div key={s.label} style={{textAlign:"center",background:C.bg,borderRadius:8,padding:"6px 3px"}}>
                      <div style={{fontSize:"0.5rem",color:C.muted}}>{s.label}</div>
                      <div style={{fontSize:"0.75rem",fontWeight:800,color:s.color,marginTop:2}}>{s.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })
      )}

      {/* ── 월간 목록 ── */}
      {period==="month"&&(
        monthGroups.length===0
          ?<div style={{...getCard(),textAlign:"center",padding:32,color:C.muted}}>기록된 데이터가 없습니다</div>
          :monthGroups.map(mg=><MonthCard key={mg.month} mg={mg} now={now}/>)
      )}

      {/* ── 연간 요약 ── */}
      {period==="year"&&(()=>{
        if(yearStats.length===0) return <div style={{...getCard(),textAlign:"center",padding:32,color:C.muted}}>기록된 데이터가 없습니다</div>;
        const ys = yearStats.find(y=>y.year===selectedYear) || yearStats[0];
        if(!ys) return null;
        return (
          <div style={{...getCard(),border:`1px solid ${ys.year===thisYear?C.accent:C.border}`,background:ys.year===thisYear?`${C.accent}08`:C.surface}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontSize:"1.125rem",fontWeight:800,color:ys.year===thisYear?C.gold:C.text}}>{ys.year}년 연간 통계</div>
              <div style={{fontSize:"0.69rem",color:C.muted}}>{ys.weeks}주 기록</div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
              {[
                {icon:"🙏",label:"총 기도시간",value:fmtHM(ys.sec),sub:`${Math.floor(ys.sec/3600)}시간`,color:C.gold},
                {icon:"📅",label:"총 기도 일수",value:`${ys.prayD}일`,sub:"1시간↑ 달성",color:C.accent},
                {icon:"🌅",label:"하가다",value:`${ys.hagada}회`,sub:"누적 반복",color:C.blue},
                {icon:"📖",label:"통독 장수",value:`${ys.read}장`,sub:"누적",color:C.blue},
                {icon:"📜",label:"완독 횟수",value:`${ys.whole}독`,sub:"성경 전체",color:ys.whole>0?C.green:C.muted},
                {icon:"🗣️ ",label:"암송 구절 수",value:`${ys.uniqueVerses||0}절`,sub:"중복 제외",color:(ys.uniqueVerses||0)>0?C.purple:C.muted},
              ].map(s=>(
                <div key={s.label} style={{background:C.bg,borderRadius:10,padding:"11px 12px",display:"flex",alignItems:"center",gap:10}}>
                  <div style={{fontSize:"1.25rem"}}>{s.icon}</div>
                  <div>
                    <div style={{fontSize:"0.625rem",color:C.muted}}>{s.label}</div>
                    <div style={{fontSize:"1.125rem",fontWeight:800,color:s.color,marginTop:1}}>{s.value}</div>
                    <div style={{fontSize:"0.625rem",color:C.muted}}>{s.sub}</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{background:C.bg,borderRadius:10,padding:"10px 14px",display:"flex",justifyContent:"space-between"}}>
              <span style={{fontSize:"0.75rem",color:C.muted}}>주평균 기도시간</span>
              <span style={{fontSize:"0.81rem",fontWeight:700,color:C.gold}}>{ys.weeks>0?fmtHM(Math.round(ys.sec/ys.weeks)):"-"}</span>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────────
  function SettingsTab({profile,groups,scheduleRange,weekKey,bibleReading,memoryVerseGroup,easyMode,easyModeLevel,setEasyMode,themeMode,activeTheme,setThemeMode,scheduleData,onSave,onBack}) {
  const [prayerType,setPrayerType]=useState(profile.prayerType||"");
  const [group,setGroup]=useState(profile.group);
  const [name,setName]=useState(profile.name);

  // prayerType 바뀌면 조목록도 변경, 기존 조는 초기화
  const handleTypeChange = (t) => { setPrayerType(t); setGroup(""); };
  const typeGroups = scheduleData?.groupsByType?.[prayerType] || [];
  const [adminUnlocked,setAdminUnlocked]=useState(false);
  const [showPinChange,setShowPinChange]=useState(false);
  const [showPinVerify,setShowPinVerify]=useState(false);
  const [pinVerifyExpected,setPinVerifyExpected]=useState("");
  const [pinVerifyCallback,setPinVerifyCallback]=useState(null);
  const hasPin = !!getPin();
  const [pwInput,setPwInput]=useState("");
  const [pwError,setPwError]=useState(false);

  const tryUnlock=()=>{
    const hashedInput = SHA256(pwInput).toString();
    if(hashedInput === ADMIN_PW_HASH){setAdminUnlocked(true);setPwError(false);setPwInput("");}
    else{setPwError(true);setPwInput("");}
  };

  const backupToSupabase = async () => {
    const today = toDateStr(getNow());
    const limitKey = "manualSupabaseBackupLimit";
    const limit = load(limitKey, {date:today, count:0});
    const normalizedLimit = limit.date === today ? limit : {date:today, count:0};

    if ((normalizedLimit.count || 0) >= 1) {
      alert("수동 서버 백업은 하루 최대 1번까지만 가능합니다.");
      return;
    }

    try {
      await backupProfileToSupabase({...profile,prayerType,group,name});

      const nextLimit = {
        date: today,
        count: (normalizedLimit.count || 0) + 1
      };

      save(limitKey, nextLimit);
      save("lastSupabaseBackup", {
        at: new Date().toISOString(),
        reason: "manual"
      });

      alert(`서버 백업이 완료되었습니다. (오늘 ${nextLimit.count}/1회 사용)`);
    } catch (e) {
      alert("서버 백업 실패: " + (e?.message || e));
    }
  };

  const restoreFromSupabase = async () => {
    const { url, key } = getSupabaseConfig();

    if (!url || !key) {
      alert("Supabase 설정이 없습니다.");
      return;
    }

    const trimmedName = String(profile.name || "").trim();
    if (!profile.group) return alert("조를 선택해 주세요.");
    if (!trimmedName) return alert("이름을 입력해 주세요.");

    const userId = getBackupUserId({...profile, name: trimmedName});

    if (!window.confirm("서버 백업으로 현재 기록을 복원할까요?")) return;

    try {
      const res = await fetch(
        `${url}/rest/v1/prayer_backups?user_id=eq.${encodeURIComponent(userId)}&select=data,updated_at,backup_pin`,
        {
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
          },
        }
      );

      if (!res.ok) throw new Error(await res.text());

      const rows = await res.json();
      if (!rows.length) return alert("서버 백업 데이터가 없습니다.");

      const row = rows[0];
      const dbPinHash = row.backup_pin;
      const localPin = getPin();

      const doRestore = async (pinToRegister=null) => {
        if(!dbPinHash && pinToRegister) {
          const pinHash = await hashPin(pinToRegister);
          await fetch(
            `${url}/rest/v1/prayer_backups?user_id=eq.${encodeURIComponent(userId)}`,
            {
              method: "PATCH",
              headers: {
                apikey: key,
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ backup_pin: pinHash }),
            }
          );
        }
        Object.entries(row.data || {}).forEach(([k, v]) => {
          localStorage.setItem(k, v);
        });
        if(pinToRegister) localStorage.setItem("backupPin", pinToRegister);
        alert("복원 완료. 앱을 다시 불러옵니다.");
        window.location.reload();
      };

      if(dbPinHash) {
        const localPin2 = getPin();
        const localHash = localPin2 ? await hashPin(localPin2) : null;
        if(localHash === dbPinHash) {
          // 로컬=DB → 핀패드 없이 바로 복원
          await doRestore();
        } else {
          // 불일치 → 핀패드로 DB 핀 검증, 통과 시 로컬에 입력값 저장
          setPinVerifyExpected("__hash__" + dbPinHash);
          setPinVerifyCallback(()=>(enteredPin)=>{
            localStorage.setItem("backupPin", enteredPin);
            doRestore();
          });
          setShowPinVerify(true);
        }
      } else if(localPin) {
        // DB 핀 없음 + 로컬 핀 있음 → 바로 복원 + 로컬 핀 해시를 DB에 등록
        await doRestore(localPin);
      } else {
        await doRestore();
      }
    } catch (e) {
      alert("서버 복원 실패: " + e.message);
    }
  };

  const verses=memoryVerseGroup?.verses||[];

  const openManual = () => {
    window.open(`${import.meta.env.BASE_URL}user-manual.html?v=${Date.now()}`, "_self");
  };

  const fontSliderPct = ((Number(easyModeLevel) - 100) / 50) * 100;

  return (
    <div>
      {/* 핀 변경 오버레이 */}
      {showPinChange&&(
        <PinSetup
          onSave={(pin)=>{
            localStorage.setItem("backupPin", pin);
            setShowPinChange(false);
            alert("✅ 비밀번호가 변경되었습니다.");
            const { url, key } = getSupabaseConfig();
            if(url && key) {
              const userId = getBackupUserId({...profile,prayerType,group,name});
              hashPin(pin).then(pinHash => {
                fetch(`${url}/rest/v1/prayer_backups?user_id=eq.${encodeURIComponent(userId)}`, {
                  method:"PATCH",
                  headers:{apikey:key,Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
                  body:JSON.stringify({backup_pin:pinHash}),
                });
              });
            }
          }}
          onCancel={()=>setShowPinChange(false)}
        />
      )}
      {/* 핀 검증 오버레이 */}
      {showPinVerify&&(
        <PinPad
          title="비밀번호 확인"
          subtitle="복원 비밀번호를 입력해주세요"
          expectedPin={pinVerifyExpected}
          onSuccess={(enteredPin)=>{ setShowPinVerify(false); pinVerifyCallback&&pinVerifyCallback(enteredPin); }}
          onCancel={()=>setShowPinVerify(false)}
        />
      )}

      {/* ── 쉬운모드 ── */}
      <div style={{...getCard()}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div>
            <div style={{fontSize:"0.875rem",fontWeight:700,color:C.text}}>🔍 글자 크기</div>
            <div style={{fontSize:"0.69rem",color:C.muted,marginTop:3}}>슬라이더로 부드럽게 조절합니다</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:"0.81rem",fontWeight:800,color:C.accent}}>
              {getEasyModeLabel(easyModeLevel)}
            </div>
            <div style={{fontSize:"0.69rem",color:C.muted,marginTop:2}}>
              {easyModeLevel}%
            </div>
          </div>
        </div>
        <div style={{position:"relative",padding:"10px 0 8px"}}>
          <style>{`
            .font-size-slider {
              -webkit-appearance: none;
              appearance: none;
              width: 100%;
              height: 34px;
              background: transparent;
              cursor: pointer;
              touch-action: pan-y;
            }
            .font-size-slider::-webkit-slider-runnable-track {
              height: 8px;
              border-radius: 999px;
              background: linear-gradient(to right, ${C.accent} 0%, ${C.accent} ${fontSliderPct}%, ${C.border} ${fontSliderPct}%, ${C.border} 100%);
            }
            .font-size-slider::-webkit-slider-thumb {
              -webkit-appearance: none;
              appearance: none;
              width: 28px;
              height: 28px;
              border-radius: 50%;
              background: #fff;
              border: 4px solid ${C.accent};
              box-shadow: 0 3px 10px rgba(0,0,0,0.25);
              margin-top: -10px;
            }
            .font-size-slider:active::-webkit-slider-thumb {
              transform: scale(1.12);
            }
            .font-size-slider::-moz-range-track {
              height: 8px;
              border-radius: 999px;
              background: ${C.border};
            }
            .font-size-slider::-moz-range-progress {
              height: 8px;
              border-radius: 999px;
              background: ${C.accent};
            }
            .font-size-slider::-moz-range-thumb {
              width: 28px;
              height: 28px;
              border-radius: 50%;
              background: #fff;
              border: 4px solid ${C.accent};
              box-shadow: 0 3px 10px rgba(0,0,0,0.25);
            }
          `}</style>
          <input
            className="font-size-slider"
            type="range"
            min="100"
            max="150"
            step="1"
            value={easyModeLevel}
            onChange={e=>setEasyMode(e.target.value)}
            aria-label="글자 크기 조절"
          />
          <div style={{display:"flex",justifyContent:"space-between",fontSize:"0.625rem",color:C.muted,marginTop:2}}>
            <span>작게</span>
            <span>기본</span>
            <span>아주 크게</span>
          </div>
        </div>
      </div>

      {/* ── 화면 모드 ── */}
      <div style={{...getCard(),padding:14,background:`linear-gradient(135deg, ${C.surface} 0%, ${C.gradientEnd} 100%)`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,marginBottom:12}}>
          <div>
            <div style={{fontSize:"0.875rem",fontWeight:800,color:C.text}}>🎨 화면 모드</div>
            <div style={{fontSize:"0.69rem",color:C.muted,marginTop:3,lineHeight:1.5}}>
              기기 설정을 따르거나 원하는 모드를 직접 선택하세요
            </div>
          </div>
          <div style={{
            padding:"4px 8px",
            borderRadius:999,
            background:activeTheme==="dark" ? `${C.purple}22` : `${C.gold}22`,
            border:`1px solid ${activeTheme==="dark" ? C.purple : C.gold}55`,
            color:activeTheme==="dark" ? C.purple : C.gold,
            fontSize:"0.625rem",
            fontWeight:800,
            whiteSpace:"nowrap"
          }}>
            현재 {activeTheme==="dark" ? "다크" : "라이트"}
          </div>
        </div>

        <div style={{
          position:"relative",
          display:"grid",
          gridTemplateColumns:"repeat(3,1fr)",
          gap:4,
          padding:4,
          borderRadius:14,
          background:C.bg,
          border:`1px solid ${C.border}`,
          boxShadow:activeTheme==="dark" ? "inset 0 1px 8px rgba(0,0,0,0.24)" : "inset 0 1px 8px rgba(0,0,0,0.06)"
        }}>
          {[
            {value:"system", icon:"🌓", label:"시스템", desc:"기기 설정"},
            {value:"light", icon:"☀️", label:"라이트", desc:"밝은 화면"},
            {value:"dark", icon:"🌙", label:"다크", desc:"어두운 화면"},
          ].map(opt=>{
            const active = themeMode===opt.value;
            return (
              <button key={opt.value}
                onClick={()=>setThemeMode(opt.value)}
                style={{
                  border:"none",
                  borderRadius:11,
                  padding:"9px 4px 8px",
                  background:active ? `linear-gradient(135deg, ${C.accent} 0%, ${C.accentLight} 100%)` : "transparent",
                  color:active ? "#fff" : C.muted,
                  fontSize:"0.69rem",
                  fontWeight:active?900:650,
                  cursor:"pointer",
                  transition:"all 0.18s ease",
                  boxShadow:active ? "0 6px 14px rgba(0,0,0,0.18)" : "none",
                  transform:active ? "translateY(-1px)" : "translateY(0)"
                }}>
                <div style={{fontSize:"1rem",lineHeight:1,marginBottom:4}}>{opt.icon}</div>
                <div>{opt.label}</div>
                <div style={{fontSize:"0.56rem",fontWeight:500,opacity:active?0.88:0.72,marginTop:2}}>
                  {opt.desc}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── 내 정보 ── */}
      <div style={{...getCard(),padding:14,background:`linear-gradient(135deg, ${C.surface} 0%, ${C.gradientEnd} 100%)`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,marginBottom:12}}>
          <div>
            <div style={{fontSize:"0.875rem",fontWeight:800,color:C.text}}>👤 내 정보</div>
            <div style={{fontSize:"0.69rem",color:C.muted,marginTop:3,lineHeight:1.5}}>
              제출에 사용할 중보 유형, 조, 이름을 확인하세요
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4,flexShrink:0}}>
            <span style={{padding:"4px 8px",borderRadius:999,background:C.accent+"18",border:"1px solid "+C.accent+"44",color:C.accent,fontSize:"0.625rem",fontWeight:800}}>
              {prayerType || "유형 미선택"}
            </span>
            {group&&<span style={{padding:"3px 8px",borderRadius:999,background:C.bg,border:"1px solid "+C.border,color:C.muted,fontSize:"0.56rem",fontWeight:700,maxWidth:130,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{group}</span>}
          </div>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:6,marginBottom:12,padding:4,borderRadius:14,background:C.bg,border:"1px solid "+C.border}}>
          {["교회중보","목회자중보"].map(t=>{
            const active=prayerType===t;
            return (
              <button key={t} onClick={()=>handleTypeChange(t)}
                style={{border:"none",borderRadius:10,padding:"10px 4px",background:active?"linear-gradient(135deg, "+C.accent+" 0%, "+C.accentLight+" 100%)":"transparent",color:active?"#fff":C.muted,fontSize:"0.75rem",fontWeight:active?900:650,cursor:"pointer",transition:"all 0.18s ease",boxShadow:active?"0 6px 14px rgba(0,0,0,0.16)":"none"}}>
                {t}
              </button>
            );
          })}
        </div>

        <div style={{padding:12,borderRadius:14,background:activeTheme==="dark"?"rgba(13,17,23,0.72)":"rgba(255,255,255,0.72)",border:"1px solid "+C.border,marginBottom:12}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr",gap:10}}>
            <div>
              <div style={{fontSize:"0.69rem",color:C.muted,marginBottom:6,fontWeight:700}}>조 선택</div>
              <select style={{...getInp(),borderRadius:10,background:C.bg}} value={group} onChange={e=>setGroup(e.target.value)}>
                <option value="">조를 선택하세요</option>
                {typeGroups.map(g=><option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <div style={{fontSize:"0.69rem",color:C.muted,marginBottom:6,fontWeight:700}}>이름</div>
              <input style={{...getInp(),borderRadius:10,background:C.bg}} value={name} onChange={e=>setName(e.target.value)} placeholder="이름을 입력하세요" />
            </div>
          </div>
        </div>

        <button
          style={{...btn("primary"),width:"100%",padding:"11px 0",fontSize:"0.81rem",fontWeight:800,borderRadius:10}}
          onClick={()=>{
            if(!group){
              alert("조를 선택해 주세요.");
              return;
            }

            const trimmedName = name.trim();

            if(!trimmedName){
              alert("이름을 입력해 주세요.");
              return;
            }

            onSave({...profile,prayerType,group,name:trimmedName});
          }}
        >
          변경사항 저장
        </button>
      </div>

      {/* ── 데이터 내보내기 / 가져오기 ── */}
      <div style={{...getCard(),padding:14,background:`linear-gradient(135deg, ${C.surface} 0%, ${C.gradientEndBlue} 100%)`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,marginBottom:12}}>
          <div>
            <div style={{fontSize:"0.875rem",fontWeight:800,color:C.text}}>💾 데이터 백업 / 복원</div>
          </div>
          <div style={{padding:"4px 8px",borderRadius:999,background:C.blue+"18",border:"1px solid "+C.blue+"44",color:C.blue,fontSize:"0.625rem",fontWeight:800,whiteSpace:"nowrap"}}>
            안전보관
          </div>
        </div>

        {/* 비밀번호 설정 */}
        <div style={{background:C.bg,border:`1px solid ${hasPin?C.green:C.accent}44`,borderRadius:10,padding:"10px 12px",marginBottom:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:"0.81rem",fontWeight:700,color:hasPin?C.green:C.accent}}>
                🔐 복원 비밀번호
              </div>
              <div style={{fontSize:"0.625rem",color:C.muted,marginTop:2}}>
                {hasPin?"설정됨 — 백업 복원 시 필요합니다":"미설정 — 복원 시 비밀번호 없이 진행됩니다"}
              </div>
            </div>
            <button
              style={{...btn("ghost"),padding:"6px 14px",fontSize:"0.75rem",color:hasPin?C.muted:C.accent,border:`1px solid ${hasPin?C.border:C.accent}55`,whiteSpace:"nowrap"}}
              onClick={async ()=>{
                if(hasPin){
                  // 서버 비번 조회 후 검증
                  const { url, key } = getSupabaseConfig();
                  const userId = getBackupUserId({...profile,prayerType,group,name});
                  let dbPinHash = null;
                  try {
                    if(url && key && userId) {
                      const res = await fetch(`${url}/rest/v1/prayer_backups?user_id=eq.${encodeURIComponent(userId)}&select=backup_pin`,
                        { headers:{ apikey:key, Authorization:`Bearer ${key}` } });
                      const rows = await res.json();
                      dbPinHash = rows?.[0]?.backup_pin || null;
                    }
                  } catch {}
                  // 서버 비번 있으면 해시 비교, 없으면 로컬 비번으로 검증
                  if(dbPinHash) {
                    setPinVerifyExpected("__hash__" + dbPinHash);
                  } else {
                    setPinVerifyExpected(getPin() || "");
                  }
                  setPinVerifyCallback(()=>()=>setShowPinChange(true));
                  setShowPinVerify(true);
                } else {
                  setShowPinChange(true);
                }
              }}>
              {hasPin?"변경":"설정"}
            </button>
          </div>
        </div>
        
        <div style={{height:1,background:C.border,margin:"12px 0"}} />
          <div style={{fontSize:"0.69rem",color:C.muted,marginBottom:8,lineHeight:1.6}}>
            현재 기기의 기록을 서버에 저장하고, 앱이 초기화되었을 때 다시 복원할 수 있게 합니다.
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <button
              style={{...btn("ghost"),padding:"10px 0",fontSize:"0.75rem",color:C.blue,border:`1px solid ${C.blue}55`}}
              onClick={backupToSupabase}
            >
              ☁️ 서버 백업
            </button>

            <button
              style={{...btn("ghost"),padding:"10px 0",fontSize:"0.75rem",color:C.purple,border:`1px solid ${C.purple}55`}}
              onClick={restoreFromSupabase}
            >
              ⬇️ 서버 복원
            </button>
          </div>

      </div>

      {/* ── 정보 & 지원 ── */}
      <div style={{...getCard(),border:`1px solid ${C.border}`}}>
        <div style={{fontWeight:700,fontSize:"0.81rem",color:C.text,marginBottom:10}}>ℹ️ 정보 & 지원</div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          <button style={{...btn("ghost"),width:"100%",padding:10,fontSize:"0.75rem",justifyContent:"flex-start",textAlign:"left",borderBottom:`1px solid ${C.border}`}}
            onClick={()=>{ window.location.href = `${import.meta.env.BASE_URL}privacy-ko.html`; }}>
            📋 개인정보 처리방침 (한국어)
          </button>
          <button style={{...btn("ghost"),width:"100%",padding:10,fontSize:"0.75rem",justifyContent:"flex-start",textAlign:"left",borderBottom:`1px solid ${C.border}`}}
            onClick={()=>{ window.location.href = `${import.meta.env.BASE_URL}privacy-policy.html`; }}>
            📋 Privacy Policy (English)
          </button>
          <button style={{...btn("ghost"),width:"100%",padding:10,fontSize:"0.75rem",justifyContent:"flex-start",textAlign:"left"}}
            onClick={()=>{
              const email = 'parkks.joyful@gmail.com';
              window.location.href = `mailto:${email}?subject=기쁨의 중보기도 - 문의`;
            }}>
            ✉️ 문의하기 (parkks.joyful@gmail.com)
          </button>
        </div>
      </div>

      {/* ── 앱 초기화 ── */}
      <div style={{...getCard(),border:`1px solid ${C.red}44`}}>
        <div style={{fontWeight:700,fontSize:"0.81rem",color:C.red,marginBottom:4}}>⚠️ 앱 초기화</div>
        <div style={{fontSize:"0.69rem",color:C.muted,marginBottom:10,lineHeight:1.6}}>
          모든 기도 기록, 설정, 프로필을 삭제하고 초기 설치 상태로 되돌립니다.<br/>
          <strong style={{color:C.red}}>이 작업은 되돌릴 수 없습니다.</strong>
        </div>
        <button style={{...btn("danger"),width:"100%",padding:10,fontSize:"0.81rem"}}
          onClick={()=>{
            if(!window.confirm("⚠️ 모든 기도 기록과 설정이 삭제됩니다.\n정말 초기화하시겠습니까?")) return;
            if(!window.confirm("마지막 확인입니다.\n삭제된 데이터는 복구할 수 없습니다.\n계속하시겠습니까?")) return;
            localStorage.clear();
            window.location.reload();
          }}>
          🗑️ 앱 초기화 (모든 데이터 삭제)
        </button>
      </div>

      {/* ── 관리자: 구글 폼 Prefill URL ── */}
      <div style={{...getCard(),border:`1px solid ${adminUnlocked?C.accent:C.border}44`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:adminUnlocked?14:0}}>
          <div>
            <label style={{...getLbl(),marginBottom:0}}>🔒 관리자 기능</label>
          </div>
          {adminUnlocked&&<button style={{...btn("ghost"),padding:"4px 10px",fontSize:"0.69rem",color:C.red,border:`1px solid ${C.red}44`}} onClick={()=>setAdminUnlocked(false)}>잠금</button>}
        </div>

        {!adminUnlocked&&(
          <div style={{marginTop:12}}>
            <div style={{display:"flex",gap:8}}>
              <input style={{...getInp(),flex:1,letterSpacing:4}} type="password" placeholder="관리자 비밀번호"
                value={pwInput} onChange={e=>{setPwInput(e.target.value);setPwError(false);}} onKeyDown={e=>e.key==="Enter"&&tryUnlock()}/>
              <button style={{...btn("primary"),whiteSpace:"nowrap"}} onClick={tryUnlock}>확인</button>
            </div>
            {pwError&&<div style={{fontSize:"0.69rem",color:C.red,marginTop:6}}>비밀번호가 올바르지 않습니다</div>}
          </div>
        )}

        {adminUnlocked&&(
          <div>
            {/* 🗓 테스트 날짜 */}
            <div style={{background:C.bg,border:`1px solid ${C.red}44`,borderRadius:10,padding:"12px 14px",marginBottom:14}}>
              <div style={{fontSize:"0.75rem",fontWeight:700,color:C.red,marginBottom:6}}>🗓 테스트 날짜</div>
              <div style={{fontSize:"0.69rem",color:C.muted,marginBottom:10,lineHeight:1.6}}>
                오늘 날짜를 직접 지정합니다. 저장 후 자동 새로고침됩니다.<br/>
                선택한 날짜가 테스트용 현재 날짜로 사용됩니다.
              </div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <input type="date" id="test-date-input"
                  defaultValue={localStorage.getItem("__testDate")||toDateStr(new Date())}
                  style={{...getInp(),flex:1,minWidth:0,padding:"6px 6px",fontSize:"0.75rem"}}
                />
                <button style={{...btn("primary"),padding:"7px 12px",fontSize:"0.75rem",flexShrink:0}}
                  onClick={()=>{
                    const v=document.getElementById("test-date-input").value;
                    if(v) {
                      localStorage.setItem("__testDate", v);
                      localStorage.removeItem("__testDateOffset");
                    } else {
                      localStorage.removeItem("__testDate");
                    }
                    window.location.reload();
                  }}>적용</button>
                <button style={{...btn("ghost"),padding:"7px 10px",fontSize:"0.75rem",color:C.red,border:`1px solid ${C.red}44`,flexShrink:0}}
                  onClick={()=>{localStorage.removeItem("__testDate");localStorage.removeItem("__testDateOffset");window.location.reload();}}>초기화</button>
              </div>
              {localStorage.getItem("__testDate")&&(
                <div style={{marginTop:8,fontSize:"0.69rem",fontWeight:700,color:C.red}}>
                  ⚠️ 테스트 날짜 지정 중: {toDateStr(getNow())}
                </div>
              )}
            </div>
            {/* 현재 앱 내장 데이터 미리보기 */}
            <div style={{marginTop:14,height:1,background:C.border}}/>
            <div style={{marginTop:14,background:C.bg,borderRadius:8,padding:"10px 12px",border:`1px solid ${C.border}`}}>
              <div style={{fontSize:"0.69rem",color:C.accent,fontWeight:700,marginBottom:8}}>📌 앱 내장 데이터 현황</div>
              <div style={{fontSize:"0.69rem",color:C.text,marginBottom:4}}>
                <span style={{color:C.accent,fontWeight:700}}>조목록 </span>
                목회자중보 {scheduleData?.groupsByType?.["목회자중보"]?.length||0}개 / 교회중보 {scheduleData?.groupsByType?.["교회중보"]?.length||0}개
              </div>
              {bibleReading.length>0&&(
                <div style={{fontSize:"0.69rem",color:C.text,marginBottom:4}}>
                  <span style={{color:C.blue,fontWeight:700}}>이번 주 통독 </span>{bibleReading.map(s=>`${s.book} ${s.chapters[0]}~${s.chapters.at(-1)}장`).join(", ")}
                </div>
              )}
              {verses.length>0&&(
                <div style={{fontSize:"0.69rem",color:C.text,marginBottom:4}}>
                  <span style={{color:C.purple,fontWeight:700}}>암송 대상 ({verses.length}절) </span>{verses.map(v=>v.reference).join(", ")}
                </div>
              )}
              {scheduleRange&&<div style={{fontSize:"0.625rem",color:C.muted}}>전체 기간: {scheduleRange}</div>}
              <div style={{fontSize:"0.625rem",color:C.muted,marginTop:8,lineHeight:1.6}}>
                schedule.json 파일만 수정하면 재배포 없이 즉시 반영됩니다.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const playAlarm = async () => {
  try {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }

    const ctx = audioCtxRef.current;

    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    const playBeep = (freq, start, dur) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.frequency.value = freq;
      osc.type = "sine";

      gain.gain.setValueAtTime(0.001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.6, ctx.currentTime + start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);

      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur);
    };

    playBeep(880, 0.0, 0.5);
    playBeep(1100, 0.6, 0.5);
    playBeep(880, 1.2, 0.8);
  } catch (e) {
  }
};
