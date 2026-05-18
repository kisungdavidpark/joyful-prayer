'use strict';

const { getFirestore } = require('firebase-admin/firestore');
const bcrypt = require('bcryptjs');
const {
  createVerifyToken,
  createSessionToken,
  verifyIdentityToken,
  requireAuth,
  handleError,
  requireMethod,
} = require('./middleware');

const db = getFirestore();

const makeUserId = (intercessionType, group, name) =>
  `${intercessionType}_${group}_${name}`;

const MAX_FAIL = 5;

// KST 기준 오늘 날짜로 초기 비밀번호 생성 (예: 05180802)
function getTodayPassword() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const mm = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(kst.getUTCDate()).padStart(2, '0');
  return `${mm}${dd}0802`;
}

// ─────────────────────────────────────────────────────────────
// 1단계: 신원 확인
// POST /verifyUser
// Body: { intercessionType, group, name, password }
// ─────────────────────────────────────────────────────────────
async function verifyUser(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const { intercessionType, group, name, password } = req.body;

    if (!intercessionType?.trim() || !group?.trim() || !name?.trim() || !password) {
      throw { status: 400, message: '중보유형, 조, 이름, 비밀번호를 모두 입력해주세요.' };
    }
    if (!/^\d{8}$/.test(password)) {
      throw { status: 400, message: '비밀번호는 8자리 숫자여야 합니다.' };
    }

    const userId = makeUserId(intercessionType.trim(), group.trim(), name.trim());
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      throw { status: 401, message: '정보가 일치하지 않습니다.' };
    }

    const userData = userDoc.data();

    if (!userData.active) {
      throw { status: 403, message: '비활성화된 계정입니다. 관리자에게 문의해주세요.' };
    }

    if ((userData.passwordFailCount || 0) >= MAX_FAIL) {
      throw { status: 403, message: '비밀번호 오류 5회 초과로 차단되었습니다. 관리자에게 문의하세요.' };
    }

    const isValid = password === getTodayPassword();
    if (!isValid) {
      const newCount = (userData.passwordFailCount || 0) + 1;
      await userRef.update({ passwordFailCount: newCount });
      if (newCount >= MAX_FAIL) {
        throw { status: 403, message: '비밀번호 오류 5회 초과로 차단되었습니다. 관리자에게 문의하세요.' };
      }
      throw { status: 401, message: `정보가 일치하지 않습니다. (${newCount}/${MAX_FAIL}회)` };
    }

    await userRef.update({ passwordFailCount: 0 });

    const verifyToken = createVerifyToken({ userId });

    return res.json({
      success: true,
      pinRegistered: !!userData.pinHash,
      verifyToken,
      name: userData.name,
      role: userData.role,
    });
  } catch (err) {
    return handleError(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
// 2단계-A: PIN 최초 등록
// POST /registerPin
// Body: { verifyToken, pin }
// ─────────────────────────────────────────────────────────────
async function registerPin(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const { verifyToken, pin } = req.body;

    if (!verifyToken || !pin) {
      throw { status: 400, message: '검증 토큰과 PIN이 필요합니다.' };
    }
    if (!/^\d{4}$/.test(pin)) {
      throw { status: 400, message: 'PIN은 4자리 숫자여야 합니다.' };
    }

    const { userId } = verifyIdentityToken(verifyToken);

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists || !userDoc.data().active) {
      throw { status: 403, message: '등록 권한이 없습니다. 관리자에게 문의해주세요.' };
    }
    if (userDoc.data().pinHash) {
      throw { status: 409, message: '이미 PIN이 등록되어 있습니다. 관리자에게 PIN 초기화를 요청하세요.' };
    }

    const userData = userDoc.data();
    const pinHash = await bcrypt.hash(pin, 10);

    await userRef.update({ pinHash, pinUpdatedAt: new Date(), pinFailCount: 0 });

    const sessionToken = createSessionToken({
      id: userId,
      name: userData.name,
      role: userData.role,
    });

    return res.json({
      success: true,
      sessionToken,
      name: userData.name,
      role: userData.role,
    });
  } catch (err) {
    return handleError(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
// 2단계-B: PIN 로그인
// POST /loginWithPin
// Body: { intercessionType, group, name, pin }
// ─────────────────────────────────────────────────────────────
async function loginWithPin(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const { intercessionType, group, name, pin } = req.body;

    if (!intercessionType?.trim() || !group?.trim() || !name?.trim() || !pin) {
      throw { status: 400, message: '중보유형, 조, 이름, PIN을 모두 입력해주세요.' };
    }

    const userId = makeUserId(intercessionType.trim(), group.trim(), name.trim());
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists || !userDoc.data().active) {
      throw { status: 403, message: '비활성화된 계정입니다. 관리자에게 문의해주세요.' };
    }
    if (!userDoc.data().pinHash) {
      throw { status: 400, message: 'PIN이 등록되지 않았습니다. 관리자에게 문의해주세요.' };
    }

    const userData = userDoc.data();

    if ((userData.pinFailCount || 0) >= MAX_FAIL) {
      throw { status: 403, message: 'PIN 오류 5회 초과로 차단되었습니다. 관리자에게 문의하세요.' };
    }

    const isValid = await bcrypt.compare(pin, userData.pinHash);
    if (!isValid) {
      const newCount = (userData.pinFailCount || 0) + 1;
      await userRef.update({ pinFailCount: newCount });
      if (newCount >= MAX_FAIL) {
        throw { status: 403, message: 'PIN 오류 5회 초과로 차단되었습니다. 관리자에게 문의하세요.' };
      }
      throw { status: 401, message: `PIN이 올바르지 않습니다. (${newCount}/${MAX_FAIL}회)` };
    }

    await userRef.update({ pinFailCount: 0, lastLoginAt: new Date() });

    const sessionToken = createSessionToken({
      id: userId,
      name: userData.name,
      role: userData.role,
    });

    return res.json({
      success: true,
      sessionToken,
      name: userData.name,
      role: userData.role,
    });
  } catch (err) {
    return handleError(res, err);
  }
}

// ─────────────────────────────────────────────────────────────
// 세션 확인
// GET /me
// ─────────────────────────────────────────────────────────────
async function me(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  try {
    const user = requireAuth(req);
    return res.json({ success: true, uid: user.uid, name: user.name, role: user.role });
  } catch (err) {
    return handleError(res, err);
  }
}

module.exports = { verifyUser, registerPin, loginWithPin, me, makeUserId };
