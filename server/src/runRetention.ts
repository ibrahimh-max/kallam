import { applyEnvFile } from './config/loadEnvFile.ts';
import { loadEnv } from './config/env.ts';
import { JsonLogger } from './core/logger.ts';
import { createRepository } from './repositories/createRepository.ts';
import { RetentionService } from './services/retention/RetentionService.ts';

applyEnvFile();
const env = loadEnv();
if (env.repositoryDriver !== 'supabase') {
  throw new Error('The one-shot retention command requires REPOSITORY_DRIVER=supabase');
}

const logger = new JsonLogger({}, 'info');
const repo = createRepository(env);
const report = await new RetentionService(repo, env.retention, logger).run();
if (report.errors.length > 0) process.exitCode = 1;
