# Firebase Cloud Functions 설정 가이드

## 프로젝트 구조

```
functions/
├── index.js              # 함수 진입점 (exports)
├── package.json
└── src/
    ├── auth.js           # 인증 관련 함수
    ├── adminFunctions.js # 관리자 전용 함수
    └── middleware.js     # JWT, 에러 처리 유틸
```

---

## 사전 요구사항

- Node.js 24+
- Firebase CLI 설치: `npm install -g firebase-tools`
- Firebase 프로젝트 생성 (Firebase Console)

---

## 초기 설정

### 1. Firebase 로그인 및 프로젝트 연결

```bash
firebase login
firebase use --add   # 프로젝트 선택 후 별칭(alias) 지정
```

### 2. Functions 의존성 설치

```bash
cd functions
npm install
```

의존성 목록:
- `firebase-admin` — Firestore 접근
- `firebase-functions` — Cloud Functions v2
- `bcryptjs` — PIN 해시
- `jsonwebtoken` — JWT 발급/검증

### 3. 환경변수 설정 (JWT Secret)

```bash
firebase functions:secrets:set JWT_SECRET
# 프롬프트에 시크릿 값 입력
```

> **중요**: `JWT_SECRET`이 없으면 모든 함수가 500 에러를 반환합니다.

---

## 로컬 에뮬레이터 실행

```bash
# 프로젝트 루트에서
npm run dev:firebase
```

내부적으로 실행되는 명령:
```bash
firebase emulators:start --only functions,firestore --import ./emulator-data --export-on-exit ./emulator-data
```

에뮬레이터 포트:
| 서비스 | 포트 |
|--------|------|
| Functions | 5001 |
| Firestore | 8080 |
| Emulator UI | 4000 |

에뮬레이터 실행 중에는 `http://localhost:5001/{project-id}/asia-northeast3/{함수명}` 으로 호출 가능.

---

## 배포

### Functions만 배포

```bash
cd functions
npm run deploy
# 또는 프로젝트 루트에서
firebase deploy --only functions
```

### 전체 배포 (Functions + Firestore Rules)

```bash
firebase deploy
```

배포 후 엔드포인트:
```
https://asia-northeast3-{project-id}.cloudfunctions.net/{함수명}
```

---

## API 엔드포인트 목록

모든 함수는 `region: asia-northeast3`, `invoker: public` (CORS 허용) 으로 설정됩니다.

### 인증 (auth.js)

| 함수 | 메서드 | 경로 | 설명 |
|------|--------|------|------|
| `verifyUser` | POST | `/verifyUser` | 1단계: 신원 확인 (중보유형+조+이름+비밀번호) |
| `registerPin` | POST | `/registerPin` | 2단계-A: PIN 최초 등록 |
| `loginWithPin` | POST | `/loginWithPin` | 2단계-B: PIN 로그인 |
| `me` | GET | `/me` | 세션 토큰 확인 |

### 관리자 (adminFunctions.js)

| 함수 | 메서드 | 경로 | 권한 | 설명 |
|------|--------|------|------|------|
| `addUser` | POST | `/addUser` | root, admin | 사용자 등록 |
| `listUsers` | GET | `/listUsers` | root, admin | 사용자 목록 조회 |
| `setUserActive` | POST | `/setUserActive` | root, admin | 활성/비활성 전환 |
| `resetPin` | POST | `/resetPin` | root, admin | PIN 초기화 |
| `updateRole` | POST | `/updateRole` | root | 역할 변경 |
| `unblockUser` | POST | `/unblockUser` | root, admin | 차단 해제 |
| `deleteUser` | POST | `/deleteUser` | root, admin | 사용자 삭제 |

---

## 인증 플로우

```
1. POST /verifyUser
   Body: { intercessionType, group, name, password }
   → 성공 시 verifyToken 반환 (10분 유효)

2-A. PIN 미등록 시 → POST /registerPin
     Body: { verifyToken, pin }
     → sessionToken 반환 (1시간 유효)

2-B. PIN 등록 완료 시 → POST /loginWithPin
     Body: { intercessionType, group, name, pin }
     → sessionToken 반환 (1시간 유효)

3. 이후 요청: Authorization: Bearer {sessionToken}
```

### 비밀번호 규칙

- 형식: 8자리 숫자
- 기본값: `MMDD0802` (당일 KST 날짜 + 0802)
  - 예: 5월 18일 → `05180802`
- 5회 오류 시 계정 차단 → `/unblockUser` 로 해제

### PIN 규칙

- 형식: 4자리 숫자
- 5회 오류 시 차단 → `/unblockUser` 로 해제
- 초기화: `/resetPin` (admin 이상)

---

## Firestore 데이터 구조

### `users` 컬렉션

Document ID: `{intercessionType}_{group}_{name}`
(예: `교회중보_1_홍길동`)

```js
{
  role: 'user' | 'admin' | 'root',
  active: true,
  pinHash: null | '<bcrypt hash>',
  passwordFailCount: 0,
  pinFailCount: 0,
  addedBy: '<userId>',
  addedAt: Timestamp,
  pinUpdatedAt: Timestamp | null,
  lastLoginAt: Timestamp | null,
}
```

### 역할 권한

| 역할 | 설명 |
|------|------|
| `user` | 일반 사용자 (출석 제출) |
| `admin` | 관리자 (사용자 관리, root 제외) |
| `root` | 슈퍼 관리자 (모든 권한) |

> `root` 계정은 Firestore Console에서 직접 생성해야 합니다 (`/addUser` 에서 root 역할 지정 불가).

---

## Firestore 보안 규칙

현재 규칙 (`firestore.rules`):

```
모든 직접 읽기/쓰기 차단
```

모든 데이터 접근은 Cloud Functions를 통해서만 이루어지며, Functions 내부에서 `firebase-admin` SDK로 Firestore에 접근합니다.

---

## 미들웨어 (middleware.js)

| 함수 | 역할 |
|------|------|
| `createVerifyToken(payload)` | 신원 확인 토큰 생성 (10분) |
| `createSessionToken(user)` | 세션 토큰 생성 (1시간) |
| `verifyIdentityToken(token)` | 신원 토큰 검증 |
| `requireAuth(req, roles)` | 세션 토큰 검증 + 역할 확인 |
| `handleError(res, err)` | 에러 응답 처리 |
| `requireMethod(req, res, method)` | HTTP 메서드 검증 |

---

## 자주 사용하는 명령

```bash
# 에뮬레이터 실행
npm run dev:firebase

# Functions 로그 확인
firebase functions:log

# Functions만 재배포
firebase deploy --only functions

# 시크릿 목록 확인
firebase functions:secrets:access JWT_SECRET
```
