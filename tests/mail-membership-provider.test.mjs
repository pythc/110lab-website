import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  createMailMembershipProvider,
  MailMembershipError,
} from '../server/mail-membership-provider.mjs';

const CONFIG = {
  appId: 'cli_fixture_app',
  appSecret: 'fixture_secret_value',
  tenantKey: 'fictional_tenant',
};
const MAILBOX_PATH =
  '/open-apis/mail/v1/public_mailboxes/noreply%40notify.110-lab.cn/members';
const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal';

/**
 * Minimal Response-like object compatible with the provider's consumption of
 * fetch: `status`, `headers.get`, and either `body` (ReadableStream) or
 * `text()`.
 */
function jsonResponse(status, payload, { chunks = null, headers = {} } = {}) {
  const body = JSON.stringify(payload);
  const base = {
    status,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === 'content-length') return String(Buffer.byteLength(body, 'utf8'));
        if (key in headers) return headers[key];
        return null;
      },
    },
    async text() {
      return body;
    },
    get body() {
      if (chunks) {
        return Readable.toWeb(Readable.from(chunks));
      }
      return Readable.toWeb(Readable.from([Buffer.from(body, 'utf8')]));
    },
  };
  return base;
}

function largeResponse(size) {
  const buf = Buffer.alloc(size, 0x61);
  return {
    status: 200,
    headers: { get: (n) => (String(n).toLowerCase() === 'content-length' ? String(size) : null) },
    body: Readable.toWeb(Readable.from([buf])),
    async text() { return buf.toString('utf8'); },
  };
}

/**
 * Build a fetch stub that records all calls and dispatches to handlers keyed
 * by (method, pathname). Each handler is a function returning a response-like
 * object or throwing.
 */
function makeFetch(handlers) {
  const calls = [];
  async function fetchImpl(url, init) {
    const u = new URL(url);
    calls.push({
      url,
      pathname: u.pathname,
      search: u.search,
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: init.redirect,
      signal: init.signal,
    });
    const key = `${init.method} ${u.pathname}`;
    const handler = handlers[key];
    if (!handler) {
      throw new Error(`unexpected request ${key}`);
    }
    return handler({ url, init, pathname: u.pathname, search: u.search });
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

function fixedNow() {
  let t = 1_700_000_000_000;
  return () => t;
}

test('config and dependency validation', () => {
  assert.throws(() => createMailMembershipProvider(null), (e) => e instanceof MailMembershipError);
  assert.throws(() => createMailMembershipProvider({}), (e) => e instanceof MailMembershipError);
  assert.throws(
    () => createMailMembershipProvider({ config: { appId: '', appSecret: 's', tenantKey: 't' } }),
    (e) => e instanceof MailMembershipError,
  );
  assert.throws(
    () =>
      createMailMembershipProvider({
        config: { appId: 'with space', appSecret: 's', tenantKey: 't' },
      }),
    (e) => e instanceof MailMembershipError,
  );
  assert.throws(
    () => createMailMembershipProvider({ config: CONFIG, fetchImpl: 'not-a-fn' }),
    (e) => e instanceof MailMembershipError,
  );
});

test('fetchImpl must be a function and now must be callable', () => {
  assert.throws(
    () => createMailMembershipProvider({ config: CONFIG, now: 123 }),
    (e) => e instanceof MailMembershipError,
  );
});

test('token is fetched once, cached, and refreshed near expiry via single-flight', async () => {
  let tokenCalls = 0;
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () => {
      tokenCalls += 1;
      return jsonResponse(200, {
        code: 0,
        msg: 'ok',
        tenant_access_token: `t-token-${tokenCalls}`,
        expire: 300,
      });
    },
    [`GET ${MAILBOX_PATH}`]: () =>
      jsonResponse(200, { code: 0, msg: 'ok', data: { has_more: false, items: [] } }),
  });
  let fakeNow = 1_700_000_000_000;
  const provider = createMailMembershipProvider({
    config: CONFIG,
    fetchImpl,
    now: () => fakeNow,
  });

  // Concurrent calls should share one in-flight token fetch.
  await Promise.all([provider.listMembers(), provider.listMembers(), provider.listMembers()]);
  assert.equal(tokenCalls, 1);

  // Reusable within lifetime.
  await provider.listMembers();
  assert.equal(tokenCalls, 1);

  // Advance past expiry (minus skew) → next call refreshes.
  fakeNow += 300_000; // 5 minutes
  await provider.listMembers();
  assert.equal(tokenCalls, 2);

  // Confirm the Authorization header carries the latest token.
  const lastList = fetchImpl.calls.filter((c) => c.method === 'GET').at(-1);
  assert.equal(lastList.headers['Authorization'], 'Bearer t-token-2');
});

