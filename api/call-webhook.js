// api/call-webhook.js
// ─────────────────────────────────────────────────────────────────────────────
// THE POST-CALL WEBHOOK (durable bookkeeping).
// Retell calls this AFTER call lifecycle events (call_started / call_ended /
// call_analyzed). Nobody is waiting on the line here, so it can afford to be
// careful. This is where three reliability patterns live:
//   - idempotency on call_id   → duplicate webhooks write only once
//   - dead-letter queue (DLQ)  → failed writes are parked, never dropped
//   - missing-webhook tracking → record starts so we can spot calls that
//                                never send an "ended" event
// ─────────────────────────────────────────────────────────────────────────────

// Helpers for the shared state store (Redis in prod, in-memory fallback locally).
const {
  alreadyProcessed,  // atomic "have we handled this call_id already?"
  writeCallLog,      // the durable write (append the finished-call record)
  pushDLQ,           // park a failed write so it's never lost
  markCallStarted,   // note a call began (for missing-webhook detection)
  clearCallStarted,  // note a call ended (matches markCallStarted)
} = require("../lib/store");

// The function Vercel runs when Retell POSTs a lifecycle event to /api/call-webhook.
module.exports = async (req, res) => {
  const body = req.body || {};
  const event = body.event;      // "call_started" | "call_ended" | "call_analyzed"
  const call = body.call || {};  // the call object Retell sends
  const callId = call.call_id;   // our idempotency key — uniquely identifies this call

  // No call_id = a malformed event. This is the one case we DO tell the sender
  // it was a bad request (400) — retrying without an id can't help anyway.
  if (!callId) {
    return res.status(400).json({ error: "missing call_id" });
  }

  // call_started: just record that this call exists, so reconcile can later
  // notice if the matching "ended" event never turns up. Then stop.
  if (event === "call_started") {
    await markCallStarted(callId);
    return res.status(200).json({ status: "start_recorded", callId });
  }

  // We only do the durable write on a terminal event; ignore anything else.
  if (event !== "call_ended" && event !== "call_analyzed") {
    return res.status(200).json({ status: "ignored", event });
  }

  // IDEMPOTENCY: if we've already handled this call_id, acknowledge and stop.
  // Webhook senders retry on timeouts, so the SAME call_ended can arrive twice —
  // without this guard we'd write duplicate records.
  if (await alreadyProcessed(callId)) {
    await clearCallStarted(callId); // safe to repeat (DEL is harmless if already gone)
    return res.status(200).json({ status: "duplicate_ignored", callId });
  }

  try {
    // The durable write: save one clean record of the finished call.
    await writeCallLog({
      callId,
      event,
      from: call.from_number || null,
      to: call.to_number || null,
      endedAt: new Date().toISOString(),
      transcript: call.transcript || null,
    });

    // The "ended" event arrived, so this call is no longer outstanding.
    await clearCallStarted(callId);

    return res.status(200).json({ status: "logged", callId });
  } catch (err) {
    // DEAD-LETTER QUEUE: the write failed (store down, bad data...). Don't lose
    // the event — park the whole payload so it can be retried/inspected later.
    // We return 200 so Retell doesn't hammer us with retries while the store is
    // already struggling; the DLQ now owns the retry instead.
    console.error("[call-webhook] write failed, sending to DLQ:", err.message);
    await pushDLQ({ callId, payload: body, error: err.message, at: Date.now() });
    return res.status(200).json({ status: "dead_lettered", callId });
  }
};
