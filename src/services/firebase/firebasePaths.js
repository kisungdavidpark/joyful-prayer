export const buildAppDataPath = (appId) =>
  `artifacts/${appId}/public/data`;

export const buildAttendanceDocPath = (appId, docId) =>
  `${buildAppDataPath(appId)}/attendance/${docId}`;

export const buildTeamsConfigPath = (appId) =>
  `${buildAppDataPath(appId)}/teams_config`;

export const buildTeamConfigDocPath = (appId, teamId) =>
  `${buildTeamsConfigPath(appId)}/${teamId}`;
