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

export function parseFirestoreValue(v) {
  if(!v) return null;
  if('stringValue' in v) return v.stringValue;
  if('integerValue' in v) return Number(v.integerValue);
  if('booleanValue' in v) return v.booleanValue;
  if('doubleValue' in v) return v.doubleValue;
  if('timestampValue' in v) return v.timestampValue;
  if('arrayValue' in v) return (v.arrayValue.values||[]).map(parseFirestoreValue);
  if('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,val])=>[k,parseFirestoreValue(val)]));
  return null;
}

export function parseFirestoreFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, parseFirestoreValue(value)]));
}

export function parseFirestoreFieldsForDisplay(fields = {}) {
  const parse = v => {
    if(!v) return "";
    if(v.timestampValue!==undefined) return v.timestampValue;
    if(v.stringValue!==undefined) return v.stringValue;
    if(v.integerValue!==undefined) return v.integerValue;
    if(v.doubleValue!==undefined) return v.doubleValue;
    if(v.booleanValue!==undefined) return v.booleanValue;
    if(v.arrayValue) return (v.arrayValue.values||[]).map(i=>i.stringValue||i.integerValue||"").join(", ");
    return JSON.stringify(v);
  };
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, parse(value)]));
}

