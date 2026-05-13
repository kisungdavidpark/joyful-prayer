import {
  buildAttendanceDocPath,
} from './firebasePaths.js';
import { getFirebaseSdkContext } from './firebaseSdkClient.js';
import { parsePlainFieldsForDisplay } from './firestoreMapper.js';

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
  const { sdk, db } = await getFirebaseSdkContext(firebaseConfig);
  const snapshot = await sdk.getDoc(sdk.doc(db, buildAttendanceDocPath(appId, docId)));
  if(!snapshot.exists()) return null;
  return {
    docId,
    fields: parsePlainFieldsForDisplay(snapshot.data() || {}),
  };
}
