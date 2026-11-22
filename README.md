# Tube Inspector

Find out what a YouTube video is really about before you watch it. Paste a link and get a one-sentence summary, content labels (paid service, clickbait, possibly misleading...), a timeline of key moments and sponsor segments, expandable topics, and a chat box to ask questions about the video.

It has two parts, both free:

- **The app** (this folder, static files) lives on GitHub Pages and installs on your iPhone like a normal app.
- **The backend** (`worker/`, one file) lives on Cloudflare Workers. It fetches captions and talks to the free AI providers, so your API keys never touch GitHub or your phone.

## 1. Get free API keys (10 minutes, no credit card)

| Provider | Where | Used for |
|---|---|---|
| Google Gemini | https://aistudio.google.com/apikey | First choice. Long context (most videos in one call) and it can watch videos that have no captions |
| Groq | https://console.groq.com/keys | Fast backup |
| OpenRouter (optional) | https://openrouter.ai/keys | Last-resort backup (`:free` models) |

You need at least one. Gemini plus Groq is the recommended pair. Free tiers change often; see "Free-tier notes" below.

## 2. Deploy the backend (Cloudflare, free)

Easiest way, no tools needed:

1. Create a free account at https://dash.cloudflare.com, then **Workers & Pages > Create > Create Worker**. Name it `tube-inspector-backend` and deploy the starter.
2. Click **Edit code**, delete everything, paste the whole content of `worker/worker.js`, and **Deploy**.
3. Open the Worker's **Settings > Variables and Secrets** and add these as **Secrets**:
   - `APP_TOKEN`: any long random text you invent. The app will ask for it once.
   - `GEMINI_API_KEY`, `GROQ_API_KEY`, and optionally `OPENROUTER_API_KEY`.
4. Add one plain **Variable**: `ALLOWED_ORIGIN` = `https://YOURNAME.github.io` (your GitHub Pages address, no path). This stops other websites from calling your backend.
5. Copy the Worker address, like `https://tube-inspector-backend.yourname.workers.dev`.

Command-line way: `cd worker`, `npx wrangler login`, `npx wrangler deploy`, then `npx wrangler secret put APP_TOKEN` (and the keys).

## 3. Put the app on GitHub Pages

1. Create a new GitHub repository (public is fine, there are no secrets in it).
2. Upload everything in this folder except `worker/` and `tests/` if you like (they are harmless either way).
3. **Settings > Pages > Build and deployment**: Deploy from branch `main`, folder `/ (root)`.
4. After a minute your app is at `https://YOURNAME.github.io/REPO/`.

## 4. Install on your iPhone

1. Open the address in **Safari**, tap **Share**, then **Add to Home Screen**. Your logo becomes the app icon.
2. Open the app, tap the settings button, and enter the **backend address** and **access token**, then tap **Test connection**. It lists which AI providers are ready.

## 5. One-tap sharing from YouTube (iOS Shortcut)

The app opens a video straight from a link like `https://YOURNAME.github.io/REPO/?url=<video link>`. To use it from the Share button:

1. Open the **Shortcuts** app > **+** to create a shortcut, name it **Inspect video**.
2. Tap the **i** button, turn on **Show in Share Sheet**, and set it to accept **URLs** only.
3. Add the action **URL Encode** and set its input to **Shortcut Input**.
4. Add the action **Open URLs** with the text `https://YOURNAME.github.io/REPO/?url=` followed by the **URL Encoded Text** variable.

Now in YouTube: **Share > Inspect video**.

## How it analyses a video

1. **Captions** are fetched by the backend. Short and medium videos go to the AI in one call. Very long transcripts are split into parts, each part is noted separately, the notes are merged, and one final call writes the summary, labels, timeline and topics.
2. **If YouTube refuses the caption request** (it often blocks cloud servers) and Gemini is configured, **Gemini watches the video itself**, 30 minutes at a time.
3. **If that also fails**, the app shows a paste box so you can copy the transcript from YouTube ("Show transcript") and summarise that. Nothing is ever a dead end.
4. **Music** videos become "A song about..." with artist and cues, never quoting lyrics. **No speech or text** gives a short "No text content" note.

Labels are AI estimates with a one-line reason. When the AI is unsure the app shows "About 65% likely". Two labels use hard evidence instead of a guess: the creator's "includes paid promotion" tick and affiliate links in the description. The app never claims "fact checked", because a language model reading a transcript cannot verify facts.

## Free-tier notes

- Limits and model names change often. The backend tries a list of models in order and skips any that do not exist. To change them, set Worker variables such as `GEMINI_SMART_MODELS`, `GEMINI_VIDEO_MODELS`, `GROQ_SMART_MODELS` (comma separated).
- Gemini's free tier allows about 8 hours of YouTube video per day, and video input was labelled preview when this was written.
- On Gemini's free tier, Google may use prompts to improve its products. YouTube transcripts are public, but do not paste private text.
- Summaries are saved on your phone (up to 60), so reopening one costs nothing.

## Updating

The app caches itself for speed. After you upload a new version, open it, close it fully, and open it again. If it still looks old, change `CACHE` in `sw.js` to a new name.

## Tests

`node tests/run.mjs` runs 36 checks (parsing, chunking, labels, the AI router, Worker behaviour) with no network.

## Privacy

Your API keys live only in Cloudflare. The access token lives only on your phone and in Cloudflare. Summaries and chats are stored only on your phone.
