/* ──────────────────────────────────────────────────────────────
   ingest.worker.js  (classic worker)

   HTTP (Range) → ZIP member → inflate → ring buffer → FFmpeg stdin

   1. Range-read the ZIP's tail + central directory (ZIP64 aware)
   2. Pick the video member, Range-stream its compressed bytes
      (auto-resumes on dropped connections)
   3. Pipe through DecompressionStream('deflate-raw')
   4. Write the inflated bytes into a SharedArrayBuffer ring that the
      FFmpeg worker is *already reading from* → every stage overlaps.

   If the URL is not a ZIP (or the server ignores Range), the response
   body is streamed straight into the ring instead.
   ────────────────────────────────────────────────────────────── */
'use strict';

const H_HEAD = 0, H_TAIL = 1, H_EOF = 2, H_ABORT = 3;
const VIDEO_EXT = /\.(mkv|webm|mp4|m4v|mov|avi|ts|m2ts|ogv|flv|wmv)$/i;

let h, ring, ringSize, ringMask;
const abortCtl = new AbortController();
const post = (m) => self.postMessage(m);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') run(m).catch(fail);
  else if (m.type === 'abort') abortCtl.abort();
};

function fail(err) {
  if (h) { Atomics.store(h, H_ABORT, 1); Atomics.notify(h, H_HEAD); }
  if (abortCtl.signal.aborted) { post({ type: 'aborted' }); return; }
  post({ type: 'error', message: String((err && err.message) || err) });
}

/* ── ring buffer writer (blocks when FFmpeg is slower than the network) ── */
let writtenTotal = 0;
function writeRing(data) {
  let off = 0;
  while (off < data.length) {
    if (Atomics.load(h, H_ABORT)) throw new Error('aborted');
    const head = Atomics.load(h, H_HEAD), tail = Atomics.load(h, H_TAIL);
    const free = ringSize - ((head - tail) >>> 0);
    if (free === 0) { Atomics.wait(h, H_TAIL, tail, 500); continue; }
    const n = Math.min(free, data.length - off);
    const start = (head >>> 0) & ringMask;
    const first = Math.min(n, ringSize - start);
    ring.set(data.subarray(off, off + first), start);
    if (first < n) ring.set(data.subarray(off + first, off + n), 0);
    Atomics.store(h, H_HEAD, (head + n) | 0);
    Atomics.notify(h, H_HEAD);
    off += n; writtenTotal += n;
  }
}

/* ── progress (throttled) ── */
let fetched = 0, fetchTotal = 0, lastProg = 0;
function progress(force) {
  const now = Date.now();
  if (!force && now - lastProg < 250) return;
  lastProg = now;
  post({ type: 'progress', fetched, total: fetchTotal, written: writtenTotal });
}

/* ── HTTP helpers ── */
async function rangeGet(url, range) {
  return fetch(url, { headers: { Range: range }, signal: abortCtl.signal });
}
async function rangeBytes(url, start, endIncl) {
  const res = await rangeGet(url, `bytes=${start}-${endIncl}`);
  if (res.status !== 206) { try { res.body && res.body.cancel(); } catch (_) {} throw new Error('Server ignored a Range request (HTTP ' + res.status + ')'); }
  return new Uint8Array(await res.arrayBuffer());
}

/** Stream [start, start+length) with automatic resume on dropped connections. */
async function* streamRange(url, start, length) {
  let pos = 0, retries = 0;
  while (pos < length) {
    try {
      const res = await rangeGet(url, `bytes=${start + pos}-${start + length - 1}`);
      if (res.status !== 206) throw Object.assign(new Error('Server ignored a Range request (HTTP ' + res.status + ')'), { fatal: true });
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pos += value.length; retries = 0; fetched += value.length; progress();
        yield value;
      }
      if (pos < length) throw new Error('Connection closed early');
    } catch (err) {
      if (abortCtl.signal.aborted || err.fatal || ++retries > 5) throw err;
      post({ type: 'status', text: 'Connection dropped, resuming… (' + retries + '/5)' });
      await sleep(800 * retries);
    }
  }
}

function toStream(asyncIter) {
  const it = asyncIter[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(ctrl) { const r = await it.next(); r.done ? ctrl.close() : ctrl.enqueue(r.value); },
    cancel() { return it.return && it.return(); },
  });
}

/* ── ZIP parsing ── */
const u16 = (dv, o) => dv.getUint16(o, true);
const u32 = (dv, o) => dv.getUint32(o, true);
const u64 = (dv, o) => Number(dv.getBigUint64(o, true));

