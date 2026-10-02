#!/usr/bin/env node
// Credentials remain on the user's computer and go only to the existing app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ENDPOINT = 'https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x/openapi/mcp';
const MAX_INPUT = 1024 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
const DEFAULT_CREDENTIAL_FILE = path.join(os.homedir(), '.config', '110-requirement-mcp', 'credentials.json');

export function loadCredentials(file = DEFAULT_CREDENTIAL_FILE) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe');
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 64 * 1024) throw new Error('too large');
    const value = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    const validSecret = v => typeof v === 'string' && v.length > 0 && v.length <= 16384 && /^[\x21-\x7e]+$/.test(v);
    if (value.version !== 1 || value.endpoint !== ENDPOINT || !validSecret(value.openApiKey) ||
        !validSecret(value.personalToken) || !value.personalToken.startsWith('rmcp_v1.')) throw new Error('invalid');
    return {endpoint: ENDPOINT, openApiKey: value.openApiKey, personalToken: value.personalToken};
  } catch {
    throw new Error('需求平台连接码未配置或无效。请使用现有需求平台接入流程保存个人连接码，然后重新连接插件；凭据文件须由当前用户持有且仅本人可读。');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function decodeResponse(text, contentType) {
  if (!text.trim()) return [];
  const parse = raw => {
    const value = JSON.parse(raw);
    const values = Array.isArray(value) ? value : [value];
    if (values.some(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || item.jsonrpc !== '2.0') return true;
      if (!Object.hasOwn(item, 'id')) return typeof item.method !== 'string';
      if (!(item.id === null || typeof item.id === 'string' || Number.isSafeInteger(item.id))) return true;
      return Object.hasOwn(item, 'result') === Object.hasOwn(item, 'error') ||
        (Object.hasOwn(item, 'error') && (!item.error || !Number.isInteger(item.error.code) || typeof item.error.message !== 'string'));
    })) throw new Error('invalid protocol');
    return values;
  };
  if (contentType.split(';', 1)[0].trim().toLowerCase() !== 'text/event-stream') return parse(text);
  return text.split(/\r?\n\r?\n/).flatMap(event => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    return data ? parse(data) : [];
  });
}

async function boundedText(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new Error('response too large'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

export function createRelay({readCredentials = loadCredentials, fetchImpl = fetch, timeoutMs = 90000, responseLimit = MAX_RESPONSE} = {}) {
  let credentials;
  let sessionId;
  let protocolVersion;
  return async payload => {
    credentials ||= readCredentials();
    const headers = {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer ' + credentials.openApiKey, 'X-Requirement-Mcp-Token': credentials.personalToken};
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetchImpl(credentials.endpoint, {method: 'POST', headers, redirect: 'error',
        body: JSON.stringify(payload), signal: abort.signal});
      if (!response.ok) {
        await response.body?.cancel();
        const message = [401, 403].includes(response.status) ? '需求平台认证失败，请检查个人连接码并重新连接插件。' : '需求平台请求失败 HTTP ' + response.status + '；写操作结果可能未知，请先查询修改结果，不要重复提交。';
        throw Object.assign(new Error(message), {safe: true});
      }
      const text = await boundedText(response, responseLimit);
      const values = decodeResponse(text, response.headers.get('content-type') || 'application/json');
      if (Object.hasOwn(payload, 'id') && !values.some(value => value.id === payload.id)) throw new Error('response ID mismatch');
      if (values.some(value => Object.hasOwn(value, 'id') && value.id !== payload.id)) throw new Error('unexpected response ID');
      if (!Object.hasOwn(payload, 'id') && values.some(value => Object.hasOwn(value, 'id'))) throw new Error('unexpected notification response');
      if (payload.method === 'initialize') {
        const reply = values.find(value => value.id === payload.id);
        if (reply?.result?.protocolVersion) protocolVersion = reply.result.protocolVersion;
      }
      sessionId = response.headers.get('mcp-session-id') || sessionId;
      return values;
    } catch (error) {
      if (error?.safe) throw error;
      // Never reflect upstream bodies, URLs, headers or credentials into errors.
      throw new Error('需求平台请求未取得可确认结果。请查询现有修改记录；写操作不得自动重放。');
    } finally { clearTimeout(timer); }
  };
}

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