test('token error does not poison the cache; next call retries fresh', async () => {
  let n = 0;
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () => {
      n += 1;
      if (n === 1) {
        return jsonResponse(200, { code: 99991663, msg: 'bad secret' });
      }
      return jsonResponse(200, {
        code: 0,
        msg: 'ok',
        tenant_access_token: 't-good',
        expire: 7200,
      });
    },
    [`GET ${MAILBOX_PATH}`]: () =>
      jsonResponse(200, { code: 0, msg: 'ok', data: { has_more: false, items: [] } }),
  });
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  await assert.rejects(provider.listMembers(), (e) => e instanceof MailMembershipError && e.providerCode === 99991663);
  // Retry succeeds.
  const members = await provider.listMembers();
  assert.deepEqual(members, []);
  assert.equal(n, 2);
});

test('listMembers fixed mailbox, pagination, bounded pages/rows, dedup', async () => {
  const page1Items = [
    { member_id: 'm_1', user_id: 'on_user1', type: 'USER' },
    { member_id: 'm_2', user_id: 'on_user2', type: 'USER' },
  ];
  const page2Items = [{ member_id: 'm_3', user_id: 'on_user3', type: 'USER' }];
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () =>
      jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 7200 }),
    [`GET ${MAILBOX_PATH}`]: ({ search }) => {
      const params = new URLSearchParams(search);
      assert.equal(params.get('user_id_type'), 'union_id');
      assert.equal(params.get('page_size'), '100');
      if (!params.get('page_token')) {
        return jsonResponse(200, {
          code: 0,
          msg: 'ok',
          data: { has_more: true, page_token: 'cursor-two', items: page1Items },
        });
      }
      assert.equal(params.get('page_token'), 'cursor-two');
      return jsonResponse(200, {
        code: 0,
        msg: 'ok',
        data: { has_more: false, items: page2Items },
      });
    },
  });
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  const members = await provider.listMembers();
  assert.deepEqual(members, [
    { memberId: 'm_1', subject: 'fictional_tenant:on_user1' },
    { memberId: 'm_2', subject: 'fictional_tenant:on_user2' },
    { memberId: 'm_3', subject: 'fictional_tenant:on_user3' },
  ]);
  // All GET requests hit the fixed mailbox path only.
  for (const c of fetchImpl.calls.filter((c) => c.method === 'GET')) {
    assert.equal(c.pathname, MAILBOX_PATH);
    assert.equal(c.redirect, 'error');
  }
});

test('listMembers rejects a page cursor loop and never follows upstream URLs', async () => {
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () =>
      jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 7200 }),
    [`GET ${MAILBOX_PATH}`]: () =>
      jsonResponse(200, {
        code: 0,
        msg: 'ok',
        data: {
          has_more: true,
          page_token: 'same-cursor',
          // Attempt to redirect via a bogus upstream URL field — must be ignored.
          next: 'https://evil.example.com/open-apis/mail/v1/public_mailboxes/x/members',
          items: [],
        },
      }),
  });
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  // First call: page_token=null → "same-cursor". Second call: page_token=same-cursor → loop detected.
  await assert.rejects(provider.listMembers(), (e) => e instanceof MailMembershipError);
  // Only two GET calls, both to the fixed URL.
  const gets = fetchImpl.calls.filter((c) => c.method === 'GET');
  assert.equal(gets.length, 2);
  for (const g of gets) assert.equal(g.pathname, MAILBOX_PATH);
});

