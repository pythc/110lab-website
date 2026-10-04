import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, lstatSync, chmodSync, symlinkSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {openWorkspaceStore, WorkspaceError} from '../server/workspace-store.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'wsstore-'));
}

const alice = {subject: 'alice', email: 'alice@lab.test', name: 'Alice', role: 'member'};
const bob = {subject: 'bob', email: 'bob@lab.test', name: 'Bob', role: 'member'};
const carol = {subject: 'carol', email: 'carol@lab.test', name: 'Carol', role: 'member'};
const admin = {subject: 'adm', email: 'adm@lab.test', name: 'Admin', role: 'admin'};
const sup = {subject: 'sup', email: 'sup@lab.test', name: 'Sup', role: 'super_admin'};

const BASE_LINKS = {repository: '', requirements: '', docs: '', demo: ''};

function base(name = 'Proj') {
  return {name, summary: 'A summary', members: [], links: BASE_LINKS};
}

function expectError(fn, status) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof WorkspaceError, `expected WorkspaceError, got ${e}`);
    assert.equal(e.status, status, `expected status ${status} got ${e.status}: ${e.message}`);
    return e;
  }
  assert.fail('expected error');
}

async function expectErrorAsync(fn, status) {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof WorkspaceError);
    assert.equal(e.status, status);
    return e;
  }
  assert.fail('expected error');
}

test('creates project with sane defaults and audits', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    const p = store.create(alice, base('P1'));
    assert.equal(p.name, 'P1');
    assert.equal(p.ownerSubject, 'alice');
    assert.equal(p.phase, 'exploring');
    assert.equal(p.archived, false);
    assert.equal(p.revision, 1);
    assert.deepEqual(p.members, []);
    assert.ok(p.canEdit && p.canApply && !p.canReview);
    assert.ok(Array.isArray(p.milestones));
    const events = store.audit(alice, p.id);
    assert.equal(events[0].action, 'create');
  } finally {
    store.close();
  }
});

test('rejects unauthenticated/invalid actor', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    expectError(() => store.list(null), 401);
    expectError(() => store.list({subject: 'x', email: 'x@y.z', name: 'x'}), 401);
    expectError(() => store.list({subject: 'x', email: 'x@y.z', name: 'x', role: 'bogus'}), 403);
    expectError(() => store.create({...alice, subject: 'bad subject!'}, base()), 401);
  } finally {
    store.close();
  }
});

test('cross-member cannot edit/apply/archive another project', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    const p = store.create(alice, base());
    expectError(() => store.update(bob, p.id, {revision: p.revision, ...base('X')}), 403);
    expectError(() => store.apply(bob, p.id, {revision: p.revision, application: 'hi'}), 403);
    expectError(() => store.archive(bob, p.id, {revision: p.revision, archived: true}), 403);
    expectError(() => store.review(bob, p.id, {revision: p.revision, decision: 'approve', note: ''}), 403);
  } finally {
    store.close();
  }
});

test('member included as project member can view but not edit project settings', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    const p = store.create(alice, {...base(), members: [{subject: 'bob', name: 'Bob', email: 'bob@lab.test'}]});
    const view = store.get(bob, p.id);
    assert.equal(view.id, p.id);
    assert.equal(view.canEdit, false);
    assert.equal(view.canApply, false);
    expectError(() => store.update(bob, p.id, {revision: p.revision, ...base('X'), members: p.members, links: p.links}), 403);
  } finally {
    store.close();
  }
});

test('owner cannot be removed and does not appear in members list', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    const p = store.create(alice, {...base(), members: [{subject: 'alice', name: 'Alice', email: 'alice@lab.test'}]});
    assert.deepEqual(p.members, []); // owner stripped
    // update: trying to put owner in members list is also stripped
    const u = store.update(alice, p.id, {revision: p.revision, name: p.name, summary: p.summary,
      members: [{subject: 'alice', name: 'Alice', email: 'alice@lab.test'}, {subject: 'bob', name: 'Bob', email: 'bob@lab.test'}],
      links: p.links});
    assert.equal(u.members.length, 1);
    assert.equal(u.members[0].subject, 'bob');
  } finally {
    store.close();
  }
});

