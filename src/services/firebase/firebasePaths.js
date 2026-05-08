const FIRESTORE_ORIGIN = "https://firestore.googleapis.com/v1";
const IDENTITY_TOOLKIT_ORIGIN = "https://identitytoolkit.googleapis.com/v1";

export const buildFirebaseAuthSignUpUrl = (apiKey) =>
  `${IDENTITY_TOOLKIT_ORIGIN}/accounts:signUp?key=${encodeURIComponent(apiKey)}`;

export const buildFirestoreDocumentsBaseUrl = (projectId) =>
  `${FIRESTORE_ORIGIN}/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;

export const buildFirestoreCommitUrl = (projectId) =>
  `${buildFirestoreDocumentsBaseUrl(projectId)}:commit`;

export const buildFirestoreRunQueryUrl = (projectId) =>
  `${buildFirestoreDocumentsBaseUrl(projectId)}:runQuery`;

export const buildFirestoreDocumentName = (projectId, documentPath) =>
  `projects/${projectId}/databases/(default)/documents/${documentPath}`;

export const buildAppDataPath = (appId) =>
  `artifacts/${appId}/public/data`;

export const buildAttendanceDocPath = (appId, docId) =>
  `${buildAppDataPath(appId)}/attendance/${docId}`;

export const buildTeamsConfigPath = (appId) =>
  `${buildAppDataPath(appId)}/teams_config`;

export const buildTeamConfigDocPath = (appId, teamId) =>
  `${buildTeamsConfigPath(appId)}/${teamId}`;

export const buildFirestoreDocumentUrl = (projectId, documentPath) =>
  `${buildFirestoreDocumentsBaseUrl(projectId)}/${documentPath}`;

