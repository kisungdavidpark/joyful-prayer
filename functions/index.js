'use strict';

const { initializeApp } = require('firebase-admin/app');
initializeApp();

const { onRequest } = require('firebase-functions/v2/https');

const auth  = require('./src/auth');
const admin = require('./src/adminFunctions');

const opts = { cors: true, region: 'asia-northeast3' };

// ── 인증 ──────────────────────────────────────────────────────
exports.verifyUser   = onRequest(opts, auth.verifyUser);
exports.registerPin  = onRequest(opts, auth.registerPin);
exports.loginWithPin = onRequest(opts, auth.loginWithPin);
exports.me           = onRequest(opts, auth.me);

// ── 관리자 ────────────────────────────────────────────────────
exports.addUser          = onRequest(opts, admin.addUser);
exports.listUsers        = onRequest(opts, admin.listUsers);
exports.setUserActive    = onRequest(opts, admin.setUserActive);
exports.resetPin         = onRequest(opts, admin.resetPin);
exports.updateRole       = onRequest(opts, admin.updateRole);
exports.unblockUser      = onRequest(opts, admin.unblockUser);
exports.deleteUser       = onRequest(opts, admin.deleteUser);
