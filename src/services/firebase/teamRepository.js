import {
  buildTeamConfigDocPath,
  buildTeamsConfigPath,
} from './firebasePaths.js';
import { getFirebaseSdkAppAndDb } from './firebaseSdkClient.js';
import { isNativeApp } from '../../lib/utils.js';

function parseFirestoreValue(value) {
  if (!value || typeof value !== "object") return value;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return Boolean(value.booleanValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(parseFirestoreValue);
  if ("mapValue" in value) return parseFirestoreFields(value.mapValue.fields || {});
  return value;
}

function parseFirestoreFields(fields = {}) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, parseFirestoreValue(value)])
  );
}

async function fetchFirestoreRestJson(firebaseConfig, documentPath) {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/${documentPath}`
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Firestore REST 조회 실패 (${response.status}) ${body}`.trim());
  }

  return response.json();
}

async function fetchTeamsConfigCollectionRest(firebaseConfig, { appId }) {
  const data = await fetchFirestoreRestJson(firebaseConfig, buildTeamsConfigPath(appId));
  return (data.documents || [])
    .map(doc => parseFirestoreFields(doc.fields || {}))
    .filter(d => d.id !== undefined && d.id !== null)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

async function fetchTeamConfigMembersRest(firebaseConfig, { appId, teamId }) {
  const data = await fetchFirestoreRestJson(firebaseConfig, buildTeamConfigDocPath(appId, teamId));
  const members = parseFirestoreFields(data.fields || {}).members;
  return Array.isArray(members) ? members.map(v => String(v || "")).filter(Boolean) : [];
}

export async function fetchTeamsConfigCollection(firebaseConfig, { appId }) {
  if (isNativeApp()) return fetchTeamsConfigCollectionRest(firebaseConfig, { appId });
  try {
    const { sdk, db } = await getFirebaseSdkAppAndDb(firebaseConfig);
    const snapshot = await sdk.getDocs(sdk.collection(db, buildTeamsConfigPath(appId)));
    return snapshot.docs
      .map(doc => doc.data())
      .filter(d => d.id !== undefined && d.id !== null)
      .sort((a, b) => Number(a.id) - Number(b.id));
  } catch {
    return fetchTeamsConfigCollectionRest(firebaseConfig, { appId });
  }
}

export async function fetchTeamConfigMembers(firebaseConfig, { appId, teamId }) {
  if (isNativeApp()) return fetchTeamConfigMembersRest(firebaseConfig, { appId, teamId });
  try {
    const { sdk, db } = await getFirebaseSdkAppAndDb(firebaseConfig);
    const snapshot = await sdk.getDoc(sdk.doc(db, buildTeamConfigDocPath(appId, teamId)));
    if (!snapshot.exists()) return [];
    const members = snapshot.data()?.members;
    return Array.isArray(members) ? members.map(v => String(v || "")).filter(Boolean) : [];
  } catch {
    return fetchTeamConfigMembersRest(firebaseConfig, { appId, teamId });
  }
}
