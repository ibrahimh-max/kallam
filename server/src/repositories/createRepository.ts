/**
 * Repository selection, once at startup.
 *
 * `memory` is the honest local default: it is functional but NOT durable, and the
 * health endpoint says so in plain text. `supabase` is selected only when its
 * credentials are actually present, and a *requested* Supabase driver without
 * credentials throws rather than silently downgrading — a silent downgrade would
 * mean a production deploy storing learners' data in a process that forgets on
 * restart.
 */
import type { ServerEnv } from '../config/env.ts';
import { AppError } from '../core/errors.ts';
import type { Repository } from './Repository.ts';
import { MemoryRepository } from './MemoryRepository.ts';
import { SupabaseRepository } from './SupabaseRepository.ts';

export function createRepository(env: ServerEnv): Repository {
  if (env.repositoryDriver === 'memory') return new MemoryRepository();

  if (env.supabase.url === '' || env.supabase.serviceRoleKey === '') {
    throw new AppError('INTERNAL', {
      messageEn: 'REPOSITORY_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
    });
  }

  return new SupabaseRepository({
    url: env.supabase.url,
    serviceRoleKey: env.supabase.serviceRoleKey,
  });
}
