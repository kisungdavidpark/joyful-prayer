import {
  buildAppDataPath,
  buildFirestoreDocumentUrl,
  buildFirestoreRunQueryUrl,
  buildTeamConfigDocPath,
  buildTeamsConfigPath,
} from './firebasePaths.js';
import { fetchFirebaseDocumentWithAuth, fetchFirebaseJsonWithAuth, getFirebaseIdToken } from './firebaseClient.js';
import { parseFirestoreFields, parseFirestoreValue } from './firestoreMapper.js';

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
  const idToken = await getFirebaseIdToken(firebaseConfig);
  const res = await fetch(
    buildFirestoreDocumentUrl(firebaseConfig.projectId, buildTeamsConfigPath(appId)),
    { headers:{ Authorization:`Bearer ${idToken}` } }
  );

  if(!res.ok) throw new Error(`조 목록 조회 실패: HTTP ${res.status}`);
  const json = await res.json();

  return (json?.documents||[])
    .map(doc => parseFirestoreFields(doc.fields || {}))
    .filter(d=>d.id&&d.name)
    .sort((a,b)=>Number(a.id)-Number(b.id));
}

export async function fetchAttendanceMemberNames(firebaseConfig, { appId, teamNameVariants }) {
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
          where,
        },
        parent: `projects/${firebaseConfig.projectId}/databases/(default)/documents/${buildAppDataPath(appId)}`,
      }),
    },
    12000
  );

  return (Array.isArray(json) ? json : [])
    .map(item => item?.document?.fields?.name)
    .filter(Boolean)
    .map(parseFirestoreValue);
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
