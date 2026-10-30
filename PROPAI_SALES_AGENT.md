# PropAI Sales Agent — what changed & how to use it

## 1. Setup (one time)
1. `npm install`
2. In `.env` set:
   - `GEMINI_API_KEY=...` (or add the key from the dashboard: Settings → AI & Business)
   - `API_PUBLIC_URL=https://<your-backend-domain>` — WhatsApp downloads the sales images from here
   - `GEMINI_MODEL` / `GEMINI_FALLBACK_MODELS` are already set to current models
3. `npm start`

## 2. Change the prompt
Dashboard → **Sales Agent** → *Sales prompt* tab → edit → **Save changes**.
Test it immediately in the **Test chat** on the right (it uses your unsaved edits).
"Reset to default" brings back the original master prompt (`src/services/ai/defaultSalesPrompt.md`).

Other tabs:
- **Welcome message** – first message + Hindi / Hinglish / English buttons
- **Product & pricing** – the only facts / prices the agent may quote
- **Sales images** – images, PDF brochure or video the agent sends during the pitch; write *when to send* in plain words
- **Behaviour** – on/off, quick-reply buttons, auto images, team alert number

## 3. Chat flow
Prospect says hi → welcome + language buttons → business type → lead volume → challenge →
current process → relevant PropAI benefit (+ matching image) → demo offer → collects date/time →
demo request appears on **Demos** page + team alert. Pricing follows region rules (UAE vs India).

## 4. Gemini 503 fix
`src/services/ai/geminiClient.js`
- `gemini-2.0-flash` (old setting) was shut down by Google on 1 June 2026 — replaced automatically
- model fallback chain, exponential backoff + jitter, Retry-After, 30s timeout
- busy model is skipped for 60s, missing model for 1h
- broken JSON → retried on the next model
- if every model fails, the prospect still gets a safe scripted reply and you get a dashboard notification
- lead scoring is throttled (max once / 45s per lead) so it doesn't compete with replies for quota
- two quick messages from the same prospect → one reply (per-lead queue + 1.5s debounce)

## 5. WhatsApp templates
The opening template is still `agarwal_homez_property_offer` (Meta-approved). Create a new
PropAI template in Meta Business Manager and put its name in `META_WHATSAPP_OPENING_TEMPLATE_NAME`.