async function readZipDirectory(url, tail) {
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) { if (u32(dv, i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) return null;                                    // not a ZIP

  let entries = u16(dv, eocd + 10), cdSize = u32(dv, eocd + 12), cdOff = u32(dv, eocd + 16);
  if (entries === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) {          // ZIP64
    if (eocd < 20 || u32(dv, eocd - 20) !== 0x07064b50) throw new Error('ZIP64 locator not found');
    const rec = u64(dv, eocd - 20 + 8);
    const z = await rangeBytes(url, rec, rec + 55);
    const zd = new DataView(z.buffer);
    if (u32(zd, 0) !== 0x06064b50) throw new Error('Bad ZIP64 end-of-directory record');
    entries = u64(zd, 32); cdSize = u64(zd, 40); cdOff = u64(zd, 48);
  }

  const cd = await rangeBytes(url, cdOff, cdOff + cdSize - 1);
  const cv = new DataView(cd.buffer);
  const td = new TextDecoder();
  const list = [];
  let p = 0;
  while (p + 46 <= cd.length && u32(cv, p) === 0x02014b50) {
    const flags = u16(cv, p + 8), method = u16(cv, p + 10);
    let csize = u32(cv, p + 20), usize = u32(cv, p + 24);
    const nameLen = u16(cv, p + 28), extraLen = u16(cv, p + 30), commentLen = u16(cv, p + 32);
    let lho = u32(cv, p + 42);
    const name = td.decode(cd.subarray(p + 46, p + 46 + nameLen));
    let x = p + 46 + nameLen; const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = u16(cv, x), sz = u16(cv, x + 2);
      if (id === 0x0001) {                                        // ZIP64 extended info
        let q = x + 4;
        if (usize === 0xFFFFFFFF) { usize = u64(cv, q); q += 8; }
        if (csize === 0xFFFFFFFF) { csize = u64(cv, q); q += 8; }
        if (lho === 0xFFFFFFFF)   { lho = u64(cv, q); }
      }
      x += 4 + sz;
    }
    list.push({ name, flags, method, csize, usize, lho });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return list;
}

function pickEntry(list, hint) {
  const files = list.filter(e => !e.name.endsWith('/'));
  if (hint) { const m = files.find(e => e.name === hint); if (m) return m; }
  const vids = files.filter(e => VIDEO_EXT.test(e.name)).sort((a, b) => b.usize - a.usize);
  if (!vids.length) throw new Error('No video file found inside the ZIP (' + files.length + ' files)');
  return vids[0];
}

/* ── main ── */
async function run(cfg) {
  const { sab, ringOffset, url } = cfg;
  ringSize = cfg.ringSize; ringMask = ringSize - 1;
  h = new Int32Array(sab, 0, 16);
  ring = new Uint8Array(sab, ringOffset, ringSize);

  post({ type: 'status', text: 'Reading ZIP directory…' });

  let list = null;
  try {
    const res = await rangeGet(url, 'bytes=-131072');
    if (res.status === 206) {
      const cr = res.headers.get('Content-Range');             // may be hidden by CORS
      const m = cr && /\/(\d+)$/.exec(cr); if (m) fetchTotal = +m[1];
      list = await readZipDirectory(url, new Uint8Array(await res.arrayBuffer()));
    } else { try { res.body && res.body.cancel(); } catch (_) {} }
  } catch (err) {
    if (abortCtl.signal.aborted) throw err;
    post({ type: 'log', line: 'Range probe failed: ' + err.message });
  }

  if (list) {
    const entry = pickEntry(list, cfg.entryName);
    if (entry.flags & 1) throw new Error('This ZIP entry is encrypted');
    if (entry.method !== 0 && entry.method !== 8) throw new Error('Unsupported ZIP compression method ' + entry.method + ' (only Store/Deflate)');
    post({ type: 'entry', name: entry.name, size: entry.usize, csize: entry.csize, method: entry.method });

    const lh = await rangeBytes(url, entry.lho, entry.lho + 29);
    const ld = new DataView(lh.buffer);
    if (u32(ld, 0) !== 0x04034b50) throw new Error('Bad ZIP local header');
    const dataStart = entry.lho + 30 + u16(ld, 26) + u16(ld, 28);

    fetchTotal = entry.csize;
    post({ type: 'status', text: 'Streaming ' + entry.name.split('/').pop() + '…' });

    let src = toStream(streamRange(url, dataStart, entry.csize));
    if (entry.method === 8) src = src.pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = src.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      writeRing(value); progress();
    }
  } else {
    /* Not a ZIP (or no Range support): stream the response body as-is. */
    post({ type: 'status', text: 'Streaming source…' });
    const res = await fetch(url, { signal: abortCtl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' while fetching the source');
    fetchTotal = +res.headers.get('Content-Length') || 0;
    const reader = res.body.getReader();
    let first = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first) {
        first = false;
        if (value[0] === 0x50 && value[1] === 0x4B)
          throw new Error('This looks like a ZIP, but the server does not allow Range requests (or CORS hides them), so the archive index cannot be read.');
      }
      fetched += value.length;
      writeRing(value); progress();
    }
  }

  progress(true);
  Atomics.store(h, H_EOF, 1);
  Atomics.notify(h, H_HEAD);
  post({ type: 'done', written: writtenTotal });
}
