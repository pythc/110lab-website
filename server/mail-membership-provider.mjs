// Feishu public mailbox membership provider.
//
// Synchronises administrators tracked in the local mail-access role store with
// a single, fixed Feishu public mailbox so administrators can send and receive
// mail as noreply@notify.110-lab.cn. This module only talks to Feishu's open
// APIs; it never writes to the local role store, never emits SMTP/IMAP calls,
// never touches browsers or production systems, and never logs secrets.
//
// The module intentionally hard-codes the target mailbox: callers may not pick
// a different mailbox. Subjects use the local store format "<tenantKey>:on_<unionId>"
// and only the "on_<unionId>" portion is forwarded upstream as `user_id` with
// `user_id_type=union_id`. Member ids returned by Feishu are opaque strings
// and must be validated before being substituted into DELETE URLs.
//
// Networking is strictly bounded: a 10 second timeout, 256 KiB response cap,
// redirects are rejected, and the page_token for list pagination is treated as
// an opaque query-string value appended to the fixed URL (never a URL from the
// upstream payload). No request body is ever retried blindly on failure.

const FEISHU_HOST = 'https://open.feishu.cn';
const TENANT_TOKEN_URL = `${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`;
// NOTE: The literal mailbox address is URL-encoded exactly once here. Callers
// cannot override this constant. "noreply@notify.110-lab.cn" -> ...%40...
const MAILBOX_ADDRESS = 'noreply@notify.110-lab.cn';
const MAILBOX_PATH_SEGMENT = encodeURIComponent(MAILBOX_ADDRESS);
const MEMBERS_URL = `${FEISHU_HOST}/open-apis/mail/v1/public_mailboxes/${MAILBOX_PATH_SEGMENT}/members`;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_LIST_PAGES = 10;
const MAX_LIST_ROWS = 400;
const LIST_PAGE_SIZE = 100;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MIN_TOKEN_LIFETIME_MS = 2_000;

// The role store is provider-agnostic; outbound subjects must additionally
// match the Feishu union-ID grammar and configured tenant.
const SUBJECT_PATTERN = /^([a-zA-Z0-9_-]{1,64}):(on_[A-Za-z0-9_-]{1,120})$/;
const MEMBER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PAGE_TOKEN_PATTERN = /^[\x21-\x7e]{1,2048}$/;

/**
 * Structured error raised for every failure. `status` is always 503 so that
 * HTTP callers surface a generic upstream failure. `providerCode` carries the
 * numeric Feishu `code` when one was present, purely for diagnostics; it is
 * never a secret, body, or URL. The message is a short static string.
 */
export class MailMembershipError extends Error {
  constructor(message, { providerCode = null } = {}) {
    super(message);
    this.name = 'MailMembershipError';
    this.status = 503;
    this.providerCode = Number.isInteger(providerCode) ? providerCode : null;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, MailMembershipError);
    }
  }
}

/**
 * Create a provider bound to a single Feishu public mailbox.
 *
 * `config.appId`, `config.appSecret`, and `config.tenantKey` come from the
 * existing authentication configuration. `tenantKey` is used only to split
 * local subjects and never forwarded upstream.
 *
 * `fetchImpl` and `now` are injectable so tests can run without real network
 * or wall-clock time.
 */
