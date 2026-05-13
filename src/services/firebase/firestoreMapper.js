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