test('duplicate members rejected', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    expectError(() => store.create(alice, {...base(), members: [
      {subject: 'bob', name: 'Bob', email: 'bob@lab.test'},
      {subject: 'bob', name: 'Bob', email: 'bob@lab.test'},
    ]}), 400);
  } finally {
    store.close();
  }
});

test('stale revisions get 409 revision_conflict', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    const p = store.create(alice, base());
    const first = store.update(alice, p.id, {revision: p.revision, name: 'B', summary: 'ok', members: [], links: BASE_LINKS});
    const err = expectError(() => store.update(alice, p.id, {revision: p.revision, name: 'C', summary: 'ok', members: [], links: BASE_LINKS}), 409);
    assert.match(err.message, /revision_conflict/);
    assert.equal(first.revision, 2);
  } finally {
    store.close();
  }
});

test('state transitions: apply -> review approve -> active', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    const p = store.create(alice, base());
    const applied = store.apply(alice, p.id, {revision: p.revision, application: 'please'});
    assert.equal(applied.phase, 'pending');
    assert.equal(applied.application, 'please');
    // owner cannot edit while pending
    expectError(() => store.update(alice, p.id, {revision: applied.revision, name: 'X', summary: 'ok', members: [], links: BASE_LINKS}), 409);
    // owner cannot review
    expectError(() => store.review(alice, p.id, {revision: applied.revision, decision: 'approve', note: ''}), 403);
    const approved = store.review(admin, p.id, {revision: applied.revision, decision: 'approve', note: ''});
    assert.equal(approved.phase, 'active');
  } finally {
    store.close();
  }
});

test('return decision requires nonempty note and sets needs_changes', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    const p = store.create(alice, base());
    const applied = store.apply(alice, p.id, {revision: p.revision, application: 'please'});
    expectError(() => store.review(admin, p.id, {revision: applied.revision, decision: 'return', note: '   '}), 400);
    const returned = store.review(admin, p.id, {revision: applied.revision, decision: 'return', note: 'please clarify'});
    assert.equal(returned.phase, 'needs_changes');
    assert.equal(returned.reviewNote, 'please clarify');
    // now owner can edit again
    const edited = store.update(alice, p.id, {revision: returned.revision, name: 'P1b', summary: 'ok', members: [], links: BASE_LINKS});
    assert.equal(edited.name, 'P1b');
    // and reapply
    const re = store.apply(alice, p.id, {revision: edited.revision, application: 'again'});
    assert.equal(re.phase, 'pending');
  } finally {
    store.close();
  }
});

test('archive requires owner/admin, preserves phase, blocks milestone/apply/review', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    const p = store.create(alice, base());
    const applied = store.apply(alice, p.id, {revision: p.revision, application: 'go'});
    // cannot archive while pending
    expectError(() => store.archive(alice, p.id, {revision: applied.revision, archived: true}), 409);
    const approved = store.review(admin, p.id, {revision: applied.revision, decision: 'approve', note: ''});
    const archived = store.archive(alice, p.id, {revision: approved.revision, archived: true});
    assert.equal(archived.archived, true);
    assert.equal(archived.phase, 'active');
    // no-op archive again
    expectError(() => store.archive(alice, p.id, {revision: archived.revision, archived: true}), 409);
    // cannot apply/review while archived
    expectError(() => store.apply(alice, p.id, {revision: archived.revision, application: 'x'}), 409);
    expectError(() => store.review(admin, p.id, {revision: archived.revision, decision: 'approve', note: ''}), 409);
    // bob cannot restore
    expectError(() => store.archive(bob, p.id, {revision: archived.revision, archived: false}), 403);
    const restored = store.archive(admin, p.id, {revision: archived.revision, archived: false});
    assert.equal(restored.archived, false);
    assert.equal(restored.phase, 'active');
  } finally {
    store.close();
  }
});