export function createMailMembershipProvider(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new MailMembershipError('invalid provider options');
  }
  const { config, fetchImpl = fetch, now = Date.now } = options;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new MailMembershipError('invalid provider options');
  }
  const appId = validateConfigString(config.appId, 1, 128);
  const appSecret = validateConfigString(config.appSecret, 1, 256);
  const tenantKey = validateConfigString(config.tenantKey, 1, 128);
  if (typeof fetchImpl !== 'function') {
    throw new MailMembershipError('invalid provider options');
  }
  if (typeof now !== 'function') {
    throw new MailMembershipError('invalid provider options');
  }

  // Memory-only token cache. A single in-flight refresh promise is shared so
  // concurrent callers don't stampede the upstream token endpoint.
  const tokenState = {
    value: null,
    expiresAt: 0,
    inflight: null,
  };

  async function getTenantAccessToken() {
    const nowMs = readNow(now);
    if (tokenState.value && tokenState.expiresAt - TOKEN_REFRESH_SKEW_MS > nowMs) {
      return tokenState.value;
    }
    if (tokenState.inflight) {
      return tokenState.inflight;
    }
    const refresh = fetchTenantAccessToken(fetchImpl, appId, appSecret)
      .then((result) => {
        const t = readNow(now);
        const lifetime = Math.max(result.expiresInSec * 1000, MIN_TOKEN_LIFETIME_MS);
        tokenState.value = result.token;
        tokenState.expiresAt = t + lifetime;
        return result.token;
      })
      .catch((err) => {
        tokenState.value = null;
        tokenState.expiresAt = 0;
        throw err;
      })
      .finally(() => {
        tokenState.inflight = null;
      });
    tokenState.inflight = refresh;
    return refresh;
  }

  async function authorizedRequest(method, url, body) {
    const token = await getTenantAccessToken();
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }
    try {
      const payload = await performRequest(fetchImpl, method, url, headers, body);
      if (payload?.code !== 0) { tokenState.value = null; tokenState.expiresAt = 0; }
      return payload;
    } catch (error) {
      tokenState.value = null; tokenState.expiresAt = 0;
      throw error;
    }
  }

  async function listMembers() {
    const members = [];
    const seenIds = new Set();
    let pageToken = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const url = buildListUrl(pageToken);
      const payload = await authorizedRequest('GET', url, undefined);
      assertProviderOk(payload);
      const data = payload.data;
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new MailMembershipError('invalid upstream response');
      }
      const items = data.items;
      if (typeof data.has_more !== 'boolean' || !Array.isArray(items)) {
        throw new MailMembershipError('invalid upstream response');
      }
      {
        if (!Array.isArray(items)) {
          throw new MailMembershipError('invalid upstream response');
        }
        for (const item of items) {
          const parsed = parseMember(item);
          if (seenIds.has(parsed.memberId)) {
            throw new MailMembershipError('invalid upstream response');
          }
          seenIds.add(parsed.memberId);
          members.push({ memberId: parsed.memberId, subject: `${tenantKey}:${parsed.unionId}` });
          if (members.length > MAX_LIST_ROWS) {
            throw new MailMembershipError('upstream page overflow');
          }
        }
      }
      const hasMore = data.has_more === true;
      const nextToken = data.page_token;
      if (!hasMore) {
        return members;
      }
      if (typeof nextToken !== 'string' || !PAGE_TOKEN_PATTERN.test(nextToken)) {
        throw new MailMembershipError('invalid upstream response');
      }
      if (pageToken !== null && nextToken === pageToken) {
        // Protect against upstream returning the same cursor forever.
        throw new MailMembershipError('upstream pagination loop');
      }
      pageToken = nextToken;
    }
    throw new MailMembershipError('upstream page overflow');
  }

  async function addMember(subject) {
    const unionId = parseSubject(subject, tenantKey);
    const url = `${MEMBERS_URL}?user_id_type=union_id`;
    const payload = await authorizedRequest('POST', url, {
      user_id: unionId,
      type: 'USER',
    });
    assertProviderOk(payload);
    const data = payload.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new MailMembershipError('invalid upstream response');
    }
    const parsed = parseMember(data);
    // Defence in depth: the mailbox is single-tenant, so the returned union_id
    // must equal the one we sent. Guard against a server mix-up.
    if (parsed.unionId !== unionId) {
      throw new MailMembershipError('invalid upstream response');
    }
    return { memberId: parsed.memberId, subject: `${tenantKey}:${unionId}` };
  }

  async function removeMember(memberId) {
    if (typeof memberId !== 'string' || !MEMBER_ID_PATTERN.test(memberId)) {
      throw new MailMembershipError('invalid member id');
    }
    const url = `${MEMBERS_URL}/${encodeURIComponent(memberId)}`;
    let payload;
    try {
      payload = await authorizedRequest('DELETE', url, undefined);
    } catch (err) {
      if (err instanceof MailMembershipError && err.providerCode === 1234040) {
        return { removed: false };
      }
      throw err;
    }
    // code === 0 means the delete succeeded. Any non-zero code except the
    // specific "member not found" idempotency marker is a hard failure.
    if (payload && payload.code === 0) {
      return { removed: true };
    }
    if (payload && payload.code === 1234040) {
      return { removed: false };
    }
    assertProviderOk(payload);
    return { removed: true };
  }

  return {
    listMembers,
    addMember,
    removeMember,
  };
}

function validateConfigString(value, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new MailMembershipError('invalid provider options');
  }
  // Must be printable ASCII with no whitespace or control characters so it can
  // be safely folded into HTTP headers/JSON bodies.
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) {
      throw new MailMembershipError('invalid provider options');
    }
  }
  return value;
}

function parseSubject(subject, expectedTenantKey) {
  if (typeof subject !== 'string' || subject.length > 256) {
    throw new MailMembershipError('invalid subject');
  }
  const match = SUBJECT_PATTERN.exec(subject);
  if (!match) {
    throw new MailMembershipError('invalid subject');
  }
  if (match[1] !== expectedTenantKey) {
    throw new MailMembershipError('invalid subject');
  }
  return match[2];
}