test('listMembers rejects more than max pages', async () => {
  let page = 0;
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () =>
      jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 7200 }),
    [`GET ${MAILBOX_PATH}`]: () => {
      page += 1;
      return jsonResponse(200, {
        code: 0,
        msg: 'ok',
        data: {
          has_more: true,
          page_token: `cursor-${page}`,
          items: [{ member_id: `m_${page}`, user_id: `on_u${page}`, type: 'USER' }],
        },
      });
    },
  });
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  await assert.rejects(provider.listMembers(), (e) => e instanceof MailMembershipError);
});

test('listMembers rejects more than max rows', async () => {
  const bigItems = Array.from({ length: 401 }, (_, i) => ({
    member_id: `m_${i}`,
    user_id: `on_u${i}`,
    type: 'USER',
  }));
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () =>
      jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 7200 }),
    [`GET ${MAILBOX_PATH}`]: () =>
      jsonResponse(200, {
        code: 0,
        msg: 'ok',
        data: { has_more: false, items: bigItems },
      }),
  });
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  await assert.rejects(provider.listMembers(), (e) => e instanceof MailMembershipError);
});

test('listMembers rejects non-USER members and malformed items', async () => {
  const bad = [
    {},
    { has_more: 'false', items: [] },
    { has_more: false, items: null },
    { has_more: false, items: [{ member_id: 'm_1', user_id: 'on_u1', type: 'DEPARTMENT' }] },
    { has_more: false, items: [{ member_id: 'm_1', user_id: 'u1', type: 'USER' }] }, // non-union_id form
    { has_more: false, items: [{ member_id: '', user_id: 'on_u1', type: 'USER' }] },
    { has_more: false, items: [{ user_id: 'on_u1', type: 'USER' }] },
    { has_more: false, items: 'not-an-array' },
    { has_more: true },
    'not-an-object',
  ];
  for (const data of bad) {
    const fetchImpl = makeFetch({
      [`POST ${TOKEN_PATH}`]: () =>
        jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 7200 }),
      [`GET ${MAILBOX_PATH}`]: () => jsonResponse(200, { code: 0, msg: 'ok', data }),
    });
    const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
    await assert.rejects(provider.listMembers(), (e) => e instanceof MailMembershipError);
  }
});

test('listMembers rejects duplicate member ids across pages', async () => {
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () =>
      jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 7200 }),
    [`GET ${MAILBOX_PATH}`]: ({ search }) => {
      const params = new URLSearchParams(search);
      if (!params.get('page_token')) {
        return jsonResponse(200, {
          code: 0,
          msg: 'ok',
          data: {
            has_more: true,
            page_token: 'c2',
            items: [{ member_id: 'm_dup', user_id: 'on_u1', type: 'USER' }],
          },
        });
      }
      return jsonResponse(200, {
        code: 0,
        msg: 'ok',
        data: {
          has_more: false,
          items: [{ member_id: 'm_dup', user_id: 'on_u2', type: 'USER' }],
        },
      });
    },
  });
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  await assert.rejects(provider.listMembers(), (e) => e instanceof MailMembershipError);
});

test('addMember posts to fixed URL with union_id, validates subject and response', async () => {
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () =>
      jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 7200 }),
    [`POST ${MAILBOX_PATH}`]: ({ init, search }) => {
      const params = new URLSearchParams(search);
      assert.equal(params.get('user_id_type'), 'union_id');
      const body = JSON.parse(init.body);
      assert.deepEqual(body, { user_id: 'on_fictional1', type: 'USER' });
      return jsonResponse(200, {
        code: 0,
        msg: 'ok',
        data: { member_id: 'm_new', user_id: 'on_fictional1', type: 'USER' },
      });
    },
  });
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  const added = await provider.addMember(`${CONFIG.tenantKey}:on_fictional1`);
  assert.deepEqual(added, { memberId: 'm_new', subject: `${CONFIG.tenantKey}:on_fictional1` });
});

