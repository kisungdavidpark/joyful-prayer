export function parsePlainFieldsForDisplay(fields = {}) {
  const parse = v => {
    if(v === null || v === undefined) return "";
    if(typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    if(v instanceof Date) return v.toISOString();
    if(typeof v?.toDate === "function") return v.toDate().toISOString();
    if(Array.isArray(v)) return v.map(item => {
      if(item === null || item === undefined) return "";
      if(typeof item === "object") return JSON.stringify(item);
      return String(item);
    }).join(", ");
    return JSON.stringify(v);
  };
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, parse(value)]));
}
