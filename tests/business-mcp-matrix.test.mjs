import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import net from 'node:net';
import {randomUUID, createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {BUSINESS_TOOLS} from '../server/business-tools.mjs';
import {BUSINESS_SCOPES} from '../server/business-scopes.mjs';
import {MAIL_ISSUER, MAIL_RESOURCE} from '../server/mail-oauth.mjs';
import {openUpdatesStore} from '../server/updates.mjs';
import {fixtureConfig, fixtureIdentity} from './helpers/mail-fixtures.mjs';

const {createHttpServer} = await import(
  process.env.BUSINESS_RELEASE_ROOT
    ? pathToFileURL(join(process.env.BUSINESS_RELEASE_ROOT, 'server/runtime.mjs'))
    : new URL('../server/http.mjs', import.meta.url)
);

const definedTools = BUSINESS_TOOLS.map(tool => tool.name);
const fullScope = Object.keys(BUSINESS_SCOPES).join(' ');
const ownerIdentity = fixtureIdentity;
const memberIdentity = {
  subject: 'fictional_tenant:on_fixture_member_2026',
  email: 'fictional.member@110-lab.cn',
  name: '虚构成员',
};
const directoryMembers = [
  {subject: ownerIdentity.subject, name: ownerIdentity.name, email: ownerIdentity.email},
  {subject: memberIdentity.subject, name: memberIdentity.name, email: memberIdentity.email},
];
const links = {repository: '', requirements: '', docs: '', demo: ''};
const article = {
  title: '仅测试的动态',
  summary: '虚构摘要',
  body: [{type: 'paragraph', content: [{text: '虚构正文'}]}],
  link: null,
};
const mailAttachmentText = '虚构邮件附件';
const redirectUri = 'http://127.0.0.1:49111/callback/business_test';

function fictionalPng() {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
}

function fictionalPdf() {
  const stream = 'BT /F1 18 Tf 72 720 Td (Fictional resume) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(pdf);
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(pdf + 'trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n' + start + '\n%%EOF');
}

function cookieHeader(response) {
  const raw = response.headers['set-cookie'] || [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(value => value.split(';')[0]).join('; ');
}

function refreshUrl(response) {
  const match = response.text.match(/<meta http-equiv="refresh" content="0;url=([^"]+)"/);
  assert.ok(match, response.text.slice(0, 400));
  return new URL(match[1].replaceAll('&amp;', '&'));
}

function requestNonce(response) {
  const match = response.text.match(/name="request" value="([\w-]{43})"/);
  assert.ok(match, response.text.slice(0, 400));
  return match[1];
}

function installLoopbackGuard(t, traffic) {
  const nativeFetch = globalThis.fetch;
  const nativeConnect = net.Socket.prototype.connect;
  globalThis.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      traffic.blocked.push(url.origin + url.pathname);
      throw new Error('refusing non-loopback fetch ' + url.href);
    }
    return nativeFetch(input, init);
  };
  net.Socket.prototype.connect = function connect(...args) {
    const first = args[0];
    const host = typeof first === 'object' && first
      ? first.host || first.hostname || ''
      : typeof args[1] === 'string' ? args[1] : '';
    if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
      traffic.blocked.push(String(host));
      throw new Error('refusing non-loopback socket ' + host);
    }
    return nativeConnect.apply(this, args);
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
    net.Socket.prototype.connect = nativeConnect;
  });
}

