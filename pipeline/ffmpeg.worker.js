/* ──────────────────────────────────────────────────────────────
   ffmpeg.worker.js  (classic worker)

   Runs FFmpeg.wasm with *streaming* stdin/stdout instead of
   writeFile()/readFile():

     stdin  (pipe:0)  ← blocking reads from a SharedArrayBuffer ring
                         that the ingest worker fills with MKV bytes
     stdout (pipe:1)  → fragmented-MP4 chunks, posted to the main
                         thread (for MSE playback) and appended to OPFS

   FFmpeg's main() runs synchronously inside this worker, which is why
   the stdin read hook may block with Atomics.wait().
   ────────────────────────────────────────────────────────────── */
'use strict';

/* Shared header layout (Int32Array over the first 64 bytes of the SAB) */
const H_HEAD = 0;     // total bytes written into the ring   (ingest)
const H_TAIL = 1;     // total bytes consumed from the ring  (ffmpeg)
const H_EOF = 2;      // ingest finished
const H_ABORT = 3;    // anyone requested a stop / ingest failed
const H_OUT_PENDING = 4; // bytes of MP4 posted to main but not yet acknowledged

const OUT_LIMIT = 24 * 1024 * 1024; // max un-acked MP4 bytes in flight

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

self.onmessage = (e) => {
  if (e.data && e.data.type === 'start') {
    run(e.data).catch(err => post({ type: 'error', message: String((err && err.message) || err) }));
  }
};

async function run(cfg) {
  const { sab, ringOffset, ringSize, coreURL, wasmURL, opfsName } = cfg;
  const h = new Int32Array(sab, 0, 16);
  const ring = new Uint8Array(sab, ringOffset, ringSize);

  /* ── load FFmpeg core ── */
  post({ type: 'status', text: 'Loading FFmpeg…' });
  importScripts(coreURL);
  let wasmBinary = cfg.wasmBinary;
  if (!wasmBinary) {
    const res = await fetch(wasmURL);
    if (!res.ok) throw new Error('Could not download ffmpeg-core.wasm (' + res.status + ')');
    wasmBinary = await res.arrayBuffer();
  }
  const core = await createFFmpegCore({ wasmBinary });
  const FS = core.FS;

  /* ── OPFS sink (sync access handle is only available in workers) ── */
  let sah = null, outPos = 0;
  try {
    if (opfsName && self.navigator && navigator.storage && navigator.storage.getDirectory) {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(opfsName, { create: true });
      sah = await fh.createSyncAccessHandle();
      sah.truncate(0);
    }
  } catch (err) {
    sah = null;
    post({ type: 'log', line: 'OPFS unavailable: ' + err.message });
  }

  /* ── logger: surface duration + keep a short tail for error messages ── */
  let sawDuration = false;
  const tail = [];
  core.setLogger(({ message }) => {
    const line = String(message);
    tail.push(line); if (tail.length > 40) tail.shift();
    post({ type: 'log', line });
    if (!sawDuration) {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
      if (m) { sawDuration = true; post({ type: 'duration', seconds: (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) }); }
    }
  });

  /* ── stdin: blocking read from the ring ── */
  const inOps = {
    read(stream, buffer, offset, length) {
      for (;;) {
        const head = Atomics.load(h, H_HEAD), tail = Atomics.load(h, H_TAIL);
        const avail = (head - tail) >>> 0;
        if (avail > 0) {
          const n = Math.min(avail, length);
          const start = (tail >>> 0) & (ringSize - 1);
          const first = Math.min(n, ringSize - start);
          buffer.set(ring.subarray(start, start + first), offset);
          if (first < n) buffer.set(ring.subarray(0, n - first), offset + first);
          Atomics.store(h, H_TAIL, (tail + n) | 0);
          Atomics.notify(h, H_TAIL);
          return n;
        }
        if (Atomics.load(h, H_ABORT)) throw new FS.ErrnoError(29);
        if (Atomics.load(h, H_EOF)) return 0;
        Atomics.wait(h, H_HEAD, head, 500);   // sleep until the ingest worker writes
      }
    },
  };

  /* ── stdout: append MP4 chunks, with back-pressure ── */
  const outOps = {
    write(stream, buffer, offset, length) {
      if (!length) return 0;
      const chunk = buffer.slice(offset, offset + length);       // copy out of the wasm heap
      if (sah) { sah.write(chunk, { at: outPos }); }
      outPos += length;
      post({ type: 'chunk', buf: chunk.buffer }, [chunk.buffer]);
      const pending = Atomics.add(h, H_OUT_PENDING, length) + length;
      let p = pending;
      while (p > OUT_LIMIT) {
        if (Atomics.load(h, H_ABORT)) throw new FS.ErrnoError(29);
        Atomics.wait(h, H_OUT_PENDING, p, 500);                   // main thread acks as it appends
        p = Atomics.load(h, H_OUT_PENDING);
      }
      return length;
    },
  };

  // Replace fd 0 / fd 1 so `pipe:0` and `pipe:1` hit our hooks instead of the TTY layer.
  FS.streams[0].stream_ops = inOps;
  FS.streams[1].stream_ops = outOps;

  const args = cfg.args || [
    '-hide_banner', '-nostats',
    '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'mp4',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ];

  post({ type: 'status', text: 'Streaming…' });
  let code;
  try {
    core.exec(...args);
    code = core.ret;
  } finally {
    core.reset();
    if (sah) { try { sah.flush(); sah.close(); } catch (_) {} }
  }

  if (Atomics.load(h, H_ABORT)) { post({ type: 'done', code: -1, aborted: true, bytes: outPos }); return; }
  if (code !== 0) {
    post({ type: 'error', message: 'FFmpeg exited with code ' + code + '. ' + tail.slice(-4).join(' | ') });
    return;
  }
  post({ type: 'done', code: 0, bytes: outPos });
}
