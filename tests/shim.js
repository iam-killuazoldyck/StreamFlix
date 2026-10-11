const { parentPort, workerData } = require('worker_threads');
const vm = require('vm'), fs = require('fs');
globalThis.self = globalThis; globalThis.location = { href: 'file:///tmp/t/core.js' };
globalThis.require = require; globalThis.__dirname = __dirname;
globalThis.postMessage = (m, t) => parentPort.postMessage(m, t || []);
globalThis.importScripts = (u) => vm.runInThisContext(fs.readFileSync(u, 'utf8'), { filename: u });
parentPort.on('message', (data) => { if (globalThis.onmessage) globalThis.onmessage({ data }); });
vm.runInThisContext(fs.readFileSync(workerData.script, 'utf8'), { filename: workerData.script });
