/**
 * Process entry point.
 *
 * The only job here is to wire the real dependencies and start listening, then keep
 * the process honest: unhandled rejections and uncaught exceptions are logged and
 * terminate the process rather than leaving it in an unknown state.
 *
 * Config is loaded and validated *before* the port is opened, so a misconfigured
 * deploy fails immediately instead of serving 500s.
 */
import { buildApp } from './app.ts';
import { applyEnvFile } from './config/loadEnvFile.ts';
import { loadEnv, safeSummary } from './config/env.ts';
import { JsonLogger } from './core/logger.ts';
import { createRepository } from './repositories/createRepository.ts';
import { createRateLimitStore } from './security/rateLimit.ts';
import { RetentionService } from './services/retention/RetentionService.ts';
import { createVoiceProvider } from './services/voice/VoiceProviderFactory.ts';
import { SEED_LESSONS, validateLessonContent } from './content/lessons.ts';

const logger = new JsonLogger({}, 'info');

// Read `server/.env` before anything reads config. A value already in the real
// environment wins, so a container/CI variable is never shadowed by the file.
// Names only are logged: no value from the file reaches the log.
const envFile = applyEnvFile();
if (envFile.found) {
  logger.info('config.env_file_loaded', {
    path: envFile.path,
    applied: envFile.applied,
    skippedExisting: envFile.skippedExisting,
  });
}

const env = loadEnv();
const repo = createRepository(env);
const choice = createVoiceProvider(env);

// Fail the deploy, not the first learner: authored content that violates the
// content contract would produce broken lessons (and empty transcripts).
for (const lesson of SEED_LESSONS) {
  const problems = validateLessonContent(lesson);
  if (problems.length > 0) {
    logger.error('content.invalid_seed_lesson', { slug: lesson.slug, problems });
    process.exit(1);
  }
}

const app = buildApp({ env, repo, provider: choice.provider, logger, rateLimitStore: createRateLimitStore(env) });
const retention = new RetentionService(repo, env.retention, logger);

// Lesson content lives in the repo as versioned TS and is seeded on boot, so a
// fresh database is usable immediately and content edits ship with the code.
await repo.lessons.upsertMany(SEED_LESSONS);

const server = app.listen(env.port, () => {
  // Names and booleans only; `safeSummary` never prints a value.
  logger.info('server.started', { ...safeSummary(env), voiceProvider: choice.kind, voiceReason: choice.reason });
  if (env.repositoryDriver === 'memory') {
    logger.warn('repository.ephemeral', {
      detail: 'in-memory driver: learner data will be lost when this process exits. Configure Supabase for durability.',
    });
  }
  void runRetention();
});

const retentionIntervalMs = 24 * 60 * 60 * 1000;
let retentionRunning = false;

async function runRetention(): Promise<void> {
  if (retentionRunning) return;
  retentionRunning = true;
  try {
    const report = await retention.run();
    if (report.errors.length > 0) {
      logger.error('retention.job_incomplete', { errorCount: report.errors.length });
    }
  } catch (error) {
    logger.error('retention.job_failed', {
      detail: error instanceof Error ? error.message : 'unknown',
    });
  } finally {
    retentionRunning = false;
  }
}

const retentionTimer = setInterval(() => {
  void runRetention();
}, retentionIntervalMs);
retentionTimer.unref();

function shutdown(signal: string, code = 0): void {
  logger.info('server.shutdown', { signal });
  clearInterval(retentionTimer);
  server.close(() => process.exit(code));
  // Do not hang on keep-alive sockets if a client stalls the close.
  setTimeout(() => process.exit(code), 5_000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => shutdown(signal));
}

process.on('unhandledRejection', (reason) => {
  logger.error('process.unhandled_rejection', { detail: reason instanceof Error ? reason.message : String(reason) });
  shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (error) => {
  logger.error('process.uncaught_exception', { detail: error.message, stack: error.stack?.split('\n').slice(0, 4).join(' | ') });
  shutdown('uncaughtException', 1);
});