async function setup(t) {
  const traffic = {sends: 0, blocked: []};
  installLoopbackGuard(t, traffic);
  const directory = await mkdtemp(join(tmpdir(), '110lab-business-mcp-'));
  const updates = openUpdatesStore(join(directory, 'updates.sqlite'));
  const mailProvider = {
    revision: 'fixture-provider-v1',
    mode: 'dry-run',
    mailboxes: () => [{address: 'noreply@110-lab.cn', enabled: true, canRead: true, canSend: true}],
    async list() {
      return {
        items: [{
          messageId: 'original@example.test',
          subject: '虚构来信',
          from: 'candidate@example.test',
        }],
        nextCursor: null,
      };
    },
    async get() {
      return {
        messageId: 'original@example.test',
        from: [{address: 'candidate@example.test'}],
        replyTo: [],
        references: [],
        attachments: [{
          index: 0,
          filename: 'note.txt',
          contentType: 'text/plain',
          size: Buffer.byteLength(mailAttachmentText),
        }],
        body: '不可信邮件内容',
      };
    },
    async attachment() {
      return {filename: 'note.txt', mime: 'text/plain', buffer: Buffer.from(mailAttachmentText)};
    },
    async send() {
      traffic.sends += 1;
      throw new Error('dry-run mailbox must not send');
    },
    close() {},
  };
  const server = await createHttpServer({
    mail: {
      enabled: true,
      directory,
      config: fixtureConfig,
      localTest: true,
      assessmentSsoEnabled: false,
      notifyEnabled: false,
      async fetchIdentity(_config, {code}) {
        if (code === 'fictional-owner') return {...ownerIdentity};
        if (code === 'fictional-member') return {...memberIdentity};
        throw new Error('unexpected fictional login code');
      },
      fetchDirectory: async () => directoryMembers.map(member => ({...member})),
    },
    admin: {enabled: true, localTest: true},
    recruitment: {enabled: false},
    recruitmentWorkflow: {
      enabled: true,
      localTest: true,
      deliveryMode: 'dry-run',
      directory: join(directory, 'recruitment-workflow'),
    },
    workspace: {localTest: true},
    honors: {localTest: true},
    business: {
      enabled: true,
      localTest: true,
      directory: join(directory, 'mcp-business'),
      mailProvider,
    },
    updatesStore: updates,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await server.workflowClosed;
    updates.close();
    await rm(directory, {recursive: true, force: true});
  });

  const call = (path, {data, form, raw, headers = {}, method} = {}) => new Promise((resolve, reject) => {
    const verb = method || (data || form || raw ? 'POST' : 'GET');
    const body = raw || (form
      ? new URLSearchParams(form).toString()
      : data ? JSON.stringify(data) : undefined);
    const req = request({
      host: '127.0.0.1',
      port: server.address().port,
      path,
      method: verb,
      headers: {
        Host: 'internal.110-lab.cn',
        Accept: 'application/json, text/event-stream',
        Origin: MAIL_ISSUER,
        ...(body ? {'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json'} : {}),
        ...headers,
      },
    }, res => {
      const parts = [];
      res.on('data', chunk => parts.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        resolve({status: res.statusCode, headers: res.headers, text, body: parsed});
      });
    });
    req.on('error', reject);
    req.end(body);
  });

  const feishu = async (url, code) => {
    const authorization = await call(url.pathname + url.search);
    const binding = cookieHeader(authorization);
    const start = await call('/mail/oauth/login', {
      form: {request: requestNonce(authorization)},
      headers: {Cookie: binding},
    });
    const launched = refreshUrl(start);
    assert.equal(launched.hostname, 'accounts.feishu.cn');
    const callback = await call('/mail/auth/callback?' + new URLSearchParams({
      state: launched.searchParams.get('state'),
      code,
    }), {headers: {Cookie: binding + '; ' + cookieHeader(start)}});
    const approval = await call('/mail/oauth/approve', {
      form: {request: requestNonce(callback)},
      headers: {Cookie: binding},
    });
    return {redirect: refreshUrl(approval), cookie: cookieHeader(callback), consent: callback.text};
  };

  const grant = async (scope, code) => {
    const registration = await call('/register', {data: {
      redirect_uris: ['http://127.0.0.1/callback/business_test'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope,
    }});
    assert.equal(registration.status, 201, registration.text);
    const client = registration.body.client_id;
    const verifier = 'v'.repeat(43);
    const authorize = new URL(MAIL_ISSUER + '/authorize?' + new URLSearchParams({
      client_id: client,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: MAIL_RESOURCE,
      scope,
      state: 'fictional_business_state',
    }));
    const session = await feishu(authorize, code);
    const token = await call('/token', {form: {
      client_id: client,
      code: session.redirect.searchParams.get('code'),
      redirect_uri: redirectUri,
      resource: MAIL_RESOURCE,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }});
    assert.equal(token.status, 200, token.text);
    return {token: token.body.access_token, scope: token.body.scope, cookie: session.cookie, client};
  };

  const tool = (token, name, args = {}) => call('/mcp/workbench-v6-1', {
    data: {jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: {name, arguments: args}},
    headers: token ? {Authorization: 'Bearer ' + token} : {},
  });

  return {call, grant, tool, traffic, server};
}

function data(result) {
  return result.structuredContent;
}

