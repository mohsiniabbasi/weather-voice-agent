# Retell Voice Agent — Configuration

This is what you paste into Retell (https://retellai.com) to create the voice
agent. Retell handles the phone call, speech-to-text, the LLM, and text-to-speech.
The only thing it delegates to us is the actual weather lookup, via a **custom
function** that calls our `/api/weather` endpoint.

---

## 1. Agent system prompt

```
You are Margret, a warm and friendly weather assistant on a phone line. Callers
ring you to check today's weather in their town. You sound like a kind, slightly
chatty British neighbour — natural and human, never robotic.

Your job:
1. Answer with a warm greeting, introduce yourself as Margret, and ask which town
   they'd like the weather for.
2. When they give you a town, call the `get_weather` function with that town.
3. Read back the result the function gives you in a natural, conversational way —
   as if you'd just looked out of the window for them.
4. If the function says a coat reminder was sent, mention it kindly ("I've popped
   a little reminder to your phone to bring a coat, love"). If it says the town
   wasn't found, ask them to try a nearby town.
5. Keep replies short — this is a phone call, not an essay. Then ask if there's
   another town they'd like to check, and wish them a lovely day when they're done.

Never invent weather numbers yourself. Always use the `get_weather` function for
any temperature or conditions. If the function returns an error message, relay it
gently to the caller and offer to try again.
```

**Voice to pick in Retell:** a British female voice (Retell's voice list has several
— anything UK-English and warm works for "Margret").

## 2. Custom function (this is the mid-call webhook)

In Retell, add a **Custom Function** with:

- **Name:** `get_weather`
- **Description:** `Get the current weather for a town and send a coat reminder if it is cold.`
- **URL:** `https://<your-vercel-project>.vercel.app/api/weather`
- **Method:** `POST`
- **Parameters (JSON schema):**

```json
{
  "type": "object",
  "properties": {
    "town": {
      "type": "string",
      "description": "The town or city the caller wants the weather for"
    }
  },
  "required": ["town"]
}
```

When the caller says "what's the weather in Hobart?", the LLM decides to call
`get_weather({ town: "Hobart" })`. Retell POSTs that to our URL, our function
replies with `{ "result": "In Hobart it's 4 degrees..." }`, and the agent speaks
the `result` text.

## 3. Post-call webhook (optional but recommended for the demo)

In Retell's **Webhook settings**, set the webhook URL to:

`https://<your-vercel-project>.vercel.app/api/call-webhook`

Retell will POST `call_started` / `call_ended` / `call_analyzed` events here. This
is what exercises the idempotency + dead-letter-queue + missing-webhook code.

## 4. Testing without a phone

Retell's dashboard has a **"Test call"** (web call) button — you can talk to the
agent from your browser, no real phone number needed. Use that for the Loom if you
don't want to set up a purchased number.
