// api/weather.js
// THE MID-CALL WEBHOOK. Retell's voice agent calls this endpoint *during*
// the phone call (as a "custom function") when the caller asks about the
// weather. It:
//   1) looks up the weather for the requested town,
//   2) if it's cold (<10°C), fires the "bring a coat" reminder immediately,
//   3) returns a short sentence for the agent to speak back to the caller.
//
// This is the time-sensitive, user-facing action. It is deliberately kept
// SEPARATE from the post-call bookkeeping in api/call-webhook.js — the caller
// should never wait on a database write to hear their weather.

const { getCurrentWeather } = require("../lib/weather");
const { notify } = require("../lib/notify");

module.exports = async (req, res) => {
  // Retell sends a POST whose body contains the function arguments. We read
  // defensively because the exact shape can vary (args nested vs. flat, and
  // we also allow ?town= for easy manual testing in a browser/curl).
  const body = req.body || {};
  const args = body.args || body || {};
  const town = args.town || args.location || req.query?.town;

  if (!town) {
    return res
      .status(200)
      .json({ result: "Which town would you like the weather for?" });
  }

  try {
    const weather = await getCurrentWeather(town);
    const roundedTemp = Math.round(weather.tempC);

    let spoken = `In ${weather.town}, it's currently ${roundedTemp} degrees and ${weather.description}.`;
    let notified = null;

    if (weather.isCold) {
      // Who gets the text? Prefer an explicit recipient the agent collected,
      // else the caller's own number from the call object, else a demo default.
      const smsTo =
        args.notify_to || body.call?.from_number || process.env.DEFAULT_SMS_TO;
      const emailTo = process.env.DEFAULT_EMAIL_TO;
      const message = `Brrr — it's ${roundedTemp}°C in ${weather.town} today. Bring a coat! 🧥`;

      try {
        notified = await notify({ smsTo, emailTo, message });
        spoken += ` That's below 10 degrees, so I've sent you a reminder to bring a coat.`;
      } catch (notifyErr) {
        // The weather answer still succeeds even if the reminder couldn't send.
        console.error("[weather] notify failed:", notifyErr.message);
        spoken += ` That's below 10 degrees — you'll want a coat, though I had trouble sending the reminder.`;
      }
    } else {
      spoken += ` That's mild enough that you won't need a coat.`;
    }

    return res.status(200).json({ result: spoken, data: { ...weather, notified } });
  } catch (err) {
    // Handled, friendly failures return HTTP 200 with a spoken message so the
    // voice agent can say something sensible instead of hard-erroring mid-call.
    if (err.code === "TOWN_NOT_FOUND") {
      return res.status(200).json({
        result: `I couldn't find a town called ${town}. Could you try a nearby town?`,
      });
    }
    console.error("[weather] unexpected error:", err);
    return res.status(200).json({
      result: "Sorry, I couldn't reach the weather service just now. Please try again in a moment.",
    });
  }
};