test('JSON-RPC tools/call covers every business MCP tool on loopback fixtures', {timeout: 90000}, async t => {
  const h = await setup(t);
  const succeeded = new Set();
  const owner = await h.grant(fullScope, 'fictional-owner');
  const member = await h.grant(fullScope, 'fictional-member');
  const narrow = await h.grant('lab:identity', 'fictional-owner');
  assert.ok(owner.cookie);
  assert.ok(member.cookie);
  assert.match(owner.scope, /projects:review/);
  assert.match(member.scope, /projects:review/);

  const ok = async (token, name, args = {}) => {
    const response = await h.tool(token, name, args);
    assert.equal(response.status, 200, name + ' ' + response.text.slice(0, 500));
    assert.equal(response.body?.error, undefined, JSON.stringify(response.body?.error));
    const result = response.body.result;
    CallToolResultSchema.parse(result);
    assert.notEqual(result?.isError, true, name + ' ' + JSON.stringify(result?.structuredContent || result));
    assert.equal(result?.isError, undefined);
    assert.ok(result?.structuredContent && typeof result.structuredContent === 'object', name);
    succeeded.add(name);
    return result;
  };
  const failTool = async (token, name, args, check) => {
    const response = await h.tool(token, name, args);
    assert.equal(response.status, 200, name + ' ' + response.text.slice(0, 500));
    assert.equal(response.body.result?.isError, true, JSON.stringify(response.body));
    check(response.body.result.structuredContent);
  };
  const csrf = async cookie => {
    const session = await h.call('/api/business/session', {headers: {Cookie: cookie}});
    assert.equal(session.status, 200, session.text);
    return session.body.csrf;
  };
  const confirm = async preview => {
    const token = await csrf(owner.cookie);
    const path = '/api/business/confirmations/' + preview.id;
    const body = {fingerprint: preview.fingerprint};
    const missing = await h.call(path, {data: body, headers: {Cookie: owner.cookie}});
    assert.equal(missing.status, 403);
    const forged = await h.call(path, {data: body, headers: {
      Cookie: owner.cookie,
      'X-CSRF-Token': token,
      Origin: 'https://evil.example',
    }});
    assert.equal(forged.status, 403);
    const memberToken = await csrf(member.cookie);
    const crossed = await h.call(path, {data: body, headers: {
      Cookie: member.cookie,
      'X-CSRF-Token': memberToken,
    }});
    assert.equal(crossed.status, 404);
    const approved = await h.call(path, {data: body, headers: {
      Cookie: owner.cookie,
      'X-CSRF-Token': token,
    }});
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.body.state, 'APPROVED');
    return approved.body;
  };
  const pollSimulated = async (operationId, field) => {
    let last;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await h.tool(owner.token, 'lab_operation_get', {operationId});
      assert.equal(response.status, 200, response.text.slice(0, 500));
      assert.notEqual(response.body.result?.isError, true, JSON.stringify(response.body.result));
      last = data(response.body.result);
      if (last[field] === 'SIMULATED') {
        succeeded.add('lab_operation_get');
        return last;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.fail('operation did not simulate: ' + JSON.stringify(last));
  };

  const listed = await h.call('/mcp/workbench-v6-1', {
    data: {jsonrpc: '2.0', id: randomUUID(), method: 'tools/list'},
  });
  assert.equal(listed.status, 200);
  const advertised = listed.body.result.tools.filter(tool => tool.name.startsWith('lab_')).map(tool => tool.name);
  assert.equal(new Set(advertised).size, 37);
  assert.deepEqual(new Set(advertised), new Set(definedTools));

  assert.equal((await h.tool(null, 'lab_whoami')).status, 401);
  assert.equal((await h.tool(narrow.token, 'lab_projects_list')).status, 403);
  await failTool(member.token, 'lab_candidates_list', {}, body => assert.equal(body.code, 'FORBIDDEN'));
  await failTool(member.token, 'lab_updates_list', {}, body => assert.equal(body.code, 'FORBIDDEN'));

  const ownerMe = data(await ok(owner.token, 'lab_whoami'));
  assert.equal(ownerMe.subject, ownerIdentity.subject);
  assert.equal(ownerMe.role, 'super_admin');
  assert.equal(ownerMe.mailMode, 'dry-run');
  assert.equal(ownerMe.applications.projects, true);
  assert.equal(ownerMe.applications.honors, true);
  assert.equal(ownerMe.applications.recruitment, true);
  assert.equal(ownerMe.applications.updates, true);
  assert.equal(ownerMe.applications.mail, true);
  assert.ok(ownerMe.capabilities.includes('lab_honor_review'));
  const memberMe = data(await ok(member.token, 'lab_whoami'));
  assert.equal(memberMe.role, 'member');
  assert.equal(memberMe.subject, memberIdentity.subject);
  assert.equal(memberMe.capabilities.includes('lab_candidates_list'), false);
  assert.ok(memberMe.capabilities.includes('lab_project_save'));

  const found = data(await ok(owner.token, 'lab_members_search', {query: '虚构成员'}));
  assert.equal(found.source, 'feishu');
  assert.equal(found.unavailable, false);
  assert.equal(found.total, 1);
  assert.equal(found.items[0].name, memberIdentity.name);
  assert.equal(found.items[0].email, memberIdentity.email);

  const projectFields = {
    name: '虚构共享项目',
    summary: '虚构项目介绍',
    members: [{subject: ownerIdentity.subject}],
    links,
  };
  const createProject = {requestId: randomUUID(), fields: projectFields};
  const createdProject = data(await ok(member.token, 'lab_project_save', createProject));
  const retriedProject = data(await ok(member.token, 'lab_project_save', createProject));
  assert.equal(retriedProject.id, createdProject.id);
  assert.equal(createdProject.phase, 'exploring');
  assert.equal(createdProject.members[0].name, ownerIdentity.name);
  await failTool(member.token, 'lab_project_save', {
    requestId: createProject.requestId,
    fields: {...projectFields, name: '被拒绝的改名'},
  }, body => assert.equal(body.code, 'REQUEST_CONFLICT'));
  const renamed = data(await ok(member.token, 'lab_project_save', {
    requestId: randomUUID(),
    id: createdProject.id,
    expectedRevision: createdProject.revision,
    fields: {...projectFields, name: '虚构共享项目修订'},
  }));
  assert.equal(renamed.name, '虚构共享项目修订');
  assert.notEqual(renamed.revision, createdProject.revision);
  await failTool(member.token, 'lab_project_save', {
    requestId: randomUUID(),
    id: createdProject.id,
    expectedRevision: createdProject.revision,
    fields: {...projectFields, name: '过期修订'},
  }, body => assert.equal(body.message, 'revision_conflict'));
  const pending = data(await ok(member.token, 'lab_project_apply', {
    requestId: randomUUID(),
    id: renamed.id,
    expectedRevision: renamed.revision,
    application: '申请成为实验室共同项目',
  }));
  assert.equal(pending.phase, 'pending');
  await failTool(member.token, 'lab_project_review', {
    requestId: randomUUID(),
    id: pending.id,
    expectedRevision: pending.revision,
    decision: 'approve',
    note: '',
  }, body => assert.equal(body.code, 'FORBIDDEN'));
  const active = data(await ok(owner.token, 'lab_project_review', {
    requestId: randomUUID(),
    id: pending.id,
    expectedRevision: pending.revision,
    decision: 'approve',
    note: '虚构审核通过',
  }));
  assert.equal(active.phase, 'active');
  const withMilestone = data(await ok(member.token, 'lab_project_milestone_save', {
    requestId: randomUUID(),
    projectId: active.id,
    fields: {title: '完成虚构里程碑', assignee: memberIdentity.subject, dueAt: null},
  }));
  const milestone = withMilestone.milestones.find(item => item.title === '完成虚构里程碑');
  assert.equal(milestone.status, 'open');
  const completed = data(await ok(member.token, 'lab_project_milestone_save', {
    requestId: randomUUID(),
    projectId: active.id,
    milestoneId: milestone.id,
    expectedRevision: milestone.revision,
    status: 'done',
  }));
  assert.equal(completed.milestones.find(item => item.id === milestone.id).status, 'done');
  const reopened = data(await ok(member.token, 'lab_project_milestone_save', {
    requestId: randomUUID(),
    projectId: active.id,
    milestoneId: milestone.id,
    expectedRevision: completed.milestones.find(item => item.id === milestone.id).revision,
    status: 'open',
  }));
  assert.equal(reopened.milestones.find(item => item.id === milestone.id).status, 'open');
  const projectList = data(await ok(member.token, 'lab_projects_list', {phase: 'active', mine: true}));
  assert.ok(projectList.items.some(item => item.id === active.id && item.name === '虚构共享项目修订'));
  const projectDetail = data(await ok(owner.token, 'lab_project_get', {id: active.id}));
  assert.equal(projectDetail.phase, 'active');
  assert.equal(projectDetail.events.length > 0, true);

  const honorFields = {
    name: '虚构荣誉',
    organizer: '虚构主办方',
    level: '校级',
    levelNote: '',
    prize: '一等奖',
    awardedAt: '2026-10-01',
    projectId: null,
    members: [{subject: ownerIdentity.subject}, {subject: memberIdentity.subject}],
    description: '虚构荣誉资料',
  };
  const certificate = data(await ok(owner.token, 'lab_file_upload', {
    requestId: randomUUID(),
    purpose: 'honor_certificate',
    filename: '证书.png',
    contentBase64: fictionalPng().toString('base64'),
  }));
  assert.equal(certificate.mime, 'image/png');
  assert.equal(certificate.bytes, fictionalPng().length);
  const honor = data(await ok(owner.token, 'lab_honor_save', {requestId: randomUUID(), fields: honorFields}));
  assert.equal(honor.status, 'draft');
  const hidden = data(await ok(member.token, 'lab_honors_list', {query: '虚构荣誉'}));
  assert.equal(hidden.items.some(item => item.id === honor.id), false);
  const attached = data(await ok(owner.token, 'lab_honor_certificate_attach', {
    requestId: randomUUID(),
    id: honor.id,
    expectedRevision: honor.revision,
    artifactId: certificate.artifactId,
  }));
  assert.equal(attached.certificate.sha256, certificate.sha256);
  const honorDetail = await ok(owner.token, 'lab_honor_get', {id: honor.id});
  assert.equal(data(honorDetail).certificate.filename, '证书.png');
  assert.match(data(honorDetail).certificate.reference, /^lab110:\/\/honor\//);
  const honorReference = data(honorDetail).certificate.reference;
  for (const reference of [honorReference, honorReference.replace(/^lab110:/, '110lab:')]) {
    assert.equal((await h.tool(narrow.token, 'lab_attachment_read', {reference})).status, 403);
    const legacyRead = await ok(owner.token, 'lab_attachment_read', {reference});
    assert.equal(data(legacyRead).reference, honorReference);
    assert.equal(legacyRead.content.find(block => block.type === 'resource').resource.uri, honorReference);
  }
  const certificateRead = await ok(owner.token, 'lab_attachment_read', {
    reference: data(honorDetail).certificate.reference,
  });
  assert.equal(data(certificateRead).mime, 'image/png');
  assert.equal(data(certificateRead).bytes, fictionalPng().length);
  assert.equal(data(certificateRead).untrustedContent, true);
  const certificateBlob = certificateRead.content.find(block => block.type === 'resource').resource.blob;
  assert.equal(Buffer.from(certificateBlob, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const submitted = data(await ok(owner.token, 'lab_honor_submit', {
    requestId: randomUUID(),
    id: honor.id,
    expectedRevision: attached.revision,
  }));
  assert.equal(submitted.status, 'pending');
  await failTool(member.token, 'lab_honor_review', {
    requestId: randomUUID(),
    id: honor.id,
    expectedRevision: submitted.revision,
    decision: 'approve',
    note: '',
  }, body => assert.equal(body.code, 'FORBIDDEN'));
  const withdrawnHonor = data(await ok(owner.token, 'lab_honor_withdraw', {
    requestId: randomUUID(),
    id: honor.id,
    expectedRevision: submitted.revision,
  }));
  assert.equal(withdrawnHonor.status, 'draft');
  const resubmitted = data(await ok(owner.token, 'lab_honor_submit', {
    requestId: randomUUID(),
    id: honor.id,
    expectedRevision: withdrawnHonor.revision,
  }));
  const approvedHonor = data(await ok(owner.token, 'lab_honor_review', {
    requestId: randomUUID(),
    id: honor.id,
    expectedRevision: resubmitted.revision,
    decision: 'approve',
    note: '虚构审核通过',
  }));
  assert.equal(approvedHonor.status, 'approved');
  const visible = data(await ok(member.token, 'lab_honors_list', {status: 'approved'}));
  assert.ok(visible.items.some(item => item.id === honor.id));

  const ownerCsrf = await csrf(owner.cookie);
  const settings = await h.call('/api/recruitment-admin/settings', {headers: {Cookie: owner.cookie}});
  assert.equal(settings.status, 200, settings.text);
  const savedSettings = await h.call('/api/recruitment-admin/settings', {
    data: {
      requestId: randomUUID(),
      revision: settings.body.revision,
      mailboxes: settings.body.mailboxes,
      sender: settings.body.sender,
      recipient: settings.body.recipient,
      feishu: {appToken: 'FictionalAppToken2026', tableId: 'tblFictional2026'},
    },
    headers: {Cookie: owner.cookie, 'X-CSRF-Token': ownerCsrf},
  });
  assert.equal(savedSettings.status, 200, savedSettings.text);
  assert.equal(savedSettings.body.mode, 'dry-run');
  const candidate = await h.call('/api/recruitment-admin/candidates', {
    data: {
      requestId: randomUUID(),
      name: '虚构候选人',
      group: '前端组',
      email: 'candidate@example.test',
      summary: '虚构投递资料',
    },
    headers: {Cookie: owner.cookie, 'X-CSRF-Token': ownerCsrf},
  });
  assert.equal(candidate.status, 201, candidate.text);
  const resumeForm = new FormData();
  resumeForm.set('requestId', randomUUID());
  resumeForm.set('revision', String(candidate.body.revision));
  resumeForm.set('resume', new Blob([fictionalPdf()], {type: 'application/pdf'}), 'fictional-resume.pdf');
  const encodedForm = new Response(resumeForm);
  const resumeUpload = await h.call('/api/recruitment-admin/candidates/' + candidate.body.id + '/resume', {
    raw: Buffer.from(await encodedForm.arrayBuffer()),
    headers: {Cookie: owner.cookie, 'X-CSRF-Token': ownerCsrf, 'Content-Type': encodedForm.headers.get('content-type')},
  });
  assert.equal(resumeUpload.status, 200, resumeUpload.text);
  candidate.body = resumeUpload.body;
  const resumeDetail = data(await ok(owner.token, 'lab_candidate_get', {id: candidate.body.id}));
  assert.match(resumeDetail.resume.reference, /^lab110:\/\/resume\//);
  const resumeRead = data(await ok(owner.token, 'lab_attachment_read', {reference: resumeDetail.resume.reference}));
  assert.equal(resumeRead.bytes, fictionalPdf().length);
  assert.equal(resumeRead.extraction.status, 'EXTRACTED');
  assert.match(resumeRead.extraction.segments[0].text, /Fictional resume/);
  await failTool(member.token, 'lab_attachment_read', {reference: resumeDetail.resume.reference}, body => assert.equal(body.code, 'FORBIDDEN'));
  const template = data(await ok(owner.token, 'lab_recruitment_template_save', {
    requestId: randomUUID(),
    template: {
      id: randomUUID(),
      revision: 0,
      name: '虚构面试邀请',
      subject: '[测试] {{name}}-{{group}}',
      body: '{{name}} 请参加 {{group}} 面试。时间 {{interviewTime}}。地点 {{location}}。面试官 {{interviewerName}}。联系 {{interviewerContact}}。',
      variables: [],
    },
  }));
  assert.equal(template.revision, 1);
  const options = data(await ok(owner.token, 'lab_recruitment_options', {templateId: template.id}));
  assert.equal(options.mode, 'dry-run');
  assert.equal(options.settings.feishu.tableId, 'tblFictional2026');
  assert.equal(options.templates[0].name, '虚构面试邀请');
  // Table-based recruitment tools are retired; old grants cannot expose them.
  assert.ok(!BUSINESS_TOOLS.some(t=>/recruitment_feishu/.test(t.name)));

  let applicant = data(await ok(owner.token, 'lab_candidate_get', {id: candidate.body.id}));
  applicant = data(await ok(owner.token, 'lab_candidate_record', {
    requestId: randomUUID(),
    id: applicant.id,
    expectedRevision: applicant.revision,
    record: {action: 'screen', assessmentRequired: true, note: '虚构初筛通过'},
  }));
  assert.equal(applicant.stage, 'assessment');
  applicant = data(await ok(owner.token, 'lab_candidate_record', {
    requestId: randomUUID(),
    id: applicant.id,
    expectedRevision: applicant.revision,
    record: {action: 'assessment', score: 86, note: '虚构考核记录'},
  }));
  assert.equal(applicant.stage, 'interview');
  const interviewAt = new Date(Date.now() + 2 * 86400000).toISOString();
  applicant = data(await ok(owner.token, 'lab_candidate_record', {
    requestId: randomUUID(),
    id: applicant.id,
    expectedRevision: applicant.revision,
    record: {
      action: 'schedule',
      at: interviewAt,
      interviewer: '虚构面试官',
      email: 'interviewer@example.test',
      contact: '虚构联系方式',
      location: '虚构会议室',
    },
  }));
  assert.equal(applicant.interview.location, '虚构会议室');
  const notice = data(await ok(owner.token, 'lab_recruitment_notice_preview', {
    requestId: randomUUID(),
    id: applicant.id,
    expectedRevision: applicant.revision,
    templateId: template.id,
    templateRevision: template.revision,
    values: {},
  }));
  assert.match(notice.preview.payload.body, /虚构候选人/);
  assert.equal(notice.preview.payload.replyTo, 'interviewer@example.test');
  await failTool(owner.token, 'lab_recruitment_notice_send', {
    requestId: randomUUID(),
    previewId: notice.id,
  }, body => assert.equal(body.code, 'CONFIRMATION_REQUIRED'));
  await confirm(notice);
  const noticeQueued = data(await ok(owner.token, 'lab_recruitment_notice_send', {
    requestId: randomUUID(),
    previewId: notice.id,
  }));
  assert.equal(noticeQueued.mailStatus, 'NOT_SENT');
  const noticeDone = await pollSimulated(noticeQueued.operationId, 'status');
  assert.equal(noticeDone.status, 'SIMULATED');
  assert.equal(noticeDone.mode, 'dry-run');
  applicant = data(await ok(owner.token, 'lab_candidate_get', {id: applicant.id}));
  assert.equal(applicant.notification.status, 'simulated');
  applicant = data(await ok(owner.token, 'lab_candidate_record', {
    requestId: randomUUID(),
    id: applicant.id,
    expectedRevision: applicant.revision,
    record: {action: 'interview', score: 91, note: '虚构面试记录'},
  }));
  assert.equal(applicant.stage, 'decision');
  const decided = data(await ok(owner.token, 'lab_candidate_decide', {
    requestId: randomUUID(),
    id: applicant.id,
    expectedRevision: applicant.revision,
    decision: 'accept',
    note: '虚构录取决定',
  }));
  assert.equal(decided.stage, 'accepted');
  const candidates = data(await ok(owner.token, 'lab_candidates_list', {stage: 'accepted', group: '前端组'}));
  assert.ok(candidates.items.some(item => item.id === decided.id && item.name === '虚构候选人'));

  const boxes = data(await ok(owner.token, 'lab_mailboxes_list'));
  assert.equal(boxes.mode, 'dry-run');
  assert.equal(boxes.items[0].address, 'noreply@110-lab.cn');
  assert.equal(boxes.items[0].canSend, true);
  const messages = data(await ok(owner.token, 'lab_mail_messages_list', {mailbox: 'noreply@110-lab.cn'}));
  assert.equal(messages.items[0].messageId, 'original@example.test');
  const message = data(await ok(owner.token, 'lab_mail_message_get', {
    mailbox: 'noreply@110-lab.cn',
    messageId: 'original@example.test',
  }));
  assert.equal(message.untrustedContent, true);
  assert.match(message.attachments[0].reference, /^lab110:\/\/mail\//);
  const mailFile = await ok(owner.token, 'lab_attachment_read', {reference: message.attachments[0].reference});
  assert.equal(data(mailFile).extraction.status, 'EXTRACTED');
  assert.match(data(mailFile).extraction.segments[0].text, /虚构邮件附件/);
  const uploadedMail = data(await ok(owner.token, 'lab_file_upload', {
    requestId: randomUUID(),
    purpose: 'mail_attachment',
    filename: '附件.txt',
    contentBase64: Buffer.from(mailAttachmentText).toString('base64'),
  }));
  const draftArgs = {
    requestId: randomUUID(),
    fields: {
      mailbox: 'noreply@110-lab.cn',
      to: ['candidate@example.test'],
      subject: '回复虚构邮件',
      body: '虚构回复正文',
      attachments: [uploadedMail.artifactId],
      replyMessageId: 'original@example.test',
    },
  };
  const draft = data(await ok(owner.token, 'lab_mail_draft_save', draftArgs));
  const draftRetry = data(await ok(owner.token, 'lab_mail_draft_save', draftArgs));
  assert.equal(draftRetry.id, draft.id);
  assert.equal(draft.kind, 'mail.send');
  assert.equal(draft.preview.fields.body, '虚构回复正文');
  await failTool(owner.token, 'lab_mail_send', {
    requestId: randomUUID(),
    previewId: draft.id,
  }, body => assert.equal(body.code, 'CONFIRMATION_REQUIRED'));
  await confirm(draft);
  const mailQueued = data(await ok(owner.token, 'lab_mail_send', {
    requestId: randomUUID(),
    previewId: draft.id,
  }));
  assert.equal(mailQueued.mailStatus, 'NOT_SENT');
  const mailDone = await pollSimulated(mailQueued.operationId, 'state');
  assert.equal(mailDone.state, 'SIMULATED');
  assert.match(mailDone.result.message, /模拟发送/);
  const mailReplay = data(await ok(owner.token, 'lab_mail_send', {
    requestId: randomUUID(),
    previewId: draft.id,
  }));
  assert.equal(mailReplay.operationId, mailQueued.operationId);
  assert.equal(h.traffic.sends, 0);

  const draftRequest = {requestId: randomUUID(), content: article};
  const news = data(await ok(owner.token, 'lab_update_draft_save', draftRequest));
  const newsRetry = data(await ok(owner.token, 'lab_update_draft_save', draftRequest));
  assert.equal(newsRetry.id, news.id);
  assert.equal(news.published, null);
  const newsList = data(await ok(owner.token, 'lab_updates_list', {status: 'draft'}));
  assert.ok(newsList.items.some(item => item.id === news.id && item.title === article.title));
  const newsDetail = data(await ok(owner.token, 'lab_update_get', {id: news.id}));
  assert.equal(newsDetail.draft.title, article.title);
  const publishPreview = data(await ok(owner.token, 'lab_update_publication_preview', {
    requestId: randomUUID(),
    id: news.id,
    expectedRevision: news.revision,
    action: 'publish',
  }));
  await failTool(owner.token, 'lab_update_publish', {
    requestId: randomUUID(),
    previewId: publishPreview.id,
  }, body => assert.equal(body.code, 'CONFIRMATION_REQUIRED'));
  const edited = data(await ok(owner.token, 'lab_update_draft_save', {
    requestId: randomUUID(),
    id: news.id,
    expectedRevision: news.revision,
    content: {...article, title: '仅测试的动态修订'},
  }));
  const staleConfirm = await h.call('/api/business/confirmations/' + publishPreview.id, {
    data: {fingerprint: publishPreview.fingerprint},
    headers: {Cookie: owner.cookie, 'X-CSRF-Token': await csrf(owner.cookie)},
  });
  assert.equal(staleConfirm.status, 409, staleConfirm.text);
  assert.equal(staleConfirm.body.code, 'REVISION_CONFLICT');
  const freshPreview = data(await ok(owner.token, 'lab_update_publication_preview', {
    requestId: randomUUID(),
    id: news.id,
    expectedRevision: edited.revision,
    action: 'publish',
  }));
  await confirm(freshPreview);
  const published = data(await ok(owner.token, 'lab_update_publish', {
    requestId: randomUUID(),
    previewId: freshPreview.id,
  }));
  assert.equal(published.published.title, '仅测试的动态修订');
  const publishedAgain = data(await ok(owner.token, 'lab_update_publish', {
    requestId: randomUUID(),
    previewId: freshPreview.id,
  }));
  assert.equal(publishedAgain.revision, published.revision);
  const publicPage = await h.call('/api/updates');
  assert.equal(publicPage.body.updates.length, 1);
  assert.equal(publicPage.body.updates[0].title, '仅测试的动态修订');
  const changedDraft = data(await ok(owner.token, 'lab_update_draft_save', {
    requestId: randomUUID(),
    id: news.id,
    expectedRevision: published.revision,
    content: {...article, title: '未发布的新草稿'},
  }));
  const stillPublic = await h.call('/api/updates');
  assert.equal(stillPublic.body.updates[0].title, '仅测试的动态修订');
  const withdrawPreview = data(await ok(owner.token, 'lab_update_publication_preview', {
    requestId: randomUUID(),
    id: news.id,
    expectedRevision: changedDraft.revision,
    action: 'withdraw',
  }));
  await confirm(withdrawPreview);
  const withdrawn = data(await ok(owner.token, 'lab_update_withdraw', {
    requestId: randomUUID(),
    previewId: withdrawPreview.id,
  }));
  assert.equal(withdrawn.published, null);
  const withdrawnAgain = data(await ok(owner.token, 'lab_update_withdraw', {
    requestId: randomUUID(),
    previewId: withdrawPreview.id,
  }));
  assert.equal(withdrawnAgain.revision, withdrawn.revision);
  assert.equal((await h.call('/api/updates')).body.updates.length, 0);

  assert.equal(definedTools.length, 37);
  const missing = definedTools.filter(name => !succeeded.has(name)).sort();
  const unexpected = [...succeeded].filter(name => !definedTools.includes(name)).sort();
  assert.deepEqual(unexpected, []);
  assert.deepEqual(missing, [], 'tools without a successful tools/call: ' + missing.join(', '));
  assert.equal(succeeded.size, 37);
  assert.equal(h.traffic.sends, 0);
  assert.deepEqual(h.traffic.blocked, []);
});
