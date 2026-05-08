import { getNow, isWeekKeyInYear } from './utils.js';

export function exportLocalBackup() {
  try {
    const data = {};
    for(let i=0; i<localStorage.length; i++){
      const k=localStorage.key(i);
      try { data[k]=JSON.parse(localStorage.getItem(k)); } catch { data[k]=localStorage.getItem(k); }
    }
    const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download=`joyful_backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
    return true;
  } catch(e){ alert("백업 실패: "+e.message); return false; }
}

export function importLocalBackup(file){
  return new Promise((resolve,reject)=>{
    if(!file) return reject(new Error("파일을 선택해주세요."));
    const reader=new FileReader();
    reader.onload=(e)=>{
      try {
        const data=JSON.parse(e.target.result);
        if(!window.confirm("복원하면 현재 데이터가 덮어씌워집니다.\n계속하시겠습니까?")) return resolve(false);
        Object.entries(data).forEach(([k,v])=>{
          try { localStorage.setItem(k,typeof v==="string"?v:JSON.stringify(v)); } catch {}
        });

        // 쉬운모드 백업을 복원한 경우, 앱 재시작 후 제출탭이 보이도록 상태를 보정한다.
        const restoredEasyMode = data.easyMode === true || data.easyMode === "true";
        const restoredEasyModeLevel = data.easyModeLevel !== undefined ? String(data.easyModeLevel).replace(/^"|"$/g, "") : "";
        if (restoredEasyMode && !restoredEasyModeLevel) {
          localStorage.setItem("easyModeLevel", JSON.stringify("150"));
        }
        if (restoredEasyMode || (restoredEasyModeLevel && restoredEasyModeLevel !== "125")) {
          localStorage.setItem("easyMode", JSON.stringify(true));
        }

        resolve(true);
      } catch { reject(new Error("잘못된 백업 파일입니다.")); }
    };
    reader.onerror=()=>reject(new Error("파일 읽기 실패"));
    reader.readAsText(file);
  });
}

/* supabase 관련 유틸 - 현재는 사용하지 않지만 향후 데이터 동기화 기능 등에 활용 가능 */
export const getSupabaseConfig = () => ({
  url: import.meta.env.VITE_SUPABASE_URL || "",
  key: import.meta.env.VITE_SUPABASE_ANON_KEY || "",
});

export function collectLocalStorageData(year = String(new Date().getFullYear())) {
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

export function hasValidBackupData(data) {
  if (!data || typeof data !== "object") return false;

  const backupYear = data.__backupYear || String(new Date().getFullYear());
  const hasWeekData = Object.keys(data).some(key => isWeekKeyInYear(key, backupYear));

  // 초기화 직후 빈 데이터가 서버 백업을 덮어쓰는 것 방지
  return hasWeekData;
}

export function getBackupUserId(profile) {
  return [profile?.prayerType, profile?.group, profile?.name]
    .map(v => String(v || "").trim())
    .filter(Boolean)
    .join("_");
}

// PIN SHA-256 해시 (Web Crypto API)
export async function hashPin(pin) {
  const encoder = new TextEncoder();
  const data = encoder.encode(pin);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function backupProfileToSupabase(profile) {
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
