// ═══════════════════════════════════════════════════════════════════════════
//  ZombieRun Crash — MongoDB application provisioning
//
//  Invoked by bootstrap.sh via `mongosh --file`, AFTER the replica set has a
//  writable primary, so every write below is guaranteed to succeed.
//
//  ── mongosh constraints (verified empirically against mongo:7.0) ──────────
//  • `await` is NOT allowed in --file scripts ("await is only allowed within
//    async functions"). This file is therefore written without async plumbing.
//  • db.runCommand() resolves to a plain value (not a Promise) in mongosh's
//    script runner, so results can be inspected directly.
//  • process.env IS available when mongosh runs a file, which lets the
//    application password come from the environment instead of being
//    duplicated as a hard-coded literal.
//
//  Idempotent by design — re-running on every `docker compose up` is safe.
// ═══════════════════════════════════════════════════════════════════════════

const APP_USER = process.env.MONGO_APP_USER;
const APP_PASS = process.env.MONGO_APP_PASSWORD;
const APP_DB   = process.env.MONGO_APP_DB || 'zombierun';

if (!APP_USER || !APP_PASS) {
  throw new Error('MONGO_APP_USER and MONGO_APP_PASSWORD must be set in the bootstrap environment');
}

const appDb = db.getSiblingDB(APP_DB);
const roles = [{ role: 'readWrite', db: APP_DB }];

// ─── 1. Application user (create, or rotate the password) ───────────────────
// .env is the single source of truth: if the password changes there, the next
// `docker compose up` pushes it into MongoDB automatically.
const existing   = appDb.runCommand({ usersInfo: { user: APP_USER, db: APP_DB } });
const userExists = !!(existing.users && existing.users.length > 0);

if (userExists) {
  appDb.runCommand({ updateUser: APP_USER, pwd: APP_PASS, roles: roles });
  print('[provision] password refreshed for user "' + APP_USER + '"');
} else {
  appDb.runCommand({ createUser: APP_USER, pwd: APP_PASS, roles: roles });
  print('[provision] created user "' + APP_USER + '"');
}

// ─── 2. Safety-net index creation ───────────────────────────────────────────
// Only the UNIQUE constraints are declared here. They are the ones that must
// exist *before the very first request*, because they are the last line of
// defence against double-spend:
//
//   bets.{idempotencyKey, roundId} → blocks a replayed PLACE_BET / CASH_OUT
//   users.{email, username}        → blocks duplicate registration
//   gamerounds.roundNumber         → blocks two concurrent identical rounds
//
// Mongoose recreates every index on startup anyway; names below intentionally
// match Mongoose's default `<field>_<direction>` naming so that the driver
// sees them as identical and does not attempt a conflicting rebuild.
const UNIQUE_INDEXES = [
  {
    collection: 'users',
    indexes: [
      { key: { email: 1 },    name: 'email_1',    unique: true },
      { key: { username: 1 }, name: 'username_1', unique: true },
    ],
  },
  {
    collection: 'bets',
    indexes: [
      { key: { idempotencyKey: 1, roundId: 1 },  name: 'idempotencyKey_1_roundId_1',  unique: true },
      { key: { cashoutIdempotencyKey: 1 },       name: 'cashoutIdempotencyKey_1',     unique: true, sparse: true },
    ],
  },
  {
    collection: 'gamerounds',
    indexes: [
      { key: { roundNumber: 1 }, name: 'roundNumber_1', unique: true },
    ],
  },
];

for (const spec of UNIQUE_INDEXES) {
  try {
    const res = appDb.runCommand({ createIndexes: spec.collection, indexes: spec.indexes });
    print(
      '[provision] ' + spec.collection + ': ' +
      res.numIndexesBefore + ' → ' + res.numIndexesAfter + ' indexes',
    );
  } catch (err) {
    // A unique index cannot be built if legacy duplicates already exist.
    // That must not abort the bootstrap — surface it loudly instead, because
    // it means the double-spend guard is NOT active.
    print('[provision] WARNING: could not build indexes on ' + spec.collection + ': ' + err.message);
  }
}

print('[provision] done ✓');
