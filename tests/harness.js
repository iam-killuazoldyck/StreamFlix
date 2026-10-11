const { Worker } = require('worker_threads');
const http = require('http'), fs = require('fs');
const [,, file, outName, ringMB = '1'] = process.argv;
const data = fs.readFileSync(file);
const srv = http.createServer((req, res) => {
  const r = req.headers.range;
  if (!r) { res.writeHead(200, {'Content-Length': data.length}); return res.end(data); }
  let [, a, b] = /bytes=(\d*)-(\d*)/.exec(r);
  let s, e;
  if (a === '') { s = Math.max(0, data.length - +b); e = data.length - 1; }
  else { s = +a; e = b === '' ? data.length - 1 : Math.min(+b, data.length - 1); }
  res.writeHead(206, {'Content-Range': `bytes ${s}-${e}/${data.length}`, 'Content-Length': e - s + 1});
  // trickle in small pieces to exercise streaming
  const part = data.subarray(s, e + 1); let o = 0;
  (function send(){ if (o >= part.length) return res.end(); res.write(part.subarray(o, o += 16384)); setImmediate(send); })();
});
srv.listen(0, async () => {
  const url = `http://127.0.0.1:${srv.address().port}/f`;
  const RING = (+ringMB) * 1024 * 1024, OFF = 64;
  const sab = new SharedArrayBuffer(OFF + RING), h = new Int32Array(sab, 0, 16);
  const core = __dirname + '/../node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js';
  const wasmBinary = fs.readFileSync(__dirname + '/../node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm');
  const ing = new Worker(__dirname + '/shim.js', { workerData: { script: __dirname + '/../pipeline/ingest.worker.js' } });
  const ff = new Worker(__dirname + '/shim.js', { workerData: { script: __dirname + '/../pipeline/ffmpeg.worker.js' } });
  const out = fs.openSync(outName, 'w'); let chunks = 0, bytes = 0, maxPending = 0, firstChunkAt = null, ingDoneAt = null; const t0 = Date.now();
  let finished = false;
  const end = (tag) => { if (finished) return; finished = true; console.log(tag, { chunks, bytes, ms: Date.now() - t0, firstChunkAt, ingDoneAt, maxPending }); fs.closeSync(out); ing.terminate(); ff.terminate(); srv.close(); };
  ing.on('message', m => {
    if (m.type === 'progress') return;
    if (m.type === 'done') ingDoneAt = Date.now() - t0;
    console.log('[ingest]', JSON.stringify(m));
    if (m.type === 'error') end('INGEST ERROR');
  });
  ff.on('message', m => {
    if (m.type === 'chunk') {
      if (firstChunkAt === null) firstChunkAt = Date.now() - t0;
      const b = Buffer.from(m.buf); fs.writeSync(out, b); chunks++; bytes += b.length;
      maxPending = Math.max(maxPending, Atomics.load(h, 4));
      Atomics.sub(h, 4, b.length); Atomics.notify(h, 4);
    } else if (m.type === 'log') { if (/Stream #|Duration|error|Error|Invalid/i.test(m.line)) console.log('[ff]', m.line); }
    else { console.log('[ffmpeg]', JSON.stringify(m)); if (m.type === 'done') end('DONE'); if (m.type === 'error') end('FF ERROR'); }
  });
  ff.on('error', e => { console.log('ff worker err', e); end('x'); }); ing.on('error', e => { console.log('ing worker err', e); end('x'); });
  ff.postMessage({ type: 'start', sab, ringOffset: OFF, ringSize: RING, coreURL: core, wasmBinary, opfsName: null });
  ing.postMessage({ type: 'start', sab, ringOffset: OFF, ringSize: RING, url });
});
