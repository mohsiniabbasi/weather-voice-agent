// api/reconcile.js
// ─────────────────────────────────────────────────────────────────────────────
// MISSING-WEBHOOK DETECTION.
// A call that sent "call_started" but never sent "call_ended" within the timeout
// is a lost event — maybe the webhook failed to deliver, maybe the call crashed.
// This endpoint surfaces those stale calls so they can be re-fetched (e.g. via
// Retell's GET /get-call API) and repaired.
//
// In production you'd run this on a schedule (a cron job every few minutes).
// Here it's an on-demand endpoint you can hit to show the concept working.
// ─────────────────────────────────────────────────────────────────────────────

const { findStaleCalls, snapshot } = require("../lib/store");

// The function Vercel runs when you GET /api/reconcile.
module.exports = async (req, res) => {
  // How old must an un-ended call be before we treat it as stale? Default 5 min,
  // overridable with ?maxAgeMs= for testing.
  const maxAgeMs = Number(req.query?.maxAgeMs) || 5 * 60 * 1000;

  // Ask the store for every call that started but hasn't been cleared in time.
  const stale = await findStaleCalls(maxAgeMs);

  // Return the findings plus a snapshot of internal counters (handy as a health view).
  return res.status(200).json({
    checkedAt: new Date().toISOString(),
    thresholdMs: maxAgeMs,
    staleCount: stale.length,
    staleCalls: stale,        // calls that started but never reported an end
    store: await snapshot(),  // seen / started / log / DLQ counts
  });
};
