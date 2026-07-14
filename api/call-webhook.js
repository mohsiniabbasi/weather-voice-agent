// api/call-webhook.js
// THE POST-CALL WEBHOOK. Retell calls this after call lifecycle events
// (call_started / call_ended / call_analyzed). This is where the durable
// bookkeeping happens — writing the call record — and where three of the
// reliability patterns live:
//   - idempotency on call_id  (duplicate webhooks write only once)
//   - dead-letter queue       (failed writes are parked, never dropped)
//   - missing-webhook tracking (record starts so we can detect calls that
//                               never send an "ended" event)

const {
  alreadyProcessed,
  writeCallLog,
  pushDLQ,
  markCallStarted,
  clearCallStarted,
} = require("../lib/store");

module.exports = async (req, res) => {
  const body = req.body || {};
  const event = body.event; // "call_started" | "call_ended" | "call_analyzed"
  const call = body.call || {};
  const callId = call.call_id;

  if (!callId) {
    return res.status(400).json({ error: "missing call_id" });
  }

  // call_started: just note that this call exists so reconcile can later spot
  // it if the matching "ended" event never arrives.
  if (event === "call_started") {
    await markCallStarted(callId);
    return res.status(200).json({ status: "start_recorded", callId });
  }

  // We only do the durable write on the terminal event.
  if (event !== "call_ended" && event !== "call_analyzed") {
    return res.status(200).json({ status: "ignored", event });
  }

  // IDEMPOTENCY: if we've already handled this call_id, acknowledge and stop.
  // Webhook senders retry on timeouts, so the SAME call_ended can arrive more
  // than once — without this guard we'd write duplicate records.
  if (await alreadyProcessed(callId)) {
    await clearCallStarted(callId); // safe to repeat
    return res.status(200).json({ status: "duplicate_ignored", callId });
  }

  try {
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
    // DEAD-LETTER QUEUE: the write failed (DB down, bad data...). Don't lose
    // the event — park the whole payload so it can be retried or inspected.
    console.error("[call-webhook] write failed, sending to DLQ:", err.message);
    await pushDLQ({ callId, payload: body, error: err.message, at: Date.now() });
    return res.status(200).json({ status: "dead_lettered", callId });
  }
};
