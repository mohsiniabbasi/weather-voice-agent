// lib/notify.js
// ─────────────────────────────────────────────────────────────────────────────
// Sends the "bring a coat" reminder. Primary channel = SMS (Twilio).
// If SMS fails or isn't configured, we fall back to email (Resend).
// This graceful degradation is deliberate: the voice UX should still "succeed"
// for the caller even if one delivery channel is down.
// ─────────────────────────────────────────────────────────────────────────────

// --- SMS via Twilio REST API (no SDK, just fetch) ---------------------------
async function sendSms(to, body) {
  // Credentials come from environment variables (never hard-coded).
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) throw new Error("Twilio not configured"); // bail early if unset
  if (!to) throw new Error("No SMS recipient number");

  // Twilio's "send a message" endpoint, scoped to our account SID.
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const form = new URLSearchParams({ To: to, From: from, Body: body }); // Twilio wants form-encoded fields

  const res = await fetch(url, {
    method: "POST",
    headers: {
      // Twilio uses HTTP Basic auth: "AccountSid:AuthToken" base64-encoded.
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });

  if (!res.ok) {
    // Include Twilio's own error text — that's how we proved the 21612 block
    // was Twilio's, not our code.
    const detail = await res.text();
    throw new Error(`Twilio failed (HTTP ${res.status}): ${detail}`);
  }
  return { channel: "sms", to, ok: true }; // report which channel delivered
}

// --- Email via Resend REST API (the fallback channel) -----------------------
async function sendEmail(to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || "onboarding@resend.dev"; // default sender if unset

  if (!key) throw new Error("Resend not configured");
  if (!to) throw new Error("No email recipient");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,          // Resend uses a Bearer token
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, text }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Resend failed (HTTP ${res.status}): ${detail}`);
  }
  return { channel: "email", to, ok: true };
}

// Try SMS first; if it throws, log why and fall back to email.
// Returns which channel actually delivered, or throws only if BOTH fail.
async function notify({ smsTo, emailTo, message }) {
  try {
    return await sendSms(smsTo, message);
  } catch (smsErr) {
    console.warn("[notify] SMS failed, falling back to email:", smsErr.message);
    try {
      return await sendEmail(emailTo, "Weather reminder", message);
    } catch (emailErr) {
      // Both channels down. Surface a combined error so the caller can record it
      // (and, in the webhook path, push it to the DLQ).
      throw new Error(
        `All notification channels failed. SMS: ${smsErr.message} | Email: ${emailErr.message}`
      );
    }
  }
}

// Expose notify (used by api/weather.js) plus the individual senders.
module.exports = { notify, sendSms, sendEmail };
