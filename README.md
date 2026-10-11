# Netlify functions — Online Media Player / Seedr bridge

These functions live in the separate Netlify client project. They call the existing Vercel API and keep its API key out of browser code.

## Functions

- `POST /.netlify/functions/media-download` — converts the JSON body fields into query parameters (e.g. `{ "url": "…" }` becomes `?url=…`) and calls `POST https://flix-player-pi.vercel.app/tasks/url-downloads` with `X-API-Key`, then returns `{ "success": true, "task_id": 123 }`.
- `GET /.netlify/functions/media-status?task_id=123` — checks `GET /tasks/{id}`. While processing it returns HTTP `202` with progress. When finished it gets the folder, retrieves each file's temporary download URL, and returns `ready: true`.

## Netlify environment variables

Set these in **Netlify → Site configuration → Environment variables**:

- `ONLINE_MEDIA_PLAYER_API_KEY` — the API key accepted by your Vercel API as `X-API-Key`. Do not prefix it with `VITE_`, `NEXT_PUBLIC_`, or another public-client prefix.
- `ALLOWED_ORIGIN` — optional; set to your exact frontend origin, e.g. `https://your-player.example.com`. It defaults to `*`; for production, set a specific origin.

Redeploy after changing environment variables.

## Frontend flow

```js
// 1. Start task. Send the exact JSON shape expected by your Vercel endpoint.
const startResponse = await fetch("/.netlify/functions/media-download", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    // Replace these example keys with the actual /tasks/url-downloads request schema.
    url: "https://example.com/video.mp4"
  })
});
const start = await startResponse.json();
if (!startResponse.ok || !start.success) throw new Error(start.error || "Could not start download");

// 2. Poll until ready.
async function waitForMedia(taskId) {
  for (;;) {
    const response = await fetch(
      `/.netlify/functions/media-status?task_id=${encodeURIComponent(taskId)}`
    );
    const result = await response.json();

    if (response.status === 202 && result.success && !result.ready) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      continue;
    }
    if (!response.ok || !result.success) {
      throw new Error(result.error || "Could not retrieve download URL");
    }
    return result; // result.url for a single file; result.files for multiple files
  }
}

const media = await waitForMedia(start.task_id);
console.log(media.url || media.files);
```

The loop above is illustrative; in a UI, use a cancellable timer and handle component unmounts.

## Important API contract note

The supplied examples establish the response shapes and endpoint paths, but do not establish the exact JSON **request body** accepted by `POST /tasks/url-downloads`. `media-download` intentionally forwards the body unchanged. Match its frontend JSON to the schema implemented by that Vercel endpoint, including the expected shape for video and subtitle URL inputs.

## Why two functions?

The initial POST should return promptly with a task ID. Seedr's transfer may take longer than a single serverless request's execution window. The frontend can poll `media-status`; each invocation checks current state and only proceeds to folder/file/download lookups once the task is finished.

## Local development

Install Netlify CLI and run:

```bash
netlify dev
```

The environment variables must be available to the local Netlify process. The functions use the Node.js built-in `fetch` API (Node 18+).

## Frontend integration (`index.html`)

The player has a **Playback mode** dropdown under the video URL box:

- **Auto** (default): tries the URL directly; if the `<video>` element errors or HLS hits a fatal error, it automatically falls back to cloud fetch.
- **Direct only**: original behaviour.
- **Cloud fetch**: always sends the link to `media-download`, polls `media-status`, then plays the returned temporary URL.

If the finished task contains several files, a file picker is shown; any `.srt` / `.vtt` in the folder is loaded as subtitles automatically.

The request body sent to `media-download` is built by `buildTaskBody(url)` in `index.html` (currently `{ "url": url }`). Change that one function if your Vercel schema expects different fields.

`FUNCTIONS_BASE` (default `/.netlify/functions`) can be set to your full Netlify site URL if the frontend is hosted elsewhere; in that case also set `ALLOWED_ORIGIN`.
