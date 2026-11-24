import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessRlsAudit } from '../src/repositories/SupabaseRepository.ts';
import { SupabaseRateLimitStore } from '../src/security/rateLimit.ts';

test('RLS health audit rejects empty, malformed and unprotected table results', () => {
  assert.equal(assessRlsAudit([]).ok, false);
  assert.equal(assessRlsAudit([{ table_name: 'profiles' }]).ok, false);
  assert.deepEqual(
    assessRlsAudit([
      { table_name: 'profiles', rls_enabled: true },
      { table_name: 'new_table', rls_enabled: false },
    ]),
    { ok: false, detail: 'RLS disabled on public tables: new_table' },
  );
  assert.deepEqual(
    assessRlsAudit([{ table_name: 'profiles', rls_enabled: true }]),
    { ok: true, detail: 'RLS enabled on 1 public tables' },
  );
});

test('shared rate-limit buckets are consistently HMACed and never send raw identifiers', async () => {
  const calls: Array<{ p_bucket_hash: string }> = [];
  const rpc = async (args: { p_bucket_hash: string }) => {
    calls.push(args);
    return {
      data: [{ allowed: true, remaining: 4, retry_after_seconds: 0 }],
      error: null,
    };
  };
  const firstInstance = new SupabaseRateLimitStore(rpc, 'shared-secret-with-at-least-thirty-two-characters');
  const secondInstance = new SupabaseRateLimitStore(rpc, 'shared-secret-with-at-least-thirty-two-characters');

  await firstInstance.hit('ip:203.0.113.8', 60_000, 5, 1_000);
  await secondInstance.hit('ip:203.0.113.8', 60_000, 5, 1_001);

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.p_bucket_hash, calls[1]!.p_bucket_hash);
  assert.notEqual(calls[0]!.p_bucket_hash, 'ip:203.0.113.8');
  assert.match(calls[0]!.p_bucket_hash, /^[0-9a-f]{64}$/);
});

test('shared rate limiter fails closed on RPC failures and malformed decisions', async () => {
  const unavailable = new SupabaseRateLimitStore(
    async () => ({ data: null, error: { message: 'database unavailable' } }),
    'shared-secret-with-at-least-thirty-two-characters',
  );
  await assert.rejects(unavailable.hit('user:learner-1', 60_000, 5, 1_000), /database unavailable/);

  const malformed = new SupabaseRateLimitStore(
    async () => ({ data: [{ allowed: 'yes', remaining: 1, retry_after_seconds: 0 }], error: null }),
    'shared-secret-with-at-least-thirty-two-characters',
  );
  await assert.rejects(malformed.hit('user:learner-1', 60_000, 5, 1_000), /invalid decision fields/);
});
