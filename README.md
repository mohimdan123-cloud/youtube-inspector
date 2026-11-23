# Tube Inspector

Find out what a YouTube video is really about before you watch it. Paste a link and get a one-sentence summary, content labels (paid service, clickbait, possibly misleading...), a timeline of key moments and sponsor segments, expandable topics, and a chat box to ask questions about the video.

There are two ways to run it. Start with **A** to test on your PC, then do **B** when you want it on your iPhone anywhere.

- **A. On your PC (fastest, nothing to deploy).** One small local server serves the app and talks to the AI. Your keys stay in a file on your PC.
- **B. On your iPhone (GitHub Pages + Cloudflare Worker).** The app is static files on GitHub Pages. A free Cloudflare Worker holds your keys and talks to the AI.

## 0. Get free API keys (10 minutes, no credit card)

| Provider | Where | Used for |
|---|---|---|
| Google Gemini | https://aistudio.google.com/apikey | First choice. Long context, and it can watch videos that have no captions |
| Groq | https://console.groq.com/keys | Fast backup |
| OpenRouter (optional) | https://openrouter.ai/keys | Last-resort backup (`:free` models) |

You need at least one. Gemini plus Groq is the recommended pair. Free tiers change often (see "Free-tier notes").

## A. Run it on your PC

1. Install **Node.js** (LTS version) from https://nodejs.org. Accept the defaults. If the installer was already open, restart your terminal afterwards.
2. In this folder, copy `.dev.vars.example` to a new file named exactly `.dev.vars`. Open it in Notepad and paste your keys after the `=` signs. (Windows may hide files starting with a dot; in File Explorer turn on **View > Show > Hidden items**.)
3. Start it:
   - **Windows:** double-click `start.bat`.
   - **Mac/Linux:** run `./start.sh` (or `node server.mjs --open`).
4. Your browser opens at `http://localhost:8787` (the number may differ; the window prints it). The app connects to the local server by itself. Paste a YouTube link and tap **Summarize**.
5. Press **Ctrl+C** in the window to stop.

Notes:

- No access token is needed on your own PC. The server only answers requests from the same computer.
- Running from your home internet may avoid YouTube's block on cloud servers, so captions are more likely to load than from a Worker. This is likely but not guaranteed.
- If the window says no AI keys are configured, check that the file is called `.dev.vars` and not `.dev.vars.txt`.

### Trying it on your phone over Wi-Fi (optional)

Double-click `start-phone.bat` (or run `node server.mjs --lan`). The window prints an address like `http://192.168.1.20:8787` and an access token. Open the address on your phone (same Wi-Fi), open Settings, and enter the token.

Limits of this mode: iOS treats a plain `http://` address on your network as not secure, so the **Paste from clipboard** button, "Add to Home Screen" as a real offline app, and the service worker will not work there. Paste into the link box by hand instead. For proper phone use, do part B.

## B. Put it on your iPhone

### B1. Deploy the backend (Cloudflare, free)

You need the command line for this (it is short).

1. Create a free account at https://dash.cloudflare.com.
2. Open `worker/wrangler.toml` and set `ALLOWED_ORIGIN` to your GitHub Pages address without a path, for example `https://yourname.github.io`. This stops other websites from calling your backend. (Leave `*` while testing.)
3. In a terminal:

```
cd worker
npx wrangler login
npx wrangler deploy
npx wrangler secret put APP_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
```

`APP_TOKEN` is any long random text you invent; the app asks for it once. Each `secret put` asks you to paste the value. Skip the keys you do not have.

4. `wrangler deploy` prints the Worker address, like `https://tube-inspector-backend.yourname.workers.dev`. Keep it for B3.

**Free-plan limit to know about:** Cloudflare's Free plan gives a Worker about 10 ms of CPU per request. Normal videos are fine because the Worker mostly waits on the network, but a very long transcript can exceed it and fail with "Error 1102". If that happens, use the PC server (part A) or Cloudflare's paid Workers plan.

