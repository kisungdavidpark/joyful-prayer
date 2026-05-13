import {
  buildAttendanceDocPath,
  buildFirestoreCommitUrl,
  buildFirestoreDocumentName,
  buildFirestoreDocumentUrl,
} from './firebasePaths.js';
import { fetchFirebaseDocumentWithAuth, fetchFirebaseJsonWithAuth } from './firebaseClient.js';
import { parseFirestoreFieldsForDisplay, toFirestoreFields } from './firestoreMapper.js';

export function buildSubmissionDocId({ week, teamNumber, safeMemberName }) {
  return `wk${week}_team${teamNumber}_${safeMemberName}`;
}

export async function saveSubmissionToFirestore(recordData, firebaseConfig, { appId, teamNumber, safeMemberName }) {
  const docId = buildSubmissionDocId({ week: recordData.week, teamNumber, safeMemberName });
  const documentPath = buildAttendanceDocPath(appId, docId);
  const documentName = buildFirestoreDocumentName(firebaseConfig.projectId, documentPath);
  const fieldPaths = Object.keys(recordData).sort();

  await fetchFirebaseJsonWithAuth(
    firebaseConfig,
    buildFirestoreCommitUrl(firebaseConfig.projectId),
    {
      method: "POST",
      body: JSON.stringify({
        writes: [{
          update: { name: documentName, fields: toFirestoreFields(recordData) },
          updateMask: { fieldPaths },
          updateTransforms: [
            { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" },
            { fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" },
          ],
        }],
      }),
    },
    15000
  );

  return { docId };
}

export async function fetchSubmissionForDisplay(firebaseConfig, { appId, docId }) {
  const documentPath = buildAttendanceDocPath(appId, docId);
  const json = await fetchFirebaseDocumentWithAuth(
    firebaseConfig,
    buildFirestoreDocumentUrl(firebaseConfig.projectId, documentPath)
  );
  if(!json) return null;
  return {
    docId,
    fields: parseFirestoreFieldsForDisplay(json.fields || {}),
  };
}

