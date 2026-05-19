import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import * as adminAuth from './api/adminAuth.js';
import {
  isNativeApp, haptic, getNow, toDateStr, parseDate, getWeekKey, getSubmitDate,
  getYearFromWeekKey, fmtHM, WEEK_DAYS, getWeekDates, load, save, loadScheduleJson,
  getGroupDisplay, getGroupLeader, getGroupTeamName, findGroupByDisplay, filterByDate,
} from './lib/utils.js';
import {
  setScheduleDataRef, getFirebaseTargetConfig,
  getPastorPrayerWeekNumber, normalizeTeamNumber, buildFirebaseSafeMemberName,
  getAttendanceStatusForFirebase, buildFirebaseChurchStatusString,
  calcFirebaseScoreStatus, calcFirebaseMemoryScore, submitPastorPrayerToFirebase,
  PRAYER_NOTIF_ID, scheduleTimerNotification, cancelTimerNotification,
  registerNotificationActions, fetchFirebaseTeamsConfig,
  convertTeamsConfigToGroup,
  fetchFirebaseSubmissionForDisplay,
  saveFirebaseRosterCache, loadFirebaseRosterCache, getCachedOrScheduleGroups,
  mergeFirebaseGroupsWithSchedule,
  withTimeout,
} from './lib/firebase.js';
import {
  exportLocalBackup, importLocalBackup,
} from './lib/storage.js';
import {
  getDayEff, calcWeekPrayerStats,
  getEasyTotalPrayerSecWithDelta, uniqueVerses, getMemoryVersesForWeek,
  applyBonusAdd, applyBonusRemove,
} from './lib/prayer.js';
import ConfirmModal from './components/common/ConfirmModal.jsx';
import {
  HourMinutePicker,
  EasyHourPicker,
  EasyPrayerDaysPicker,
} from './components/common/TimePickers.jsx';

// 항목 해제 확인 (앱 내 모달 사용)
let _setConfirmDialog = null;
function registerConfirmSetter(fn) { _setConfirmDialog = fn; }