### B2. Put the app on GitHub Pages

1. Create a new GitHub repository (public is fine).
2. Unzip this project, then upload its **contents** so that `index.html` sits at the top level of the repository (not inside an extra folder). Do **not** upload `.dev.vars`; it holds your keys. (The included `.gitignore` already protects you if you use git.)
3. **Settings > Pages > Build and deployment**: Deploy from branch `main`, folder `/ (root)`.
4. After a minute your app is at `https://YOURNAME.github.io/REPO/`.

### B3. Install on your iPhone

1. Open the address in **Safari**, tap **Share**, then **Add to Home Screen**.
2. Open the app, tap the settings button, enter the **backend address** (from B1) and the **access token**, then tap **Test connection**. It lists which AI providers are ready.

### B4. One-tap sharing from YouTube (iOS Shortcut)

The app opens a video from `https://YOURNAME.github.io/REPO/#<video link>` (the older `?url=<video link>` form also works).

1. Open **Shortcuts**, tap **+**, and name it **Inspect video**.
2. Open the shortcut's settings, turn on **Show in Share Sheet**, and accept **URLs** only.
3. Add the action **Text** and type `https://YOURNAME.github.io/REPO/#` then insert the **Shortcut Input** variable right after it, with no space.
4. Add the action **Open URLs** and give it that Text.

Now in YouTube: **Share > Inspect video**. Shortcuts action names and layout change between iOS versions, so adapt if yours differ.

## How it analyses a video

1. **Captions** are fetched by the backend. Short and medium videos go to the AI in one call. Very long transcripts are split into parts, each part is noted separately, the notes are merged, and a final call writes the summary, labels, timeline and topics.
2. **If YouTube refuses the caption request** (it often blocks cloud servers) and Gemini is configured, **Gemini watches the video itself**, 30 minutes at a time.
3. **If that also fails**, the app shows a paste box so you can copy the transcript from YouTube ("Show transcript") and summarise that.
4. **Music** videos become "A song about..." with artist and cues, never quoting lyrics. **No speech or text** gives a short "No text content" note.

Labels are AI estimates with a one-line reason. When the AI is unsure the app shows "About 65% likely". Two labels use hard evidence instead of a guess: the creator's "includes paid promotion" tick and affiliate links in the description. The app never claims "fact checked", because a language model reading a transcript cannot verify facts.

## Free-tier notes

- Limits and model names change often. The backend tries a list of models in order and skips any that do not exist. To change them, set `GEMINI_SMART_MODELS`, `GEMINI_VIDEO_MODELS`, `GROQ_SMART_MODELS` (comma separated) in `.dev.vars` (PC) or in the `[vars]` section of `worker/wrangler.toml` (Worker).
- Gemini's free tier allows roughly 8 hours of YouTube video per day, and video input was labelled preview when this was written.
- On Gemini's free tier, Google may use prompts to improve its products. YouTube transcripts are public, but do not paste private text.
- Summaries are saved on your device (up to 60), so reopening one costs nothing.

## Updating

The app caches itself for speed. After you upload a new version, open it, close it fully, and open it again. If it still looks old, change `CACHE` in `sw.js` to a new name.

## Tests

`npm test` (or `node tests/run.mjs` and `node tests/server-smoke.mjs`) runs 36 logic checks plus 8 local-server checks with no network. They use fake AI and YouTube responses.

**What is not tested:** the tests could not reach the real YouTube, Gemini, Groq, OpenRouter or Cloudflare. The first real run on your PC is the true test. If something fails, the app shows a plain message, and the PC window logs the cause.

## Privacy and safety

- Your API keys live only in `.dev.vars` on your PC and/or in Cloudflare secrets. They are never sent to your phone or GitHub.
- The access token lives only on your phone and in Cloudflare. Summaries and chats are stored only on the device you use.
- If you ever paste a key into a chat or share it, delete it and create a new one in the provider's console.
