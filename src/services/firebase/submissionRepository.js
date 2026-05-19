import {
  buildAttendanceDocPath,
} from './firebasePaths.js';
import { getFirebaseSdkContext } from './firebaseSdkClient.js';
import { parsePlainFieldsForDisplay } from './firestoreMapper.js';

// spiritGuidanceText 는 의도적으로 제외 — 네트워크 구간에서 내용 비노출
const DISPLAY_FIELDS = [
  'status', 'reason', 'reasonAbsent', 'reasonLate', 'reasonEarly', 'reasonExcused',
  'dailyPrayer', 'totalPrayerTime',
  'filePrayer', 'bibleMemory', 'bibleReading', 'fullBibleReading',
  'isFilingManager', 'spiritGuidance',
  'updatedAt',
];

function parseFirestoreRestValue(v) {
  if (!v) return '';
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(parseFirestoreRestValue);
  if ('mapValue' in v) return Object.fromEntries(
    Object.entries(v.mapValue.fields || {}).map(([k, val]) => [k, parseFirestoreRestValue(val)])
  );
  return '';
}

export function buildSubmissionDocId({ week, teamNumber, safeMemberName }) {
  return `wk${week}_team${teamNumber}_${safeMemberName}`;
}

export async function saveSubmissionToFirestore(recordData, firebaseConfig, { appId, teamNumber, safeMemberName }) {
  const docId = buildSubmissionDocId({ week: recordData.week, teamNumber, safeMemberName });
  const { sdk, db } = await getFirebaseSdkContext(firebaseConfig);
  await sdk.setDoc(
    sdk.doc(db, buildAttendanceDocPath(appId, docId)),
    {
      ...recordData,
      updatedAt: sdk.serverTimestamp(),
      createdAt: sdk.serverTimestamp(),
    },
    { merge: true }
  );

  return { docId };
}

export async function fetchSubmissionForDisplay(firebaseConfig, { appId, docId }) {
  const { auth } = await getFirebaseSdkContext(firebaseConfig);
  const idToken = await auth.currentUser?.getIdToken();

  const docPath = buildAttendanceDocPath(appId, docId);
  const fullPath = `projects/${firebaseConfig.projectId}/databases/(default)/documents/${docPath}`;
  const maskQuery = DISPLAY_FIELDS.map(f => `mask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  const url = `https://firestore.googleapis.com/v1/${fullPath}?${maskQuery}`;

  const res = await fetch(url, {
    headers: idToken ? { Authorization: `Bearer ${idToken}` } : {},
  });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`조회 실패: ${res.status}`);

  const json = await res.json();
  if (!json.fields) return null;

  const rawData = Object.fromEntries(
    Object.entries(json.fields).map(([k, v]) => [k, parseFirestoreRestValue(v)])
  );

  return {
    docId,
    fields: parsePlainFieldsForDisplay(rawData),
  };
}
