# StreamFlix: in-browser streaming remux player

No backend. Everything runs in the browser and the site is static.

## Pipeline

```
HTTP Range ──► ZIP directory ──► Range-stream member ──► deflate-raw ──► ring buffer
 (ingest worker, with auto-resume)   (DecompressionStream)          (SharedArrayBuffer)
                                                                           │ blocking read
                                                                     FFmpeg.wasm pipe:0
                                                                     -c:v copy -c:a aac
                                                                     fragmented MP4 on pipe:1
                                                                           │
                                             ┌─────────────────────────────┴────────────┐
                                             ▼                                          ▼
                                   OPFS file (Save MP4)                      MediaSource (live playback)
```

Every stage runs concurrently. A full ring buffer blocks the downloader, and un-acknowledged MP4 output blocks FFmpeg, so memory stays bounded (≈16 MB ring + ≤24 MB output in flight + the playback buffer).

| File | Role |
| --- | --- |
| `pipeline/ingest.worker.js` | Range requests, ZIP/ZIP64 directory parsing, resume on dropped connections, inflate, ring-buffer writer |
| `pipeline/ffmpeg.worker.js` | Loads `@ffmpeg/core`, replaces fd 0/1 with ring-buffer reads and chunked writes (no `writeFile`/`readFile`), writes OPFS |
| `pipeline/stream-pipeline.js` | Orchestration, MP4 init → MSE codec string, append queue, eviction, back-pressure acks, Save |
| `tests/harness.js` | Runs both workers in Node against the real FFmpeg wasm (`npm i`, then `npm run test:pipeline`) |

FFmpeg command: `-i pipe:0 -map 0:v:0 -map 0:a:0? -sn -dn -c:v copy -c:a aac -b:a 192k -ac 2 -avoid_negative_ts make_zero -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof pipe:1`

## Modes (dropdown under the URL box)

- **Auto**: `.zip` URLs go to the streaming pipeline. Everything else plays directly, and if direct playback fails it falls back to the pipeline.
- **Direct only**: the original player (MP4/WebM/HLS).
- **Streaming remux**: always uses the pipeline (ZIP containing a video, or a raw MKV URL).

## Requirements and limits

- **Source server:** must send CORS headers. For ZIPs it must also support `Range` requests, allow the `Range` header in `Access-Control-Allow-Headers`, and ideally expose `Content-Range` (needed only for total size). Without a backend there is no way around CORS.
- **Browser:** needs cross-origin isolation (`netlify.toml` sets COOP/COEP `credentialless`), `DecompressionStream`, MediaSource and OPFS. This means Chrome/Edge 103+ or Firefox 113+. Safari lacks `credentialless`, and iPhone Safari has no MediaSource, so the pipeline is unavailable there and direct playback still works.
- **ZIP:** Store and Deflate only, no encryption. The largest video file in the archive is chosen (`entryName` option forces one). ZIP64 is supported.
- **Streaming caveats:** MKVs that need data from the end of the file (e.g. a late index) may fail or buffer. Video is copied as-is, so the browser must be able to decode the codec (H.264/AAC is safest). Audio is always transcoded to stereo AAC, and embedded subtitle tracks are dropped (use the subtitle box).
- **Seeking:** you can seek within data already buffered. Data older than ~10 s behind the playhead may be evicted if the browser's buffer quota is hit.
- **FFmpeg core** loads from jsDelivr (≈30 MB, cached afterwards). To self-host, pass `coreBase` to `new StreamPipeline({...})`.

## Deploy

Static site on Netlify. `netlify.toml` only sets the isolation headers. The old Netlify functions and `ONLINE_MEDIA_PLAYER_API_KEY` are no longer needed, so you can delete that variable.