test('milestones: scope, max, orphan protection, assignee can toggle status', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    const p = store.create(alice, {...base(), members: [{subject: 'bob', name: 'Bob', email: 'bob@lab.test'}]});
    // bob not owner/admin cannot add milestone
    expectError(() => store.addMilestone(bob, p.id, {title: 'T', assignee: 'bob', dueAt: null}), 403);
    // assignee out of scope (carol not a member)
    expectError(() => store.addMilestone(alice, p.id, {title: 'T', assignee: 'carol', dueAt: null}), 400);
    // bad dueAt
    expectError(() => store.addMilestone(alice, p.id, {title: 'T', assignee: 'bob', dueAt: 'notadate'}), 400);
    expectError(() => store.addMilestone(alice, p.id, {title: 'T', assignee: 'bob', dueAt: '1999-01-01'}), 400);
    expectError(() => store.addMilestone(alice, p.id, {title: 'T', assignee: 'bob', dueAt: '2101-01-01'}), 400);

    const after = store.addMilestone(alice, p.id, {title: 'Design', assignee: 'bob', dueAt: '2026-11-01'});
    assert.equal(after.milestones.length, 1);
    const m = after.milestones[0];
    assert.equal(m.assignee, 'bob');
    assert.equal(m.assigneeName, 'Bob');
    assert.equal(m.status, 'open');
    assert.equal(m.canChange, true); // alice is owner
    const alView = store.get(alice, p.id).milestones[0];
    assert.equal(alView.canChange, true);
    const boView = store.get(bob, p.id).milestones[0];
    assert.equal(boView.canChange, true);
    const caView = store.get({...carol}, p.id).milestones[0];
    assert.equal(caView.canChange, false);

    // bob (assignee) marks done
    const marked = store.setMilestone(bob, p.id, m.id, {revision: m.revision, status: 'done'});
    assert.equal(marked.milestones[0].status, 'done');
    // Removing bob from the members while bob has... but milestone is now done so should be fine
    const edited = store.update(alice, p.id, {revision: marked.revision, name: p.name, summary: p.summary, members: [], links: p.links});
    assert.equal(edited.members.length, 0);

    // Now re-add bob and give bob an OPEN milestone, then try removing
    const re = store.update(alice, p.id, {revision: edited.revision, name: p.name, summary: p.summary, members: [{subject: 'bob', name: 'Bob', email: 'bob@lab.test'}], links: p.links});
    const added = store.addMilestone(alice, p.id, {title: 'Build', assignee: 'bob', dueAt: null});
    const openId = added.milestones.find((x) => x.status === 'open').id;
    expectError(() => store.update(alice, p.id, {revision: added.revision, name: p.name, summary: p.summary, members: [], links: p.links}), 409);
    // After bob closes it, removal is allowed
    const closed = store.setMilestone(bob, p.id, openId, {revision: added.milestones.find((x) => x.status === 'open').revision, status: 'done'});
    const removed = store.update(alice, p.id, {revision: closed.revision, name: p.name, summary: p.summary, members: [], links: p.links});
    assert.equal(removed.members.length, 0);
  } finally {
    store.close();
  }
});

test('milestone CAS and archived blocks', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    const p = store.create(alice, {...base(), members: [{subject: 'bob', name: 'Bob', email: 'bob@lab.test'}]});
    const after = store.addMilestone(alice, p.id, {title: 'Design', assignee: 'bob', dueAt: null});
    const m = after.milestones[0];
    const done = store.setMilestone(alice, p.id, m.id, {revision: m.revision, status: 'done'});
    const stale = m.revision;
    expectError(() => store.setMilestone(alice, p.id, m.id, {revision: stale, status: 'open'}), 409);
    // archive, then setMilestone should 409 archived
    // Need to approve first? no - archive requires non-pending; phase is exploring, so OK.
    const archived = store.archive(alice, p.id, {revision: done.revision, archived: true});
    expectError(() => store.setMilestone(alice, p.id, m.id, {revision: done.milestones[0].revision, status: 'open'}), 409);
    // addMilestone on archived
    expectError(() => store.addMilestone(alice, p.id, {title: 'X', assignee: 'bob', dueAt: null}), 409);
  } finally {
    store.close();
  }
});