function confirmUncheck(label) {
  if(!_setConfirmDialog) return Promise.resolve(window.confirm(`"${label}"을(를) 미완료로 변경하시겠습니까?`));
  return new Promise(resolve => {
    _setConfirmDialog({ label, resolve });
  });
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

function getReadingKey(book, chapter) {
  return `${book}_${chapter}`;
}

function buildBibleReadingSections(scheduleReading, weekKey) {
  const weekReadingSections = filterByDate(scheduleReading, weekKey);
  return Object.values(weekReadingSections.reduce((acc,r)=>{
    if(!acc[r.book]) acc[r.book]={book:r.book,chapters:[]};
    acc[r.book].chapters=[...new Set([...acc[r.book].chapters,...r.chapters])].sort((a,b)=>a-b);
    return acc;
  },{}));
}

function getBibleReadingKeys(bibleReading) {
  return (Array.isArray(bibleReading) ? bibleReading : [])
    .flatMap(section => (section?.chapters || []).map(ch => getReadingKey(section.book, ch)));
}

function countCheckedBibleReading(readingChecked, bibleReading) {
  return getBibleReadingKeys(bibleReading)
    .filter(key => !!readingChecked?.[key])
    .length;
}

function getMemoryDisplayStatus(memoryDone, memoryErrors) {
  if (!memoryDone) return { label: "미완료", completed: false, partial: false };
  const errors = Number(memoryErrors || 0);
  if (errors === 0) return { label: "완료", completed: true, partial: false };
  if (errors <= 3) return { label: "1~3글자 틀림", completed: true, partial: true };
  return { label: "미완료", completed: false, partial: false };
}

function getAttendancePrayerBonusSec(weekData) {
  const key = weekData?.attendancePrayerBonus;
  if (!key) return 0;
  return Math.min(3600, Math.max(0, Number(weekData.bonusSeconds?.[key]) || 0));
}

function removeAttendancePrayerBonus(weekData) {
  const key = weekData?.attendancePrayerBonus;
  if (!key) return { data:weekData, changed:false };

  const bonusSeconds = weekData.bonusSeconds || {};
  const currentBonus = Math.max(0, Number(bonusSeconds[key]) || 0);
  const removedSec = getAttendancePrayerBonusSec(weekData);
  const next = {
    ...weekData,
    attendancePrayerBonus: "",
  };

  if (removedSec > 0) {
    next.bonusSeconds = {
      ...bonusSeconds,
      [key]: Math.max(0, currentBonus - removedSec),
    };

    if (weekData.easyTotalPrayerSec !== undefined && weekData.easyTotalPrayerSec !== null) {
      next.easyTotalPrayerSec = Math.max(0, Number(weekData.easyTotalPrayerSec) - removedSec);
    }
    if (weekData.submitTotalPrayerSec !== undefined && weekData.submitTotalPrayerSec !== null) {
      next.submitTotalPrayerSec = Math.max(0, Number(weekData.submitTotalPrayerSec) - removedSec);
    }
  }

  return { data:next, changed:true };
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
const btn = (v="primary") => ({
  background:v==="primary"?C.accent:v==="danger"?C.red:v==="green"?C.green:"transparent",
  color:v==="ghost"?C.muted:"#fff",
  border:v==="ghost"?`1px solid ${C.border}`:"none",
  borderRadius:8, padding:"9px 16px", fontSize:"0.81rem", fontWeight:600, cursor:"pointer",
});
const getCompletionChoiceWrap = () => ({
  display:"grid",
  gridTemplateColumns:"repeat(2, minmax(58px, 1fr))",
  gap:4,
  padding:3,
  borderRadius:10,
  border:`1px solid ${C.border}`,
  background:C.bg,
  flexShrink:0,
  boxSizing:"border-box",
});

const getCompletionChoiceButton = (selected, color, tone="complete") => {
  const activeColor = tone === "complete" ? color : C.muted;
  const activeBg = tone === "complete" ? `${color}30` : `${C.muted}18`;
  const idleBg = tone === "complete" ? `${color}08` : C.surface;
  const idleBorder = tone === "complete" ? `${color}24` : C.border;
  return ({
  minWidth:58,
  height:30,
  borderRadius:7,
  border:`1px solid ${selected ? activeColor : idleBorder}`,
  background:selected ? activeBg : idleBg,
  color:selected ? activeColor : C.muted,
  cursor:"pointer",
  padding:"0 8px",
  fontSize:selected && tone === "complete" ? "0.75rem" : "0.72rem",
  fontWeight:selected && tone === "complete" ? 950 : 900,
  lineHeight:1,
  whiteSpace:"nowrap",
  opacity:selected ? 1 : 0.72,
  boxShadow:selected
    ? `0 0 0 1px ${activeColor}22 inset, 0 3px 8px ${activeColor}18`
    : "none",
  touchAction:"manipulation",
  transition:"background 0.18s ease, border-color 0.18s ease, color 0.18s ease, opacity 0.18s ease",
});
};

function CompletionChoice({ done, color, onSelect, completeLabel="완료", incompleteLabel="미완료", ariaLabel }) {
  return (
    <div style={getCompletionChoiceWrap()} role="group" aria-label={ariaLabel || "완료 상태 선택"}>
      <button
        type="button"
        onClick={() => onSelect(true)}
        aria-pressed={done}
        style={getCompletionChoiceButton(done, color, "complete")}
      >
        {completeLabel}
      </button>
      <button
        type="button"
        onClick={() => onSelect(false)}
        aria-pressed={!done}
        style={getCompletionChoiceButton(!done, color, "incomplete")}
      >
        {incompleteLabel}
      </button>
    </div>
  );
}

function getProfileTeamName(profile, scheduleData) {
  if (profile?.groupTeamName) return profile.groupTeamName;

  const rosterGroups = loadFirebaseRosterCache(profile?.prayerType)?.groups || [];
  const scheduleGroups = scheduleData?.groupsByType?.[profile?.prayerType] || [];
  const selectedGroup = findGroupByDisplay([...rosterGroups, ...scheduleGroups], profile?.group);

  return getGroupTeamName(selectedGroup) || profile?.group || "";
}

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
  const [fbQueryResult,setFbQueryResult] = useState(null); // 전역 Firebase 조회 결과 팝업
  const [profile,setProfile] = useState(()=>load("profile",{group:"",name:"",prayerType:"",setupDone:false}));
  const [privacyAgreed,setPrivacyAgreed] = useState(()=>load("privacyAgreed",false));
  const [easyModeLevel,setEasyModeLevel] = useState(()=>load("easyModeLevel", "125"));
  const [easyMode,setEasyModeFlag] = useState(()=>load("easyMode", false));
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
    // 글자 크기만 변경한다. 쉬운모드 ON/OFF와는 분리한다.
    setEasyModeLevel(level);
    save("easyModeLevel", level);
  };

  const submitWeekKeyRef = useRef(null);

  const setEasyModeEnabled = (enabled) => {
    const next = !!enabled;
    const nextLevel = next ? "150" : "125";

    try {
      const targetWk = submitWeekKeyRef.current || getWeekKey(getNow());
      const dates = getWeekDates(targetWk);
      // 항상 localStorage에서 직접 로드 (tab 무관하게 올바른 주차 데이터 사용)
      const targetWeekData = load(`week_${targetWk}`, {dailySeconds:{},easyTotalPrayerSec:undefined,easyPrayDays:undefined});
      const currentStats = calcWeekPrayerStats(targetWeekData, dates);

      if(isSubmitActive) {
        const currentTotalPrayerSec = easyMode
          ? targetWeekData.easyTotalPrayerSec !== undefined && targetWeekData.easyTotalPrayerSec !== null
            ? Math.max(0, Number(targetWeekData.easyTotalPrayerSec)||0)
            : currentStats.totalSec
          : targetWeekData.submitTotalPrayerSec !== undefined && targetWeekData.submitTotalPrayerSec !== null
            ? Math.max(0, Number(targetWeekData.submitTotalPrayerSec)||0)
            : currentStats.totalSec;
        const currentPrayDays = easyMode
          ? targetWeekData.easyPrayDays !== undefined && targetWeekData.easyPrayDays !== null
            ? Math.max(0, Math.min(6, Number(targetWeekData.easyPrayDays)||0))
            : currentStats.prayDays
          : targetWeekData.submitPrayDays !== undefined && targetWeekData.submitPrayDays !== null
            ? Math.max(0, Math.min(6, Number(targetWeekData.submitPrayDays)||0))
            : currentStats.prayDays;
        const converted = {
          ...targetWeekData,
          ...(next
            ? {
                easyTotalPrayerSec: currentTotalPrayerSec,
                easyPrayDays: currentPrayDays,
              }
            : {
                submitTotalPrayerSec: currentTotalPrayerSec,
                submitPrayDays: currentPrayDays,
              }),
        };
        if(targetWk === weekKey) setWeekDataForKey(targetWk, converted);
        save(`week_${targetWk}`, converted);
      }
    } catch(e) {
      console.log("쉬운모드 전환 변환 실패", e);
    }

    setEasyModeFlag(next);
    setEasyModeLevel(nextLevel);
    save("easyMode", next);
    save("easyModeLevel", nextLevel);
  };

  // 쉬운모드에서는 제출탭과 설정탭만 노출되므로,
  // 새로고침/복원 후 다른 탭에 머물러 빈 화면이 나오지 않게 보정한다.
  useEffect(()=>{
    if(easyMode && tab !== "home" && tab !== "settings" && tab !== "admin") {
      setTab("home");
    }
  },[easyMode, tab]);

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

  useEffect(()=>{
    if(scheduleData) {
      setScheduleDataRef(scheduleData);
      adminAuth.setUsersConfig(scheduleData?.firebase?.users);
    }
  },[scheduleData]);


  // 기도 타이머 state - 탭 전환 시에도 유지
  const [timerRunning,setTimerRunning] = useState(false);
  const [timerElapsed,setTimerElapsed] = useState(0);
  const [timerMode,setTimerMode] = useState("stopwatch");
  const [timerTarget,setTimerTarget] = useState(3600);
  const [timerActiveDay,setTimerActiveDay] = useState("");
  const [timerAlarming,setTimerAlarming] = useState(false);
  const [confirmDialog,setConfirmDialog] = useState(null);

  // 타이머 ref - App 레벨에서 관리해야 탭 전환 시 유지
  const timerStartTsRef = useRef(null);
  const timerBaseElapsedRef = useRef(0);
  const timerIntervalRef = useRef(null);
  const timerAutoSavedElapsedRef = useRef(0); // 분 단위 자동 저장 기준 elapsed
  const timerAlarmPlayedRef = useRef(false);  // 타이머 완료 알람 중복 방지
  const timerCompletedRef = useRef(false);    // 타이머 완료 중복 처리 방지
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
        adminAuth.setUsersConfig(data?.firebase?.users);
        save("scheduleCache", data); // 오프라인 대비 캐시
        setScheduleError(null);
      })
      .catch(e=>{
        setScheduleError(e.message);
        // 캐시된 데이터로 폴백 - Firebase 설정도 캐시에서 등록
        const cached = load("scheduleCache", null);
        if(cached) { setScheduleDataRef(cached); adminAuth.setUsersConfig(cached?.firebase?.users); }
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
    document.documentElement.style.colorScheme = activeTheme;
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
      if(timerCompletedRef.current) return;
      timerCompletedRef.current = true;
      setTimerRunning(false);
      setTimerElapsed(timerTarget);

      const activeDay = timerActiveDay || toDateStr(getNow());
      const weekKey_ = getWeekKey(new Date(activeDay));
      const wd = load(`week_${weekKey_}`, {dailySeconds:{}});
      const cur = wd.dailySeconds?.[activeDay]||0;
      // 자동 저장된 분량을 제외한 나머지만 추가 (중복 저장 방지)
      const remaining = timerTarget - timerAutoSavedElapsedRef.current;
      if(remaining > 0){
        save(`week_${weekKey_}`, {
          ...wd,
          dailySeconds:{ ...wd.dailySeconds, [activeDay]: cur + remaining }
        });
      }

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

  useEffect(()=>{ registerConfirmSetter(setConfirmDialog); },[]);

  // running 변경 시 interval 관리
  useEffect(()=>{
    if(timerRunning){
      timerAlarmPlayedRef.current = false;
      timerCompletedRef.current = false;
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

  // AudioContext 언마운트 시 정리
  useEffect(()=>{
    return ()=>{
      if(audioCtxRef.current && audioCtxRef.current.state !== "closed"){
        audioCtxRef.current.close().catch(()=>{});
      }
    };
  },[]);

  // timerActiveDay 변경 시 자동 저장 기준 elapsed 초기화 (시간 누수 방지)
  useEffect(()=>{
    if(timerRunning){
      timerAutoSavedElapsedRef.current = Math.floor(timerElapsed / 60) * 60;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[timerActiveDay]);

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

  const groups = [];
  const scheduleReading = scheduleData?.reading || [];
  const scheduleVerse   = scheduleData?.verses || [];

  const thisWeekKey = getWeekKey(getNow());
  const prevWeekKey = useMemo(()=>{ const d=new Date(thisWeekKey); d.setDate(d.getDate()-7); return toDateStr(d); },[thisWeekKey]);
  const [selectedWeekKey,setSelectedWeekKey] = useState(thisWeekKey);

  const todayDow = getNow().getDay();
  const todayStr2 = toDateStr(getNow());
  const _prevWeekData = load(`week_${prevWeekKey}`, {submitted:false, submittedDate:""});
  const _submitted = _prevWeekData.submitted;
  const _submittedToday = _submitted && _prevWeekData.submittedDate === todayStr2;
  const prevSubmittedBeforeToday = _submitted && _prevWeekData.submittedDate && _prevWeekData.submittedDate < todayStr2;
  const isSubmitWindow = todayDow >= 2 && todayDow <= 4;          // 화~목: 지난 주 제출 기간
  const isSubmitActive = isSubmitWindow && !prevSubmittedBeforeToday
    && (!_submitted || _submittedToday);                         // 미제출 또는 당일 제출분 재제출 허용
  // 제출 탭 노출 주차:
  // - 이전 제출이 오늘 이전에 완료됨: thisWeekKey (차주 제출 대상 미리보기)
  // - 화~목 제출 기간 중 미제출/당일 제출: prevWeekKey (지난 주 제출/재제출)
  // - 금~월 또는 제출 기간 이후: thisWeekKey (차주 제출 대상 미리보기)
  const submitWeekKey = prevSubmittedBeforeToday
    ? thisWeekKey
    : isSubmitWindow
      ? prevWeekKey
      : thisWeekKey;
  submitWeekKeyRef.current = submitWeekKey;
  const weekKey = tab === "home" ? submitWeekKey : thisWeekKey;
  const submitDate = getSubmitDate(weekKey);
  const weekDates = getWeekDates(weekKey);
  const weekEnd = toDateStr(weekDates[6]);

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

  const bibleReading = buildBibleReadingSections(scheduleReading, weekKey);
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

  const getDefaultWeekData = () => ({
    dailySeconds:{},readingChecked:{},wholeReadingDone:false,
    memoryDone:false,memoryErrors:0,spiritNotes:"",
    attendance:null,attendReason:"",attendLateTime:"",
    churchLate:false,churchLeave:false,churchLateTime:"",churchLateReason:"",churchLeaveTime:"",churchLeaveReason:"",
    prayerFile:false,submitted:false,dawnService:{},fridayService:false,
  });
  const loadWeekData = (wk) => removeAttendancePrayerBonus(load(`week_${wk}`, getDefaultWeekData())).data;
  const [weekDataState,setWeekDataState] = useState(()=>({ weekKey, data:loadWeekData(weekKey) }));
  const weekData = weekDataState.weekKey === weekKey ? weekDataState.data : loadWeekData(weekKey);
  const setWeekDataForKey = (wk, data) => setWeekDataState({ weekKey:wk, data });
  const setWeekData = (data) => setWeekDataForKey(weekKey, data);

  useEffect(()=>{
    const rawWeekData = load(`week_${weekKey}`, getDefaultWeekData());
    const { data, changed } = removeAttendancePrayerBonus(rawWeekData);
    if (changed) save(`week_${weekKey}`, data);
    setWeekDataForKey(weekKey, data);
  },[weekKey]);

  const handleFbQuery = async (docId, prayerType) => {
    try {
      const result = await fetchFirebaseSubmissionForDisplay(docId, prayerType);
      if(!result){ alert(`❌ 제출 기록이 없습니다.\ndocId: ${docId}`); return; }
      setFbQueryResult({ docId, fields: result.fields, prayerType });
    } catch(e){ alert(`조회 실패: ${e.message}`); }
  };

  // ── 관리자 인증 상태 ──────────────────────────────────────────
  const [adminUnlocked,setAdminUnlocked]=useState(()=>adminAuth.isAdmin());
  const [adminShowAuth,setAdminShowAuth]=useState(false);
  useEffect(()=>{
    document.body.style.overflow=adminShowAuth?"hidden":"";
    return()=>{document.body.style.overflow="";};
  },[adminShowAuth]);
  const [adminStep,setAdminStep]=useState(()=>adminAuth.isPinRegistered()?'pin':'identity');
  const [adminPinRegistered,setAdminPinRegistered]=useState(()=>adminAuth.isPinRegistered());
  const [adminVerifyToken,setAdminVerifyToken]=useState('');
  const [adminPassword,setAdminPassword]=useState('');
  const [adminPinInput,setAdminPinInput]=useState('');
  const [adminPinConfirm,setAdminPinConfirm]=useState('');
  const [adminPinPhase,setAdminPinPhase]=useState('enter');
  const [adminError,setAdminError]=useState('');
  const [adminLoading,setAdminLoading]=useState(false);

  const resetAdminState=(forcePinStep=false)=>{
    const pinReg=forcePinStep?false:adminAuth.isPinRegistered();
    setAdminStep(pinReg?'pin':'identity');
    setAdminPinRegistered(pinReg);
    setAdminPassword('');
    setAdminPinInput(''); setAdminPinConfirm(''); setAdminPinPhase('enter'); setAdminError('');
  };

  const isAdminTab = tab === "admin" && adminUnlocked;
  const handleAdminLock = () => { adminAuth.clearSession(); setAdminUnlocked(false); resetAdminState(); setTab("settings"); };

  const handleAdminVerifyUser=async()=>{
    if(!adminPassword){setAdminError('비밀번호를 입력해주세요.');return;}
    setAdminLoading(true); setAdminError('');
    try{
      const data=await adminAuth.verifyUser(profile.prayerType,normalizeTeamNumber(profile.groupTeamName),profile.name,adminPassword);
      setAdminVerifyToken(data.verifyToken);
      setAdminPinRegistered(data.pinRegistered);
      setAdminPinInput(''); setAdminPinConfirm(''); setAdminPinPhase('enter');
      setAdminStep('pin');
    }catch(err){setAdminError(err.message);}
    finally{setAdminLoading(false);}
  };

  const handlePinKey=useCallback(async(key)=>{
    const phase=adminPinPhase;
    const cur=phase==='enter'?adminPinInput:adminPinConfirm;
    const set=phase==='enter'?setAdminPinInput:setAdminPinConfirm;
    if(key==='back'){set(p=>p.slice(0,-1));return;}
    if(cur.length>=4) return;
    const next=cur+key;
    set(next);
    if(next.length<4) return;
    if(adminPinRegistered){
      setAdminLoading(true); setAdminError('');
      try{
        await adminAuth.loginWithPin(profile.prayerType,normalizeTeamNumber(profile.groupTeamName),profile.name,next);
        if(!adminAuth.isAdmin()){adminAuth.clearSession();resetAdminState(true);setAdminError('관리자 권한이 없습니다.');return;}
        setAdminUnlocked(true); setAdminShowAuth(false); resetAdminState(); setTab('admin');
      }catch(err){
        if(err.message.includes('PIN이 등록되지 않았습니다')||err.message.includes('비활성화')||err.message.includes('차단')){
          adminAuth.clearPinRegistered(); resetAdminState(true); setAdminError(err.message);
        }else{setAdminError(err.message); setAdminPinInput('');}
      }finally{setAdminLoading(false);}
    }else if(phase==='enter'){
      setAdminPinPhase('confirm');
    }else{
      if(next!==adminPinInput){
        setAdminError('PIN이 일치하지 않습니다. 다시 입력해주세요.');
        setAdminPinInput(''); setAdminPinConfirm(''); setAdminPinPhase('enter'); return;
      }
      setAdminLoading(true); setAdminError('');
      try{
        await adminAuth.registerPin(adminVerifyToken,adminPinInput);
        if(!adminAuth.isAdmin()){adminAuth.clearSession();resetAdminState(true);setAdminError('관리자 권한이 없습니다.');return;}
        setAdminUnlocked(true); setAdminShowAuth(false); resetAdminState(); setTab('admin');
      }catch(err){
        if(err.message.includes('비활성화')||err.message.includes('차단')||err.message.includes('권한이 없습니다')){
          resetAdminState(true); setAdminError(err.message);
        }else{setAdminError(err.message); setAdminPinInput(''); setAdminPinConfirm(''); setAdminPinPhase('enter');}
      }finally{setAdminLoading(false);}
    }
  },[adminPinPhase,adminPinInput,adminPinConfirm,adminPinRegistered,adminVerifyToken,profile,resetAdminState]);

  const handleAdminMenuClick=()=>{
    if(adminUnlocked){setTab('admin');}
    else{setAdminShowAuth(true);}
  };


  const updateWeek = (patch) => {
    const n = {...weekData, ...patch};
    if(!easyMode && Object.prototype.hasOwnProperty.call(patch, "dailySeconds") && !Object.prototype.hasOwnProperty.call(patch, "submitTotalPrayerSec")) {
      n.submitTotalPrayerSec = undefined;
      n.submitPrayDays = undefined;
    }
    setWeekData(n);
    save(`week_${weekKey}`, n);
  };

  useEffect(()=>{
    const submissionFields = [
      "submitted",
      "submittedDate",
      "submittedTotalPrayerSec",
      "submittedPrayDays",
      "submittedReadingCount",
      "submittedWholeReadingDone",
      "submittedMemoryDone",
      "submittedHagadaCount",
    ];
    let updatedCurrentWeekData = null;

    for(let i=0; i<localStorage.length; i++){
      const key = localStorage.key(i);
      if(!key?.startsWith("week_")) continue;

      const sourceWeekKey = key.replace("week_", "");
      const sourceData = load(key, null);
      if(!sourceData?.submitted || !sourceData.submittedDate) continue;
      if(sourceData.submittedDate === getSubmitDate(sourceWeekKey)) continue;

      const submittedDate = parseDate(sourceData.submittedDate);
      submittedDate.setDate(submittedDate.getDate() - 7);
      const targetWeekKey = getWeekKey(submittedDate);
      if(!targetWeekKey || targetWeekKey === sourceWeekKey) continue;

      const targetKey = `week_${targetWeekKey}`;
      const targetData = load(targetKey, {});
      if(targetData.submitted && targetData.submittedDate && targetData.submittedDate !== sourceData.submittedDate) continue;

      const movedTargetData = {...targetData};
      submissionFields.forEach(field => {
        if(sourceData[field] !== undefined) movedTargetData[field] = sourceData[field];
      });
      save(targetKey, movedTargetData);

      const cleanedSourceData = {...sourceData};
      submissionFields.forEach(field => { delete cleanedSourceData[field]; });
      cleanedSourceData.submitted = false;
      cleanedSourceData.submittedDate = "";
      save(key, cleanedSourceData);

      if(weekKey === targetWeekKey) updatedCurrentWeekData = movedTargetData;
      if(weekKey === sourceWeekKey) updatedCurrentWeekData = cleanedSourceData;
    }

    if(updatedCurrentWeekData) setWeekData(updatedCurrentWeekData);
  },[weekKey]);

  // 타이머/스톱워치가 1분 단위로 넘어갈 때마다 자동 누적 저장
  useEffect(()=>{
    if(!timerRunning) return;
    if(timerCompletedRef.current) return;

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

  //if (!profile.setupDone) return <SetupScreen scheduleData={scheduleData} installPrompt={installPrompt} isIOS={isIOS} isStandalone={isStandalone} showIOSInstallGuide={showIOSInstallGuide} onInstallApp={handleInstallApp} onSave={(p)=>{ const np={...p,setupDone:true}; setProfile(np); save("profile",np); }}/>;
  if (!profile.setupDone) return <SetupScreen
    scheduleData={scheduleData}
    installPrompt={installPrompt}
    isIOS={isIOS}
    isStandalone={isStandalone}
    showIOSInstallGuide={showIOSInstallGuide}
    onInstallApp={handleInstallApp}
    onSave={(p)=>{
      const np={...p,setupDone:true};
      setProfile(np);
      save("profile",np);

      const restoredEasyMode = load("easyMode", false);
      const restoredEasyModeLevel = load("easyModeLevel", "125");

      setEasyModeFlag(restoredEasyMode);
      setEasyModeLevel(restoredEasyModeLevel);

      if(restoredEasyMode) setTab("home");
    }}
  />;

  // 데이터 로딩 중 (캐시도 없을 때만)
  if (scheduleLoading && !scheduleData) return (
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12}}>
      <div style={{fontSize:"2rem"}}>🙏</div>
      <div style={{color:C.gold,fontSize:"0.875rem",fontWeight:700}}>데이터 로딩 중...</div>
    </div>
  );

  const calculatedPrayerStats = calcWeekPrayerStats(weekData, weekDates);
  const calculatedTotalSec = calculatedPrayerStats.totalSec;
  const calculatedPrayDays = calculatedPrayerStats.prayDays;

  const easyTotalPrayerSec = weekData.easyTotalPrayerSec !== undefined
    ? Math.max(0, Number(weekData.easyTotalPrayerSec)||0)
    : calculatedTotalSec;

  const easyPrayDays = weekData.easyPrayDays !== undefined
    ? Math.max(0, Math.min(6, Number(weekData.easyPrayDays)||0))
    : calculatedPrayDays;
  const submitTotalPrayerSec = weekData.submitTotalPrayerSec !== undefined
    ? Math.max(0, Number(weekData.submitTotalPrayerSec)||0)
    : calculatedTotalSec;
  const submitPrayDays = weekData.submitPrayDays !== undefined
    ? Math.max(0, Math.min(6, Number(weekData.submitPrayDays)||0))
    : calculatedPrayDays;

  const showEasyDailyCalculatedValue = easyMode && !isSubmitActive;
  const totalSec = showEasyDailyCalculatedValue
    ? calculatedTotalSec
    : easyMode ? easyTotalPrayerSec : submitTotalPrayerSec;
  const prayDays = showEasyDailyCalculatedValue
    ? calculatedPrayDays
    : easyMode ? easyPrayDays : submitPrayDays;
  const totalChapters = bibleReading.reduce((a,b)=>a+b.chapters.length,0);
  const checkedCount = countCheckedBibleReading(weekData.readingChecked, bibleReading);

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
  const memoryStatusForShare = getMemoryDisplayStatus(weekData.memoryDone, weekData.memoryErrors);
  const shareText = [
    `1. 설문제출완료 : ${O(weekData.submitted)}`,
    `2. 출석 : ${O(hasAttendanceForShare)}`,
    `3. 지각/조퇴 : ${O(hasLateLeaveForShare)}`,
    `4. 매일 기도 : ${prayDays}/6`,
    `5. 총기도 시간: ${Math.floor(totalSec/3600)}`,
    `6. 기도 파일 : ${O(weekData.prayerFile)}`,
    `7. 성경통독 : ${O(checkedCount>=totalChapters&&totalChapters>0)}`,
    `8. 성경 암송 : ${O(memoryStatusForShare.completed)}`,
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
    <div style={{minHeight:"100vh",backgroundColor:C.bg,color:C.text,fontFamily:"'Noto Sans KR',sans-serif",paddingBottom:isAdminTab?"24px":"calc(84px + env(safe-area-inset-bottom, 0px))",WebkitOverflowScrolling:"touch",touchAction:"pan-y"}}>

      {/* ── 관리자 인증 팝업 ── */}
      {adminShowAuth&&!adminUnlocked&&(
        <div style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"flex-end",justifyContent:"center",overscrollBehavior:"none"}}
          onClick={()=>{setAdminShowAuth(false);resetAdminState();}}
          onTouchMove={e=>e.stopPropagation()}>
          <div style={{width:"100%",maxWidth:480,background:C.surface,borderRadius:"24px 24px 0 0",paddingBottom:"calc(32px + env(safe-area-inset-bottom,0px))"}}
            onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"center",paddingTop:12,paddingBottom:4}}>
              <div style={{width:40,height:4,borderRadius:2,background:C.border}}/>
            </div>
            <div style={{padding:"12px 20px 14px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontWeight:800,fontSize:"1rem",color:C.text}}>
                {adminStep==='identity'?"🔒 관리자 인증":adminPinRegistered?"🔑 PIN 입력":adminPinPhase==='enter'?"🔑 PIN 등록":"🔑 PIN 확인"}
              </div>
              <button onClick={()=>{setAdminShowAuth(false);resetAdminState();}}
                style={{background:C.bg,border:`1px solid ${C.border}`,color:C.muted,fontSize:"0.875rem",cursor:"pointer",padding:"6px 10px",borderRadius:8,lineHeight:1}}>✕</button>
            </div>
            {adminStep==='identity'?(
              <div style={{padding:"20px 20px 8px",display:"flex",flexDirection:"column",gap:10}}>
                <input style={{...getInp(),letterSpacing:4}} type="password" inputMode="numeric"
                  placeholder="비밀번호 (8자리)" value={adminPassword}
                  autoFocus
                  onChange={e=>{setAdminPassword(e.target.value);setAdminError('');}}
                  onKeyDown={e=>e.key==="Enter"&&handleAdminVerifyUser()}/>
                {adminError&&<div style={{fontSize:"0.75rem",color:C.red}}>{adminError}</div>}
                <button style={{...btn("primary"),padding:"12px 0",fontSize:"0.875rem"}}
                  onClick={handleAdminVerifyUser} disabled={adminLoading}>
                  {adminLoading?"확인 중...":"확인"}
                </button>
              </div>
            ):(
              <div style={{padding:"24px 20px 8px",display:"flex",flexDirection:"column",alignItems:"center",gap:16}}>
                <div style={{display:"flex",gap:18}}>
                  {[0,1,2,3].map(i=>{
                    const cur=adminPinPhase==='enter'?adminPinInput:adminPinConfirm;
                    return <div key={i} style={{width:16,height:16,borderRadius:"50%",background:i<cur.length?C.accent:"transparent",border:`2px solid ${i<cur.length?C.accent:C.muted}`,transition:"background 0.15s"}}/>;
                  })}
                </div>
                {adminError&&<div style={{fontSize:"0.75rem",color:C.red,textAlign:"center"}}>{adminError}</div>}
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,width:"100%",maxWidth:260}}>
                  {[1,2,3,4,5,6,7,8,9,"←",0,"뒤로"].map((k,i)=>(
                    <button key={i} disabled={adminLoading}
                      style={{padding:"16px 0",fontSize:k==="뒤로"?"0.8rem":"1.25rem",fontWeight:700,borderRadius:12,border:`1px solid ${C.border}`,background:k==="←"||k==="뒤로"?C.surface:C.bg,color:k==="뒤로"?C.muted:C.text,cursor:"pointer",opacity:adminLoading?0.4:1,touchAction:"manipulation",userSelect:"none"}}
                      onPointerDown={e=>{e.preventDefault();if(!adminLoading){k==="뒤로"?resetAdminState(true):handlePinKey(k==="←"?"back":String(k));}}}>{k}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── 전역 Firebase 조회 결과 팝업 ── */}
      {fbQueryResult&&(
        <div style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"flex-end",justifyContent:"center",overscrollBehavior:"none"}}
          onClick={()=>setFbQueryResult(null)}
          onTouchMove={e=>e.stopPropagation()}>
          <div style={{width:"100%",maxWidth:480,background:C.surface,borderRadius:"24px 24px 0 0",paddingBottom:40,maxHeight:"72vh",overflowY:"auto",overscrollBehavior:"contain"}}
            onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"center",paddingTop:12,paddingBottom:4}}>
              <div style={{width:40,height:4,borderRadius:2,background:C.border}}/>
            </div>
            <div style={{padding:"12px 20px 14px",borderBottom:`1px solid ${C.border}`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div>
                  <div style={{fontSize:"1.06rem",fontWeight:800,color:C.text,marginBottom:6}}>제출 기록</div>
                </div>
                <button onClick={()=>setFbQueryResult(null)}
                  style={{background:C.bg,border:`1px solid ${C.border}`,color:C.muted,fontSize:"0.875rem",cursor:"pointer",padding:"6px 10px",borderRadius:8,lineHeight:1}}>✕</button>
              </div>
            </div>
            <div style={{padding:"16px 20px 0"}}>
              {(()=>{
                const f = fbQueryResult.fields;
                const statusVal = String(f.status||"");
                const reasonVal = String(f.reason||f.reasonAbsent||f.reasonLate||f.reasonEarly||f.reasonExcused||"");
                const isAbsent = statusVal.includes("결석");
                const isLate   = statusVal.includes("지각");
                const isEarly  = statusVal.includes("조퇴");
                const statusColor = isAbsent ? C.red : (isLate||isEarly) ? C.accent : C.green;
                const dailyVal = f.dailyPrayer!==undefined ? `${f.dailyPrayer}/6` : null;
                const timeVal = f.totalPrayerTime!==undefined ? `${f.totalPrayerTime}시간` : null;
                const actItems = [
                  { key:"filePrayer",      icon:"📂", label:"파일기도",  color:C.blue },
                  { key:"bibleMemory",     icon:"🗣️", label:"성경암송", color:C.purple },
                  { key:"bibleReading",    icon:"📖", label:"성경통독", color:C.accent },
                  { key:"fullBibleReading",icon:"📚", label:"성경 1독",   color:C.gold },
                ];
                return (
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                    {f.status!==undefined&&(
                      <div style={{padding:"11px 14px",borderRadius:12,background:C.bg,border:`1.5px solid ${statusColor}44`}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:reasonVal?8:0}}>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <span style={{fontSize:"1rem"}}>⛪</span>
                            <span style={{fontSize:"0.69rem",color:C.muted}}>출석</span>
                          </div>
                          <span style={{fontSize:"0.875rem",fontWeight:800,color:statusColor}}>{statusVal}</span>
                        </div>
                        {reasonVal&&<div style={{background:`${statusColor}10`,borderRadius:8,padding:"6px 10px",fontSize:"0.69rem",color:statusColor,borderLeft:`2px solid ${statusColor}66`}}>{reasonVal}</div>}
                      </div>
                    )}
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                      {timeVal&&<div style={{padding:"11px 14px",borderRadius:12,background:C.bg,border:`1px solid ${C.border}`}}>
                        <div style={{fontSize:"0.625rem",color:C.muted,marginBottom:4}}>⏱ 총 기도시간</div>
                        <div style={{fontSize:"1.25rem",fontWeight:800,color:C.blue}}>{timeVal}</div>
                      </div>}
                      {dailyVal&&<div style={{padding:"11px 14px",borderRadius:12,background:C.bg,border:`1px solid ${C.border}`}}>
                        <div style={{fontSize:"0.625rem",color:C.muted,marginBottom:4}}>🙏 기도 일수</div>
                        <div style={{fontSize:"1.25rem",fontWeight:800,color:C.green}}>{dailyVal}</div>
                      </div>}
                    </div>
                    {actItems.filter(({key})=>f[key]!==undefined&&f[key]!==null&&f[key]!=="").map(({key,icon,label,color})=>{
                      const val=String(f[key]);
                      const isPartialMemory = key === "bibleMemory" && val === "1~3글자 틀림";
                      const isDone=val==="완료"||val==="있음"||val==="true";
                      const displayVal = isDone ? "완료" : isPartialMemory ? "1~3글자 틀림" : "미완료";
                      const valueColor = isDone ? color : isPartialMemory ? C.accent : C.muted;
                      return (
                        <div key={key} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 14px",borderRadius:12,background:C.bg,border:`1px solid ${C.border}`}}>
                          <span style={{fontSize:"1rem",flexShrink:0}}>{icon}</span>
                          <span style={{fontSize:"0.81rem",color:C.muted,flex:1}}>{label}</span>
                          <span style={{fontSize:"0.875rem",fontWeight:800,color:valueColor}}>{displayVal}</span>
                          {isDone&&<span style={{fontSize:"0.75rem"}}>✅</span>}
                        </div>
                      );
                    })}
                    {f.isFilingManager!==undefined&&fbQueryResult.prayerType==="교회중보"&&(
                      <div style={{display:"flex",alignItems:"center",gap:12,padding:"11px 14px",borderRadius:12,background:C.bg,border:`1px solid ${C.border}`}}>
                        <span style={{fontSize:"1rem",flexShrink:0}}>🗂</span>
                        <span style={{fontSize:"0.81rem",color:C.muted,flex:1}}>파일링 담당</span>
                        <span style={{fontSize:"0.875rem",fontWeight:800,color:f.isFilingManager===true||f.isFilingManager==="true"?C.blue:C.muted}}>
                          {f.isFilingManager===true||f.isFilingManager==="true"?"완료":"미완료"}
                        </span>
                        {(f.isFilingManager===true||f.isFilingManager==="true")&&<span style={{fontSize:"0.75rem"}}>✅</span>}
                      </div>
                    )}
                    {f.spiritGuidance!==undefined&&(
                      <div style={{display:"flex",alignItems:"center",gap:12,padding:"11px 14px",borderRadius:12,background:C.bg,border:`1px solid ${C.border}`}}>
                        <span style={{fontSize:"1rem",flexShrink:0}}>✨</span>
                        <span style={{fontSize:"0.81rem",color:C.muted,flex:1}}>성령의 인도하심</span>
                        <span style={{fontSize:"0.875rem",fontWeight:800,color:String(f.spiritGuidance)==="있음"?C.purple:C.muted}}>{String(f.spiritGuidance)==="있음"?"있음":"없음"}</span>
                        {String(f.spiritGuidance)==="있음"&&<span style={{fontSize:"0.75rem"}}>✅</span>}
                      </div>
                    )}
                  </div>
                );
              })()}
              {fbQueryResult.fields.updatedAt&&(
                <div style={{marginTop:12,marginBottom:4,padding:"12px 14px",borderRadius:12,background:`${C.accent}12`,border:`1px solid ${C.accent}33`}}>
                  <div style={{fontSize:"0.625rem",color:C.accent,fontWeight:700,marginBottom:6}}>📅 최종 제출일시</div>
                  <div style={{fontSize:"0.875rem",fontWeight:800,color:C.text,fontFamily:"monospace"}}>
                    {(()=>{
                      const raw=String(fbQueryResult.fields.updatedAt);
                      try {
                        const d=new Date(raw);
                        const kst=new Date(d.getTime()+9*60*60*1000);
                        const pad=n=>String(n).padStart(2,"0");
                        return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth()+1)}-${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())}`;
                      } catch { return raw; }
                    })()}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <div style={{
        background:`linear-gradient(135deg,${C.accent}22 0%,${C.surface}ee 52%,${C.bg}ee 100%)`,
        backdropFilter:"blur(16px)",
        WebkitBackdropFilter:"blur(16px)",
        borderBottom:`1px solid ${C.accent}66`,
        padding:"calc(12px + env(safe-area-inset-top, 0px)) 14px 12px",
        minHeight:"calc(72px + env(safe-area-inset-top, 0px))",
        boxSizing:"border-box",
        position:"sticky",
        top:0,
        zIndex:50,
        display:"flex",
        justifyContent:"space-between",
        alignItems:"center",
        gap:12,
      }}>
        <div style={{minWidth:0,flex:1}}>
          <div style={{fontSize:18.75,fontWeight:800,color:(isSubmitTab||isStatsTab)?C.accentLight:C.gold,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,whiteSpace:"nowrap"}}>
            <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
              <span>{isSubmitTab?"📤":isStatsTab?"📊":isSettingsTab?"⚙️":isAdminTab?"🔒":tab==="reading"?"📖":tab==="memory"?"🗣️":"🙏"}</span>
              <span style={{overflow:"hidden",textOverflow:"ellipsis"}}>
                {isSubmitTab
                  ? "주간 제출"
                  : isStatsTab
                    ? "통계"
                    : isSettingsTab
                      ? "설정"
                      : isAdminTab
                        ? "관리자"
                        : tab === "reading"
                          ? "통독 기록"
                          : tab === "memory"
                            ? "암송 기록"
                            : "기도 기록"}
              </span>
            </div>
            {isAdminTab&&(
              <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                <button
                  style={{padding:"4px 12px",borderRadius:8,border:`1px solid ${C.red}55`,background:`${C.red}18`,color:C.red,cursor:"pointer",fontSize:13,fontWeight:700,flexShrink:0}}
                  onClick={handleAdminLock}
                >잠금</button>
              </div>
            )}
            {!isAdminTab&&(isSubmitTab||isStatsTab||isSettingsTab)&&(
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
            {!isAdminTab&&(!isSubmitTab&&!isStatsTab&&!isSettingsTab)&&(
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
          ) : isAdminTab ? (
            <div style={{marginTop:6,display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"4px 9px",borderRadius:999,background:`${C.accent}18`,border:`1px solid ${C.accent}33`,width:"100%",boxSizing:"border-box"}}>
              <div style={{display:"flex",alignItems:"center",gap:5,minWidth:0}}>
                <span style={{fontSize:12.5,color:C.accentLight,fontWeight:900,whiteSpace:"nowrap"}}>사용자 관리</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
                <span style={{fontSize:12.5,color:C.accentLight,fontWeight:900,whiteSpace:"nowrap"}}>대리 제출 · 설정</span>
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
        <>
          {tab==="home"    && <HomeTab weekDates={weekDates} weekData={weekData} totalSec={totalSec} prayDays={prayDays} updateWeek={updateWeek} setTab={setTab} checkedCount={checkedCount} totalChapters={totalChapters} shareText={shareText} submitDate={submitDate} weekKey={weekKey} scheduleData={scheduleData} bibleReading={bibleReading} memoryVerseGroup={memoryVerseGroup} isSubmitActive={isSubmitActive} profile={profile} onFbQuery={handleFbQuery} easyMode={easyMode} thisWeekKey={thisWeekKey}/>}
          {!easyMode && tab==="prayer"  && <PrayerTab weekDates={weekDates} weekData={weekData} updateWeek={updateWeek} scheduleData={scheduleData} timerRunning={timerRunning} setTimerRunning={setTimerRunning} timerElapsed={timerElapsed} setTimerElapsed={setTimerElapsed} timerMode={timerMode} setTimerMode={setTimerMode} timerTarget={timerTarget} setTimerTarget={setTimerTarget} timerActiveDay={timerActiveDay} setTimerActiveDay={setTimerActiveDay}/>}
          {!easyMode && tab==="reading" && <ReadingTab weekData={weekData} updateWeek={updateWeek} bibleReading={bibleReading} weekKey={weekKey}/>}
          {!easyMode && tab==="memory"  && <MemoryTab weekData={weekData} updateWeek={updateWeek} memoryVerseGroup={memoryVerseGroup} weekKey={weekKey} scheduleData={scheduleData} weekDates={weekDates}/>}
          {!easyMode && tab==="stats"   && <StatsTab thisWeekKey={thisWeekKey} weekKey={weekKey} weekData={weekData} scheduleData={scheduleData} activeYear={activeYear}/>}
          {tab==="settings"&& <SettingsTab profile={profile} groups={groups} scheduleRange={scheduleRange} weekKey={weekKey} activeYear={activeYear} bibleReading={bibleReading} memoryVerseGroup={memoryVerseGroup} easyMode={easyMode} easyModeLevel={easyModeLevel} setEasyMode={setEasyMode} setEasyModeEnabled={setEasyModeEnabled} themeMode={themeMode} activeTheme={activeTheme} setThemeMode={setThemeMode} scheduleData={scheduleData} onSave={(p)=>{setProfile(p);save("profile",p);setTab("home");}} onBack={()=>setTab("home")} onFbQuery={handleFbQuery} adminUnlocked={adminUnlocked} onAdminClick={handleAdminMenuClick}/>}
          {tab==="admin"&&adminUnlocked&&<AdminTab scheduleData={scheduleData} onFbQuery={handleFbQuery} bibleReading={bibleReading} memoryVerseGroup={memoryVerseGroup}/>}
        </>
      </div>

      {!easyMode && !isAdminTab && (
      <nav style={{position:"fixed",bottom:0,left:0,right:0,background:C.surface,borderTop:`1px solid ${C.border}`,display:"flex",justifyContent:"space-around",padding:"6px 0 max(6px, calc(env(safe-area-inset-bottom, 0px) - 10px))",zIndex:100}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"5px 10px",borderRadius:8,background:tab===t.id?`${C.accent}22`:"transparent",cursor:"pointer",border:"none",color:tab===t.id?C.accent:C.muted,fontSize:13.125,fontWeight:tab===t.id?700:400}}>
            <span style={{fontSize:27.5}}>{t.icon}</span>{t.label}
          </button>
        ))}
      </nav>
      )}
      <ConfirmModal dialog={confirmDialog} onClose={()=>setConfirmDialog(null)} theme={C} />
    </div>
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────
function SetupScreen({scheduleData, installPrompt, isIOS, isStandalone, showIOSInstallGuide, onInstallApp, onSave}) {
  const [prayerType,setPrayerType]=useState("");
  const [group,setGroup]=useState("");
  const [name,setName]=useState("");
  const [setupEasyMode,setSetupEasyMode]=useState(true);
  const [fbGroups,setFbGroups]=useState(null);
  const [fbLoading,setFbLoading]=useState(false);
  const [fbError,setFbError]=useState("");
  const [members,setMembers]=useState([]);
  const [nameMode,setNameMode]=useState("select"); // "select" | "input"

  const handleTypeChange = async (t) => {
    setPrayerType(t); setGroup(""); setName(""); setMembers([]); setNameMode("select");
    setFbError("");

    // localStorage에 저장된 Firebase 조목록/명단 캐시를 먼저 표시합니다.
    // 날짜가 지나도 마지막 성공 데이터를 사용할 수 있게 해서 Firebase 일시 오류/쿼터 초과 시에도 계속 사용할 수 있게 합니다.
    const cachedRoster = getCachedOrScheduleGroups(t, scheduleData);
    if (cachedRoster?.length) setFbGroups(cachedRoster);

    const cached = loadFirebaseRosterCache(t);
    const cacheAge = cached?.savedAt ? Date.now() - new Date(cached.savedAt).getTime() : Infinity;
    if (cached?.groups?.length && cacheAge < 24 * 60 * 60 * 1000) return;

    setFbLoading(true);
    try {
      const teams = await fetchFirebaseTeamsConfig(t);
      const converted = mergeFirebaseGroupsWithSchedule(teams.map(team=>convertTeamsConfigToGroup(team, t)), t, scheduleData);
      setFbGroups(converted);
      saveFirebaseRosterCache(t, converted);
    } catch(e) {
      const fallback = getCachedOrScheduleGroups(t, scheduleData);
      setFbGroups(fallback);
      setFbError(fallback?.length ? "서버 조회 실패 - 저장된 목록을 사용합니다." : (e?.message || "조 목록을 불러오지 못했습니다. 네트워크 상태를 확인해 주세요."));
    } finally { setFbLoading(false); }
  };

  const handleGroupChange = (display) => {
    setGroup(display);
    setName(""); setFbError("");
    if (!display) { setMembers([]); return; }
    const g = (fbGroups||[]).find(g=>getGroupDisplay(g)===display);
    if (!g) { setMembers([]); return; }
    const base = g.members || [];
    const leader = getGroupLeader(g);
    setMembers(leader && !base.includes(leader) ? [leader, ...base] : base);
  };

  const groups = fbGroups || getCachedOrScheduleGroups(prayerType, scheduleData);
  const canSubmit = prayerType && group && name.trim();

  const handleStart = () => {
    if(!prayerType){ alert("중보 유형을 선택해 주세요."); return; }
    if(!group){ alert("조를 선택해 주세요."); return; }
    if(!name.trim()){ alert("이름을 입력해 주세요."); return; }
    if(members.length>0 && !members.includes(name.trim())){
      alert(`"${name.trim()}"은(는) 조원 목록에 없는 이름입니다.\n동명이인의 경우 알파벳까지 입력해 주세요.`);
      return;
    }
    save("easyModeLevel", setupEasyMode ? "150" : "125");
    save("easyMode", setupEasyMode);
    const selectedGroup = findGroupByDisplay(groups, group);
    onSave({
      prayerType,
      group,
      groupTeamName:getGroupTeamName(selectedGroup) || group,
      name:name.trim().replace(/[a-z]/g, c=>c.toUpperCase())
    });
  };

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

        {/* 조 선택 */}
        {prayerType&&(
          <div style={{marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
              <label style={getLbl()}>조 선택</label>
              {!fbLoading&&<button style={{fontSize:"0.625rem",color:C.muted,background:"none",border:"none",cursor:"pointer",padding:"2px 4px"}} onClick={()=>{
                try{localStorage.removeItem(`fbRosterMerged_${prayerType}`);}catch{}
                handleTypeChange(prayerType);
              }}>새로고침</button>}
            </div>
            {fbLoading
              ? <div style={{...getInp(),display:"flex",alignItems:"center",gap:8,color:C.muted}}>
                  <span style={{fontSize:"0.875rem"}}>⏳</span><span>조 목록 불러오는 중...</span>
                </div>
              : <>
                  {fbError&&<div style={{fontSize:"0.625rem",color:C.accent,marginBottom:4}}>{fbError}</div>}
                  <select style={getInp()} value={group} onChange={e=>handleGroupChange(e.target.value)}>
                    <option value="">조를 선택하세요</option>
                    {groups.map(g=><option key={getGroupDisplay(g)} value={getGroupDisplay(g)}>{getGroupDisplay(g)}</option>)}
                  </select>
                </>
            }
          </div>
        )}

        {/* 이름 입력 */}
        {group&&(
          <div style={{marginBottom:22}}>
            <label style={getLbl()}>이름</label>
            <input style={getInp()} placeholder="이름을 입력하세요" value={name} onChange={e=>setName(e.target.value.replace(/[a-z]/g, c=>c.toUpperCase()))}/>

          </div>
        )}

        {/* 쉬운 모드 토글 */}
        <div style={{
          ...getCard(),
          marginTop:12,
          border:`1.5px solid ${setupEasyMode ? C.accent : C.border}`,
          background:setupEasyMode ? `${C.accent}0f` : C.surface
        }}>
          <div
            onClick={()=>setSetupEasyMode(v=>!v)}
            style={{
              display:"flex",
              justifyContent:"space-between",
              alignItems:"center",
              gap:12,
              cursor:"pointer"
            }}
          >
            <div style={{minWidth:0}}>
              <div style={{fontSize:"0.94rem",fontWeight:800,color:C.text}}>
                🔍 쉬운모드로 시작
              </div>
              <div style={{
                fontSize:"0.72rem",
                color:setupEasyMode ? C.accent : C.muted,
                marginTop:4,
                lineHeight:1.5,
                fontWeight:setupEasyMode ? 700 : 500
              }}>
                글자를 크게 보고, 제출 중심 화면으로 간단하게 사용합니다.
              </div>
            </div>

            <div style={{
              width:54,
              height:30,
              borderRadius:15,
              background:setupEasyMode ? C.accent : C.border,
              position:"relative",
              flexShrink:0,
              transition:"background 0.2s"
            }}>
              <div style={{
                width:22,
                height:22,
                borderRadius:11,
                background:"#fff",
                position:"absolute",
                top:4,
                left:setupEasyMode ? 28 : 4,
                transition:"left 0.2s",
                boxShadow:"0 2px 6px rgba(0,0,0,0.25)"
              }} />
            </div>
          </div>
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
function HomeTab({weekDates,weekData,totalSec,prayDays,updateWeek,setTab,checkedCount,totalChapters,shareText,submitDate,weekKey,scheduleData,bibleReading,memoryVerseGroup,isSubmitActive,profile,onFbQuery,easyMode,thisWeekKey}) {
  const [copied,setCopied]=useState(false);
  const [showShare,setShowShare]=useState(false);

  const profileForHome = load("profile", {group:"", name:"", prayerType:""});
  const isChurchIntercession = profileForHome.prayerType === "교회중보";
  const submitConfirmUrl = isChurchIntercession
    ? "https://prayer-for-the-church.vercel.app/"
    : "https://prayer-for-the-pastor.vercel.app/";
  const churchFilingManager = !!weekData.isFilingManager;
  const updateSubmitTotalPrayerHours = (hours) => {
    const nextSec = Math.max(0, Math.min(50, Number(hours)||0)) * 3600;
    updateWeek(easyMode ? {easyTotalPrayerSec:nextSec} : {submitTotalPrayerSec:nextSec});
  };
  const updateSubmitPrayerDays = (days) => {
    const nextDays = Math.max(0, Math.min(6, Number(days)||0));
    updateWeek(easyMode ? {easyPrayDays:nextDays} : {submitPrayDays:nextDays});
  };
  const readingDone = totalChapters > 0 && checkedCount >= totalChapters;
  const hagadaTarget = Number(scheduleData?.hagadaTarget || 700);
  const hasReading = checkedCount > 0;
  const weekRangeLabel = `${weekDates[0].getMonth()+1}/${weekDates[0].getDate()} ~ ${weekDates[6].getMonth()+1}/${weekDates[6].getDate()}`;
  const todayStr = toDateStr(getNow());
  const submitDateObj = parseDate(submitDate);
  const submitDeadline = new Date(submitDateObj);
  submitDeadline.setDate(submitDeadline.getDate() + 2);
  const submitDeadlineStr = toDateStr(submitDeadline);
  const submittedDate = weekData.submittedDate || null;
  const isPreviewMode = submitDate > todayStr;
  const canSubmit = !isPreviewMode && !weekData.submitted && isSubmitActive;
  const canResubmit = !isPreviewMode && weekData.submitted && submittedDate === todayStr && isSubmitActive;
  const canPrimarySubmit = weekData.submitted ? canResubmit : canSubmit;
  const canUseSubmittedActions = !isPreviewMode && !!weekData.submitted;
  const canQuerySubmission = canUseSubmittedActions && !!onFbQuery;
  const canEditSubmission = canSubmit || canResubmit;
  const memoryStatus = getMemoryDisplayStatus(weekData.memoryDone, weekData.memoryErrors);
  const submitReadingRangeLabel = bibleReading.map(section => {
    const chapters = section?.chapters || [];
    if (!section?.book || !chapters.length) return "";
    const first = chapters[0];
    const last = chapters[chapters.length - 1];
    return first === last ? `${section.book} ${first}장` : `${section.book} ${first}~${last}장`;
  }).filter(Boolean).join(", ");
  const submitEditableCardStyle = {
    ...getInputCard(),
    marginBottom:12,
    opacity:canEditSubmission?1:0.5,
    pointerEvents:canEditSubmission?"auto":"none",
  };
  const submitActionButtonStyle = {
    flex:1,
    minWidth:0,
    minHeight:50,
    height:50,
    padding:"7px 4px",
    fontSize:"0.75rem",
    lineHeight:1.12,
    whiteSpace:"nowrap",
    display:"flex",
    alignItems:"center",
    justifyContent:"center",
    boxSizing:"border-box",
  };
  const setMemoryDone = async (next) => {
    if (next === memoryStatus.completed) return;
    if (!next) {
      if (!await confirmUncheck("성경암송")) return;
      updateWeek({ memoryDone:false, memoryErrors:0 });
      return;
    }
    updateWeek({ memoryDone:true, memoryErrors:0 });
  };

  const showSummaryMode = weekData.submitted && submittedDate && submittedDate < todayStr;

  const copy=()=>{
    if(!canUseSubmittedActions){ alert("⚠️ 제출 후 복사할 수 있습니다."); return; }
    navigator.clipboard.writeText(shareText).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000);});
  };

  const share=async()=>{
    if(!canUseSubmittedActions){ alert("⚠️ 제출 후 공유할 수 있습니다."); return; }
    if(navigator.share){
      try{ await navigator.share({title:"중보기도 기록",text:shareText}); }
      catch{}
    } else { copy(); }
  };

  const setReadingDone = async (next) => {
    if (next === readingDone) return;
    const nextChecked = {...(weekData.readingChecked || {})};
    if(!next && !await confirmUncheck("통독")) return;
    bibleReading.forEach(section => section.chapters.forEach(ch => {
      nextChecked[getReadingKey(section.book, ch)] = next;
    }));
    updateWeek({readingChecked:nextChecked});
  };

  const applyAttendance = (val) => {
    const patch = {
      attendReason: "",
      attendLateTime: "",
    };

    if(isChurchIntercession){
      if(val === "attend"){
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
        Object.assign(patch, {
          attendance: "attend",
          churchLate: !weekData.churchLate,
        });
      } else if(val === "leave"){
        Object.assign(patch, {
          attendance: "attend",
          churchLeave: !weekData.churchLeave,
        });
      }
    } else {
      Object.assign(patch, { attendance: val, ...(val === "attend" ? { attendReason: "", attendLateTime: "" } : {}) });
    }

    updateWeek(patch);
  };

  const submit = async () => {
    if (!weekData.attendance) {
      alert("⚠️ 출석상태를 선택해주세요.\n(출석 / 지각 / 조퇴 / 결석)");
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
    const memoryLabel = memoryStatus.label;
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

    const firebaseStatus = isChurchIntercession ? churchStatus : status.join(", ");
    const teamName = getProfileTeamName(profile, scheduleData);
    const firebaseRecord = {
      teamName,
      leader: "",
      name: profile.name,
      date: submitDate,
      week: getPastorPrayerWeekNumber(submitDate),
      status: firebaseStatus,
      reason: combinedReason,
      tardyReason,
      earlyLeaveReason,
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
      updateWeek({
        submitted:true,
        submittedDate:toDateStr(getNow()),
        submittedTotalPrayerSec:totalSec,
        submittedPrayDays:prayDays,
        submittedReadingCount:checkedCount,
        submittedWholeReadingDone:!!weekData.wholeReadingDone,
        submittedMemoryDone:memoryStatus.completed,
        submittedHagadaCount:Number(weekData.hagadaCount||0),
      });
      /* 로컬백업으로 대체됨 */;
      alert("제출이 완료되었습니다.");
    } catch (e) {
      alert(`제출에 실패했습니다.\n${e?.message || "Firebase 제출 중 알 수 없는 오류가 발생했습니다."}`);
    }
  };

  return (
    <div>
      <div style={{...getCard(),borderLeft:`3px solid ${C.accent}`,paddingLeft:13,position:"relative",opacity:isSubmitActive?1:0.5,pointerEvents:isSubmitActive?"auto":"none"}}>
        <div style={{display:"flex",alignItems:"baseline",gap:6,marginBottom:10}}>
          <div style={{fontWeight:700,fontSize:"0.81rem",color:C.text}}>📋 출석상태</div>
        </div>
        {isChurchIntercession ? (
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,minmax(0,1fr))",gap:6,marginBottom:(weekData.churchLate||weekData.churchLeave||weekData.attendance)?10:0}}>
            {[
              ["attend", "출석", C.green],
              ["excused", "출석\n인정\n결석", C.blue],
              ["late", "지각", C.accent],
              ["leave", "조퇴", C.blue],
              ["absent", "결석", C.red]
            ].map(([val,label,color])=>{
              const selected = !isPreviewMode && (
                val === "attend" ? (weekData.attendance === "attend" && !weekData.churchLate && !weekData.churchLeave)
                : val === "excused" ? weekData.attendance === "excused"
                : val === "absent" ? weekData.attendance === "absent"
                : val === "late" ? !!weekData.churchLate
                : !!weekData.churchLeave
              );

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
                  {label}{(!isPreviewMode&&(val==="late"&&weekData.churchLate)||(val==="leave"&&weekData.churchLeave))?"\n✓":""}
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,minmax(0,1fr))",gap:6,marginBottom:(!isPreviewMode&&weekData.attendance)?10:0}}>
            {[
              ["attend", "출석", C.green],
              ["excused", "출석\n인정\n결석", C.blue],
              ["late", "지각", C.accent],
              ["leave", "조퇴", C.blue],
              ["absent", "결석", C.red]
            ].map(([val,label,color])=>{
              const selected = !isPreviewMode && weekData.attendance === val;

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
            <span>파일기도</span>
          </div>
          <CompletionChoice
            done={weekData.prayerFile}
            color={C.green}
            ariaLabel="파일기도 완료 여부"
            onSelect={async (next) => {
              if (next === weekData.prayerFile) return;
              if (!next && !await confirmUncheck("파일기도")) return;
              updateWeek({ prayerFile:next });
            }}
          />
        </div>
      </div>

      <div style={{...getCard(),borderLeft:`3px solid ${C.blue}`,paddingLeft:13,opacity:isSubmitActive?1:0.5,pointerEvents:isSubmitActive?"auto":"none"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
          <div style={{minWidth:0}}>
            <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text}}>
              <span style={{fontSize:"1rem"}}>📖</span>
              <span>성경통독</span>
            </div>
            <div style={{fontSize:"0.69rem",color:C.muted,marginTop:4,lineHeight:1.55,wordBreak:"keep-all"}}>
              이번 주 범위: {submitReadingRangeLabel || "통독 범위 없음"}
            </div>
          </div>
          <CompletionChoice
            done={readingDone}
            color={C.blue}
            ariaLabel="성경통독 완료 여부"
            onSelect={setReadingDone}
          />
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
            onClick={async ()=>{ if(!churchFilingManager || await confirmUncheck("파일링 담당")) updateWeek({isFilingManager:!churchFilingManager}); }}
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

      <div style={{...getCard(),borderLeft:`3px solid ${C.purple}`,paddingLeft:13,paddingTop:13,paddingBottom:13,opacity:isSubmitActive?1:0.5,pointerEvents:isSubmitActive?"auto":"none"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginBottom:weekData.memoryDone?10:0}}>
          <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text}}>
            <span style={{fontSize:"1rem"}}>🗣️</span>
            <span>성경암송</span>
          </div>
          <CompletionChoice
            done={memoryStatus.completed}
            color={C.purple}
            ariaLabel="성경암송 완료 여부"
            onSelect={setMemoryDone}
          />
        </div>
        {weekData.memoryDone&&(
          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:2}}>
            <div style={{fontSize:"0.69rem",color:C.muted,fontWeight:700,whiteSpace:"nowrap",flexShrink:0}}>틀린 글자 수</div>
            <div style={{display:"flex",gap:5,flex:1,justifyContent:"flex-end"}}>
              {[0,1,2,3,4].map(n=>(
                <button key={n} onClick={()=>updateWeek({memoryErrors:n})}
                  style={{height:28,minWidth:32,padding:"0 7px",borderRadius:7,border:`1px solid ${(weekData.memoryErrors??0)===n?C.purple:C.border}`,background:(weekData.memoryErrors??0)===n?`${C.purple}22`:C.bg,color:(weekData.memoryErrors??0)===n?C.purple:C.muted,fontSize:"0.69rem",fontWeight:800,cursor:"pointer",whiteSpace:"nowrap"}}>
                  {n===4?"4+":n}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div>
        <div style={submitEditableCardStyle}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
              <div style={{minWidth:0,flex:1}}>
                <div style={{fontWeight:800,fontSize:"0.875rem",color:C.text,whiteSpace:"nowrap"}}>
                  🙏 매일기도(일수)
                </div>
                <div style={{fontSize:"0.6rem",color:C.muted,marginTop:4,lineHeight:1.45}}>
                  하루 1시간 이상 기도한 일수를 입력하세요.
                </div>
              </div>

              <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
                <EasyPrayerDaysPicker
                  theme={C}
                  days={prayDays}
                  onChange={updateSubmitPrayerDays}
                />
              </div>
            </div>
        </div>
        <div style={submitEditableCardStyle}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
              <div style={{minWidth:0,flex:1}}>
                <div style={{fontWeight:800,fontSize:"0.875rem",color:C.text,whiteSpace:"nowrap"}}>
                  📅 총 기도시간
                </div>
                <div style={{fontSize:"0.6rem",color:C.muted,marginTop:4,lineHeight:1.45}}>
                  오른쪽 시간 박스를 눌러 제출할 총 기도시간을 변경할 수 있습니다.
                </div>
              </div>

              <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
                <EasyHourPicker
                  theme={C}
                  hours={Math.floor(totalSec/3600)}
                  onChange={updateSubmitTotalPrayerHours}
                />
              </div>
            </div>
        </div>
        <div style={{...getCard(),borderLeft:`3px solid ${C.gold}`,paddingLeft:13,paddingTop:13,paddingBottom:13,opacity:isSubmitActive?1:0.5,pointerEvents:isSubmitActive?"auto":"none"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
            <div style={{minWidth:0}}>
              <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text}}>
                <span style={{fontSize:"1rem"}}>📜</span>
                <span>성경 전체 1독</span>
              </div>
              <div style={{fontSize:"0.69rem",color:C.muted,marginTop:4,lineHeight:1.55,wordBreak:"keep-all"}}>
                창세기~요한계시록까지 1독을 완료하셨다면 체크해 주세요
              </div>
            </div>
            <CompletionChoice
              done={weekData.wholeReadingDone}
              color={C.gold}
              ariaLabel="성경 전체 1독 완료 여부"
              onSelect={async (next) => {
                if (next === weekData.wholeReadingDone) return;
                if (!next && !await confirmUncheck("성경 1독")) return;
                updateWeek({ wholeReadingDone:next });
              }}
            />
          </div>
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
          <button onClick={canUseSubmittedActions?copy:undefined} style={{...btn("ghost"),...submitActionButtonStyle,color:copied?C.green:canUseSubmittedActions?C.muted:"#444",border:`1px solid ${copied?C.green:C.border}`,opacity:canUseSubmittedActions?1:0.5,cursor:canUseSubmittedActions?"pointer":"not-allowed"}}>
            {copied?"✓ 복사됨":"복사"}
          </button>
          <button onClick={canUseSubmittedActions?share:undefined} style={{...btn("ghost"),...submitActionButtonStyle,color:canUseSubmittedActions?C.blue:"#444",border:`1px solid ${canUseSubmittedActions?C.blue:C.border}44`,opacity:canUseSubmittedActions?1:0.5,cursor:canUseSubmittedActions?"pointer":"not-allowed"}}>
            <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:3,lineHeight:1.12,whiteSpace:"nowrap"}}>📨 공유</span>
          </button>
          <button onClick={canPrimarySubmit?submit:undefined}
            style={{...btn(weekData.submitted?"green":"primary"),...submitActionButtonStyle,opacity:canPrimarySubmit?1:0.4,cursor:canPrimarySubmit?"pointer":"not-allowed"}}>
            {weekData.submitted ? (
              <span style={{display:"inline-block",lineHeight:1.12,whiteSpace:"nowrap"}}>다시제출</span>
            ) : (
              <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:3,lineHeight:1.12,whiteSpace:"nowrap"}}>📤 제출</span>
            )}
          </button>
          <button
            onClick={canQuerySubmission ? async () => {
              const week = getPastorPrayerWeekNumber(submitDate);
              const teamNumber = normalizeTeamNumber(getProfileTeamName(profile, scheduleData));
              const safeName = buildFirebaseSafeMemberName(profile.name);
              const docId = `wk${week}_team${teamNumber}_${safeName}`;
              await onFbQuery(docId, profile.prayerType);
            } : undefined}
            style={{...btn("ghost"),...submitActionButtonStyle,color:C.purple,border:`1px solid ${C.purple}55`,opacity:canQuerySubmission?1:0.4,cursor:canQuerySubmission?"pointer":"not-allowed"}}
          >
            <span style={{display:"inline-block",lineHeight:1.12,whiteSpace:"nowrap"}}>제출확인</span>
          </button>
        </div>
        {!canPrimarySubmit&&!weekData.submitted&&(
          <div style={{fontSize:"0.625rem",color:C.muted,textAlign:"center",marginTop:6}}>
            {isPreviewMode
              ? `제출 가능일: ${submitDate} (화) ~ ${submitDeadlineStr} (목)`
              : `제출 가능일: ${submitDate} (화) ~ ${submitDeadlineStr} (목)`}
          </div>
        )}
        {weekData.submitted&&canResubmit&&(
          <div style={{fontSize:"0.69rem",color:C.muted,textAlign:"center",marginTop:8}}>제출 완료 · 당일 다시 제출 가능</div>
        )}
        {weekData.submitted&&!canResubmit&&(
          <div style={{fontSize:"0.69rem",color:C.green,textAlign:"center",marginTop:8}}>✓ 제출 완료</div>
        )}
      </div>
    </div>
  );
}

// ── Prayer ────────────────────────────────────────────────────────────────────
function PrayerTab({weekDates,weekData,updateWeek,scheduleData,timerRunning,setTimerRunning,timerElapsed,setTimerElapsed,timerMode,setTimerMode,timerTarget,setTimerTarget,timerActiveDay,setTimerActiveDay}) {
  const todayKey=toDateStr(getNow());
  const validKey=weekDates.find(d=>toDateStr(d)===todayKey)?todayKey:toDateStr(weekDates[0]);
  // activeDay 초기값: 저장된 값 있으면 유지, 없으면 오늘
  const [activeDay,setActiveDay]=useState(()=>timerActiveDay||validKey);
  const running=timerRunning, setRunning=setTimerRunning;
  const elapsed=timerElapsed, setElapsed=setTimerElapsed;
  const mode=timerMode, setMode=setTimerMode;
  const [editingDay,setEditingDay]=useState(null);
  const dayBase=getDayEff(weekData,activeDay);

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
  const activeWeekKey = weekDates[0] ? toDateStr(weekDates[0]) : "";
  const hasCurrentReadingChecked = countCheckedBibleReading(
    weekData.readingChecked,
    buildBibleReadingSections(scheduleData?.reading || [], activeWeekKey)
  ) > 0;

  const toggleDawn=(key)=>{
    const d=parseDate(key);
    if(d.getDay()===0) return;
    const wasOn = weekData.dawnService?.[key];
    const bonusPatch = wasOn ? applyBonusRemove(weekData,key,3600) : applyBonusAdd(weekData,key,3600);
    updateWeek({ dawnService:{...(weekData.dawnService||{}),[key]:!wasOn}, ...bonusPatch });
  };

  const updateDayPrayerTime = (key, newEff) => {
    const safeEff = Math.max(0, Number(newEff) || 0);
    const bonus = weekData.bonusSeconds?.[key] || 0;
    const patch = {
      dailySeconds: {
        ...(weekData.dailySeconds || {}),
      },
    };

    if(weekData.dawnService?.[key] && safeEff < 3600) {
      patch.dawnService = {
        ...(weekData.dawnService || {}),
        [key]: false,
      };
    }

    if(safeEff < bonus) {
      patch.bonusSeconds = {
        ...(weekData.bonusSeconds || {}),
        [key]: 0,
      };

      if(weekData.hagadaBonus && weekData.hagadaBonusKey === key) {
        const hagadaTarget = Number(scheduleData?.hagadaTarget || 700);
        const hagadaCount = Number(weekData.hagadaCount || 0);
        patch.hagadaCount = Math.max(0, hagadaCount - hagadaTarget);
        patch.hagadaDone = false;
        patch.hagadaBonus = false;
        patch.hagadaBonusKey = null;
      }

      if(fridayKey === key && weekData.fridayService) {
        patch.fridayService = false;
        patch.fridayBonus = 0;
      }

      if(weekData.attendancePrayerBonus === key) {
        patch.attendancePrayerBonus = "";
      }

      patch.dailySeconds[key] = safeEff;
      updateWeek(patch);
      return;
    }

    patch.dailySeconds[key] = Math.max(0, safeEff - bonus);
    updateWeek(patch);
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
                {showPrayList?"닫기":"수정"}
              </button>
            </div>
          </div>

          {showPrayList&&(
            <div style={{marginTop:10}}>
              {weekDates.map((d,i)=>{
                const key=toDateStr(d);
                const eff=getDayEff(weekData,key);
                const hasDawn=weekData.dawnService?.[key]&&eff>0;
                const hasFri=d.getDay()===5&&weekData.fridayService;
                const hasHagada=weekData.hagadaBonus&&weekData.hagadaBonusKey===key;
                const hasPrayerFile=weekData.prayerFile&&eff>0;
                const hasSpiritNotes=Boolean(weekData.spiritNotes)&&eff>0;
                const hasReading=hasCurrentReadingChecked&&eff>0;
                const hasWhole=weekData.wholeReadingDone&&eff>0;
                return (
                  <div key={key} style={{borderBottom:i<6?`1px solid ${C.border}`:"none"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0"}}>
                      <div style={{display:"flex",alignItems:"center",gap:5}}>
                        <span style={{fontSize:"0.81rem",color:C.muted,minWidth:24}}>{WEEK_DAYS[i]}</span>
                        <span style={{fontSize:"0.625rem",color:C.muted}}>{d.getMonth()+1}/{d.getDate()}</span>
                        {hasDawn&&<span style={{fontSize:"0.625rem",color:C.blue,fontWeight:700}}>{d.getDay()===6?"🙏":"🌅"}</span>}
                        {hasFri&&<span style={{fontSize:"0.625rem",color:C.purple,fontWeight:700}}>🔥</span>}
                        {hasHagada&&<span style={{fontSize:"0.625rem",color:C.gold,fontWeight:700}}>🗣️</span>}
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}} onClick={e=>e.stopPropagation()}>
                        <HourMinutePicker
                          theme={C}
                          compact
                          seconds={eff}
                          onChange={(newEff)=>updateDayPrayerTime(key, newEff)}
                        />
                      </div>
                    </div>
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
            <span>파일기도</span>
          </div>
          <CompletionChoice
            done={weekData.prayerFile}
            color={C.green}
            ariaLabel="파일기도 완료 여부"
            onSelect={async (next) => {
              if (next === weekData.prayerFile) return;
              if (!next && !await confirmUncheck("파일기도")) return;
              updateWeek({ prayerFile:next });
            }}
          />
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
                        updateWeek({fridayService:true,fridayBonus:sec,...applyBonusAdd(weekData,friKey,sec)});
                      }}>{lbl}</button>
                  ))}
                </div>
                :<button style={{padding:"5px 10px",borderRadius:7,border:`1px solid ${C.red}44`,background:"transparent",color:C.red,fontSize:"0.69rem",fontWeight:700,cursor:"pointer"}}
                  onClick={()=>{
                    const friKey=weekDates.find(d=>d.getDay()===5)?toDateStr(weekDates.find(d=>d.getDay()===5)):null;
                    if(!friKey)return;
                    const bonus=weekData.fridayBonus||7200;
                    updateWeek({fridayService:false,fridayBonus:0,...applyBonusRemove(weekData,friKey,bonus)});
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
  const readingChecked = weekData.readingChecked || {};
  const safeBibleReading = Array.isArray(bibleReading)
    ? bibleReading
        .filter(section => section && section.book && Array.isArray(section.chapters))
        .map(section => ({...section, chapters: section.chapters.filter(ch => ch !== undefined && ch !== null && ch !== "")}))
        .filter(section => section.chapters.length > 0)
    : [];
  const totalChapters=safeBibleReading.reduce((a,b)=>a+b.chapters.length,0);
  const checkedCount=countCheckedBibleReading(readingChecked, safeBibleReading);
  const allDone=totalChapters>0&&checkedCount>=totalChapters;
  // Modified: update auto-backup conditions for reading
  const toggle=async (book,ch)=>{
    const key = getReadingKey(book, ch);
    const cur = !!readingChecked[key];
    if(allDone && cur && !await confirmUncheck("통독")) return;
    const next = {...readingChecked,[key]:!cur};
    updateWeek({readingChecked:next});
  };
  const setAllReadingDone = async (nextDone) => {
    if (nextDone === allDone) return;
    if (!nextDone && !await confirmUncheck("통독")) return;
    const next = {...readingChecked};
    safeBibleReading.forEach(s=>s.chapters.forEach(c=>{next[getReadingKey(s.book,c)]=nextDone;}));
    updateWeek({readingChecked:next});
  };
  // 통독 범위 요약 (열왕기상 9~22장 형식)
  const readingRangeLabel = safeBibleReading.map(s=>{
    const chs = s.chapters;
    return `${s.book} ${chs[0]}~${chs[chs.length-1]}장`;
  }).join(', ');

  return (
    <div>
      <div style={{...getInputCard(),background:`linear-gradient(135deg,${C.surface2} 0%,${C.surface} 100%)`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,marginBottom:10}}>
          <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text}}>
            <span style={{fontSize:"1rem"}}>📖</span>
            <span>성경통독</span>
          </div>
          <CompletionChoice
            done={allDone}
            color={C.blue}
            ariaLabel="통독 전체 완료 여부"
            onSelect={setAllReadingDone}
          />
        </div>
        <div style={{borderRadius:10,border:`1px solid ${C.blue}33`,background:C.surface,padding:"11px 12px"}}>
          <div style={{fontSize:"0.69rem",color:C.muted,marginBottom:7,lineHeight:1.5,wordBreak:"keep-all"}}>
            이번 주 범위: {readingRangeLabel || "통독 범위 없음"}
          </div>
          <div style={{fontSize:"1.875rem",fontWeight:800,color:allDone?C.green:C.blue,lineHeight:1}}>
            {checkedCount}<span style={{fontSize:"0.94rem",color:C.muted}}>/{totalChapters}장</span>
          </div>
          <div style={{height:5,background:C.border,borderRadius:3,margin:"10px 0 0"}}>
            <div style={{height:"100%",width:`${totalChapters>0?(checkedCount/totalChapters)*100:0}%`,background:allDone?C.green:C.blue,borderRadius:3,transition:"width 0.3s"}}/>
          </div>
        </div>
        <div style={{marginTop:10}}>
          {safeBibleReading.length===0
            ? <div style={{textAlign:"center",padding:"22px 12px",borderRadius:10,border:`1px dashed ${C.border}`,background:C.surface}}>
                <div style={{fontSize:"2rem",marginBottom:8}}>📂</div>
                <div style={{color:C.muted}}>이번 주 통독 데이터 없음</div>
                <div style={{color:C.muted,fontSize:"0.75rem",marginTop:4}}>설정 → 엑셀 업로드</div>
              </div>
            : safeBibleReading.map((section,si)=>(
                <div key={si} style={{borderRadius:10,border:`1px solid ${C.border}`,background:C.surface,padding:12,marginTop:si===0?0:8}}>
                  <label style={{...getLbl(),marginBottom:8}}>{section.book}</label>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,2.75rem)",gap:4,justifyContent:"start"}}>
                    {section.chapters.map(ch=>{
                      const checked=readingChecked[getReadingKey(section.book,ch)];
                      return <button key={ch} onClick={()=>toggle(section.book,ch)} style={{width:"2.75rem",height:"1.8rem",borderRadius:6,border:`1px solid ${checked?C.blue:C.border}`,background:checked?`${C.blue}22`:C.bg,color:checked?C.blue:C.muted,fontSize:"0.72rem",fontWeight:checked?700:400,cursor:"pointer",padding:"0 2px",whiteSpace:"nowrap",boxSizing:"border-box",textAlign:"center",display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>{ch}장</button>;
                    })}
                  </div>
                </div>
              ))
          }
        </div>
      </div>
      <div style={getInputCard()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontWeight:700,fontSize:"0.875rem"}}>📜 성경 전체 1독</div>
            <div style={{fontSize:"0.69rem",color:C.muted,marginTop:2,lineHeight:1.55,wordBreak:"keep-all"}}>
              창세기~요한계시록까지 1독을 완료하셨다면 체크해 주세요
            </div>
          </div>
          <CompletionChoice
            done={weekData.wholeReadingDone}
            color={C.gold}
            ariaLabel="성경 전체 1독 완료 여부"
            onSelect={async (next) => {
              if (next === weekData.wholeReadingDone) return;
              if (!next && !await confirmUncheck("성경 1독")) return;
              updateWeek({ wholeReadingDone:next });
            }}
          />
        </div>
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
  const memoryStatus = getMemoryDisplayStatus(weekData.memoryDone, weekData.memoryErrors);
  const setMemoryDone = async (next) => {
    if (next === memoryStatus.completed) return;
    if (!next) {
      if (!await confirmUncheck("암송")) return;
      updateWeek({ memoryDone:false, memoryErrors:0 });
      return;
    }
    updateWeek({ memoryDone:true, memoryErrors:0 });
  };
  const hagadaTarget = Number(scheduleData?.hagadaTarget || 700);
  const hagadaCount = Number(weekData.hagadaCount || 0);
  const hagadaDisplayTarget = hagadaCount >= 300 ? hagadaTarget : 300;
  const easyModeForBonus = load("easyMode", false);
  const getHagadaBonusKey = () => {
    const todayKey = toDateStr(getNow());
    const tuesdayKey = toDateStr(weekDates[0]);
    const weekDateKeys = weekDates.map(d2 => toDateStr(d2));
    return weekDateKeys.includes(todayKey) ? todayKey : tuesdayKey;
  };
  const applyEasyHagadaBonus = (patch, deltaSec) => {
    if(easyModeForBonus && deltaSec !== 0) {
      patch.easyTotalPrayerSec = getEasyTotalPrayerSecWithDelta(weekData, weekDates, deltaSec);
    }
  };
  const applyHagadaCompletion = (patch, nextCount) => {
    if(nextCount >= 300 && !weekData.memoryDone) {
      patch.memoryDone = true;
      patch.memoryErrors = 0;
    }

    if(nextCount < hagadaTarget) {
      if(weekData.hagadaDone) patch.hagadaDone = false;
      if(weekData.hagadaBonus) {
        const bonusKey = weekData.hagadaBonusKey;
        patch.hagadaBonus = false;
        patch.hagadaBonusKey = null;
        if(bonusKey) {
          Object.assign(patch, applyBonusRemove(weekData, bonusKey, 3600));
          applyEasyHagadaBonus(patch, -3600);
        }
      }
      return;
    }

    patch.hagadaDone = true;

    if(!weekData.hagadaBonus) {
      const bonusKey = getHagadaBonusKey();
      patch.hagadaBonus = true;
      patch.hagadaBonusKey = bonusKey;
      Object.assign(patch, applyBonusAdd(weekData, bonusKey, 3600));
      applyEasyHagadaBonus(patch, 3600);
    }

  };
  const addHagadaCount = (amount = 1) => {
    const nextCount = Math.max(0, hagadaCount + amount);
    const patch = { hagadaCount: nextCount };

    applyHagadaCompletion(patch, nextCount);

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

  return (
    <div>
      {/* 1. 암송 구절 */}
      {!verses.length ? (
        <div style={{...getCard(),textAlign:"center",padding:32}}><div style={{fontSize:"2rem",marginBottom:8}}>📂</div><div style={{color:C.muted,fontSize:"0.875rem"}}>이번 주 암송 데이터 없음</div><div style={{color:C.muted,fontSize:"0.75rem",marginTop:4}}>schedule.json을 확인하세요</div></div>
      ) : (
        <div style={{...getCard(),background:`linear-gradient(135deg,${C.surface2} 0%,${C.surface} 100%)`,border:`1px solid ${C.purple}44`}}>
          {verses.map((v,i)=>(
            <div key={i} style={{marginBottom: i < verses.length-1 ? 16 : 0}}>
              <div style={{fontSize:"0.75rem",color:C.purple,fontWeight:700,marginBottom:6}}>{v.reference}</div>
              <div style={{fontSize:"0.875rem",lineHeight:1.25,color:C.text}}>{v.text}</div>
              {i < verses.length-1 && <div style={{height:1,background:`${C.purple}33`,marginTop:16}}/>}
            </div>
          ))}
        </div>
      )}

      {/* 2. 하가다 - 암송 데이터 없을 때도 항상 렌더링 */}
      <div style={{...getCard(),borderLeft:`3px solid ${C.gold}`,paddingLeft:13}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
          <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text}}>
            <span style={{fontSize:"1rem"}}>🔁</span><span>하가다</span>
          </div>
          <CompletionChoice
            done={weekData.hagadaDone}
            color={C.green}
            ariaLabel="하가다 완료 여부"
            onSelect={async (next) => {
              const done=weekData.hagadaDone;
              if (next === done) return;
              if(!next && !await confirmUncheck("하가다")) return;
              const nextCount=next?Math.max(hagadaCount,hagadaTarget):Math.max(0,hagadaCount-hagadaTarget);
              const patch={hagadaCount:nextCount};
              applyHagadaCompletion(patch,nextCount);
              updateWeek(patch);
            }}
          />
        </div>
        <div style={{display:"flex",alignItems:"stretch",gap:10,marginBottom:8}}>
          <div style={{flex:1,borderRadius:14,border:`1px solid ${hagadaCount>=hagadaTarget?C.green:C.gold}55`,background:hagadaCount>=hagadaTarget?`${C.green}14`:`${C.gold}14`,padding:"10px 12px",display:"flex",flexDirection:"column",justifyContent:"center",minWidth:0}}>
            <div style={{fontSize:"0.625rem",color:C.muted,fontWeight:800,marginBottom:4}}>읊조리기 횟수 <span style={{fontSize:"0.56rem",fontWeight:400,marginLeft:4}}>✏️ 직접입력</span></div>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <input type="number" min={0} value={hagadaCount}
                onChange={e=>{
                  const v=Math.max(0,Number(e.target.value)||0);
                  const patch={hagadaCount:v};
                  applyHagadaCompletion(patch, v);
                  updateWeek(patch);
                }}
                style={{width:88,fontSize:"1.75rem",fontWeight:900,color:hagadaCount>=hagadaTarget?C.green:C.gold,background:"transparent",border:`1px dashed ${hagadaCount>=hagadaTarget?C.green:C.gold}55`,borderRadius:6,outline:"none",letterSpacing:"-0.04em",lineHeight:1,padding:"2px 4px",MozAppearance:"textfield",textAlign:"center"}}
              />
              <span style={{fontSize:"0.875rem",fontWeight:900,color:C.text}}>/ {hagadaDisplayTarget}회</span>
            </div>
          </div>
          <button type="button" onClick={()=>{haptic("medium");addHagadaCount(1);}}
            style={{width:118,borderRadius:14,border:`2px solid ${hagadaCount>=hagadaTarget?C.green:C.gold}`,background:hagadaCount>=hagadaTarget?`${C.green}24`:`${C.gold}24`,color:hagadaCount>=hagadaTarget?C.green:C.gold,cursor:"pointer",fontWeight:900,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:3,flexShrink:0,touchAction:"manipulation"}}>
            <span style={{fontSize:"1.35rem",lineHeight:1}}>＋1</span>
            <span style={{fontSize:"0.69rem",fontWeight:800}}>읊조리기</span>
          </button>
        </div>
        {weekData.hagadaBonus&&<div style={{fontSize:"0.69rem",color:C.green,fontWeight:800,marginTop:8,textAlign:"center"}}>✓ {hagadaTarget}회 이상! 기도시간 +1시간이 반영됩니다.</div>}
      </div>

      {verses.length > 0 && <>
      {/* 3. 암송 완료 */}
      <div style={{...getInputCard(),paddingTop:13,paddingBottom:13}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginBottom:weekData.memoryDone?12:0}}>
          <div style={{display:"flex",alignItems:"center",gap:6,fontWeight:800,fontSize:"0.875rem",color:C.text}}>
            <span style={{fontSize:"1rem"}}>🗣️</span><span>암송</span>
          </div>
          <CompletionChoice
            done={memoryStatus.completed}
            color={C.purple}
            ariaLabel="암송 완료 여부"
            onSelect={setMemoryDone}
          />
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
      </>}

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
    const submitted = !!wd.submitted;
    if(!submitted) return null;
    const dates=getWeekDates(wk);
    const calculatedSec=dates.reduce((s,d)=>s+getDayEff(wd,toDateStr(d)),0);
    const calculatedPrayD=Math.min(dates.filter(d=>getDayEff(wd,toDateStr(d))>=3600).length, 6);
    const calculatedRead=countCheckedBibleReading(
      wd.readingChecked,
      buildBibleReadingSections(scheduleData?.reading || [], wk)
    );
    const attendanceBonusSec = getAttendancePrayerBonusSec(wd);
    const sec = wd.submittedTotalPrayerSec !== undefined
      ? Math.max(0, (Number(wd.submittedTotalPrayerSec)||0) - attendanceBonusSec)
      : wd.submitTotalPrayerSec !== undefined
        ? Math.max(0, (Number(wd.submitTotalPrayerSec)||0) - attendanceBonusSec)
        : wd.easyTotalPrayerSec !== undefined
          ? Math.max(0, (Number(wd.easyTotalPrayerSec)||0) - attendanceBonusSec)
          : calculatedSec;
    const prayD = wd.submittedPrayDays !== undefined
      ? Math.max(0, Math.min(6, Number(wd.submittedPrayDays)||0))
      : wd.submitPrayDays !== undefined
        ? Math.max(0, Math.min(6, Number(wd.submitPrayDays)||0))
        : wd.easyPrayDays !== undefined
          ? Math.max(0, Math.min(6, Number(wd.easyPrayDays)||0))
          : calculatedPrayD;
    const read = wd.submittedReadingCount !== undefined
      ? Math.max(0, Number(wd.submittedReadingCount)||0)
      : calculatedRead;
    const dawn=dates.filter(d=>{
      const key=toDateStr(d);
      return d.getDay()!==0 && d.getDay()!==6 && wd.dawnService?.[key];
    }).length;
    const hagada=wd.submittedHagadaCount !== undefined
      ? Math.max(0, Number(wd.submittedHagadaCount)||0)
      : Number(wd.hagadaCount||0);
    const end=toDateStr(dates[6]);
    const memoryCompleted = wd.submittedMemoryDone !== undefined
      ? !!wd.submittedMemoryDone
      : getMemoryDisplayStatus(wd.memoryDone, wd.memoryErrors).completed;
    const wholeCompleted = wd.submittedWholeReadingDone !== undefined
      ? !!wd.submittedWholeReadingDone
      : !!wd.wholeReadingDone;
    const verseRefs=memoryCompleted ? getMemoryVersesForWeek(scheduleData?.verses||[], wk).map(v=>v.reference) : [];
    return {wk,end,sec,prayD,read,dawn,hagada,whole:wholeCompleted?1:0,memory:memoryCompleted?1:0,verseRefs,submitted};
  }).filter(Boolean),[period]);

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
          ?<div style={{...getCard(),textAlign:"center",padding:32,color:C.muted}}>제출 완료된 주간 데이터가 없습니다</div>
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

// ── Admin ─────────────────────────────────────────────────────────────────────
function AdminTab({scheduleData, onFbQuery, bibleReading, memoryVerseGroup}) {
  const currentUserInfo = adminAuth.getUserInfo();
  const isRoot = currentUserInfo?.role === 'root';

  // ── 사용자 관리 상태 ──
  const [userList, setUserList] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState('');
  const [showAddUser, setShowAddUser] = useState(false);
  const [addUserType, setAddUserType] = useState('');
  const [addUserGroups, setAddUserGroups] = useState(null);
  const [addUserGroupDisp, setAddUserGroupDisp] = useState('');
  const [addUserMembers, setAddUserMembers] = useState([]);
  const [addUserGroupLoading, setAddUserGroupLoading] = useState(false);
  const [addUserName, setAddUserName] = useState('');
  const [addUserRole, setAddUserRole] = useState('admin');
  const [addUserLoading, setAddUserLoading] = useState(false);
  const [addUserError, setAddUserError] = useState('');
  const [expandedUserId, setExpandedUserId] = useState(null);

  const loadUsers = async () => {
    setUsersLoading(true);
    setUsersError('');
    try {
      const data = await adminAuth.listUsers();
      setUserList(data.list || []);
    } catch(e) {
      setUsersError(e.message || '사용자 목록 조회 실패');
    } finally { setUsersLoading(false); }
  };

  useEffect(() => { loadUsers(); }, []);

  const loadAddUserGroups = async (t) => {
    const cached = getCachedOrScheduleGroups(t, scheduleData);
    if (cached?.length) setAddUserGroups(cached);
    const rosterCache = loadFirebaseRosterCache(t);
    const age = rosterCache?.savedAt ? Date.now() - new Date(rosterCache.savedAt).getTime() : Infinity;
    if (rosterCache?.groups?.length && age < 24 * 60 * 60 * 1000) return;
    setAddUserGroupLoading(true);
    try {
      const teams = await fetchFirebaseTeamsConfig(t);
      const converted = mergeFirebaseGroupsWithSchedule(teams.map(team => convertTeamsConfigToGroup(team, t)), t, scheduleData);
      setAddUserGroups(converted);
      saveFirebaseRosterCache(t, converted);
    } catch(e) {
      setAddUserGroups(getCachedOrScheduleGroups(t, scheduleData));
    } finally { setAddUserGroupLoading(false); }
  };

  const resetAddUserForm = () => {
    setAddUserType(''); setAddUserGroups(null);
    setAddUserGroupDisp(''); setAddUserMembers([]);
    setAddUserName(''); setAddUserRole('admin'); setAddUserError('');
  };

  const handleAddUser = async () => {
    const selGroup = (addUserGroups||[]).find(g => getGroupDisplay(g) === addUserGroupDisp);
    const groupNum = selGroup ? normalizeTeamNumber(getGroupTeamName(selGroup) || '') : 0;
    if (!addUserType || !groupNum || !addUserName.trim()) {
      setAddUserError('중보구분, 조, 이름을 모두 선택해주세요.'); return;
    }
    setAddUserLoading(true); setAddUserError('');
    try {
      await adminAuth.addUser(addUserType, groupNum, addUserName.trim(), addUserRole);
      resetAddUserForm();
      setShowAddUser(false);
      await loadUsers();
    } catch(e) {
      setAddUserError(e.message || '등록 실패');
    } finally { setAddUserLoading(false); }
  };

  const handleToggleActive = async (u) => {
    if (!window.confirm(`${u.name}을(를) ${u.active ? '비활성화' : '활성화'}하시겠습니까?`)) return;
    try {
      await adminAuth.setUserActive(u.id, !u.active);
      await loadUsers();
    } catch(e) { alert(e.message); }
  };

  const handleResetPin = async (u) => {
    if (!window.confirm(`${u.name}의 PIN을 초기화하시겠습니까?`)) return;
    try {
      await adminAuth.adminResetPin(u.id);
      alert('PIN이 초기화되었습니다.');
      await loadUsers();
    } catch(e) { alert(e.message); }
  };

  const handleUnblock = async (u) => {
    if (!window.confirm(`${u.name}의 오류 횟수를 초기화(차단 해제)하시겠습니까?`)) return;
    try {
      await adminAuth.unblockUser(u.id);
      alert('오류 횟수가 초기화되었습니다.');
      await loadUsers();
    } catch(e) { alert(e.message); }
  };

  const handleUpdateRole = async (u) => {
    const roles = ['user', 'admin'];
    const next = roles.find(r => r !== u.role) || 'user';
    if (!window.confirm(`${u.name}의 역할을 "${u.role}" → "${next}"로 변경하시겠습니까?`)) return;
    try {
      await adminAuth.updateRole(u.id, next);
      await loadUsers();
    } catch(e) { alert(e.message); }
  };

  const handleDeleteUser = async (u) => {
    if (!window.confirm(`"${u.intercessionType} ${u.group}조 ${u.name}"을(를) 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;
    try {
      await adminAuth.deleteUser(u.id);
      setExpandedUserId(null);
      await loadUsers();
    } catch(e) { alert(e.message); }
  };

  const [adminSubData, setAdminSubData] = useState({
    prayerType: "", group: "", name: "", date: getWeekKey(getNow()),
    attendance: "", attendReason: "", attendLateTime: "",
    churchLate: false, churchLateTime: "", churchLateReason: "",
    churchLeave: false, churchLeaveTime: "", churchLeaveReason: "",
    prayerDays: 0, prayerHours: 0,
    bibleReading: false, memoryDone: false, memoryErrors: 0,
    prayerFile: false, spiritNotes: "", wholeReading: false, isFilingManager: false,
  });
  const [adminSubGroups, setAdminSubGroups] = useState(null);
  const [adminSubMembers, setAdminSubMembers] = useState([]);
  const [adminSubLoading, setAdminSubLoading] = useState(false);
  const [adminSubSubmitting, setAdminSubSubmitting] = useState(false);
  const [adminSubLastDoc, setAdminSubLastDoc] = useState(null);
  const updateAdminSub = (u) => setAdminSubData(p => ({...p, ...u}));
  const verses = memoryVerseGroup?.verses||[];

  const loadAdminSubGroups = async (t) => {
    const cached = getCachedOrScheduleGroups(t, scheduleData);
    if (cached?.length) setAdminSubGroups(cached);
    const rosterCache = loadFirebaseRosterCache(t);
    const age = rosterCache?.savedAt ? Date.now() - new Date(rosterCache.savedAt).getTime() : Infinity;
    if (rosterCache?.groups?.length && age < 24 * 60 * 60 * 1000) return;
    setAdminSubLoading(true);
    try {
      const teams = await fetchFirebaseTeamsConfig(t);
      const converted = mergeFirebaseGroupsWithSchedule(teams.map(team => convertTeamsConfigToGroup(team, t)), t, scheduleData);
      setAdminSubGroups(converted);
      saveFirebaseRosterCache(t, converted);
    } catch(e) {
      const fallback = getCachedOrScheduleGroups(t, scheduleData);
      setAdminSubGroups(fallback);
    } finally { setAdminSubLoading(false); }
  };

  const handleAdminSubSubmit = async () => {
    const { prayerType: asPT, group: asGrp, name: asName, date: asDate,
      attendance, attendReason, attendLateTime,
      churchLate, churchLateTime, churchLateReason,
      churchLeave, churchLeaveTime, churchLeaveReason,
      prayerDays, prayerHours, bibleReading, memoryDone, memoryErrors,
      prayerFile, spiritNotes, wholeReading, isFilingManager } = adminSubData;
    if (!asPT || !asGrp || !asName.trim()) { alert("중보구분, 조, 이름을 선택해주세요."); return; }
    if (!asDate) { alert("제출 날짜를 입력해주세요."); return; }
    if (!attendance) { alert("출석상태를 선택해주세요."); return; }
    const isChurch = asPT === "교회중보";
    if (isChurch) {
      if (attendance === "excused" && !attendReason) { alert("출석 인정 결석 사유를 입력해주세요."); return; }
      if (attendance === "absent" && !attendReason) { alert("결석 사유를 입력해주세요."); return; }
      if (churchLate && !churchLateTime) { alert("지각 시간을 입력해주세요."); return; }
      if (churchLate && !churchLateReason) { alert("지각 사유를 입력해주세요."); return; }
      if (churchLeave && !churchLeaveTime) { alert("조퇴 시간을 입력해주세요."); return; }
      if (churchLeave && !churchLeaveReason) { alert("조퇴 사유를 입력해주세요."); return; }
    } else {
      if (attendance === "late" && !attendLateTime) { alert("지각 시간을 입력해주세요."); return; }
      if (attendance === "late" && !attendReason) { alert("지각 사유를 입력해주세요."); return; }
      if (attendance === "leave" && !attendLateTime) { alert("조퇴 시간을 입력해주세요."); return; }
      if (attendance === "leave" && !attendReason) { alert("조퇴 사유를 입력해주세요."); return; }
      if (attendance === "excused" && !attendReason) { alert("출석 인정 결석 사유를 입력해주세요."); return; }
      if (attendance === "absent" && !attendReason) { alert("결석 사유를 입력해주세요."); return; }
    }
    const isLate = isChurch ? !!churchLate : attendance === "late";
    const isLeave = isChurch ? !!churchLeave : attendance === "leave";
    const isAbsent = attendance === "absent";
    const syntheticWeekData = { attendance, churchLate, churchLeave };
    const firebaseStatus = isChurch
      ? buildFirebaseChurchStatusString({ isChurchIntercession: true, weekData: syntheticWeekData, isLate, isLeave, isAbsent })
      : getAttendanceStatusForFirebase({ isChurchIntercession: false, weekData: syntheticWeekData, isLate, isLeave, isAbsent }).join(", ");
    const tardyReason = isChurch ? (isLate ? [churchLateReason, churchLateTime].filter(Boolean).join(" ") : "") : (isLate ? [attendReason, attendLateTime].filter(Boolean).join(" ") : "");
    const earlyLeaveReason = isChurch ? (isLeave ? [churchLeaveReason, churchLeaveTime].filter(Boolean).join(" ") : "") : (isLeave ? [attendReason, attendLateTime].filter(Boolean).join(" ") : "");
    const reasonExcused = attendance === "excused" ? (attendReason || "") : "";
    const reasonAbsent = isAbsent ? (attendReason || "") : "";
    const combinedReason = isChurch
      ? (reasonExcused || (isAbsent ? reasonAbsent : ""))
      : [reasonExcused, tardyReason ? `지각: ${tardyReason}` : "", earlyLeaveReason ? `조퇴: ${earlyLeaveReason}` : "", reasonAbsent ? `결석: ${reasonAbsent}` : ""].filter(Boolean).join(", ");
    const selectedGroup = (adminSubGroups||[]).find(g => getGroupDisplay(g) === asGrp);
    const teamName = getGroupTeamName(selectedGroup) || asGrp;
    const memoryLabel = memoryDone ? (Number(memoryErrors||0) === 0 ? "완료" : Number(memoryErrors||0) <= 3 ? "1~3글자 틀림" : "미완료") : "미완료";
    const firebaseRecord = {
      teamName, leader: "", name: asName.trim(), date: asDate,
      week: getPastorPrayerWeekNumber(asDate), status: firebaseStatus,
      reason: combinedReason, tardyReason, earlyLeaveReason,
      filePrayer: prayerFile ? "완료" : "미완료", bibleReading: bibleReading ? "완료" : "미완료",
      spiritGuidance: spiritNotes ? "있음" : "없음", bibleMemory: memoryLabel,
      dailyPrayer: Number(prayerDays||0), totalPrayerTime: Number(prayerHours||0),
      fullBibleReading: !!wholeReading, fullBibleReadingDate: wholeReading ? asDate : "",
      spiritGuidanceText: spiritNotes || "", isFilingManager: isChurch ? !!isFilingManager : false,
      scoreStatus: calcFirebaseScoreStatus(firebaseStatus), scoreFilePrayer: prayerFile ? 1 : 0,
      scoreBibleReading: bibleReading ? 1 : 0, scoreSpiritGuidance: spiritNotes ? 1 : 0,
      scoreBibleMemory: calcFirebaseMemoryScore(memoryDone, memoryErrors),
      scoreDailyPrayer: Number(prayerDays||0), scoreFullBibleReading: wholeReading ? 1 : 0,
    };
    const confirmMsg = ["📋 대리 제출 내용을 확인해주세요", "", `👤 ${asGrp}  ${asName}`, `📅 제출일: ${asDate} (${getPastorPrayerWeekNumber(asDate)}주차)`, `✅ 출석: ${firebaseStatus}`, `🙏 기도: ${prayerHours}시간 (${prayerDays}일)`, `📖 통독: ${bibleReading?"완료":"미완료"}`, `🗣️ 암송: ${memoryLabel}`, `📄 파일기도: ${prayerFile?"완료":"미완료"}`, `💫 성령인도: ${spiritNotes?"기록함":"미기록"}`, "", "대리 제출하시겠습니까?"].join("\n");
    if (!window.confirm(confirmMsg)) return;
    setAdminSubSubmitting(true); setAdminSubLastDoc(null);
    try {
      const firebaseConfig = getFirebaseTargetConfig(asPT);
      if (!firebaseConfig) throw new Error("Firebase 설정이 없습니다.");
      const result = await withTimeout(submitPastorPrayerToFirebase(firebaseRecord, firebaseConfig), 15000, "제출 시간이 초과되었습니다.");
      setAdminSubLastDoc({ docId: result.docId, prayerType: asPT, name: asName.trim() });
      alert(`✅ ${asName}님의 제출이 완료되었습니다.\n아래 확인하기 버튼으로 제출 내용을 조회할 수 있습니다.`);
    } catch(e) {
      alert(`제출에 실패했습니다.\n${e?.message || "알 수 없는 오류"}`);
    } finally { setAdminSubSubmitting(false); }
  };

  return (
    <>

      {/* 👥 사용자 관리 */}
      <div style={{...getCard(),border:`1px solid ${C.blue}44`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={{fontSize:"0.75rem",fontWeight:700,color:C.blue}}>👥 사용자 관리</div>
          <div style={{display:"flex",gap:6}}>
            <button style={{...btn("ghost"),padding:"4px 10px",fontSize:"0.69rem",color:C.green,border:`1px solid ${C.green}55`}}
              onClick={()=>{if(showAddUser){resetAddUserForm();}setShowAddUser(v=>!v);}}>

              {showAddUser?'취소':'+ 추가'}
            </button>
            <button style={{...btn("ghost"),padding:"4px 10px",fontSize:"0.69rem",color:C.blue,border:`1px solid ${C.blue}44`}}
              onClick={loadUsers} disabled={usersLoading}>
              {usersLoading?'로딩 중...':'새로고침'}
            </button>
          </div>
        </div>

        {/* 사용자 추가 폼 */}
        {showAddUser&&(
          <div style={{background:`${C.green}10`,border:`1px solid ${C.green}33`,borderRadius:8,padding:"10px 12px",marginBottom:12}}>
            <div style={{fontSize:"0.69rem",fontWeight:700,color:C.green,marginBottom:8}}>새 사용자 등록</div>

            {/* 중보구분 */}
            <div style={{marginBottom:8}}>
              <div style={{fontSize:"0.69rem",fontWeight:700,color:C.muted,marginBottom:5}}>중보구분</div>
              <div style={{display:"flex",gap:6}}>
                {['교회중보','목회자중보'].map(t=>(
                  <button key={t} style={{...btn(addUserType===t?'primary':'ghost'),flex:1,padding:"5px 0",fontSize:"0.69rem",background:addUserType===t?C.green:'transparent',borderColor:addUserType===t?C.green:C.border,color:addUserType===t?"#fff":C.muted}}
                    onClick={()=>{setAddUserType(t);setAddUserGroups(null);setAddUserGroupDisp('');setAddUserMembers([]);setAddUserName('');loadAddUserGroups(t);}}>
                    {t}
                  </button>
                ))}
              </div>
              {addUserGroupLoading&&<div style={{fontSize:"0.625rem",color:C.muted,marginTop:4}}>조 목록 로딩 중...</div>}
            </div>

            {/* 조 선택 */}
            {addUserGroups?.length>0&&(
              <div style={{marginBottom:8}}>
                <div style={{fontSize:"0.69rem",fontWeight:700,color:C.muted,marginBottom:5}}>조 선택</div>
                <select style={{...getInp(),width:"100%",padding:"6px 8px",fontSize:"0.75rem"}} value={addUserGroupDisp}
                  onChange={e=>{
                    const disp=e.target.value;
                    const g=(addUserGroups||[]).find(g=>getGroupDisplay(g)===disp);
                    const base=g?.members||[];
                    const leader=getGroupLeader(g);
                    setAddUserMembers(leader&&!base.includes(leader)?[leader,...base]:base);
                    setAddUserGroupDisp(disp);
                    setAddUserName('');
                  }}>
                  <option value="">선택하세요</option>
                  {addUserGroups.map(g=>(<option key={getGroupDisplay(g)} value={getGroupDisplay(g)}>{getGroupDisplay(g)}</option>))}
                </select>
              </div>
            )}

            {/* 이름 선택 (멤버 있을 때) */}
            {addUserMembers.length>0&&(
              <div style={{marginBottom:8}}>
                <div style={{fontSize:"0.69rem",fontWeight:700,color:C.muted,marginBottom:5}}>이름</div>
                <select style={{...getInp(),width:"100%",padding:"6px 8px",fontSize:"0.75rem"}} value={addUserName} onChange={e=>setAddUserName(e.target.value)}>
                  <option value="">선택하세요</option>
                  {addUserMembers.map(m=>(<option key={m} value={m}>{m}</option>))}
                </select>
              </div>
            )}

            {/* 이름 직접 입력 (조 선택됐으나 멤버 없을 때) */}
            {addUserGroupDisp&&addUserMembers.length===0&&(
              <div style={{marginBottom:8}}>
                <div style={{fontSize:"0.69rem",fontWeight:700,color:C.muted,marginBottom:5}}>이름 (직접 입력)</div>
                <input style={{...getInp(),width:"100%",padding:"6px 8px",fontSize:"0.75rem"}} placeholder="이름 입력" value={addUserName} onChange={e=>setAddUserName(e.target.value)}/>
              </div>
            )}

            {/* 역할 */}
            <div style={{marginBottom:8}}>
              <div style={{fontSize:"0.69rem",fontWeight:700,color:C.muted,marginBottom:5}}>역할</div>
              <div style={{display:"flex",gap:6}}>
                {[{v:'사용자',k:'user'},{v:'관리자',k:'admin'}].map(({v,k})=>(
                  <button key={k} style={{...btn(addUserRole===k?'primary':'ghost'),flex:1,padding:"5px 0",fontSize:"0.69rem",background:addUserRole===k?C.blue:'transparent',borderColor:addUserRole===k?C.blue:C.border,color:addUserRole===k?"#fff":C.muted}}
                    onClick={()=>setAddUserRole(k)}>
                    {v}
                  </button>
                ))}
              </div>
            </div>

            {addUserError&&<div style={{fontSize:"0.69rem",color:C.red,marginBottom:6}}>{addUserError}</div>}
            <button style={{...btn("primary"),width:"100%",padding:"7px 0",fontSize:"0.75rem",background:C.green,opacity:addUserLoading?0.6:1}}
              disabled={addUserLoading} onClick={handleAddUser}>
              {addUserLoading?'등록 중...':'등록'}
            </button>
          </div>
        )}

        {/* 오류 */}
        {usersError&&<div style={{fontSize:"0.69rem",color:C.red,marginBottom:8}}>{usersError}</div>}

        {/* 사용자 목록 */}
        {userList.length===0&&!usersLoading&&(
          <div style={{fontSize:"0.69rem",color:C.muted,textAlign:"center",padding:"12px 0"}}>등록된 사용자가 없습니다.</div>
        )}
        {userList.map(u=>{
          const isExpanded = expandedUserId===u.id;
          const blocked = u.passwordFailCount>=5||u.pinFailCount>=5;
          return (
            <div key={u.id} style={{borderBottom:`1px solid ${C.border}44`,paddingBottom:8,marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}
                onClick={()=>setExpandedUserId(isExpanded?null:u.id)}>
                <div>
                  <span style={{fontSize:"0.75rem",fontWeight:700,color:u.active?C.text:`${C.muted}88`}}>
                    {u.intercessionType} {u.group}조 {u.name}
                  </span>
                  <span style={{marginLeft:6,fontSize:"0.625rem",fontWeight:700,
                    color:u.role==='root'?C.red:u.role==='admin'?C.purple:C.muted,
                    background:u.role==='root'?`${C.red}18`:u.role==='admin'?`${C.purple}18`:`${C.muted}18`,
                    borderRadius:4,padding:"1px 5px"}}>
                    {u.role}
                  </span>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:5}}>
                  {!u.active&&<span style={{fontSize:"0.625rem",color:C.red,fontWeight:700}}>비활성</span>}
                  {blocked&&<span style={{fontSize:"0.625rem",color:C.accent,fontWeight:700}}>차단</span>}
                  {!u.pinRegistered&&<span style={{fontSize:"0.625rem",color:C.muted}}>PIN미등록</span>}
                  <span style={{color:C.muted,fontSize:"0.875rem"}}>{isExpanded?'▲':'▼'}</span>
                </div>
              </div>
              {isExpanded&&(
                <div style={{marginTop:8}}>
                  <div style={{fontSize:"0.625rem",color:C.muted,marginBottom:6,lineHeight:1.6}}>
                    비밀번호 오류: {u.passwordFailCount} · PIN 오류: {u.pinFailCount} · PIN: {u.pinRegistered?'등록':'미등록'}
                    {u.lastLoginAt&&` · 최근로그인: ${new Date(u.lastLoginAt).toLocaleDateString('ko-KR')}`}
                  </div>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                    <button style={{...btn("ghost"),padding:"4px 10px",fontSize:"0.625rem",
                      color:u.active?C.red:C.green,border:`1px solid ${u.active?C.red:C.green}55`}}
                      onClick={()=>handleToggleActive(u)}>
                      {u.active?'비활성화':'활성화'}
                    </button>
                    {(u.passwordFailCount>0||u.pinFailCount>0)&&(
                      <button style={{...btn("ghost"),padding:"4px 10px",fontSize:"0.625rem",color:C.accent,border:`1px solid ${C.accent}55`}}
                        onClick={()=>handleUnblock(u)}>
                        오류초기화
                      </button>
                    )}
                    {u.pinRegistered&&(
                      <button style={{...btn("ghost"),padding:"4px 10px",fontSize:"0.625rem",color:C.blue,border:`1px solid ${C.blue}55`}}
                        onClick={()=>handleResetPin(u)}>
                        PIN초기화
                      </button>
                    )}
                    {isRoot&&u.role!=='root'&&(
                      <button style={{...btn("ghost"),padding:"4px 10px",fontSize:"0.625rem",color:C.purple,border:`1px solid ${C.purple}55`}}
                        onClick={()=>handleUpdateRole(u)}>
                        역할변경
                      </button>
                    )}
                    <button style={{...btn("ghost"),padding:"4px 10px",fontSize:"0.625rem",color:C.red,border:`1px solid ${C.red}55`}}
                      onClick={()=>handleDeleteUser(u)}>
                      삭제
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 📋 대리 제출 */}
      <div style={{...getCard(),border:`1px solid ${C.purple}44`}}>
        <div style={{fontSize:"0.75rem",fontWeight:700,color:C.purple,marginBottom:12}}>📋 대리 제출</div>
        <div style={{marginBottom:10}}>
          <div style={{fontSize:"0.69rem",fontWeight:700,color:C.muted,marginBottom:6}}>중보구분</div>
          <div style={{display:"flex",gap:6}}>
            {["교회중보","목회자중보"].map(t=>(
              <button key={t} style={{...btn(adminSubData.prayerType===t?"primary":"ghost"),flex:1,padding:"6px 0",fontSize:"0.75rem"}}
                onClick={()=>{updateAdminSub({prayerType:t,group:"",name:""});setAdminSubGroups(null);setAdminSubMembers([]);loadAdminSubGroups(t);}}>
                {t}
              </button>
            ))}
          </div>
          {adminSubLoading&&<div style={{fontSize:"0.625rem",color:C.muted,marginTop:4}}>조 목록 로딩 중...</div>}
        </div>
        {adminSubGroups?.length>0&&(
          <div style={{marginBottom:10}}>
            <div style={{fontSize:"0.69rem",fontWeight:700,color:C.muted,marginBottom:6}}>조 선택</div>
            <select style={{...getInp(),width:"100%",padding:"6px 8px",fontSize:"0.75rem"}} value={adminSubData.group}
              onChange={e=>{const disp=e.target.value;const g=(adminSubGroups||[]).find(g=>getGroupDisplay(g)===disp);const base=g?.members||[];const leader=getGroupLeader(g);setAdminSubMembers(leader&&!base.includes(leader)?[leader,...base]:base);updateAdminSub({group:disp,name:""});}}>
              <option value="">선택하세요</option>
              {adminSubGroups.map(g=>(<option key={getGroupDisplay(g)} value={getGroupDisplay(g)}>{getGroupDisplay(g)}</option>))}
            </select>
          </div>
        )}
        {adminSubMembers.length>0&&(
          <div style={{marginBottom:10}}>
            <div style={{fontSize:"0.69rem",fontWeight:700,color:C.muted,marginBottom:6}}>이름</div>
            <select style={{...getInp(),width:"100%",padding:"6px 8px",fontSize:"0.75rem"}} value={adminSubData.name} onChange={e=>updateAdminSub({name:e.target.value})}>
              <option value="">선택하세요</option>
              {adminSubMembers.map(m=>(<option key={m} value={m}>{m}</option>))}
            </select>
          </div>
        )}
        {adminSubData.group&&adminSubMembers.length===0&&(
          <div style={{marginBottom:10}}>
            <div style={{fontSize:"0.69rem",fontWeight:700,color:C.muted,marginBottom:6}}>이름 (직접 입력)</div>
            <input style={{...getInp(),width:"100%",padding:"6px 8px",fontSize:"0.75rem"}} placeholder="이름 입력" value={adminSubData.name} onChange={e=>updateAdminSub({name:e.target.value})}/>
          </div>
        )}
        <div style={{marginBottom:10}}>
          <div style={{fontSize:"0.69rem",fontWeight:700,color:C.muted,marginBottom:6}}>제출 기준일 (화요일)</div>
          {(()=>{const tuesdays=Array.from({length:10},(_,i)=>{const d=parseDate(getWeekKey(getNow()));d.setDate(d.getDate()-i*7);return toDateStr(d);});return(<select style={{...getInp(),width:"100%",padding:"6px 8px",fontSize:"0.75rem"}} value={adminSubData.date} onChange={e=>updateAdminSub({date:e.target.value})}>{tuesdays.map(tue=>(<option key={tue} value={tue}>{getPastorPrayerWeekNumber(tue)}주차 ({tue})</option>))}</select>);})()}
        </div>
        <div style={{height:1,background:`${C.purple}22`,margin:"10px 0"}}/>
        <div style={{marginBottom:10}}>
          <div style={{fontSize:"0.69rem",fontWeight:700,color:C.muted,marginBottom:6}}>출석상태</div>
          {adminSubData.prayerType==="교회중보"?(
            // 교회중보: 출석/출석인정결석/결석 mutually exclusive + 지각·조퇴 독립 토글 (출석 내포)
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:5}}>
              {[["attend","출석",C.green],["excused","출석\n인정\n결석",C.blue],["late","지각",C.accent],["leave","조퇴",C.blue],["absent","결석",C.red]].map(([val,label,color])=>{
                const sel=val==="late"?!!adminSubData.churchLate:val==="leave"?!!adminSubData.churchLeave:val==="attend"?(adminSubData.attendance==="attend"&&!adminSubData.churchLate&&!adminSubData.churchLeave):adminSubData.attendance===val;
                return(<button key={val} style={{width:"100%",minHeight:52,padding:"6px 2px",borderRadius:8,fontSize:"0.69rem",fontWeight:700,border:`1.5px solid ${sel?color:C.border}`,background:sel?`${color}20`:C.surface,color:sel?color:C.muted,cursor:"pointer",whiteSpace:"pre-line",lineHeight:1.3}}
                  onClick={()=>{
                    if(val==="late")updateAdminSub({churchLate:!adminSubData.churchLate,attendance:"attend"});
                    else if(val==="leave")updateAdminSub({churchLeave:!adminSubData.churchLeave,attendance:"attend"});
                    else updateAdminSub({attendance:val,churchLate:false,churchLeave:false});
                  }}>{label}</button>);
              })}
            </div>
          ):(
            // 목회자중보: 5개 중 하나만
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:5}}>
              {[["attend","출석",C.green],["excused","출석\n인정\n결석",C.blue],["late","지각",C.accent],["leave","조퇴",C.blue],["absent","결석",C.red]].map(([val,label,color])=>(
                <button key={val} style={{width:"100%",minHeight:52,padding:"6px 2px",borderRadius:8,fontSize:"0.69rem",fontWeight:700,border:`1.5px solid ${adminSubData.attendance===val?color:C.border}`,background:adminSubData.attendance===val?`${color}20`:C.surface,color:adminSubData.attendance===val?color:C.muted,cursor:"pointer",whiteSpace:"pre-line",lineHeight:1.3}}
                  onClick={()=>updateAdminSub({attendance:val})}>{label}</button>
              ))}
            </div>
          )}
        </div>
        {adminSubData.prayerType!=="교회중보"&&(adminSubData.attendance==="late"||adminSubData.attendance==="leave")&&(
          <div style={{marginBottom:10,display:"flex",gap:6}}>
            <input style={{...getInp(),flex:"0 0 90px",padding:"6px 8px",fontSize:"0.75rem"}} placeholder="시간 (예: 10분)" value={adminSubData.attendLateTime} onChange={e=>updateAdminSub({attendLateTime:e.target.value})}/>
            <input style={{...getInp(),flex:1,padding:"6px 8px",fontSize:"0.75rem"}} placeholder={adminSubData.attendance==="late"?"지각 사유":"조퇴 사유"} value={adminSubData.attendReason} onChange={e=>updateAdminSub({attendReason:e.target.value})}/>
          </div>
        )}
        {adminSubData.prayerType!=="교회중보"&&(adminSubData.attendance==="excused"||adminSubData.attendance==="absent")&&(
          <div style={{marginBottom:10}}><input style={{...getInp(),width:"100%",padding:"6px 8px",fontSize:"0.75rem"}} placeholder={adminSubData.attendance==="excused"?"출석인정결석 사유":"결석 사유"} value={adminSubData.attendReason} onChange={e=>updateAdminSub({attendReason:e.target.value})}/></div>
        )}
        {adminSubData.prayerType==="교회중보"&&adminSubData.churchLate&&(
          <div style={{marginBottom:8,display:"flex",gap:6}}>
            <input style={{...getInp(),flex:"0 0 90px",padding:"6px 8px",fontSize:"0.75rem"}} placeholder="지각 시간" value={adminSubData.churchLateTime} onChange={e=>updateAdminSub({churchLateTime:e.target.value})}/>
            <input style={{...getInp(),flex:1,padding:"6px 8px",fontSize:"0.75rem"}} placeholder="지각 사유" value={adminSubData.churchLateReason} onChange={e=>updateAdminSub({churchLateReason:e.target.value})}/>
          </div>
        )}
        {adminSubData.prayerType==="교회중보"&&adminSubData.churchLeave&&(
          <div style={{marginBottom:8,display:"flex",gap:6}}>
            <input style={{...getInp(),flex:"0 0 90px",padding:"6px 8px",fontSize:"0.75rem"}} placeholder="조퇴 시간" value={adminSubData.churchLeaveTime} onChange={e=>updateAdminSub({churchLeaveTime:e.target.value})}/>
            <input style={{...getInp(),flex:1,padding:"6px 8px",fontSize:"0.75rem"}} placeholder="조퇴 사유" value={adminSubData.churchLeaveReason} onChange={e=>updateAdminSub({churchLeaveReason:e.target.value})}/>
          </div>
        )}
        {adminSubData.prayerType==="교회중보"&&(adminSubData.attendance==="excused"||adminSubData.attendance==="absent")&&(
          <div style={{marginBottom:8}}><input style={{...getInp(),width:"100%",padding:"6px 8px",fontSize:"0.75rem"}} placeholder={adminSubData.attendance==="excused"?"출석인정결석 사유":"결석 사유"} value={adminSubData.attendReason} onChange={e=>updateAdminSub({attendReason:e.target.value})}/></div>
        )}
        <div style={{height:1,background:`${C.purple}22`,margin:"10px 0"}}/>
        <div style={{marginBottom:10,display:"flex",gap:8}}>
          <div style={{flex:1}}>
            <div style={{fontSize:"0.69rem",fontWeight:700,color:C.muted,marginBottom:4}}>기도 시간 (시)</div>
            <select style={{...getInp(),width:"100%",padding:"6px 8px",fontSize:"0.75rem"}} value={adminSubData.prayerHours} onChange={e=>updateAdminSub({prayerHours:Number(e.target.value)})}>
              {Array.from({length:51},(_,i)=>(<option key={i} value={i}>{i}시간</option>))}
            </select>
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:"0.69rem",fontWeight:700,color:C.muted,marginBottom:4}}>1시간↑ 기도일수</div>
            <div style={{display:"flex",gap:3}}>
              {[0,1,2,3,4,5,6].map(d=>(<button key={d} style={{flex:1,padding:"4px 0",borderRadius:6,fontSize:"0.69rem",fontWeight:700,border:`1.5px solid ${adminSubData.prayerDays===d?C.purple:C.border}`,background:adminSubData.prayerDays===d?`${C.purple}20`:C.surface,color:adminSubData.prayerDays===d?C.purple:C.muted,cursor:"pointer"}} onClick={()=>updateAdminSub({prayerDays:d})}>{d}</button>))}
            </div>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
          {[{key:"bibleReading",label:"📖 통독",desc:"완료"},{key:"prayerFile",label:"📄 파일기도",desc:"완료"},{key:"wholeReading",label:"📚 성경 1독",desc:"완료"},...(adminSubData.prayerType==="교회중보"?[{key:"isFilingManager",label:"🗂️ 파일링 담당",desc:"예"}]:[])].map(({key,label,desc})=>(
            <button key={key} style={{padding:"8px 10px",borderRadius:8,fontSize:"0.69rem",fontWeight:700,border:`1.5px solid ${adminSubData[key]?C.green:C.border}`,background:adminSubData[key]?`${C.green}18`:C.surface,color:adminSubData[key]?C.green:C.muted,cursor:"pointer",textAlign:"left"}} onClick={()=>updateAdminSub({[key]:!adminSubData[key]})}>
              {label}<br/><span style={{fontWeight:400,fontSize:"0.625rem"}}>{adminSubData[key]?desc:"미완료"}</span>
            </button>
          ))}
        </div>
        <div style={{marginBottom:10}}>
          <div style={{fontSize:"0.69rem",fontWeight:700,color:C.muted,marginBottom:6}}>🗣️ 암송</div>
          <div style={{display:"flex",gap:5}}>
            {[["완료",true,0,C.green],["1~3오류",true,2,C.accent],["미완료",false,0,C.muted]].map(([label,done,errors,color])=>{
              const sel=adminSubData.memoryDone===done&&(done?Number(adminSubData.memoryErrors||0)===(errors===2?2:0):true);
              return(<button key={label} style={{flex:1,padding:"6px 4px",borderRadius:8,fontSize:"0.69rem",fontWeight:700,border:`1.5px solid ${sel?color:C.border}`,background:sel?`${color}20`:C.surface,color:sel?color:C.muted,cursor:"pointer"}} onClick={()=>updateAdminSub({memoryDone:done,memoryErrors:errors})}>{label}</button>);
            })}
          </div>
        </div>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:"0.69rem",fontWeight:700,color:C.muted,marginBottom:4}}>💫 성령인도 내용 (선택)</div>
          <textarea style={{...getInp(),width:"100%",padding:"6px 8px",fontSize:"0.75rem",minHeight:60,resize:"vertical"}} placeholder="성령 인도 내용 (없으면 비워두세요)" value={adminSubData.spiritNotes} onChange={e=>updateAdminSub({spiritNotes:e.target.value})}/>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button style={{...btn("primary"),flex:1,padding:10,fontSize:"0.81rem",background:C.purple,opacity:adminSubSubmitting?0.6:1}} disabled={adminSubSubmitting} onClick={handleAdminSubSubmit}>
            {adminSubSubmitting?"제출 중...":"대리 제출"}
          </button>
          <button style={{...btn("ghost"),flex:1,padding:10,fontSize:"0.81rem",border:`1px solid ${C.purple}55`,color:C.purple}}
            onClick={()=>{
              if(!adminSubData.prayerType||!adminSubData.group||!adminSubData.name.trim()){alert("중보구분, 조, 이름을 먼저 선택해주세요.");return;}
              const week=getPastorPrayerWeekNumber(adminSubData.date);
              const selGrp=(adminSubGroups||[]).find(g=>getGroupDisplay(g)===adminSubData.group);
              const teamNumber=normalizeTeamNumber(getGroupTeamName(selGrp)||adminSubData.group);
              const safeName=buildFirebaseSafeMemberName(adminSubData.name.trim());
              const docId=`wk${week}_team${teamNumber}_${safeName}`;
              if(onFbQuery) onFbQuery(docId,adminSubData.prayerType);
            }}>
            🔍 확인하기
          </button>
        </div>
      </div>

      {/* 🧪 테스트 */}
      <div style={{...getCard(),border:`1px solid ${C.red}44`}}>
        <div style={{fontSize:"0.75rem",fontWeight:700,color:C.red,marginBottom:12}}>🧪 테스트</div>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:"0.69rem",fontWeight:700,color:C.muted,marginBottom:6}}>🗓 테스트 날짜</div>
          <div style={{fontSize:"0.625rem",color:C.muted,marginBottom:8,lineHeight:1.6}}>오늘 날짜를 직접 지정합니다. 저장 후 자동 새로고침됩니다.</div>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <input type="date" id="test-date-input" defaultValue={localStorage.getItem("__testDate")||toDateStr(new Date())} style={{...getInp(),flex:1,minWidth:0,padding:"6px 6px",fontSize:"0.75rem"}}/>
            <button style={{...btn("primary"),padding:"7px 12px",fontSize:"0.75rem",flexShrink:0}} onClick={()=>{const v=document.getElementById("test-date-input").value;if(v){localStorage.setItem("__testDate",v);localStorage.removeItem("__testDateOffset");}else{localStorage.removeItem("__testDate");}window.location.reload();}}>적용</button>
            <button style={{...btn("ghost"),padding:"7px 10px",fontSize:"0.75rem",color:C.red,border:`1px solid ${C.red}44`,flexShrink:0}} onClick={()=>{localStorage.removeItem("__testDate");localStorage.removeItem("__testDateOffset");window.location.reload();}}>초기화</button>
          </div>
          {localStorage.getItem("__testDate")&&(<div style={{marginTop:6,fontSize:"0.69rem",fontWeight:700,color:C.red}}>⚠️ 테스트 날짜 지정 중: {toDateStr(getNow())}</div>)}
        </div>
      </div>

      {/* 📌 앱 내장 데이터 현황 */}
      <div style={{...getCard()}}>
        <div style={{fontSize:"0.69rem",color:C.accent,fontWeight:700,marginBottom:8}}>📌 앱 내장 데이터 현황</div>
        <div style={{fontSize:"0.69rem",color:C.text,marginBottom:4}}><span style={{color:C.accent,fontWeight:700}}>목회자중보 </span>{(loadFirebaseRosterCache("목회자중보")?.groups||[]).map(g=>g.leader?`${Number(g.no)}조 (${g.leader})`:`${Number(g.no)}조`).join(", ")||"미로드"}</div>
        <div style={{fontSize:"0.69rem",color:C.text,marginBottom:4}}><span style={{color:C.accent,fontWeight:700}}>교회중보 </span>{(loadFirebaseRosterCache("교회중보")?.groups||[]).map(g=>g.partName||"").join(", ")||"미로드"}</div>
        {bibleReading.length>0&&(<div style={{fontSize:"0.69rem",color:C.text,marginBottom:4}}><span style={{color:C.blue,fontWeight:700}}>이번 주 통독 </span>{bibleReading.map(s=>`${s.book} ${s.chapters[0]}~${s.chapters.at(-1)}장`).join(", ")}</div>)}
        {verses.length>0&&(<div style={{fontSize:"0.69rem",color:C.text,marginBottom:4}}><span style={{color:C.purple,fontWeight:700}}>암송 대상 ({verses.length}절) </span>{verses.map(v=>v.reference).join(", ")}</div>)}
        <div style={{fontSize:"0.625rem",color:C.muted,marginTop:8,lineHeight:1.6}}>schedule.json 파일만 수정하면 재배포 없이 즉시 반영됩니다.</div>
      </div>
    </>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────────
  function SettingsTab({profile,groups,scheduleRange,weekKey,bibleReading,memoryVerseGroup,easyMode,easyModeLevel,setEasyMode,setEasyModeEnabled,themeMode,activeTheme,setThemeMode,scheduleData,onSave,onBack,onFbQuery,adminUnlocked,onAdminClick}) {
  const fileInputRef = useRef(null);
  const [pkg,setPkg]=useState(null);
  useEffect(()=>{
    if(typeof __APP_VERSION__ === "undefined") {
      fetch("/package.json").then(r=>r.json()).then(setPkg).catch(()=>{});
    }
  },[]);

  const verses=memoryVerseGroup?.verses||[];

  const openManual = () => {
    window.open(`${import.meta.env.BASE_URL}user-manual.html?v=${Date.now()}`, "_self");
  };

  const fontSliderPct = ((Number(easyModeLevel) - 100) / 50) * 100;

  return (
    <div>
      {/* ── 쉬운모드 토글 ── */}
      <div style={{...getCard(),padding:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontSize:"0.875rem",fontWeight:800,color:C.text}}>🔍 쉬운모드</div>
            <div style={{fontSize:"0.69rem",color:C.muted,marginTop:3,lineHeight:1.5}}>
              {easyMode ? "폰트 150% · 제출탭만 표시 · 하단 네비 숨김" : "기본 화면"}
            </div>
          </div>
          <button
            onClick={()=>setEasyModeEnabled?.(!easyMode)}
            style={{
              position:"relative",width:52,height:28,borderRadius:999,
              background:easyMode?C.accent:C.border,
              border:"none",cursor:"pointer",transition:"background 0.2s",flexShrink:0,
              outline:"none",
            }}
          >
            <span style={{
              position:"absolute",top:3,
              left:easyMode?24:3,
              width:22,height:22,borderRadius:"50%",background:"#fff",
              transition:"left 0.2s",boxShadow:"0 1px 4px rgba(0,0,0,0.25)",display:"block"
            }}/>
          </button>
        </div>
      </div>

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

      {/* ── 데이터 백업 / 복원 ── */}
      <div style={{...getCard(),padding:14,background:`linear-gradient(135deg, ${C.surface} 0%, ${C.gradientEndBlue} 100%)`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:"0.875rem",fontWeight:800,color:C.text}}>💾 데이터 백업 / 복원</div>
          <div style={{padding:"3px 8px",borderRadius:999,background:C.blue+"18",border:"1px solid "+C.blue+"44",color:C.blue,fontSize:"0.625rem",fontWeight:800}}>로컬</div>
        </div>
        <div style={{fontSize:"0.69rem",color:C.muted,marginBottom:12,lineHeight:1.6}}>
          현재 기기의 데이터를 JSON 파일로 저장하고 복원합니다.
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <button
            style={{...btn("ghost"),padding:"10px 0",fontSize:"0.75rem",color:C.blue,border:`1px solid ${C.blue}55`}}
            onClick={async()=>{
              const ok = await exportLocalBackup();
              if(ok && !isNativeApp()) alert("백업 파일이 저장되었습니다.");
            }}
          >📥 백업 저장</button>
          <button
            style={{...btn("ghost"),padding:"10px 0",fontSize:"0.75rem",color:C.purple,border:`1px solid ${C.purple}55`}}
            onClick={()=>fileInputRef.current?.click()}
          >📤 백업 복원</button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          style={{display:"none"}}
          onChange={async(e)=>{
            const file=e.target.files?.[0];
            e.target.value="";
            if(!file) return;
            try {
              const ok=await importLocalBackup(file);
              if(ok){ alert("복원 완료. 앱을 재시작합니다."); window.location.reload(); }
            } catch(err){ alert(err.message); }
          }}
        />
      </div>

      {/* 버전 정보 */}
      <div style={{...getCard(),padding:14}}>
        <div style={{fontSize:"0.875rem",fontWeight:800,color:C.text,marginBottom:10}}>🏷️ 버전 정보</div>
        <div style={{background:C.bg,borderRadius:8,padding:"10px 12px",border:`1px solid ${C.border}`}}>
          <div style={{fontSize:"0.69rem",color:C.text,marginBottom:4,display:"flex",justifyContent:"space-between",gap:10}}>
            <span style={{color:C.muted,fontWeight:700}}>앱 버전</span>
            <span style={{fontWeight:800}}>v{typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : pkg?.version || "—"}</span>
          </div>
          <div style={{fontSize:"0.69rem",color:C.text,marginBottom:4,display:"flex",justifyContent:"space-between",gap:10}}>
            <span style={{color:C.muted,fontWeight:700}}>빌드</span>
            <span style={{fontWeight:700}}>{typeof __BUILD_DATE__ !== "undefined" ? __BUILD_DATE__ : "dev"}</span>
          </div>
          <div style={{fontSize:"0.69rem",color:C.text,display:"flex",justifyContent:"space-between",gap:10}}>
            <span style={{color:C.muted,fontWeight:700}}>JSON 버전</span>
            <span style={{fontWeight:800,textAlign:"right"}}>
              {scheduleData?.scheduleVersion || "—"}
              {scheduleData?.scheduleUpdatedAt ? ` (${scheduleData.scheduleUpdatedAt})` : ""}
            </span>
          </div>
        </div>
      </div>

      {/* ── 관리자 메뉴 ── */}
      <div style={{...getCard(),cursor:"pointer",padding:"14px 16px"}} onClick={onAdminClick}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:"1rem"}}>🔒</span>
            <span style={{fontWeight:700,fontSize:"0.875rem",color:C.text}}>관리자 메뉴</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:"0.69rem",color:adminAuth.isPinRegistered()?C.green:C.muted,fontWeight:600}}>{adminAuth.isPinRegistered()?"PIN 등록됨":"PIN 미등록"}</span>
            <span style={{color:C.muted,fontSize:"1.25rem",lineHeight:1}}>›</span>
          </div>
        </div>
      </div>

      {/* ── 정보 & 지원 ── */}
      <div style={{...getCard(),border:`1px solid ${C.border}`}}>
        <div style={{fontWeight:700,fontSize:"0.875rem",color:C.text,marginBottom:10}}>ℹ️ 정보 & 지원</div>
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
        <div style={{fontWeight:700,fontSize:"0.875rem",color:C.red,marginBottom:4}}>⚠️ 앱 초기화</div>
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

    </div>
  );
}
