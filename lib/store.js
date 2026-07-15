// lib/store.js
// ─────────────────────────────────────────────────────────────────────────────
// The "memory" of the system: idempotency, the call log, and the dead-letter
// queue (DLQ). Serverless functions are STATELESS — each invocation may run on a
// fresh machine — so anything that must survive between requests lives in an
// external shared store. We use Upstash Redis (free, REST-based) when configured,
// and fall back to an in-process Map for local testing.
//
// NOTE on the fallback: the in-memory version only works within a single warm
// instance. It's fine for a local demo but is NOT real idempotency across
// serverless invocations — which is exactly why the Redis path exists.
// ─────────────────────────────────────────────────────────────────────────────

// Local-only fallback state (used when Redis env vars are absent).
const memory = {
  seen: new Map(),    // call_id -> timestamp  (idempotency)
  started: new Map(), // call_id -> timestamp  (for missing-webhook detection)
  logs: [],           // completed call records
  dlq: [],            // failed writes, kept for retry/inspection
};

// True only if both Upstash env vars are present → use Redis; otherwise in-memory.
function hasRedis() {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

// Minimal Upstash REST client: POST a command array (e.g. ["SET","k","v"]),
// get back { result: ... }. One HTTP round-trip per command.
async function redisCmd(cmd) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`Redis command failed: HTTP ${res.status}`);
  return res.json();
}

// --- Idempotency ------------------------------------------------------------
// Returns TRUE if this call_id has already been processed (caller should skip).
// The check-and-mark is ATOMIC via Redis `SET key val NX`:
//   - NX = "only set if it does not already exist"
//   - result "OK"  -> we just claimed it (first time)  -> return false
//   - result null  -> it already existed (duplicate)    -> return true
// One atomic command avoids a race where two duplicates arriving in the same
// millisecond both think they're first. EX 86400 = the key self-expires in 24h.
async function alreadyProcessed(callId) {
  if (hasRedis()) {
    const out = await redisCmd(["SET", `seen:${callId}`, "1", "NX", "EX", "86400"]);
    return out.result === null; // null means the key already existed = duplicate
  }
  // In-memory fallback (single instance only — not true cross-invocation dedupe).
  if (memory.seen.has(callId)) return true;
  memory.seen.set(callId, Date.now());
  return false;
}

// --- Call log (the "post-call write") ---------------------------------------
// Append the finished-call record. RPUSH adds to the end of a Redis list.
async function writeCallLog(record) {
  if (hasRedis()) {
    await redisCmd(["RPUSH", "call_logs", JSON.stringify(record)]);
    return;
  }
  memory.logs.push(record);
}

// --- Dead-letter queue ------------------------------------------------------
// When a write fails, we don't drop it — we park it here so it can be retried
// or inspected later. Losing data silently is the failure mode we guard against.
async function pushDLQ(item) {
  if (hasRedis()) {
    await redisCmd(["RPUSH", "dlq", JSON.stringify(item)]);
    return;
  }
  memory.dlq.push(item);
}

// --- Missing-webhook detection ----------------------------------------------
// Record when a call starts; clear it when the matching "ended" webhook arrives.
// Any start left un-cleared past the timeout means "ended" never came — a signal
// to reconcile (see api/reconcile.js). EX 3600 = the marker self-expires in 1h.
async function markCallStarted(callId) {
  if (hasRedis()) {
    await redisCmd(["SET", `started:${callId}`, Date.now().toString(), "EX", "3600"]);
    return;
  }
  memory.started.set(callId, Date.now());
}

// Remove the "started" marker once the call has properly ended.
async function clearCallStarted(callId) {
  if (hasRedis()) {
    await redisCmd(["DEL", `started:${callId}`]);
    return;
  }
  memory.started.delete(callId);
}

// List Redis keys matching a pattern, looping SCAN until the cursor returns "0".
// (SCAN is the non-blocking way to enumerate keys via the REST API.)
async function redisKeys(pattern) {
  let cursor = "0";
  const keys = [];
  do {
    const out = await redisCmd(["SCAN", cursor, "MATCH", pattern, "COUNT", "1000"]);
    cursor = out.result[0];       // next cursor position
    keys.push(...out.result[1]);  // the batch of keys found
  } while (cursor !== "0");
  return keys;
}

// Returns call_ids that started but never ended within `maxAgeMs`.
// Redis mode scans `started:*` keys (their values are the start timestamps).
async function findStaleCalls(maxAgeMs = 5 * 60 * 1000) {
  const now = Date.now();
  const stale = [];
  if (hasRedis()) {
    const keys = await redisKeys("started:*");
    for (const key of keys) {
      const out = await redisCmd(["GET", key]);
      const startedAt = Number(out.result);
      if (startedAt && now - startedAt > maxAgeMs) {
        stale.push({ callId: key.replace("started:", ""), startedAt });
      }
    }
    return stale;
  }
  // In-memory fallback: walk the started map.
  for (const [callId, startedAt] of memory.started.entries()) {
    if (now - startedAt > maxAgeMs) stale.push({ callId, startedAt });
  }
  return stale;
}

// Small helper so the reconcile/health endpoints can show internal state (counts).
async function snapshot() {
  if (hasRedis()) {
    // Gather all four counters in parallel for speed.
    const [seen, started, logs, dlq] = await Promise.all([
      redisKeys("seen:*"),
      redisKeys("started:*"),
      redisCmd(["LLEN", "call_logs"]), // LLEN = length of a list
      redisCmd(["LLEN", "dlq"]),
    ]);
    return {
      backend: "redis",
      seenCount: seen.length,
      startedCount: started.length,
      logCount: logs.result,
      dlqCount: dlq.result,
    };
  }
  return {
    backend: "in-memory",
    seenCount: memory.seen.size,
    startedCount: memory.started.size,
    logCount: memory.logs.length,
    dlqCount: memory.dlq.length,
  };
}

// Expose everything the webhook/reconcile endpoints need.
module.exports = {
  alreadyProcessed,
  writeCallLog,
  pushDLQ,
  markCallStarted,
  clearCallStarted,
  findStaleCalls,
  snapshot,
  hasRedis,
};
