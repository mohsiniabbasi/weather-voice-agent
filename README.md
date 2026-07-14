# Weather-Aware Voice Agent — Yokeru Build

A voice agent you phone to check the weather. If it's below 10°C it texts you a
"bring a coat" reminder. Built as a real **deployed serverless function** (not a
low-code canvas), with the reliability patterns the role cares about baked in.

- **Voice:** Retell
- **Logic:** Vercel serverless functions (`/api/*.js`)
- **Weather:** Open-Meteo (free, no key)
- **Notify:** Twilio SMS → Resend email fallback
- **State:** Upstash Redis (idempotency, call log, dead-letter queue)

> New here? Read **SYSTEM-EXPLAINER.md** for the full "how and why", and
> **FUNCTIONAL-ANALYSIS.md** for the scoping doc. **LOOM-SCRIPT.md** is the
> recording plan.

---

## Files

```
api/weather.js        Mid-call webhook: weather lookup + cold reminder (the live path)
api/call-webhook.js   Post-call webhook: idempotent logging + dead-letter queue
api/reconcile.js      Missing-webhook detection (lists calls that never ended)
lib/weather.js        Open-Meteo geocoding + forecast + cold rule
lib/notify.js         Twilio SMS with Resend email fallback
lib/store.js          Idempotency / call log / DLQ (Redis, or in-memory fallback)
scripts/test-weather.js   Local test, no deploy/accounts needed
retell/agent-prompt.md    What to paste into Retell
```

## Run the logic locally (no accounts, no deploy)

```bash
node scripts/test-weather.js Dewsbury     # mild → no coat
node scripts/test-weather.js Hobart       # cold  → would send reminder
```

## Deploy the functions (Vercel)

1. Install the CLI and log in: `npm i -g vercel && vercel login`
2. From this folder: `vercel` (accept the defaults; it detects the `api/` functions).
3. Your endpoints are now live at:
   - `https://<project>.vercel.app/api/weather`
   - `https://<project>.vercel.app/api/call-webhook`
   - `https://<project>.vercel.app/api/reconcile`
4. Add environment variables (Vercel dashboard → Settings → Environment Variables)
   using `.env.example` as the checklist, then redeploy (`vercel --prod`).

Quick manual test of the deployed weather endpoint:

```bash
curl -X POST https://<project>.vercel.app/api/weather \
  -H "Content-Type: application/json" \
  -d '{"town":"Hobart"}'
```

You should get back `{ "result": "In Hobart, it's ... Bring a coat ..." }`.

## Wire up Retell

Follow **retell/agent-prompt.md**: create the agent, paste the system prompt, add
the `get_weather` custom function pointing at `/api/weather`, and (optional) set the
call webhook to `/api/call-webhook`. Use Retell's **web test call** to try it with
no phone number.

## Demo the reliability patterns (great for the Loom)

```bash
# Idempotency: send the same call_ended twice — second is ignored
# NOTE: call_id must be one you've never sent before (the store remembers old
# ones forever) — pick a fresh id each take, e.g. loom-demo-1, loom-demo-2...
curl -X POST https://<project>.vercel.app/api/call-webhook \
  -H "Content-Type: application/json" \
  -d '{"event":"call_ended","call":{"call_id":"loom-demo-1"}}'
# → {"status":"logged","callId":"loom-demo-1"}
# run the exact same command again:
# → {"status":"duplicate_ignored","callId":"loom-demo-1"}
```

## Cost

Everything here runs on free tiers (Open-Meteo, Retell free, Vercel hobby, Upstash
free, Twilio trial / Resend free). The only real-money item in a production version
would be a phone number and outbound SMS/voice minutes.
