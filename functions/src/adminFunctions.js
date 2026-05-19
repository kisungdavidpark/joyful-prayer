'use strict';

const { getFirestore } = require('firebase-admin/firestore');
const { requireAuth, handleError, requireMethod } = require('./middleware');
const { makeUserId } = require('./auth');

const db = getFirestore();

const VALID_ROLES = ['root', 'admin', 'user'];

const parseUserId = (userId) => {
  const parts = userId.split('_');
  return { intercessionType: parts[0], group: Number(parts[1]), name: parts.slice(2).join('_') };
};

// ─────────────────────────────────────────────────────────────
// 사용자 등록
// POST /addUser
// Body: { intercessionType, group, name, role? }
// ─────────────────────────────────────────────────────────────
async function addUser(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const caller = requireAuth(req, ['root', 'admin']);
    const { intercessionType, group, name, role = 'user' } = req.body;

    const groupNum = Number(group);
    if (!intercessionType?.trim() || !Number.isInteger(groupNum) || !name?.trim()) {
      throw { status: 400, message: '중보유형, 조(숫자), 이름을 모두 입력해주세요.' };
    }
    if (!VALID_ROLES.includes(role)) {
      throw { status: 400, message: `역할은 ${VALID_ROLES.join(', ')} 중 하나여야 합니다.` };
    }
    if (role === 'root') {
      throw { status: 403, message: 'root 등록은 Firestore Console에서 직접 설정해주세요.' };
    }
    if (role === 'admin' && caller.role !== 'root') {
      throw { status: 403, message: 'admin 역할 부여는 root만 가능합니다.' };
    }

    const userId = makeUserId(intercessionType.trim(), groupNum, name.trim());

    const existing = await db.collection('users').doc(userId).get();
    if (existing.exists) {
      throw { status: 409, message: '이미 등록된 사용자입니다.' };
    }

    const now = new Date();

    await db.collection('users').doc(userId).set({
      role,
      active: true,
      pinHash: null,
      passwordFailCount: 0,
      pinFailCount: 0,
      addedBy: caller.uid,
      addedAt: now,
      pinUpdatedAt: null,
      lastLoginAt: null,
    });

    return res.json({
      success: true,
      id: userId,
      message: `${name.trim()}이(가) 등록되었습니다.`,
    });
  } catch (err) {
    return handleError(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
// 사용자 목록 조회
// GET /listUsers
// ─────────────────────────────────────────────────────────────
async function listUsers(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  try {
    requireAuth(req, ['root', 'admin']);

    const snap = await db.collection('users').get();

    const list = snap.docs.map(doc => {
      const d = doc.data();
      const { intercessionType, group, name } = parseUserId(doc.id);
      return {
        id: doc.id,
        intercessionType,
        group,
        name,
        role: d.role,
        active: d.active,
        pinRegistered: !!d.pinHash,
        passwordFailCount: d.passwordFailCount || 0,
        pinFailCount: d.pinFailCount || 0,
        addedAt: d.addedAt?.toDate?.() || d.addedAt,
        lastLoginAt: d.lastLoginAt?.toDate?.() || d.lastLoginAt || null,
      };
    });

    list.sort((a, b) => {
      const tc = a.intercessionType.localeCompare(b.intercessionType, 'ko');
      if (tc !== 0) return tc;
      if (a.group !== b.group) return a.group - b.group;
      return a.name.localeCompare(b.name, 'ko');
    });

    return res.json({ success: true, list });
  } catch (err) {
    return handleError(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
// 활성/비활성 전환
// POST /setUserActive
// ─────────────────────────────────────────────────────────────
async function setUserActive(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const caller = requireAuth(req, ['root', 'admin']);
    const { userId, active } = req.body;

    if (!userId || typeof active !== 'boolean') {
      throw { status: 400, message: 'userId와 active(boolean) 값이 필요합니다.' };
    }

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      throw { status: 404, message: '사용자를 찾을 수 없습니다.' };
    }

    const target = userDoc.data();

    if (caller.role === 'admin' && ['root', 'admin'].includes(target.role)) {
      throw { status: 403, message: '다른 관리자는 비활성화할 수 없습니다.' };
    }

    await userRef.update({ active });

    const { name } = parseUserId(userId);
    return res.json({
      success: true,
      message: `${name}이(가) ${active ? '활성화' : '비활성화'}되었습니다.`,
    });
  } catch (err) {
    return handleError(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
// PIN 초기화
// POST /resetPin
// ─────────────────────────────────────────────────────────────
async function resetPin(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const caller = requireAuth(req, ['root', 'admin']);
    const { userId } = req.body;

    if (!userId) {
      throw { status: 400, message: 'userId가 필요합니다.' };
    }

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      throw { status: 404, message: '사용자를 찾을 수 없습니다.' };
    }

    const target = userDoc.data();

    if (caller.role === 'admin' && ['root', 'admin'].includes(target.role)) {
      throw { status: 403, message: '다른 관리자의 PIN은 초기화할 수 없습니다.' };
    }
    if (!target.pinHash) {
      throw { status: 400, message: '등록된 PIN이 없습니다.' };
    }

    await userRef.update({
      pinHash: null,
      pinUpdatedAt: new Date(),
      pinResetBy: caller.uid,
      pinFailCount: 0,
    });

    const { name } = parseUserId(userId);
    return res.json({
      success: true,
      message: `${name}의 PIN이 초기화되었습니다.`,
    });
  } catch (err) {
    return handleError(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
// 역할 변경
// POST /updateRole
// ─────────────────────────────────────────────────────────────
async function updateRole(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const caller = requireAuth(req, ['root']);
    const { userId, role } = req.body;

    if (!userId || !role) {
      throw { status: 400, message: 'userId와 role이 필요합니다.' };
    }
    if (!VALID_ROLES.includes(role)) {
      throw { status: 400, message: `역할은 ${VALID_ROLES.join(', ')} 중 하나여야 합니다.` };
    }

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      throw { status: 404, message: '사용자를 찾을 수 없습니다.' };
    }

    await userRef.update({
      role,
      roleUpdatedAt: new Date(),
      roleUpdatedBy: caller.uid,
    });

    const { name } = parseUserId(userId);
    return res.json({
      success: true,
      message: `${name}의 역할이 ${role}로 변경되었습니다.`,
    });
  } catch (err) {
    return handleError(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
// 차단 해제
// POST /unblockUser
// ─────────────────────────────────────────────────────────────
async function unblockUser(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const caller = requireAuth(req, ['root', 'admin']);
    const { userId } = req.body;

    if (!userId) {
      throw { status: 400, message: 'userId가 필요합니다.' };
    }

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      throw { status: 404, message: '사용자를 찾을 수 없습니다.' };
    }

    const target = userDoc.data();

    if (caller.role === 'admin' && ['root', 'admin'].includes(target.role)) {
      throw { status: 403, message: '다른 관리자의 차단은 해제할 수 없습니다.' };
    }

    await userRef.update({
      passwordFailCount: 0,
      pinFailCount: 0,
    });

    const { name } = parseUserId(userId);
    return res.json({
      success: true,
      message: `${name}의 차단이 해제되었습니다.`,
    });
  } catch (err) {
    return handleError(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
// 사용자 삭제
// POST /deleteUser
// ─────────────────────────────────────────────────────────────
async function deleteUser(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const caller = requireAuth(req, ['root', 'admin']);
    const { userId } = req.body;

    if (!userId) {
      throw { status: 400, message: 'userId가 필요합니다.' };
    }
    if (caller.uid === userId) {
      throw { status: 403, message: '자신을 삭제할 수 없습니다.' };
    }

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      throw { status: 404, message: '사용자를 찾을 수 없습니다.' };
    }

    const target = userDoc.data();

    if (caller.role === 'admin' && ['root', 'admin'].includes(target.role)) {
      throw { status: 403, message: '다른 관리자는 삭제할 수 없습니다.' };
    }

    await userRef.delete();

    const { name } = parseUserId(userId);
    return res.json({
      success: true,
      message: `${name}이(가) 삭제되었습니다.`,
    });
  } catch (err) {
    return handleError(res, err);
  }
}

module.exports = { addUser, listUsers, setUserActive, resetPin, updateRole, unblockUser, deleteUser };
