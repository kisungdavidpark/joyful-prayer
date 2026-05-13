import {
  buildAppDataPath,
  buildFirestoreDocumentUrl,
  buildFirestoreRunQueryUrl,
  buildTeamConfigDocPath,
  buildTeamsConfigPath,
} from './firebasePaths.js';
import { fetchFirebaseDocumentWithAuth, fetchFirebaseJsonWithAuth } from './firebaseClient.js';
import { parseFirestoreFields, parseFirestoreValue } from './firestoreMapper.js';

const _memberNamesSessionCache = new Map();
const MEMBER_NAMES_CACHE_TTL = 24 * 60 * 60 * 1000;

function getMemberNamesCacheKey(projectId, teamNameVariants) {
  return `fbMemberNames_${projectId}_${[...teamNameVariants].sort().join(",")}`;
}

function loadMemberNamesCache(key) {
  try {
    const cached = JSON.parse(localStorage.getItem(key) || "null");
    if (cached?.names && cached.savedAt > Date.now() - MEMBER_NAMES_CACHE_TTL) return cached.names;
  } catch {}
  return null;
}

function saveMemberNamesCache(key, names) {
  try { localStorage.setItem(key, JSON.stringify({ names, savedAt: Date.now() })); } catch {}
}

export async function fetchAttendanceRows(firebaseConfig, { appId }) {
  const json = await fetchFirebaseJsonWithAuth(
    firebaseConfig,
    buildFirestoreRunQueryUrl(firebaseConfig.projectId),
    {
      method: "POST",
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "attendance" }],
          orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
        },
        parent: `projects/${firebaseConfig.projectId}/databases/(default)/documents/${buildAppDataPath(appId)}`,
      }),
    },
    20000
  );

  return (Array.isArray(json) ? json : [])
    .map(item => item?.document)
    .filter(Boolean)
    .map(doc => ({ id: doc.name?.split("/").pop() || "", ...parseFirestoreFields(doc.fields || {}) }));
}

export async function fetchTeamsConfigCollection(firebaseConfig, { appId }) {
  const json = await fetchFirebaseJsonWithAuth(
    firebaseConfig,
    buildFirestoreDocumentUrl(firebaseConfig.projectId, buildTeamsConfigPath(appId))
  );

  return (json?.documents||[])
    .map(doc => parseFirestoreFields(doc.fields || {}))
    .filter(d=>d.id&&d.name)
    .sort((a,b)=>Number(a.id)-Number(b.id));
}

export async function fetchAttendanceMemberNames(firebaseConfig, { appId, teamNameVariants }) {
  const lsKey = getMemberNamesCacheKey(firebaseConfig.projectId, teamNameVariants);
  const sessionKey = lsKey;

  if (_memberNamesSessionCache.has(sessionKey)) return _memberNamesSessionCache.get(sessionKey);
  const lsCached = loadMemberNamesCache(lsKey);
  if (lsCached) { _memberNamesSessionCache.set(sessionKey, lsCached); return lsCached; }

  const filters = teamNameVariants.map(value => ({
    fieldFilter: {
      field: { fieldPath: "teamName" },
      op: "EQUAL",
      value: { stringValue: value },
    },
  }));

  if (!filters.length) return [];

  const where = filters.length === 1
    ? filters[0]
    : { compositeFilter: { op: "OR", filters } };

  const json = await fetchFirebaseJsonWithAuth(
    firebaseConfig,
    buildFirestoreRunQueryUrl(firebaseConfig.projectId),
    {
      method: "POST",
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "attendance" }],
          select: { fields: [{ fieldPath: "name" }] },
          where,
          limit: 300,
        },
        parent: `projects/${firebaseConfig.projectId}/databases/(default)/documents/${buildAppDataPath(appId)}`,
      }),
    },
    12000
  );

  const names = (Array.isArray(json) ? json : [])
    .map(item => item?.document?.fields?.name)
    .filter(Boolean)
    .map(parseFirestoreValue);

  _memberNamesSessionCache.set(sessionKey, names);
  saveMemberNamesCache(lsKey, names);
  return names;
}

export async function fetchTeamConfigMembers(firebaseConfig, { appId, teamId }) {
  const json = await fetchFirebaseDocumentWithAuth(
    firebaseConfig,
    buildFirestoreDocumentUrl(firebaseConfig.projectId, buildTeamConfigDocPath(appId, teamId))
  );
  if(!json) return [];
  const membersVal = json.fields?.members;
  return membersVal?.arrayValue?.values?.map(v=>v.stringValue||"").filter(Boolean) || [];
}
