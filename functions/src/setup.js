'use strict';

const { getFirestore } = require('firebase-admin/firestore');
const { handleError, requireMethod } = require('./middleware');
const { makeUserId } = require('./auth');

const db = getFirestore();

// ─────────────────────────────────────────────────────────────
// 최초 root 계정 생성 (root가 하나도 없을 때만 동작)
// POST /initRoot
// Body: { intercessionType, group, name }
//
// 보안: Firestore에 role='root' 문서가 이미 존재하면 즉시 거부
// ─────────────────────────────────────────────────────────────
async function initRoot(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const existing = await db.collection('users')
      .where('role', '==', 'root')
      .limit(1)
      .get();

    if (!existing.empty) {
      throw { status: 403, message: '이미 root 계정이 존재합니다. 이 엔드포인트는 최초 1회만 사용할 수 있습니다.' };
    }

    const { intercessionType, group, name } = req.body;

    if (!intercessionType?.trim() || !group?.trim() || !name?.trim()) {
      throw { status: 400, message: '중보유형, 조, 이름을 모두 입력해주세요.' };
    }

    const userId = makeUserId(intercessionType.trim(), group.trim(), name.trim());

    const alreadyExists = await db.collection('users').doc(userId).get();
    if (alreadyExists.exists) {
      throw { status: 409, message: '이미 동일한 ID의 사용자가 존재합니다.' };
    }

    const now = new Date();

    await db.collection('users').doc(userId).set({
      intercessionType: intercessionType.trim(),
      group: group.trim(),
      name: name.trim(),
      role: 'root',
      active: true,
      pinHash: null,
      passwordFailCount: 0,
      pinFailCount: 0,
      addedBy: 'system',
      addedAt: now,
      pinUpdatedAt: null,
      lastLoginAt: null,
    });

    return res.json({
      success: true,
      message: `root 계정(${name.trim()})이 생성되었습니다. 앱에서 비밀번호 확인 후 PIN을 등록해주세요.`,
    });
  } catch (err) {
    return handleError(res, err);
  }
}

module.exports = { initRoot };
