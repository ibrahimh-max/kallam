export type AuthActionPage = 'verify-email' | 'reset-password';

export function renderAuthActionPage(kind: AuthActionPage, nonce: string): string {
  const isVerification = kind === 'verify-email';
  const title = isVerification ? 'تأكيد البريد الإلكتروني' : 'إعادة تعيين كلمة المرور';
  const content = isVerification
    ? `<p id="status">نتحقق من الرابط...</p>`
    : `<form id="reset-form">
        <label for="password">كلمة المرور الجديدة</label>
        <input id="password" type="password" minlength="8" maxlength="200" autocomplete="new-password" required>
        <button type="submit">حفظ كلمة المرور</button>
      </form>
      <p id="status" role="status"></p>`;
  const script = isVerification
    ? `const token = new URLSearchParams(location.hash.slice(1)).get('token');
       history.replaceState(null, '', location.pathname);
       const status = document.getElementById('status');
       if (!token) {
         status.textContent = 'الرابط غير صالح. اطلب رسالة تحقق جديدة من التطبيق.';
       } else {
         fetch('/v1/auth/verify-email', {
           method: 'POST',
           headers: { 'content-type': 'application/json' },
           body: JSON.stringify({ token })
         }).then((response) => {
           if (response.ok) {
             status.textContent = 'تم تأكيد بريدك. ارجع للتطبيق وسجّل الدخول.';
           } else if (response.status === 401) {
             status.textContent = 'انتهت صلاحية الرابط أو تم استخدامه. اطلب رسالة تحقق جديدة.';
           } else {
             status.textContent = 'تعذر التحقق من البريد الآن. حاول مرة ثانية.';
           }
         }).catch(() => {
           status.textContent = 'تعذر الاتصال. حاول فتح الرابط مرة ثانية أو اطلب رسالة جديدة.';
         });
       }`
    : `const token = new URLSearchParams(location.hash.slice(1)).get('token');
       history.replaceState(null, '', location.pathname);
       const form = document.getElementById('reset-form');
       const status = document.getElementById('status');
       if (!token) {
         form.hidden = true;
         status.textContent = 'الرابط غير صالح. اطلب رابط استعادة جديد من التطبيق.';
       }
       form.addEventListener('submit', async (event) => {
         event.preventDefault();
         const password = document.getElementById('password').value;
         try {
           const response = await fetch('/v1/auth/reset-password', {
             method: 'POST',
             headers: { 'content-type': 'application/json' },
             body: JSON.stringify({ token, password })
           });
           if (response.ok) {
             form.hidden = true;
             status.textContent = 'تم تحديث كلمة المرور. ارجع للتطبيق وسجّل الدخول.';
           } else if (response.status === 401) {
             form.hidden = true;
             status.textContent = 'انتهت صلاحية الرابط. اطلب رابط استعادة جديداً.';
           } else {
             status.textContent = 'تعذر تحديث كلمة المرور. تأكد من إدخال كلمة مرور صحيحة وحاول مرة ثانية.';
           }
         } catch {
           status.textContent = 'تعذر الاتصال. حاول مرة ثانية.';
         }
       });`;

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${title} - Saudi English Tutor</title>
  <style>
    body { font-family: sans-serif; margin: 3rem auto; max-width: 32rem; padding: 0 1rem; line-height: 1.7; }
    input, button { box-sizing: border-box; display: block; font: inherit; margin-top: 1rem; padding: .7rem; width: 100%; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    ${content}
  </main>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
}
