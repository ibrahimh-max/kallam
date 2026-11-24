import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NullLogger } from '../src/core/logger.ts';
import { MemoryRepository } from '../src/repositories/MemoryRepository.ts';
import { UsageService, utcDay } from '../src/services/usage/UsageService.ts';

test('concurrent reservations cannot exceed the shared daily credit budget', async () => {
  const now = new Date();
  const day = utcDay(now);
  const repo = new MemoryRepository();
  const usage = new UsageService(
    repo,
    {
      freeDailySpeakingAttempts: 100,
      freeDailyTtsRequests: 100,
      dailyCreditBudget: 100,
    },
    new NullLogger(),
    () => now,
  );

  const reservations = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      usage.reserve({
        userId: `learner-${index}`,
        feature: 'stt',
        quantity: 40,
        creditsEstimated: 40,
        provider: 'test',
        model: null,
        requestId: `budget-test-${index}`,
      }),
    ),
  );

  assert.equal(reservations.filter((reservation) => reservation.allowed).length, 2);
  assert.equal(
    reservations.filter((reservation) => reservation.reason === 'credit_budget').length,
    8,
  );
  assert.equal(await repo.usage.creditsForDay(day), 80);
});

test('a failed reservation releases daily budget headroom', async () => {
  const now = new Date();
  const day = utcDay(now);
  const repo = new MemoryRepository();
  const usage = new UsageService(
    repo,
    {
      freeDailySpeakingAttempts: 100,
      freeDailyTtsRequests: 100,
      dailyCreditBudget: 40,
    },
    new NullLogger(),
    () => now,
  );

  const first = await usage.reserve({
    userId: 'learner-1',
    feature: 'stt',
    quantity: 40,
    creditsEstimated: 40,
    provider: 'test',
    model: null,
    requestId: 'failed-budget-reservation-1',
  });
  assert.equal(first.allowed, true);
  await usage.settleFailure(first.event!.id);

  const retry = await usage.reserve({
    userId: 'learner-1',
    feature: 'stt',
    quantity: 40,
    creditsEstimated: 40,
    provider: 'test',
    model: null,
    requestId: 'failed-budget-reservation-2',
  });

  assert.equal(retry.allowed, true);
  assert.equal(await repo.usage.creditsForDay(day), 40);
});
