// Capacitor 네이티브 환경 감지
export const isNativeApp = () => {
  return typeof window !== "undefined" &&
    (window.Capacitor?.isNativePlatform?.() ||
     window.Capacitor?.platform === "ios" ||
     window.Capacitor?.platform === "android");
};

export async function haptic(style = "light") {
  if(!isNativeApp()) return;
  try {
    const H = window.Capacitor?.Plugins?.Haptics;
    if(!H) return;
    const styleMap = { light:"LIGHT", medium:"MEDIUM", heavy:"HEAVY" };
    await H.impact({ style: styleMap[style] || "LIGHT" });
  } catch {}
}

// 날짜 문자열 → 로컬 Date (UTC 파싱 방지)
export function parseDate(str) {
  const [y,m,d] = str.split("-").map(Number);
  return new Date(y, m-1, d);
}

// 로컬 날짜를 YYYY-MM-DD 문자열로 변환 (UTC 변환 없이)
export function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

// 테스트용 날짜 지정 또는 오프셋으로 현재 날짜 반환
export function getNow() {
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

export function getWeekKey(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay(); // 0=일, 1=월, 2=화~6=토
  const diff = day < 2 ? day + 5 : day - 2; // 해당 주 화요일까지의 거리
  d.setDate(d.getDate() - diff);
  return toDateStr(d);
}

export function getSubmitDate(wk) {
  const d = parseDate(wk);
  d.setDate(d.getDate() + 7);
  return toDateStr(d);
}

export function getPrevWeekKey(wk) {
  const d = parseDate(wk);
  d.setDate(d.getDate() - 7);
  return toDateStr(d);
}

export function getYearFromWeekKey(wk) {
  return String(parseDate(wk).getFullYear());
}

export function isWeekKeyInYear(key, year) {
  return key.startsWith(`week_${year}-`);
}

export const fmtTime = (sec) => `${String(Math.floor(sec/3600)).padStart(2,"0")}:${String(Math.floor((sec%3600)/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`;
export const fmtHM = (sec) => { const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60); return h>0&&m>0?`${h}시간 ${m}분`:h>0?`${h}시간`:`${m}분`; };
export const WEEK_DAYS = ["화","수","목","금","토","일","월"];

export function getWeekDates(wk) {
  return Array.from({length:7}, (_,i) => {
    const d = parseDate(wk);
    d.setDate(d.getDate() + i);
    return d;
  });
}

export const load = (k,d) => { try { return JSON.parse(localStorage.getItem(k))??d; } catch { return d; } };
export const save = (k,v) => localStorage.setItem(k, JSON.stringify(v));

// ── 그룹 데이터 헬퍼 ────────────────────────────────────────────────────────
// groupsByType 항목이 객체 배열이면 display 사용, 문자열이면 그대로 사용 (하위호환)
export function getGroupDisplay(g) {
  return typeof g === "object" ? g.display : g;
}
export function getGroupTeamName(g) {
  return typeof g === "object" ? g.teamName : g;
}
export function getGroupLeader(g) {
  return typeof g === "object" ? (g.leader || "") : "";
}
export function findGroupByDisplay(groups, display) {
  return groups.find(g => getGroupDisplay(g) === display) || null;
}

export function filterByDate(list, wk) {
  return (Array.isArray(list)?list:[]).filter(r=>r.startDate<=wk && r.endDate>=wk);
}

export function filterByRange(list, startDate, endDate) {
  return (Array.isArray(list)?list:[]).filter(r => r.startDate <= endDate && r.endDate >= startDate);
}

// ─── schedule.json 원격+내장 로딩 유틸 ──────────────────────────────────────
const REMOTE_SCHEDULE_URL = import.meta.env.VITE_REMOTE_SCHEDULE_URL;

export async function loadScheduleJson() {
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
