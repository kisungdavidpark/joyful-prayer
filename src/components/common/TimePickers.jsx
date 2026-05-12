export function HourMinutePicker({ seconds, onChange, maxHours = 50, compact = false, theme }) {
  const C = theme;
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const hour = Math.max(0, Math.min(maxHours, Math.floor(safeSeconds / 3600)));
  const minute = Math.floor((safeSeconds % 3600) / 60);
  const minuteOptions = Array.from({ length: 12 }, (_, i) => i * 5);
  const safeMinute = Math.max(0, Math.min(55, Math.round(minute / 5) * 5));

  const selectStyle = compact ? {
    height:30,
    borderRadius:7,
    border:`1.5px solid ${C.accent}`,
    background:C.bg,
    color:C.text,
    fontSize:"0.75rem",
    fontWeight:700,
    padding:"0 4px",
  } : {
    height:42,
    borderRadius:11,
    border:`1.5px solid ${C.accent}`,
    background:C.bg,
    color:C.text,
    fontSize:"0.81rem",
    fontWeight:700,
  };

  const emit = (h, m) => {
    const nextHour = Math.max(0, Math.min(maxHours, Number(h) || 0));
    const nextMinute = Math.max(0, Math.min(55, Math.round((Number(m) || 0) / 5) * 5));
    onChange?.(nextHour * 3600 + nextMinute * 60);
  };

  return (
    <div style={{display:"flex",alignItems:"center",gap:compact?4:7,flexWrap:"wrap"}}>
      <select value={hour} onChange={e=>emit(Number(e.target.value), safeMinute)} style={{...selectStyle,width:compact?86:106}} aria-label="기도 시간 선택">
        {Array.from({length:maxHours+1},(_,h)=>(
          <option key={h} value={h}>{h}시간</option>
        ))}
      </select>
      <select value={safeMinute} onChange={e=>emit(hour, Number(e.target.value))} style={{...selectStyle,width:compact?74:92}} aria-label="기도 분 선택">
        {minuteOptions.map(m=>(
          <option key={m} value={m}>{m}분</option>
        ))}
      </select>
    </div>
  );
}

export function EasyHourPicker({ hours, onChange, theme }) {
  const C = theme;
  const safeHours = Math.max(0, Math.min(50, Number(hours) || 0));

  return (
    <select
      value={safeHours}
      onChange={e=>onChange?.(Number(e.target.value)||0)}
      style={{
        width:148,
        height:50,
        borderRadius:12,
        border:`1.5px solid ${C.accent}`,
        background:C.bg,
        color:C.gold,
        fontSize:"1.15rem",
        fontWeight:900,
        textAlign:"center",
        padding:"0 10px",
        outline:"none",
        WebkitAppearance:"menulist",
        appearance:"menulist",
        boxShadow:`0 0 0 3px ${C.accent}18`,
        cursor:"pointer",
      }}
      aria-label="총 기도시간 선택"
    >
      {Array.from({length:51},(_,h)=>(
        <option key={h} value={h}>{h}시간</option>
      ))}
    </select>
  );
}

export function EasyPrayerDaysPicker({ days, onChange, theme }) {
  const C = theme;
  const safeDays = Math.max(0, Math.min(6, Number(days) || 0));

  return (
    <select
      value={safeDays}
      onChange={e=>onChange?.(Number(e.target.value)||0)}
      style={{
        width:148,
        height:50,
        borderRadius:12,
        border:`1.5px solid ${C.accent}`,
        background:C.bg,
        color:C.gold,
        fontSize:"1.15rem",
        fontWeight:900,
        textAlign:"center",
        padding:"0 10px",
        outline:"none",
        boxShadow:`0 0 0 3px ${C.accent}18`,
        cursor:"pointer",
        WebkitAppearance:"menulist",
        appearance:"menulist",
      }}
      aria-label="기도일수 선택"
    >
      {Array.from({length:7},(_,d)=>(
        <option key={d} value={d}>{d}/6일</option>
      ))}
    </select>
  );
}