test('addMember rejects invalid or foreign-tenant subjects', async () => {
  const provider = createMailMembershipProvider({
    config: CONFIG,
    fetchImpl: makeFetch({}), // should never be invoked
    now: fixedNow(),
  });
  const bad = [
    null,
    123,
    '',
    'bad',
    `${CONFIG.tenantKey}:unionid-no-prefix`,
    `other_tenant:on_u1`,
    `${CONFIG.tenantKey}:on_${'x'.repeat(200)}`,
    `${CONFIG.tenantKey}:on_bad space`,
  ];
  for (const s of bad) {
    await assert.rejects(provider.addMember(s), (e) => e instanceof MailMembershipError);
  }
});

test('addMember rejects mismatched union_id in response', async () => {
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () =>
      jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 7200 }),
    [`POST ${MAILBOX_PATH}`]: () =>
      jsonResponse(200, {
        code: 0,
        msg: 'ok',
        data: { member_id: 'm_x', user_id: 'on_someoneelse', type: 'USER' },
      }),
  });
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  await assert.rejects(
    provider.addMember(`${CONFIG.tenantKey}:on_u1`),
    (e) => e instanceof MailMembershipError,
  );
});

test('addMember surfaces provider code without leaking message/body/url', async () => {
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () =>
      jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 7200 }),
    [`POST ${MAILBOX_PATH}`]: () =>
      jsonResponse(400, { code: 1234027, msg: 'limit exceeded; secret=xyz' }),
  });
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  await assert.rejects(provider.addMember(`${CONFIG.tenantKey}:on_u1`), (e) => {
    if (!(e instanceof MailMembershipError)) return false;
    if (e.status !== 503) return false;
    if (e.providerCode !== 1234027) return false;
    // Message must not leak upstream string or URL.
    if (/limit exceeded/i.test(e.message)) return false;
    if (/secret/i.test(e.message)) return false;
    if (/public_mailboxes/i.test(e.message)) return false;
    return true;
  });
});

test('removeMember validates memberId strictly', async () => {
  const provider = createMailMembershipProvider({
    config: CONFIG,
    fetchImpl: makeFetch({}),
    now: fixedNow(),
  });
  for (const id of ['', null, 123, '../etc/passwd', 'has space', 'x'.repeat(200)]) {
    await assert.rejects(provider.removeMember(id), (e) => e instanceof MailMembershipError);
  }
});

test('removeMember success and idempotent 404 member-not-found', async () => {
  const outcomes = [
    { status: 200, body: { code: 0, msg: 'ok', data: {} }, expect: { removed: true } },
    {
      status: 404,
      body: { code: 1234040, msg: 'public mailbox member not found' },
      expect: { removed: false },
    },
    // In-body code without HTTP 4xx still treated per code.
    {
      status: 200,
      body: { code: 1234040, msg: 'member not found' },
      expect: { removed: false },
    },
  ];
  for (const o of outcomes) {
    const fetchImpl = makeFetch({
      [`POST ${TOKEN_PATH}`]: () =>
        jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 7200 }),
      [`DELETE ${MAILBOX_PATH}/m_abc`]: () => jsonResponse(o.status, o.body),
    });
    const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
    const r = await provider.removeMember('m_abc');
    assert.deepEqual(r, o.expect);
  }
});

test('removeMember throws on 404 mailbox-not-found (not the member one)', async () => {
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () =>
      jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 7200 }),
    [`DELETE ${MAILBOX_PATH}/m_abc`]: () =>
      jsonResponse(404, { code: 1234016, msg: 'public mailbox not found' }),
  });
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  await assert.rejects(provider.removeMember('m_abc'), (e) => {
    return e instanceof MailMembershipError && e.providerCode === 1234016;
  });
});

test('http transport errors become MailMembershipError without leaking cause', async () => {
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () => {
      throw new Error('ECONNRESET: production-dns-leak');
    },
  });
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  await assert.rejects(provider.listMembers(), (e) => {
    if (!(e instanceof MailMembershipError)) return false;
    if (/ECONNRESET|dns-leak/i.test(e.message) || e.cause !== undefined) return false;
    return e.status === 503;
  });
});

