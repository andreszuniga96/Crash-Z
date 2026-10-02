/**
 * @file seedAdmin.ts
 * @description One-time admin user bootstrapper.
 *
 * Runs at server startup. If no admin user exists in the database,
 * creates one using the credentials in the environment variables:
 *   BOOTSTRAP_ADMIN_EMAIL
 *   BOOTSTRAP_ADMIN_PASSWORD
 *   BOOTSTRAP_ADMIN_USERNAME
 *
 * After the first successful creation:
 *   - Logs a warning to remove the bootstrap env vars from production
 *   - Is a no-op on all subsequent restarts (idempotent)
 *
 * SECURITY: Remove or randomize BOOTSTRAP_ADMIN_* vars after first deploy.
 */

import { UserModel, UserRole, AccountStatus } from '../models/User.model';
import { hashPassword }                        from '../auth/password';
import { logger }                              from '../logger';

export async function bootstrapAdmin(): Promise<void> {
  const email    = process.env['BOOTSTRAP_ADMIN_EMAIL'];
  const password = process.env['BOOTSTRAP_ADMIN_PASSWORD'];
  const username = process.env['BOOTSTRAP_ADMIN_USERNAME'] ?? 'admin';

  if (!email || !password) {
    logger.debug('[Seed] BOOTSTRAP_ADMIN_* vars not set — skipping admin creation');
    return;
  }

  // Check if any admin already exists
  const existingAdmin = await UserModel.findOne({ role: UserRole.ADMIN }).lean();
  if (existingAdmin) {
    logger.debug(`[Seed] Admin already exists (${existingAdmin.username}) — skipping bootstrap`);
    return;
  }

  // Check password strength
  if (password.length < 12) {
    logger.error('[Seed] BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters! Skipping admin creation.');
    return;
  }

  try {
    const passwordHash = await hashPassword(password);

    await UserModel.create({
      username,
      email:        email.toLowerCase(),
      passwordHash,
      role:         UserRole.ADMIN,
      status:       AccountStatus.ACTIVE,
      balanceCents: 0,
    });

    logger.info(`[Seed] ✓ Bootstrap admin created: ${username} (${email})`);
    logger.warn('[Seed] ⚠️  REMOVE BOOTSTRAP_ADMIN_* from your .env file after first deployment!');

  } catch (err) {
    // E11000 = duplicate key — means admin was created by a concurrent instance
    if ((err as NodeJS.ErrnoException).message?.includes('E11000')) {
      logger.info('[Seed] Admin already exists (concurrent creation) — OK');
    } else {
      logger.error('[Seed] Failed to create bootstrap admin', { error: (err as Error).message });
    }
  }
}
