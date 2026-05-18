'use strict';

const jwt = require('jsonwebtoken');

const getSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET 환경변수가 설정되지 않았습니다.');
  return secret;
};

function createVerifyToken(payload) {
  return jwt.sign(
    { ...payload, purpose: 'identity_verified' },
    getSecret(),
    { expiresIn: '10m' }
  );
}

function createSessionToken(user) {
  return jwt.sign(
    { uid: user.id, name: user.name, role: user.role },
    getSecret(),
    { expiresIn: '7d' }
  );
}

function verifyIdentityToken(token) {
  try {
    const decoded = jwt.verify(token, getSecret());
    if (decoded.purpose !== 'identity_verified') {
      throw { status: 401, message: '유효하지 않은 토큰 유형입니다.' };
    }
    return decoded;
  } catch (err) {
    if (err.status) throw err;
    throw { status: 401, message: '검증 토큰이 만료되었거나 유효하지 않습니다.' };
  }
}

function requireAuth(req, allowedRoles = []) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw { status: 401, message: '인증 토큰이 없습니다.' };
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, getSecret());
    if (allowedRoles.length > 0 && !allowedRoles.includes(decoded.role)) {
      throw { status: 403, message: '접근 권한이 없습니다.' };
    }
    return decoded;
  } catch (err) {
    if (err.status) throw err;
    throw { status: 401, message: '유효하지 않은 세션 토큰입니다.' };
  }
}

function handleError(res, err) {
  console.error('[Error]', err);
  if (err.status) {
    return res.status(err.status).json({ success: false, error: err.message });
  }
  return res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
}

function requireMethod(req, res, method) {
  if (req.method !== method) {
    res.status(405).json({ success: false, error: `${method} 요청만 허용됩니다.` });
    return false;
  }
  return true;
}

module.exports = {
  createVerifyToken,
  createSessionToken,
  verifyIdentityToken,
  requireAuth,
  handleError,
  requireMethod,
};
