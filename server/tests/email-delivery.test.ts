import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmailDeliveryError, ResendEmailDelivery } from '../src/services/auth/EmailDelivery.ts';

test('Resend delivery posts only the configured sender, recipient and action link', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const sender = new ResendEmailDelivery(
    'test-api-key',
    'Saudi English Tutor <noreply@example.com>',
    async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(null, { status: 200 });
    },
  );

  await sender.sendVerification('learner@example.com', 'https://tutor.example/auth/verify-email#token=secret');

  assert.equal(capturedUrl, 'https://api.resend.com/emails');
  assert.equal(new Headers(capturedInit?.headers).get('authorization'), 'Bearer test-api-key');
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    from: 'Saudi English Tutor <noreply@example.com>',
    to: ['learner@example.com'],
    subject: 'تحقق من بريدك الإلكتروني - Saudi English Tutor',
    text: 'استخدم الرابط التالي لتأكيد بريدك الإلكتروني:\n\nhttps://tutor.example/auth/verify-email#token=secret\n\nإذا لم تطلب إنشاء حساب، تجاهل هذه الرسالة.',
  });
  assert.ok(capturedInit?.signal instanceof AbortSignal);
});

test('Resend failures expose only a provider status, never provider response data', async () => {
  const sender = new ResendEmailDelivery('test-api-key', 'noreply@example.com', async () =>
    new Response('provider body with private details', { status: 429 }),
  );

  await assert.rejects(
    sender.sendPasswordRecovery('learner@example.com', 'https://tutor.example/reset#token=secret'),
    (error: unknown) => {
      assert.ok(error instanceof EmailDeliveryError);
      assert.equal(error.status, 429);
      assert.equal(error.message, 'email provider returned 429');
      assert.equal(error.message.includes('private details'), false);
      assert.equal(error.message.includes('test-api-key'), false);
      return true;
    },
  );
});
