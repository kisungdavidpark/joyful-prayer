# 🔔 푸시 알림 로컬 테스트 가이드

## 문제
VS Code 내장 브라우저는 시크릿 모드에서만 작동하며, Chrome은 시크릿 모드에서 Push API를 차단합니다.

## 해결방법: 실제 브라우저에서 테스트

### 1️⃣ 로컬 개발 서버 실행
```bash
npm run dev
# http://localhost:5174/joyful-prayer/ 에서 서버 실행
```

### 2️⃣ Chrome/Firefox 일반 탭에서 접속
- **Windows/Mac**: Chrome, Firefox, Safari 등 설치된 브라우저 실행
- 주소창에 다음 입력:
  ```
  http://localhost:5174/joyful-prayer/
  ```

### 3️⃣ 설정 → 푸시 알림 → "구독하기" 클릭
- 브라우저가 알림 권한을 요청합니다
- **"허용" 클릭**
- "✅ 푸시 알림이 구독되었습니다" 메시지 확인

### 4️⃣ 테스트 페이지 접속
구독 완료 후 설정 탭의 "🧪 테스트" 버튼이 나타남
- 클릭하면 테스트 페이지로 이동

### 5️⃣ 테스트 알림 전송
테스트 페이지에서:
1. 알림 제목, 본문 입력
2. "🚀 푸시 알림 전송" 클릭
3. 브라우저 오른쪽 상단에서 알림 확인

---

## 프로덕션 배포 후

### 백엔드에서 실제 푸시 메시지 발송
배포 후 백엔드 서버에서 다음 코드로 푸시 알림을 보낼 수 있습니다:

```javascript
// Node.js에서 web-push 사용
const webpush = require('web-push');

webpush.setVapidDetails(
  'mailto:example@example.com',
  'BGAAkeewi5PIsZqvhtC9EQ2xF8yaDULZy9m9NvfQ6HwoxCTD8w9cJXUov7k-EiG3SsAh_AttKzg0-J5V8VAETWM', // 공개 키
  'gnXwo97jGpU3WH07u2izJHljDZWAroBKqvNohuMxv2s'  // 개인 키 (서버에서만 사용)
);

// 저장된 구독 정보로 푸시 전송
const subscription = { /* 클라이언트에서 저장한 구독 정보 */ };

const payload = {
  title: '⏰ 기도 시간 완료!',
  body: '기도 시간이 끝났습니다 🙏'
};

webpush.sendNotification(subscription, JSON.stringify(payload))
  .then(result => console.log('알림 전송 성공'))
  .catch(error => console.error('알림 전송 실패:', error));
```

---

## VAPID 키 정보
현재 설정된 키:
- **공개 키**: `BGAAkeewi5PIsZqvhtC9EQ2xF8yaDULZy9m9NvfQ6HwoxCTD8w9cJXUov7k-EiG3SsAh_AttKzg0-J5V8VAETWM`
- **개인 키**: `gnXwo97jGpU3WH07u2izJHljDZWAroBKqvNohuMxv2s`

⚠️ **개인 키는 보안을 위해 서버에만 저장해야 합니다!**

---

## 지원되는 브라우저
- ✅ Chrome/Chromium (v50+)
- ✅ Firefox (v48+)
- ✅ Edge (모든 버전)
- ❌ Safari (지원 안 함)

---

## 문제 해결

### "알림 권한이 거부되었습니다" 오류
1. Chrome 주소창 오른쪽의 🔔 또는 🔕 아이콘 클릭
2. "항상 허용" 또는 "차단 해제" 선택
3. 다시 "구독하기" 클릭

### "시크릿 모드에서 Push API 미지원" 오류
- VS Code 내장 브라우저가 아닌 **외부 브라우저 사용**
- Chrome 일반 탭에서 http://localhost:5174/joyful-prayer/ 접속

### 알림이 표시되지 않음
1. 브라우저 알림 권한 확인
2. Service Worker가 등록되었는지 확인:
   - DevTools (F12) → Application → Service Workers
3. 콘솔에서 에러 메시지 확인