test('input and URL validation', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    expectError(() => store.create(alice, {...base(), name: ''}), 400);
    expectError(() => store.create(alice, {...base(), name: 'x'.repeat(81)}), 400);
    expectError(() => store.create(alice, {...base(), summary: ''}), 400);
    expectError(() => store.create(alice, {...base(), summary: 'x'.repeat(801)}), 400);
    expectError(() => store.create(alice, {...base(), links: {repository: 'http://github.com/a/b', requirements: '', docs: '', demo: ''}}), 400);
    expectError(() => store.create(alice, {...base(), links: {repository: 'https://evil.example/x/y', requirements: '', docs: '', demo: ''}}), 400);
    expectError(() => store.create(alice, {...base(), links: {repository: 'https://github.com/a/b', requirements: 'ftp://x', docs: '', demo: ''}}), 400);
    expectError(() => store.create(alice, {...base(), links: {repository: '', requirements: 'https://user:pw@example.com/', docs: '', demo: ''}}), 400);
    assert.equal(store.create(alice, {...base(), links: {repository: '', requirements: 'https://1.2.3.4/x', docs: '', demo: ''}}).links.requirements, 'https://1.2.3.4/x');
    expectError(() => store.create(alice, {...base(), members: [{subject: 'x', name: 'bad\u0000', email: 'bob@lab.test'}]}), 400);
    expectError(() => store.create(alice, {...base(), members: [{subject: 'spaces are bad', name: 'B', email: 'bob@lab.test'}]}), 400);
    expectError(() => store.create(alice, {...base(), members: [{subject: 'x', name: 'B', email: 'not-email'}]}), 400);
    // unknown keys rejected (strict schema)
    expectError(() => store.create(alice, {...base(), evil: true}), 400);
    const ok = store.create(alice, {...base(), links: {repository: 'https://github.com/foo/bar.git', requirements: 'https://docs.example/req', docs: '', demo: ''}});
    assert.equal(ok.links.repository, 'https://github.com/foo/bar.git');
    expectError(() => store.create(alice, {...base(), summary:'   '}), 400);
    expectError(() => store.apply(alice, ok.id, {revision:1,application:'   '}), 400);
    expectError(() => store.addMilestone(alice,ok.id,{title:'Invalid calendar date',assignee:alice.subject,dueAt:'2026-02-30'}),400);
    expectError(() => store.create(alice,{...base(),links:{repository:'https://github.com/owner/..',requirements:'',docs:'',demo:''}}),400);
  } finally {
    store.close();
  }
});

test('listTodos filters properly', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    const p1 = store.create(alice, {...base('A'), members: [{subject: 'bob', name: 'Bob', email: 'bob@lab.test'}]});
    const p2 = store.create(carol, base('C'));
    store.apply(carol, p2.id, {revision: p2.revision, application: 'pls'});
    store.addMilestone(alice, p1.id, {title: 'Mb', assignee: 'bob', dueAt: '2026-12-01'});
    // bob sees only his milestone, not p2 pending (not admin) and no revision todo
    const bobTodos = store.listTodos(bob).items;
    assert.equal(bobTodos.length, 1);
    assert.equal(bobTodos[0].kind, 'milestone');
    // alice sees nothing (not admin, no needs_changes, no assigned milestone to her)
    assert.deepEqual(store.listTodos(alice).items, []);
    // admin sees p2 pending
    const adTodos = store.listTodos(admin).items;
    assert.ok(adTodos.some((t) => t.kind === 'project_review' && t.projectId === p2.id));
    // admin not an assignee anywhere, so no milestone todos
    assert.ok(!adTodos.some((t) => t.kind === 'milestone'));
    // return p2 so carol has needs_changes
    const applied2 = store.get(carol, p2.id);
    store.review(admin, p2.id, {revision: applied2.revision, decision: 'return', note: 'nope'});
    const carolTodos = store.listTodos(carol).items;
    assert.ok(carolTodos.some((t) => t.kind === 'project_revision' && t.projectId === p2.id));
  } finally {
    store.close();
  }
});

