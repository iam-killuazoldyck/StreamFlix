/* ──────────────────────────────────────────────────────────────
   stream-pipeline.js  (main thread)

   Orchestrates the overlapped pipeline:

     [ingest worker]  HTTP Range → ZIP → inflate ──┐ SharedArrayBuffer ring
     [ffmpeg worker]  pipe:0 → remux → fMP4 pipe:1 ◄┘
            │ chunks (+ OPFS file written inside the worker)
            ▼
     [main thread]    MediaSource playback, back-pressure acks, Save

   Usage:
     const p = new StreamPipeline({ onStatus, onProgress, onError, ... });
     await p.start(url, videoElement);
     p.abort();  p.save('name.mp4');
   ────────────────────────────────────────────────────────────── */
(function (root) {
  'use strict';

  const H_ABORT = 3, H_OUT_PENDING = 4;
  const DEFAULT_CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/';
  const SCRIPT_BASE = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src)
    ? new URL('.', document.currentScript.src).href
    : (typeof location !== 'undefined' ? new URL('pipeline/', location.href).href : '');

  /* ───────── MP4 init-segment → MSE codec string ───────── */
  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const pad2 = (n) => String(n).padStart(2, '0');
  const hex = (n) => n.toString(16);

  function* iterBoxes(b, start, end) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p), hdr = 8;
      const type = fourcc(b, p + 4);
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
      else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) return;          // truncated box
      yield { type, start: p, hdr, end: p + size };
      p += size;
    }
  }
  const child = (b, box, type) => { for (const c of iterBoxes(b, box.start + box.hdr, box.end)) if (c.type === type) return c; return null; };

  function videoCodec(b, e) {
    const kids = [...iterBoxes(b, e.start + e.hdr + 78, e.end)];
    const get = (t) => kids.find(k => k.type === t);
    let box;
    if (e.type === 'avc1' || e.type === 'avc3') {
      box = get('avcC'); if (!box) return e.type;
      const o = box.start + box.hdr;
      return `${e.type}.${pad2(hex(b[o + 1]))}${pad2(hex(b[o + 2]))}${pad2(hex(b[o + 3]))}`;
    }
    if (e.type === 'hvc1' || e.type === 'hev1') {
      box = get('hvcC'); if (!box) return e.type;
      const o = box.start + box.hdr, b1 = b[o + 1];
      let compat = ((b[o + 2] << 24) | (b[o + 3] << 16) | (b[o + 4] << 8) | b[o + 5]) >>> 0, rev = 0;
      for (let i = 0; i < 32; i++) { rev = ((rev << 1) | (compat & 1)) >>> 0; compat >>>= 1; }
      const cons = [...b.subarray(o + 6, o + 12)];
      while (cons.length && cons[cons.length - 1] === 0) cons.pop();
      return `${e.type}.${['', 'A', 'B', 'C'][b1 >> 6]}${b1 & 31}.${hex(rev)}.${(b1 >> 5) & 1 ? 'H' : 'L'}${b[o + 12]}` +
             (cons.length ? '.' + cons.map(x => hex(x).toUpperCase()).join('.') : '');
    }
    if (e.type === 'av01') {
      box = get('av1C'); if (!box) return 'av01';
      const o = box.start + box.hdr, hbd = (b[o + 2] >> 6) & 1, tw = (b[o + 2] >> 5) & 1;
      return `av01.${b[o + 1] >> 5}.${pad2(b[o + 1] & 31)}${b[o + 2] >> 7 ? 'H' : 'M'}.${pad2(tw ? 12 : hbd ? 10 : 8)}`;
    }
    if (e.type === 'vp09') {
      box = get('vpcC'); if (!box) return 'vp09';
      const o = box.start + box.hdr;
      return `vp09.${pad2(b[o + 4])}.${pad2(b[o + 5])}.${pad2(b[o + 6] >> 4)}`;
    }
    return e.type;
  }

  function audioCodec(b, e) {
    if (e.type === 'Opus') return 'opus';
    if (e.type === 'fLaC') return 'flac';
    if (e.type === 'ac-3' || e.type === 'ec-3') return e.type;
    if (e.type !== 'mp4a') return e.type;
    try {
      const esds = [...iterBoxes(b, e.start + e.hdr + 28, e.end)].find(k => k.type === 'esds');
      if (!esds) return 'mp4a.40.2';
      let p = esds.start + esds.hdr + 4;
      const len = () => { let l = 0; for (let i = 0; i < 4; i++) { const x = b[p++]; l = (l << 7) | (x & 0x7f); if (!(x & 0x80)) break; } return l; };
      if (b[p++] !== 0x03) return 'mp4a.40.2';
      len(); p += 2; const fl = b[p++];
      if (fl & 0x80) p += 2; if (fl & 0x40) p += 1 + b[p]; if (fl & 0x20) p += 2;
      if (b[p++] !== 0x04) return 'mp4a.40.2';
      len(); const oti = b[p++]; p += 12;
      if (oti !== 0x40) return 'mp4a.' + hex(oti).toUpperCase();
      if (b[p++] !== 0x05) return 'mp4a.40.2';
      len();
      return 'mp4a.40.' + (b[p] >> 3);
    } catch (_) { return 'mp4a.40.2'; }
  }

  /** Returns { codecs: [...], mime } once a complete moov is present, else null. */
  function codecsFromInit(b) {
    let moov = null;
    for (const box of iterBoxes(b, 0, b.length)) if (box.type === 'moov') { moov = box; break; }
    if (!moov) return null;
    const codecs = [];
    for (const trak of iterBoxes(b, moov.start + moov.hdr, moov.end)) {
      if (trak.type !== 'trak') continue;
      const mdia = child(b, trak, 'mdia'), hdlr = mdia && child(b, mdia, 'hdlr');
      const minf = mdia && child(b, mdia, 'minf'), stbl = minf && child(b, minf, 'stbl'), stsd = stbl && child(b, stbl, 'stsd');
      if (!hdlr || !stsd) continue;
      const kind = fourcc(b, hdlr.start + hdlr.hdr + 8);
      const entry = iterBoxes(b, stsd.start + stsd.hdr + 8, stsd.end).next().value;
      if (!entry) continue;
      if (kind === 'vide') codecs.push(videoCodec(b, entry));
      else if (kind === 'soun') codecs.push(audioCodec(b, entry));
    }
    return { codecs, mime: `video/mp4; codecs="${codecs.join(',')}"` };
  }

  const concat = (a, c) => { const r = new Uint8Array(a.length + c.length); r.set(a, 0); r.set(c, a.length); return r; };

  /* ───────── the pipeline ───────── */
  class StreamPipeline {
    constructor(opts) {
      this.o = Object.assign({
        ringMB: 16,                 // ingest → FFmpeg ring buffer
        coreBase: DEFAULT_CORE,     // where ffmpeg-core.js / .wasm live (self-host to go offline)
        maxAheadSec: 90,            // don't buffer further ahead of the playhead than this
        entryName: null,            // force a specific file inside the ZIP
        corsProxy: null,            // e.g. 'https://your-worker.example.workers.dev/?url=' (used only if direct fetch is blocked)
        onStatus() {}, onEntry() {}, onProgress() {}, onPlayable() {}, onDone() {}, onError() {},
      }, opts || {});
      this.opfsName = 'streamflix-' + Date.now() + '.mp4';
      this.queue = []; this.head = new Uint8Array(0);
      this.sb = null; this.appending = false; this.closed = false; this.failed = false;
      this.ffDone = false; this.duration = null; this.entryName = null; this._playable = false;
    }

    static check() {
      if (typeof Worker === 'undefined') return { ok: false, reason: 'Web Workers are not available.' };
      if (!root.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined')
        return { ok: false, reason: 'Streaming mode needs cross-origin isolation (COOP/COEP headers; see netlify.toml). Chrome, Edge and Firefox support this; Safari does not support the "credentialless" policy.' };
      if (typeof DecompressionStream === 'undefined') return { ok: false, reason: 'This browser has no DecompressionStream (needs Chrome 103+, Firefox 113+ or Safari 16.4+).' };
      if (typeof MediaSource === 'undefined') return { ok: false, reason: 'This browser has no MediaSource Extensions (e.g. iPhone Safari).' };
      return { ok: true };
    }

    async start(url, video) {
      const sup = StreamPipeline.check();
      if (!sup.ok) throw new Error(sup.reason);
      this.video = video;
      await StreamPipeline._cleanupOpfs();

      const ringSize = this.o.ringMB * 1024 * 1024, OFF = 64;
      const sab = new SharedArrayBuffer(OFF + ringSize);
      this.h = new Int32Array(sab, 0, 16);

      this._initMSE();

      this.ingest = new Worker(SCRIPT_BASE + 'ingest.worker.js');
      this.ffmpeg = new Worker(SCRIPT_BASE + 'ffmpeg.worker.js');
      this.ingest.onerror = (e) => this._fail('Ingest worker crashed: ' + (e.message || 'unknown error'));
      this.ffmpeg.onerror = (e) => this._fail('FFmpeg worker crashed: ' + (e.message || 'unknown error'));

      this.ingest.onmessage = ({ data: m }) => {
        if (this.closed) return;
        if (m.type === 'status') this.o.onStatus(m.text);
        else if (m.type === 'entry') { this.entryName = m.name; this.o.onEntry(m); }
        else if (m.type === 'progress') this.o.onProgress(m);
        else if (m.type === 'error') this._fail(m.message);
        else if (m.type === 'log') console.debug('[ingest]', m.line);
      };
      this.ffmpeg.onmessage = ({ data: m }) => {
        if (this.closed && m.type !== 'done') return;
        if (m.type === 'chunk') this._onChunk(new Uint8Array(m.buf));
        else if (m.type === 'status') this.o.onStatus(m.text);
        else if (m.type === 'duration') { this.duration = m.seconds; this._applyDuration(); }
        else if (m.type === 'log') console.debug('[ffmpeg]', m.line);
        else if (m.type === 'error') this._fail(m.message);
        else if (m.type === 'done') this._ffDone(m);
      };

      const base = this.o.coreBase;
      this.ffmpeg.postMessage({ type: 'start', sab, ringOffset: OFF, ringSize, coreURL: base + 'ffmpeg-core.js', wasmURL: base + 'ffmpeg-core.wasm', opfsName: this.opfsName });
      this.ingest.postMessage({ type: 'start', sab, ringOffset: OFF, ringSize, url, entryName: this.o.entryName, proxy: this.o.corsProxy });
    }

    /* ── MediaSource ── */
    _initMSE() {
      const ms = this.mediaSource = new MediaSource();
      this._objUrl = URL.createObjectURL(ms);
      this.video.src = this._objUrl;
      ms.addEventListener('sourceopen', () => this._maybeInit(), { once: true });
      const re = () => this._pump();
      this.video.addEventListener('timeupdate', re);
      this.video.addEventListener('play', re);
      this.video.addEventListener('seeking', re);
      this._detach = () => { this.video.removeEventListener('timeupdate', re); this.video.removeEventListener('play', re); this.video.removeEventListener('seeking', re); };
    }

    _maybeInit() {
      if (this.sb || this.closed || this.mediaSource.readyState !== 'open') return;
      const info = codecsFromInit(this.head);
      if (!info) return;                                   // moov not complete yet
      if (!MediaSource.isTypeSupported(info.mime))
        return this._fail('This browser cannot play ' + info.codecs.join(' + ') + ' through MediaSource.');
      this.codecs = info.codecs;
      this.sb = this.mediaSource.addSourceBuffer(info.mime);
      this.sb.addEventListener('updateend', () => {
        if (this.appending) {
          this.appending = false;
          const c = this.queue.shift(); this._ack(c.byteLength);
          if (!this._playable) { this._playable = true; this.o.onPlayable({ codecs: this.codecs }); this.video.play().catch(() => {}); }
        }
        this._pump();
      });
      this.sb.addEventListener('error', () => this._fail('MediaSource rejected the stream data.'));
      this._applyDuration();
      this.head = null;
      this._pump();
    }

    _applyDuration() {
      if (this.duration == null || !this.sb || this.sb.updating || this.mediaSource.readyState !== 'open') return;
      try { this.mediaSource.duration = this.duration; } catch (_) {}
    }

    _onChunk(u8) {
      if (this.closed) return;
      this.queue.push(u8);
      if (!this.sb) { this.head = concat(this.head, u8); this._maybeInit(); }
      else this._pump();
    }

    _pump() {
      const sb = this.sb;
      if (!sb || this.appending || sb.updating || this.closed) return;
      if (!this.queue.length) { this._maybeEnd(); return; }
      try {                                                 // don't run far ahead of the playhead
        const b = sb.buffered;
        if (b.length && b.end(b.length - 1) - this.video.currentTime > this.o.maxAheadSec) return;
      } catch (_) {}
      try { sb.appendBuffer(this.queue[0]); this.appending = true; }
      catch (e) {
        if (e.name !== 'QuotaExceededError') return this._fail('MediaSource append failed: ' + e.message);
        try {                                               // free data behind the playhead, else wait
          const b = sb.buffered, cut = this.video.currentTime - 10;
          if (b.length && cut - b.start(0) > 5) sb.remove(b.start(0), cut);
        } catch (_) {}
      }
    }

    _ack(n) { Atomics.sub(this.h, H_OUT_PENDING, n); Atomics.notify(this.h, H_OUT_PENDING); }

    _maybeEnd() {
      if (this.ffDone && !this.queue.length && this.sb && !this.sb.updating && !this.appending && this.mediaSource.readyState === 'open')
        try { this.mediaSource.endOfStream(); } catch (_) {}
    }

    _ffDone(m) {
      this.ffDone = true;
      this.o.onDone({ bytes: m.bytes, aborted: !!m.aborted });
      if (!m.aborted) this._maybeEnd();
      setTimeout(() => { try { this.ingest && this.ingest.terminate(); this.ffmpeg && this.ffmpeg.terminate(); } catch (_) {} }, 200);
    }

    _fail(msg) {
      if (this.failed || this.closed) return;
      this.failed = true;
      this.abort();
      this.o.onError(msg);
    }

    /** Stop everything and release resources. */
    abort() {
      if (this.h) {
        Atomics.store(this.h, H_ABORT, 1);
        for (const i of [0, 1, 4]) Atomics.notify(this.h, i);
      }
      if (this.ingest) try { this.ingest.postMessage({ type: 'abort' }); } catch (_) {}
      this.closed = true;
      if (this._detach) this._detach();
      setTimeout(() => { try { this.ingest && this.ingest.terminate(); this.ffmpeg && this.ffmpeg.terminate(); } catch (_) {} }, 800);
      if (this._objUrl) { const u = this._objUrl; this._objUrl = null; setTimeout(() => URL.revokeObjectURL(u), 1000); }
    }

    /** Download the finished fragmented MP4 from OPFS. Call after onDone. */
    async save(filename) {
      const dir = await navigator.storage.getDirectory();
      const file = await (await dir.getFileHandle(this.opfsName)).getFile();
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || ((this.entryName || 'video').split('/').pop().replace(/\.[^.]+$/, '') + '.mp4');
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    static async _cleanupOpfs() {
      try {
        const dir = await navigator.storage.getDirectory();
        const names = [];
        for await (const [name] of dir.entries()) if (name.startsWith('streamflix-')) names.push(name);
        for (const n of names) await dir.removeEntry(n).catch(() => {});
      } catch (_) {}
    }
  }

  StreamPipeline.codecsFromInit = codecsFromInit;   // exposed for tests
  root.StreamPipeline = StreamPipeline;
  if (typeof module !== 'undefined' && module.exports) module.exports = StreamPipeline;
})(typeof self !== 'undefined' ? self : globalThis);
