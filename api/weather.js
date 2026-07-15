// api/weather.js
// ─────────────────────────────────────────────────────────────────────────────
// THE MID-CALL WEBHOOK (the live, user-facing function).
// Retell's voice agent calls this endpoint *during* the phone call, as a
// "custom function", the moment the caller asks about the weather. It:
//   1) looks up the weather for the requested town,
//   2) if it's cold (<10°C), fires the "bring a coat" reminder immediately,
//   3) returns a short sentence for the agent to speak back to the caller.
//
// This is time-sensitive and user-facing. It is deliberately kept SEPARATE from
// the post-call bookkeeping in api/call-webhook.js — the caller should never
// wait on a database write just to hear their weather. (This is the "decoupling".)
// ─────────────────────────────────────────────────────────────────────────────

// Pull in the two helpers this file coordinates (each lives in its own file).
const { getCurrentWeather } = require("../lib/weather"); // talks to the weather API
const { notify } = require("../lib/notify");             // sends the SMS / email reminder

// The function Vercel runs when Retell POSTs to /api/weather.
// req = the incoming request (caller's data); res = the reply we send back.
// `async` because we do slow things (call other servers) and need to `await` them.
module.exports = async (req, res) => {
  // --- Read the caller's town defensively -----------------------------------
  const body = req.body || {};                 // the POST body, or {} if there isn't one
  const args = body.args || body || {};        // Retell may nest args under `args`, or send them flat — handle both
  const town = args.town || args.location || req.query?.town; // field may be `town` or `location`; `?town=` lets us test in a browser/curl

  // If no town was given, ask for one instead of crashing.
  // Note the 200 (success) status: on a voice call the agent needs a spoken
  // sentence to say, not an HTTP error — so "errors become speech".
  if (!town) {
    return res
      .status(200)
      .json({ result: "Which town would you like the weather for?" });
  }

  try {
    // Look up the weather and WAIT for the result (an object like
    // { town, tempC, description, isCold }).
    const weather = await getCurrentWeather(town);
    const roundedTemp = Math.round(weather.tempC); // round 4.8 → 5 so the agent says a clean number

    // Build the sentence the agent will speak. `${...}` inserts real values.
    let spoken = `In ${weather.town}, it's currently ${roundedTemp} degrees and ${weather.description}.`;
    let notified = null; // will hold the delivery result IF we send a reminder

    if (weather.isCold) {
      // It's below the threshold → send the coat reminder.
      // Pick the recipient: an explicit number the agent collected, else the
      // caller's own number from the call object, else a demo default.
      const smsTo =
        args.notify_to || body.call?.from_number || process.env.DEFAULT_SMS_TO;
      const emailTo = process.env.DEFAULT_EMAIL_TO; // fallback channel address
      const message = `Brrr — it's ${roundedTemp}°C in ${weather.town} today. Bring a coat! 🧥`;

      try {
        // Try to send the reminder (SMS first, email fallback — see lib/notify.js).
        notified = await notify({ smsTo, emailTo, message });
        spoken += ` That's below 10 degrees, so I've sent you a reminder to bring a coat.`;
      } catch (notifyErr) {
        // Reminder failed — but the weather answer STILL succeeds. The core
        // answer never depends on the side-effect working (graceful degradation).
        console.error("[weather] notify failed:", notifyErr.message);
        spoken += ` That's below 10 degrees — you'll want a coat, though I had trouble sending the reminder.`;
      }
    } else {
      // Warm enough — no reminder needed.
      spoken += ` That's mild enough that you won't need a coat.`;
    }

    // Success: hand the spoken sentence back for the agent to say. `data` carries
    // the raw details too (handy for logs / debugging), but the agent uses `result`.
    return res.status(200).json({ result: spoken, data: { ...weather, notified } });
  } catch (err) {
    // --- Friendly failures: still return 200 with something sayable ----------
    // A 500 would leave the agent with nothing to say mid-call, so we turn every
    // error into a spoken sentence instead.

    // Known case: the weather library couldn't find that town (typed error code).
    if (err.code === "TOWN_NOT_FOUND") {
      return res.status(200).json({
        result: `I couldn't find a town called ${town}. Could you try a nearby town?`,
      });
    }

    // Anything else (API down, unexpected): log it for us, apologise to the caller.
    console.error("[weather] unexpected error:", err);
    return res.status(200).json({
      result: "Sorry, I couldn't reach the weather service just now. Please try again in a moment.",
    });
  }
};
