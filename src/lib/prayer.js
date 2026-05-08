import { toDateStr, getWeekDates, filterByRange } from './utils.js';

export function getDayEff(wd, key) {
  return (wd.dailySeconds?.[key] || 0) + (wd.bonusSeconds?.[key] || 0);
}

export function applyBonusAdd(weekData, key, amount) {
  const cur = weekData.bonusSeconds?.[key] || 0;
  return { bonusSeconds: { ...(weekData.bonusSeconds || {}), [key]: cur + amount } };
}

export function applyBonusRemove(weekData, key, amount) {
  const inBonus = weekData.bonusSeconds?.[key] || 0;
  if (inBonus > 0) {
    return { bonusSeconds: { ...(weekData.bonusSeconds || {}), [key]: Math.max(0, inBonus - amount) } };
  }
  return { dailySeconds: { ...(weekData.dailySeconds || {}), [key]: Math.max(0, (weekData.dailySeconds?.[key] || 0) - amount) } };
}

export function calcWeekPrayerStats(wd, dates) {
  const totalSec = dates.reduce((s,d)=>s+getDayEff(wd,toDateStr(d)),0);
  const rawPrayDays = dates.filter(d=>getDayEff(wd,toDateStr(d))>=3600).length;
  return { totalSec, prayDays: Math.min(rawPrayDays, 6) };
}

export function buildDailySecondsFromEasyValues(dates, totalSec, prayDays) {
  const safeTotal = Math.max(0, Number(totalSec)||0);
  const safeDays = Math.max(0, Math.min(6, Number(prayDays)||0));
  const nextDaily = {};
  // 화~토 우선, 일(0) 제외, 6일까지
  const eligible = dates.filter(d=>d.getDay()!==0).slice(0,6);
  if(!eligible.length) return nextDaily;

  // 1. prayDays 만큼 각 날짜에 1시간씩
  eligible.slice(0, safeDays).forEach(d=>{ nextDaily[toDateStr(d)] = 3600; });

  // 2. 나머지 시간은 첫 번째 날(화요일)에 추가
  const baseTotal = safeDays * 3600;
  const remainder = Math.max(0, safeTotal - baseTotal);
  if(remainder > 0 || safeDays === 0) {
    const firstKey = toDateStr(eligible[0]);
    nextDaily[firstKey] = (nextDaily[firstKey] || 0) + remainder;
  }

  return nextDaily;
}

export function getEasyTotalPrayerSecWithDelta(weekData, dates, deltaSec) {
  const base = weekData.easyTotalPrayerSec !== undefined && weekData.easyTotalPrayerSec !== null
    ? Math.max(0, Number(weekData.easyTotalPrayerSec) || 0)
    : calcWeekPrayerStats(weekData, dates).totalSec;
  return Math.max(0, base + deltaSec);
}

export function uniqueVerses(verses) {
  const seen = new Set();
  return (Array.isArray(verses)?verses:[]).filter(v => {
    const key = v.reference || v.text || JSON.stringify(v);
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getMemoryVersesForWeek(scheduleVerse, wk) {
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