function buildListUrl(pageToken) {
  const params = new URLSearchParams();
  params.set('user_id_type', 'union_id');
  params.set('page_size', String(LIST_PAGE_SIZE));
  if (pageToken !== null) {
    params.set('page_token', pageToken);
  }
  return `${MEMBERS_URL}?${params.toString()}`;
}

function parseMember(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new MailMembershipError('invalid upstream response');
  }
  const memberId = item.member_id;
  const type = item.type;
  const userId = item.user_id;
  if (type !== 'USER') {
    throw new MailMembershipError('unsupported member type');
  }
  if (typeof memberId !== 'string' || !MEMBER_ID_PATTERN.test(memberId)) {
    throw new MailMembershipError('invalid upstream response');
  }
  if (typeof userId !== 'string' || !/^on_[A-Za-z0-9_-]{1,120}$/.test(userId)) {
    throw new MailMembershipError('invalid upstream response');
  }
  return { memberId, unionId: userId };
}

function assertProviderOk(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new MailMembershipError('invalid upstream response');
  }
  if (!Number.isInteger(payload.code)) {
    throw new MailMembershipError('invalid upstream response');
  }
  if (payload.code !== 0) {
    throw new MailMembershipError('upstream rejected request', { providerCode: payload.code });
  }
}

async function fetchTenantAccessToken(fetchImpl, appId, appSecret) {
  const payload = await performRequest(
    fetchImpl,
    'POST',
    TENANT_TOKEN_URL,
    { 'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json' },
    { app_id: appId, app_secret: appSecret },
  );
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new MailMembershipError('invalid upstream response');
  }
  if (!Number.isInteger(payload.code) || payload.code !== 0) {
    throw new MailMembershipError('upstream rejected request', {
      providerCode: Number.isInteger(payload.code) ? payload.code : null,
    });
  }
  const token = payload.tenant_access_token;
  const expire = payload.expire;
  if (typeof token !== 'string' || token.length < 1 || token.length > 512) {
    throw new MailMembershipError('invalid upstream response');
  }
  // Printable ASCII only; prevents header-smuggling if the upstream ever
  // returned something weird.
  for (let i = 0; i < token.length; i += 1) {
    const code = token.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) {
      throw new MailMembershipError('invalid upstream response');
    }
  }
  if (!Number.isInteger(expire) || expire < 1 || expire > 86400) {
    throw new MailMembershipError('invalid upstream response');
  }
  return { token, expiresInSec: expire };
}

async function performRequest(fetchImpl, method, url, headers, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let response;
  try {
    const init = {
      method,
      headers,
      redirect: 'error',
      signal: controller.signal,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    try {
      response = await fetchImpl(url, init);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new MailMembershipError('upstream timeout');
      }
      throw new MailMembershipError('upstream unavailable');
    }
    if (response === null || typeof response !== 'object') {
      throw new MailMembershipError('invalid upstream response');
    }
    if (typeof response.status !== 'number') {
      throw new MailMembershipError('invalid upstream response');
    }
    const text = await readBoundedBody(response);
    const payload = parseJson(text);
    // Non-2xx responses: inspect for a provider code before failing so callers
    // (notably removeMember's idempotent 404) can act on it.
    if (response.status < 200 || response.status >= 300) {
      const code =
        payload && typeof payload === 'object' && !Array.isArray(payload) && Number.isInteger(payload.code)
          ? payload.code
          : null;
      throw new MailMembershipError('upstream rejected request', { providerCode: code });
    }
    return payload;
  } catch (error) {
    if (error instanceof MailMembershipError) throw error;
    throw new MailMembershipError(controller.signal.aborted ? 'upstream timeout' : 'upstream unavailable');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function readBoundedBody(response) {
  // Prefer the streaming body so we can abort reading as soon as we exceed the
  // cap, even if the server lies about Content-Length.
  const declared = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-length')
    : null;
  if (declared !== null && declared !== undefined) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_RESPONSE_BYTES) {
      throw new MailMembershipError('upstream response too large');
    }
  }
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            try { await reader.cancel(); } catch { /* ignore */ }
            throw new MailMembershipError('upstream response too large');
          }
          chunks.push(value);
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }
  // Fallback: no streaming body available. Use text() but validate size.
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new MailMembershipError('upstream response too large');
    }
    return text;
  }
  throw new MailMembershipError('invalid upstream response');
}

function parseJson(text) {
  if (typeof text !== 'string') {
    throw new MailMembershipError('invalid upstream response');
  }
  if (text.length === 0) {
    throw new MailMembershipError('invalid upstream response');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MailMembershipError('invalid upstream response');
  }
}

function readNow(now) {
  let value;
  try {
    value = now();
  } catch {
    throw new MailMembershipError('invalid clock');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MailMembershipError('invalid clock');
  }
  return Math.trunc(value);
}
