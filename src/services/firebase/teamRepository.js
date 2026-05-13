import {
  buildTeamConfigDocPath,
  buildTeamsConfigPath,
} from './firebasePaths.js';
import { getFirebaseSdkContext } from './firebaseSdkClient.js';

export async function fetchTeamsConfigCollection(firebaseConfig, { appId }) {
  const { sdk, db } = await getFirebaseSdkContext(firebaseConfig);
  const snapshot = await sdk.getDocs(sdk.collection(db, buildTeamsConfigPath(appId)));

  return snapshot.docs
    .map(doc => doc.data())
    .filter(d=>d.id&&d.name)
    .sort((a,b)=>Number(a.id)-Number(b.id));
}

export async function fetchTeamConfigMembers(firebaseConfig, { appId, teamId }) {
  const { sdk, db } = await getFirebaseSdkContext(firebaseConfig);
  const snapshot = await sdk.getDoc(sdk.doc(db, buildTeamConfigDocPath(appId, teamId)));
  if(!snapshot.exists()) return [];
  const members = snapshot.data()?.members;
  return Array.isArray(members) ? members.map(v=>String(v||"")).filter(Boolean) : [];
}
