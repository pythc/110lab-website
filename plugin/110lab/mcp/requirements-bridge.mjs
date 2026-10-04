#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRelay} from './requirements-client.mjs';
export {ENDPOINT,loadCredentials,decodeResponse,createRelay} from './requirements-client.mjs';
const MAX_INPUT=1024*1024;

export function startBridge({input = process.stdin, output = process.stdout, relay = createRelay()} = {}) {
  input.setEncoding('utf8');
  let pending = '', oversized = false, queue = Promise.resolve(), queued = 0;
  const send = value => output.write(JSON.stringify(value) + '\n');
  const fail = (id, code, message) => send({jsonrpc: '2.0', id, error: {code, message}});
  function line(text) {
    if (!text.trim()) return;
    let payload;
    try { payload = JSON.parse(text); } catch { fail(null, -32700, 'Invalid JSON'); return; }
    const hasId = payload && Object.hasOwn(payload, 'id');
    if (!payload || Array.isArray(payload) || payload.jsonrpc !== '2.0' || typeof payload.method !== 'string' ||
        (hasId && !(payload.id === null || typeof payload.id === 'string' || Number.isSafeInteger(payload.id)))) {
      fail(null, -32600, 'Invalid request'); return;
    }
    if (queued >= 32) { if (hasId) fail(payload.id, -32000, 'Too many pending requests'); return; }
    queued++;
    queue = queue.then(async () => {
      try { for (const response of await relay(payload)) send(response); }
      catch (error) { if (hasId) fail(payload.id, -32000, error.message); }
      finally { queued--; }
    });
  }
  input.on('data', chunk => {
    for (const [index, part] of chunk.split('\n').entries()) {
      if (index) {
        if (oversized) fail(null, -32700, 'Request too large'); else line(pending);
        pending = ''; oversized = false;
      }
      if (!oversized) {
        if (Buffer.byteLength(pending) + Buffer.byteLength(part) > MAX_INPUT) { pending = ''; oversized = true; }
        else pending += part;
      }
    }
  });
  return new Promise(resolve => input.once('end', () => {
    if (oversized) fail(null, -32700, 'Request too large'); else line(pending);
    void queue.then(resolve);
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await startBridge();
}