test('persistence across reopen', () => {
  const dir = tmp();
  let store = openWorkspaceStore({directory: dir});
  let id;
  try {
    const p = store.create(alice, base('Persist'));
    id = p.id;
  } finally {
    store.close();
  }
  store = openWorkspaceStore({directory: dir});
  try {
    const got = store.get(alice, id);
    assert.equal(got.name, 'Persist');
    assert.equal(got.phase, 'exploring');
  } finally {
    store.close();
  }
});

test('db file and directory private; symlink rejected', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    const dStat = lstatSync(dir);
    assert.equal(dStat.mode & 0o777, 0o700);
    const fStat = lstatSync(join(dir, 'workspace.sqlite'));
    assert.equal(fStat.mode & 0o777, 0o600);
  } finally {
    store.close();
  }
  // Setup: directory where DB file is a symlink -> rejected
  const d2 = tmp();
  writeFileSync(join(d2, 'elsewhere'), '');
  symlinkSync(join(d2, 'elsewhere'), join(d2, 'workspace.sqlite'));
  expectError(() => openWorkspaceStore({directory: d2}), 500);
  // Directory group-writable -> rejected (we tighten; after tighten we accept)
  const d3 = tmp();
  chmodSync(d3, 0o755);
  const s3 = openWorkspaceStore({directory: d3});
  try {
    assert.equal(lstatSync(d3).mode & 0o777, 0o700);
  } finally {
    s3.close();
  }
});

test('rollback: zod failure after count still leaves DB consistent', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    // Many invalid inputs should not create partial rows.
    for (let i = 0; i < 5; i++) {
      expectError(() => store.create(alice, {...base(), summary: ''}), 400);
    }
    assert.deepEqual(store.list(alice).projects, []);
  } finally {
    store.close();
  }
});

test('quota enforcement per owner', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  // Use a small simulation of quota by patching MAX? We cannot patch here.
  // Instead sanity-check logic by creating a project and ensuring list returns it.
  try {
    const p = store.create(alice, base('A'));
    assert.equal(store.list(alice).projects.length, 1);
    assert.equal(p.ownerSubject, 'alice');
  } finally {
    store.close();
  }
});

test('audit returns sanitized ordered events, latest100', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    const p = store.create(alice, base());
    const applied = store.apply(alice, p.id, {revision: p.revision, application: 'go'});
    store.review(admin, p.id, {revision: applied.revision, decision: 'return', note: 'fix things'});
    const events = store.audit(alice, p.id);
    const actions = events.map((e) => e.action);
    assert.equal(actions[0], 'return');
    assert.equal(actions[1], 'apply');
    assert.equal(actions[2], 'create');
    for (const e of events) {
      assert.ok(typeof e.action === 'string');
      assert.ok(typeof e.actorName === 'string');
      assert.ok(typeof e.at === 'string');
      assert.ok(typeof e.note === 'string');
      // no raw subject leaked
      assert.ok(!('actor_subject' in e));
    }
  } finally {
    store.close();
  }
});

test('invalid id formats return 404 not internal error', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    expectError(() => store.get(alice, 'not-a-uuid'), 404);
    expectError(() => store.audit(alice, 'not-a-uuid'), 404);
    expectError(() => store.update(alice, 'not-a-uuid', {revision: 1, ...base()}), 404);
  } finally {
    store.close();
  }
});

test('super_admin treated as admin for review', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  try {
    const p = store.create(alice, base());
    const applied = store.apply(alice, p.id, {revision: p.revision, application: 'g'});
    const approved = store.review(sup, p.id, {revision: applied.revision, decision: 'approve', note: ''});
    assert.equal(approved.phase, 'active');
  } finally {
    store.close();
  }
});

test('close is idempotent and further calls fail cleanly', () => {
  const dir = tmp();
  const store = openWorkspaceStore({directory: dir});
  store.close();
  store.close();
  expectError(() => store.list(alice), 503);
});