test('request times out when upstream never responds', async () => {
  const fetchImpl = async (_url, init) => {
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
  // Override the token path only; we trigger it via listMembers()
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  const started = Date.now();
  await assert.rejects(provider.listMembers(), (e) => e instanceof MailMembershipError);
  // Timeout bound is 10s; we just ensure we didn't hang forever and it bailed.
  assert.ok(Date.now() - started < 15_000);
});

test('response larger than 256KiB is rejected (declared content-length)', async () => {
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () =>
      jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 7200 }),
    [`GET ${MAILBOX_PATH}`]: () => largeResponse(300 * 1024),
  });
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  await assert.rejects(provider.listMembers(), (e) => e instanceof MailMembershipError);
});

test('response larger than 256KiB is rejected during stream read (undeclared size)', async () => {
  const big = Buffer.alloc(300 * 1024, 0x62);
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () =>
      jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 7200 }),
    [`GET ${MAILBOX_PATH}`]: () => ({
      status: 200,
      headers: { get: () => null },
      body: Readable.toWeb(Readable.from([big])),
      async text() { return big.toString('utf8'); },
    }),
  });
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  await assert.rejects(provider.listMembers(), (e) => e instanceof MailMembershipError);
});

test('malformed JSON upstream becomes a generic error', async () => {
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () =>
      jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 7200 }),
    [`GET ${MAILBOX_PATH}`]: () => ({
      status: 200,
      headers: { get: () => '7' },
      body: Readable.toWeb(Readable.from([Buffer.from('not-json', 'utf8')])),
      async text() { return 'not-json'; },
    }),
  });
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  await assert.rejects(provider.listMembers(), (e) => e instanceof MailMembershipError);
});

test('response stream failures never leak underlying details', async () => {
  const provider=createMailMembershipProvider({config:CONFIG,fetchImpl:async()=>({status:200,headers:new Headers(),body:new ReadableStream({start(controller){controller.error(new Error('fixture_private_network_detail'));}})})});
  await assert.rejects(provider.listMembers(),error=>error instanceof MailMembershipError&&error.cause===undefined&&!String(error).includes('fixture_private_network_detail'));
});

test('redirect is disabled on every request', async () => {
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () =>
      jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 7200 }),
    [`GET ${MAILBOX_PATH}`]: () =>
      jsonResponse(200, { code: 0, msg: 'ok', data: { has_more: false, items: [] } }),
  });
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  await provider.listMembers();
  for (const c of fetchImpl.calls) {
    assert.equal(c.redirect, 'error');
    // Authorization header must only ever be present on mailbox calls.
    if (c.pathname === TOKEN_PATH) {
      assert.equal(c.headers['Authorization'], undefined);
    } else {
      assert.match(c.headers['Authorization'], /^Bearer /);
    }
  }
});

test('non-2xx token response fails cleanly', async () => {
  const fetchImpl = makeFetch({
    [`POST ${TOKEN_PATH}`]: () => jsonResponse(500, { code: 99991400, msg: 'srv err' }),
  });
  const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
  await assert.rejects(provider.listMembers(), (e) => {
    return e instanceof MailMembershipError && e.providerCode === 99991400;
  });
});

test('token response missing fields is rejected', async () => {
  const bad = [
    { code: 0, msg: 'ok', expire: 7200 }, // no token
    { code: 0, msg: 'ok', tenant_access_token: '', expire: 7200 },
    { code: 0, msg: 'ok', tenant_access_token: 't-ok' }, // no expire
    { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 0 },
    { code: 0, msg: 'ok', tenant_access_token: 't-ok', expire: 999999 },
    { code: 'zero', msg: 'ok', tenant_access_token: 't-ok', expire: 7200 },
  ];
  for (const b of bad) {
    const fetchImpl = makeFetch({ [`POST ${TOKEN_PATH}`]: () => jsonResponse(200, b) });
    const provider = createMailMembershipProvider({ config: CONFIG, fetchImpl, now: fixedNow() });
    await assert.rejects(provider.listMembers(), (e) => e instanceof MailMembershipError);
  }
});
