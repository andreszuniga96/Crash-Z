#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
#  ZombieRun Crash — MongoDB bootstrap (idempotent, runs on every `up`)
#
#  Executed by the one-shot `mongo-init` container AFTER mongod reports
#  healthy. Safe to run repeatedly — every step is idempotent.
#
#    1. wait for mongod to accept AUTHENTICATED connections
#    2. initiate the single-node replica set       (skipped if already done)
#    3. wait for a writable PRIMARY                (initiate returns early!)
#    4. provision the application user + indexes   (bootstrap.js)
#
#  ── Why this container exists ────────────────────────────────────────────────
#  Scripts in /docker-entrypoint-initdb.d only run when MongoDB's data
#  directory is EMPTY. On an existing volume they are skipped forever, which
#  is exactly how the application user went missing and the API server got
#  stuck in a restart loop with "Authentication failed".
#
#  MongoDB also requires transactions (used by the game state machine) to run
#  against a replica set, and a replica set has to be initiated from outside
#  the mongod process — hence this one-shot sidecar.
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

MONGO_HOST="${MONGO_RS_HOST:-mongo:27017}"
RS_NAME="${MONGO_RS_NAME:-rs0}"
WAIT_ATTEMPTS="${BOOTSTRAP_WAIT_ATTEMPTS:-60}"   # × 2s = 120s per phase

# Fail fast with a clear message if compose did not pass the secrets through.
: "${MONGO_ROOT_USER:?MONGO_ROOT_USER is required}"
: "${MONGO_ROOT_PASSWORD:?MONGO_ROOT_PASSWORD is required}"

MONGO_ARGS=(
  --host "$MONGO_HOST"
  --username "$MONGO_ROOT_USER"
  --password "$MONGO_ROOT_PASSWORD"
  --authenticationDatabase admin
  --quiet
)

log() { echo "[bootstrap] $*"; }

# ── 1. Wait for mongod with auth ──────────────────────────────────────────────
log "Waiting for mongod at ${MONGO_HOST} to accept authenticated connections…"
attempt=0
until mongosh "${MONGO_ARGS[@]}" --eval 'db.adminCommand({ ping: 1 }).ok' 2>/dev/null | grep -q 1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$WAIT_ATTEMPTS" ]; then
    log "FATAL: mongod unreachable after $((WAIT_ATTEMPTS * 2))s"
    exit 1
  fi
  sleep 2
done
log "mongod reachable ✓"

# ── 2. Initiate the replica set (idempotent) ──────────────────────────────────
log "Ensuring replica set '${RS_NAME}' is initiated…"
mongosh "${MONGO_ARGS[@]}" --eval "
  let initialised = false;
  try { initialised = rs.status().ok === 1; } catch (e) { initialised = false; }

  if (initialised) {
    print('replica set already initiated — leaving as is');
  } else {
    try {
      rs.initiate({ _id: '${RS_NAME}', members: [{ _id: 0, host: '${MONGO_HOST}' }] });
      print('initiated ${RS_NAME} with member ${MONGO_HOST}');
    } catch (e) {
      if (String(e.codeName) === 'AlreadyInitialized') {
        print('replica set already initiated (race) — OK');
      } else {
        throw new Error('rs.initiate failed: ' + e.message);
      }
    }
  }
"

# ── 3. Wait for a writable PRIMARY ────────────────────────────────────────────
# rs.initiate() returns before the election finishes. Any write issued in that
# window fails with NotWritablePrimary, so we must block until the node has
# actually been promoted.
log "Waiting for a writable primary…"
attempt=0
until mongosh "${MONGO_ARGS[@]}" --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -qi true; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$WAIT_ATTEMPTS" ]; then
    log "FATAL: no writable primary after $((WAIT_ATTEMPTS * 2))s"
    exit 1
  fi
  sleep 2
done
log "primary elected ✓"

# ── 4. Provision application user + indexes ───────────────────────────────────
log "Provisioning application user and indexes…"
mongosh "${MONGO_ARGS[@]}" --file /bootstrap.js

log "MongoDB bootstrap complete ✓"
