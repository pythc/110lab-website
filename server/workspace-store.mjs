// Workspace project store for the 110lab portal.
//
// Public API:
//   openWorkspaceStore({directory, now=Date.now}) -> store methods
//   WorkspaceError(status, message)
//
// All public methods require a trusted `actor` object supplied by the HTTP
// layer. The store never trusts a role baked into stored data: the actor's
// role is always what the live role store (upstream) said at request time.

import {DatabaseSync} from 'node:sqlite';
import {
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  chmodSync,
} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

// ---------- Error type ----------

export class WorkspaceError extends Error {
  constructor(status, message) {
    super(typeof message === 'string' ? message : 'invalid_request');
    this.name = 'WorkspaceError';
    this.status =
      Number.isInteger(status) && status >= 400 && status <= 599 ? status : 400;
  }
}

const E = (status, msg) => {
  throw new WorkspaceError(status, msg);
};

// ---------- Constants / limits ----------

const MAX_PROJECTS_GLOBAL = 1000;
const MAX_PROJECTS_PER_OWNER = 100;
const MAX_MEMBERS = 50;
const MAX_MILESTONES_PER_PROJECT = 100;
const MAX_AUDIT_RETURN = 100;

const PHASES = ['exploring', 'pending', 'active', 'needs_changes'];
const ROLES = new Set(['member', 'admin', 'super_admin']);

// ---------- Validators ----------

// Narrow printable ASCII subject format: alnum, dash, dot, underscore, at,
// colon, plus. Bounded. We do not re-authenticate; we just enforce syntax so
// stray payloads cannot smuggle control characters into stored audit rows.
const SUBJECT_RE = /^[A-Za-z0-9._+:@-]+$/;
const subjectSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => SUBJECT_RE.test(v), {message: 'invalid_subject'});

// Reasonably strict email: single @, no whitespace, no controls, bounded.
const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .refine(
    (v) =>
      /^[^\s@<>"'`\\]+@[^\s@<>"'`\\]+\.[^\s@<>"'`\\]+$/.test(v) &&
      !/[\u0000-\u001f\u007f]/.test(v),
    {message: 'invalid_email'},
  );

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), {message: 'invalid_name'});

const projectNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), {message: 'invalid_name'});

const summarySchema = z
  .string()
  .trim()
  .min(1)
  .max(800)
  .refine((v) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v), {
    message: 'invalid_summary',
  });

const applicationSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((v) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v), {
    message: 'invalid_application',
  });

const reviewNoteSchema = z
  .string()
  .max(1000)
  .refine((v) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v), {
    message: 'invalid_note',
  });

const milestoneTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), {message: 'invalid_title'});

const revisionSchema = z.number().int().min(1).max(2 ** 31 - 1);

// repository: '' or exactly GitHub owner/repo (optional .git)
const GH_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}(?:\.git)?$/;

const repositorySchema = z
  .string()
  .max(2000)
  .refine((v) => v === '' || (GH_RE.test(v) && !['.','..'].includes(v.split('/').at(-1))), {message: 'invalid_repository'});

function isSafeHttpsUrl(v) {
  if (typeof v !== 'string' || v === '') return true;
  if (v.length > 2000) return false;
  if (/[\u0000-\u001f\u007f\s]/.test(v)) return false;
  let u;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (!u.hostname || u.hostname.length > 253) return false;
  return true;
}

const safeUrlSchema = z
  .string()
  .max(2000)
  .refine((v) => v === '' || isSafeHttpsUrl(v), {message: 'invalid_url'});

const linksSchema = z
  .object({
    repository: repositorySchema,
    requirements: safeUrlSchema,
    docs: safeUrlSchema,
    demo: safeUrlSchema,
  })
  .strict();

const memberSchema = z
  .object({
    subject: subjectSchema,
    name: nameSchema,
    email: emailSchema,
  })
  .strict();

const membersSchema = z
  .array(memberSchema)
  .max(MAX_MEMBERS)
  .refine(
    (list) => {
      const seen = new Set();
      for (const m of list) {
        if (seen.has(m.subject)) return false;
        seen.add(m.subject);
      }
      return true;
    },
    {message: 'duplicate_member'},
  );

const createInputSchema = z
  .object({
    name: projectNameSchema,
    summary: summarySchema,
    members: membersSchema,
    links: linksSchema,
  })
  .strict();

const updateInputSchema = z
  .object({
    revision: revisionSchema,
    name: projectNameSchema,
    summary: summarySchema,
    members: membersSchema,
    links: linksSchema,
  })
  .strict();

const applyInputSchema = z
  .object({
    revision: revisionSchema,
    application: applicationSchema,
  })
  .strict();

const reviewInputSchema = z
  .object({
    revision: revisionSchema,
    decision: z.enum(['approve', 'return']),
    note: reviewNoteSchema,
  })
  .strict();

const archiveInputSchema = z
  .object({
    revision: revisionSchema,
    archived: z.boolean(),
  })
  .strict();

function parseIsoDateBounded(value) {
  if (value === null) return null;
  if (typeof value !== 'string') E(400, 'invalid_due');
  if (value.length < 10 || value.length > 40) E(400, 'invalid_due');
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z)?$/.test(value))
    E(400, 'invalid_due');
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) E(400, 'invalid_due');
  // Date parsing otherwise silently normalizes invalid dates (e.g. February 30).
  const canonical = d.toISOString();
  if (canonical.slice(0,10) !== value.slice(0,10)) E(400, 'invalid_due');
  const year = d.getUTCFullYear();
  if (year < 2000 || year > 2100) E(400, 'invalid_due');
  return d.toISOString();
}

const addMilestoneInputSchema = z
  .object({
    title: milestoneTitleSchema,
    assignee: subjectSchema,
    dueAt: z.union([z.string(), z.null()]),
  })
  .strict();

const setMilestoneInputSchema = z
  .object({
    revision: revisionSchema,
    status: z.enum(['open', 'done']),
  })
  .strict();

// ---------- Actor helpers ----------

function requireActor(actor) {
  if (
    !actor ||
    typeof actor !== 'object' ||
    typeof actor.subject !== 'string' ||
    typeof actor.email !== 'string' ||
    typeof actor.name !== 'string' ||
    typeof actor.role !== 'string'
  ) {
    E(401, 'unauthenticated');
  }
  if (!SUBJECT_RE.test(actor.subject)) E(401, 'unauthenticated');
  if (!ROLES.has(actor.role)) E(403, 'forbidden');
  return actor;
}

function isAdmin(actor) {
  return actor.role === 'admin' || actor.role === 'super_admin';
}

// ---------- Filesystem helpers ----------

function ensurePrivateDirectory(directory) {
  try {
    mkdirSync(directory, {recursive: true, mode: 0o700});
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink())
    throw new WorkspaceError(500, 'insecure_directory');
  if ((dir.mode & 0o077) !== 0) {
    try {
      chmodSync(directory, 0o700);
    } catch {
      throw new WorkspaceError(500, 'insecure_directory');
    }
    const after = lstatSync(directory);
    if ((after.mode & 0o077) !== 0)
      throw new WorkspaceError(500, 'insecure_directory');
  }
}

function ensurePrivateFile(path) {
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const f = lstatSync(path);
  if (!f.isFile() || f.isSymbolicLink())
    throw new WorkspaceError(500, 'insecure_file');
  if ((f.mode & 0o077) !== 0) {
    chmodSync(path, 0o600);
    const after = lstatSync(path);
    if ((after.mode & 0o077) !== 0)
      throw new WorkspaceError(500, 'insecure_file');
  }
}

function tightenSidecars(path) {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = path + suffix;
    try {
      const stat = lstatSync(sidecar);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new WorkspaceError(500, 'insecure_file');
      if ((stat.mode & 0o077) !== 0) chmodSync(sidecar, 0o600);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}

// ---------- Public factory ----------

export function openWorkspaceStore({directory, now = Date.now}) {
  if (typeof directory !== 'string' || directory.length === 0)
    throw new WorkspaceError(500, 'invalid_directory');
  if (typeof now !== 'function')
    throw new WorkspaceError(500, 'invalid_clock');

  ensurePrivateDirectory(directory);
  const dbPath = join(directory, 'workspace.sqlite');
  ensurePrivateFile(dbPath);
  tightenSidecars(dbPath);

  const db = new DatabaseSync(dbPath);
  let closed = false;

  try {
    db.enableDefensive(true);
    db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;

      CREATE TABLE IF NOT EXISTS projects(
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        summary TEXT NOT NULL,
        owner_subject TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        owner_email TEXT NOT NULL,
        members_json TEXT NOT NULL,
        links_json TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('exploring','pending','active','needs_changes')),
        application TEXT NOT NULL DEFAULT '',
        review_note TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_subject);
      CREATE INDEX IF NOT EXISTS projects_phase_idx ON projects(phase);
      CREATE INDEX IF NOT EXISTS projects_updated_idx ON projects(updated_at);

      CREATE TABLE IF NOT EXISTS milestones(
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        assignee TEXT NOT NULL,
        due_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('open','done')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS milestones_project_idx ON milestones(project_id);
      CREATE INDEX IF NOT EXISTS milestones_assignee_idx ON milestones(assignee);

      CREATE TABLE IF NOT EXISTS audit(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_subject TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        at TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT ''
      ) STRICT;

      CREATE INDEX IF NOT EXISTS audit_project_idx ON audit(project_id, id DESC);
    `);
    // Make sure the file is still 0600 after WAL creation; same for sidecars.
    chmodSync(dbPath, 0o600);
    tightenSidecars(dbPath);
  } catch (error) {
    db.close();
    throw error;
  }

  // ---- prepared statements ----

  const insertProject = db.prepare(`
    INSERT INTO projects(id,name,summary,owner_subject,owner_name,owner_email,
      members_json,links_json,phase,application,review_note,archived,revision,
      created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const selectProject = db.prepare('SELECT * FROM projects WHERE id=?');
  const listProjectsStmt = db.prepare(
    'SELECT * FROM projects ORDER BY updated_at DESC, id ASC',
  );
  const countProjects = db.prepare('SELECT COUNT(*) AS c FROM projects');
  const countProjectsByOwner = db.prepare(
    'SELECT COUNT(*) AS c FROM projects WHERE owner_subject=?',
  );
  const updateProjectCAS = db.prepare(`
    UPDATE projects
       SET name=?,summary=?,members_json=?,links_json=?,phase=?,application=?,
           review_note=?,archived=?,revision=revision+1,updated_at=?
     WHERE id=? AND revision=?
  `);
  const insertAudit = db.prepare(
    'INSERT INTO audit(project_id,action,actor_subject,actor_name,at,note) VALUES(?,?,?,?,?,?)',
  );
  const latestAudit = db.prepare(
    'SELECT action,actor_name,at,note FROM audit WHERE project_id=? ORDER BY id DESC LIMIT ?',
  );
  const insertMilestone = db.prepare(`
    INSERT INTO milestones(id,project_id,title,assignee,due_at,status,revision,created_at,updated_at)
    VALUES(?,?,?,?,?,'open',1,?,?)
  `);
  const listMilestonesStmt = db.prepare(
    'SELECT * FROM milestones WHERE project_id=? ORDER BY created_at ASC, id ASC',
  );
  const countMilestonesStmt = db.prepare(
    'SELECT COUNT(*) AS c FROM milestones WHERE project_id=?',
  );
  const selectMilestone = db.prepare(
    'SELECT * FROM milestones WHERE id=? AND project_id=?',
  );
  const updateMilestoneCAS = db.prepare(`
    UPDATE milestones
       SET status=?,revision=revision+1,updated_at=?
     WHERE id=? AND project_id=? AND revision=?
  `);
  const openMilestonesByAssigneeInProject = db.prepare(
    "SELECT COUNT(*) AS c FROM milestones WHERE project_id=? AND assignee=? AND status='open'",
  );
  const todosForAssignee = db.prepare(`
    SELECT m.id AS mid, m.title AS title, m.due_at AS due_at, m.revision AS revision,
           m.status AS status, p.id AS project_id, p.name AS project_name, p.updated_at AS updated_at
      FROM milestones m
      JOIN projects p ON p.id=m.project_id
     WHERE m.assignee=? AND m.status='open' AND p.archived=0
     ORDER BY m.due_at IS NULL, m.due_at ASC, p.updated_at DESC, m.id ASC
  `);
  const pendingProjects = db.prepare(
    "SELECT * FROM projects WHERE phase='pending' AND archived=0 ORDER BY updated_at DESC, id ASC",
  );
  const ownedNeedsChanges = db.prepare(
    "SELECT * FROM projects WHERE owner_subject=? AND phase='needs_changes' AND archived=0 ORDER BY updated_at DESC, id ASC",
  );

  // ---- helpers ----

  function nowIso() {
    const t = now();
    if (!Number.isFinite(t)) E(500, 'clock_error');
    return new Date(t).toISOString();
  }

  function rowToProject(row, actor) {
    let members, links;
    try {
      members = JSON.parse(row.members_json);
      links = JSON.parse(row.links_json);
    } catch {
      throw new WorkspaceError(503, 'store_corrupt');
    }
    const milestoneRows = listMilestonesStmt.all(row.id);
    const milestones = milestoneRows.map((m) =>
      rowToMilestone(m, row, members, actor),
    );
    const archived = row.archived === 1;
    const admin = isAdmin(actor);
    const owner = row.owner_subject === actor.subject;
    const canEdit =
      !archived && (owner || admin) && row.phase !== 'pending';
    const canApply =
      !archived &&
      (owner || admin) &&
      (row.phase === 'exploring' || row.phase === 'needs_changes');
    const canReview = !archived && admin && row.phase === 'pending';
    return {
      id: row.id,
      name: row.name,
      summary: row.summary,
      ownerSubject: row.owner_subject,
      ownerName: row.owner_name,
      ownerEmail: row.owner_email,
      members,
      links,
      phase: row.phase,
      application: row.application,
      reviewNote: row.review_note,
      archived,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      milestones,
      canEdit,
      canApply,
      canReview,
    };
  }

  function rowToMilestone(row, projectRow, members, actor) {
    const owner = projectRow.owner_subject;
    let assigneeName = '';
    if (row.assignee === owner) assigneeName = projectRow.owner_name;
    else {
      const m = members.find((x) => x.subject === row.assignee);
      if (m) assigneeName = m.name;
    }
    const archived = projectRow.archived === 1;
    const admin = isAdmin(actor);
    const isOwner = projectRow.owner_subject === actor.subject;
    const isAssignee = row.assignee === actor.subject;
    const canChange = !archived && (isOwner || admin || isAssignee);
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      assignee: row.assignee,
      assigneeName,
      dueAt: row.due_at,
      status: row.status,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      canChange,
    };
  }

  function parse(schema, data) {
    const result = schema.safeParse(data);
    if (!result.success) E(400, 'invalid_input');
    return result.data;
  }

  function loadProjectOrFail(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))
      E(404, 'not_found');
    const row = selectProject.get(id);
    if (!row) E(404, 'not_found');
    return row;
  }

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  function wrapInternal(fn) {
    return function (...args) {
      if (closed) throw new WorkspaceError(503, 'closed');
      try {
        return fn.apply(this, args);
      } catch (e) {
        if (e instanceof WorkspaceError) throw e;
        // Internal SQL / unexpected failures become a generic 503 so the HTTP
        // layer never leaks raw driver errors. Zod errors already surfaced
        // via E(400,...).
        throw new WorkspaceError(503, 'store_unavailable');
      } finally {
        try {
          tightenSidecars(dbPath);
        } catch {
          /* ignore */
        }
      }
    };
  }

  // ---------- Methods ----------

  function list(actor) {
    requireActor(actor);
    const rows = listProjectsStmt.all();
    return {projects: rows.map((r) => rowToProject(r, actor))};
  }

  function get(actor, id) {
    requireActor(actor);
    const row = loadProjectOrFail(id);
    return rowToProject(row, actor);
  }

  function create(actor, input) {
    requireActor(actor);
    const data = parse(createInputSchema, input);
    // Owner forced from actor; cannot be present as a member.
    const members = data.members.filter((m) => m.subject !== actor.subject);
    if (members.length > MAX_MEMBERS) E(400, 'too_many_members');
    return tx(() => {
      const totalRow = countProjects.get();
      if (totalRow.c >= MAX_PROJECTS_GLOBAL) E(409, 'project_quota');
      const ownerRow = countProjectsByOwner.get(actor.subject);
      if (ownerRow.c >= MAX_PROJECTS_PER_OWNER) E(409, 'owner_quota');
      const id = randomUUID();
      const ts = nowIso();
      insertProject.run(
        id,
        data.name.trim(),
        data.summary,
        actor.subject,
        actor.name.trim(),
        actor.email.trim(),
        JSON.stringify(members),
        JSON.stringify(data.links),
        'exploring',
        '',
        '',
        0,
        1,
        ts,
        ts,
      );
      insertAudit.run(id, 'create', actor.subject, actor.name.trim(), ts, '');
      const row = selectProject.get(id);
      return rowToProject(row, actor);
    });
  }

  function update(actor, id, input) {
    requireActor(actor);
    const data = parse(updateInputSchema, input);
    return tx(() => {
      const row = loadProjectOrFail(id);
      if (row.archived === 1) E(409, 'archived');
      if (!(row.owner_subject === actor.subject || isAdmin(actor)))
        E(403, 'forbidden');
      if (row.phase === 'pending') E(409, 'pending_locked');
      if (row.revision !== data.revision) E(409, 'revision_conflict');

      // Owner cannot appear in members list and cannot be removed as owner.
      let members = data.members.filter(
        (m) => m.subject !== row.owner_subject,
      );
      // Removing an assigned member while they have open milestones is 409.
      const prevMembers = JSON.parse(row.members_json);
      const prevSet = new Set(prevMembers.map((m) => m.subject));
      const nextSet = new Set(members.map((m) => m.subject));
      for (const sub of prevSet) {
        if (!nextSet.has(sub)) {
          const openRow = openMilestonesByAssigneeInProject.get(id, sub);
          if (openRow.c > 0) E(409, 'member_has_open_milestones');
        }
      }
      const ts = nowIso();
      const result = updateProjectCAS.run(
        data.name.trim(),
        data.summary,
        JSON.stringify(members),
        JSON.stringify(data.links),
        row.phase,
        row.application,
        row.review_note,
        row.archived,
        ts,
        id,
        data.revision,
      );
      if (result.changes !== 1) E(409, 'revision_conflict');
      insertAudit.run(id, 'update', actor.subject, actor.name.trim(), ts, '');
      return rowToProject(selectProject.get(id), actor);
    });
  }

  function apply(actor, id, input) {
    requireActor(actor);
    const data = parse(applyInputSchema, input);
    return tx(() => {
      const row = loadProjectOrFail(id);
      if (row.archived === 1) E(409, 'archived');
      if (!(row.owner_subject === actor.subject || isAdmin(actor)))
        E(403, 'forbidden');
      if (!(row.phase === 'exploring' || row.phase === 'needs_changes'))
        E(409, 'invalid_phase');
      if (row.revision !== data.revision) E(409, 'revision_conflict');
      const ts = nowIso();
      const r = updateProjectCAS.run(
        row.name,
        row.summary,
        row.members_json,
        row.links_json,
        'pending',
        data.application,
        '',
        row.archived,
        ts,
        id,
        data.revision,
      );
      if (r.changes !== 1) E(409, 'revision_conflict');
      insertAudit.run(id, 'apply', actor.subject, actor.name.trim(), ts, '');
      return rowToProject(selectProject.get(id), actor);
    });
  }

  function review(actor, id, input) {
    requireActor(actor);
    const data = parse(reviewInputSchema, input);
    if (!isAdmin(actor)) E(403, 'forbidden');
    return tx(() => {
      const row = loadProjectOrFail(id);
      if (row.archived === 1) E(409, 'archived');
      if (row.phase !== 'pending') E(409, 'invalid_phase');
      if (row.revision !== data.revision) E(409, 'revision_conflict');
      let nextPhase, note;
      if (data.decision === 'approve') {
        nextPhase = 'active';
        note = data.note.trim();
      } else {
        if (data.note.trim().length === 0) E(400, 'invalid_note');
        nextPhase = 'needs_changes';
        note = data.note;
      }
      const ts = nowIso();
      const r = updateProjectCAS.run(
        row.name,
        row.summary,
        row.members_json,
        row.links_json,
        nextPhase,
        row.application,
        note,
        row.archived,
        ts,
        id,
        data.revision,
      );
      if (r.changes !== 1) E(409, 'revision_conflict');
      insertAudit.run(
        id,
        data.decision === 'approve' ? 'approve' : 'return',
        actor.subject,
        actor.name.trim(),
        ts,
        note,
      );
      return rowToProject(selectProject.get(id), actor);
    });
  }

  function archive(actor, id, input) {
    requireActor(actor);
    const data = parse(archiveInputSchema, input);
    return tx(() => {
      const row = loadProjectOrFail(id);
      if (!(row.owner_subject === actor.subject || isAdmin(actor)))
        E(403, 'forbidden');
      if (row.phase === 'pending') E(409, 'pending_locked');
      if (row.revision !== data.revision) E(409, 'revision_conflict');
      if ((row.archived === 1) === data.archived) E(409, 'no_change');
      const ts = nowIso();
      const r = updateProjectCAS.run(
        row.name,
        row.summary,
        row.members_json,
        row.links_json,
        row.phase, // preserve stage
        row.application,
        row.review_note,
        data.archived ? 1 : 0,
        ts,
        id,
        data.revision,
      );
      if (r.changes !== 1) E(409, 'revision_conflict');
      insertAudit.run(
        id,
        data.archived ? 'archive' : 'restore',
        actor.subject,
        actor.name.trim(),
        ts,
        '',
      );
      return rowToProject(selectProject.get(id), actor);
    });
  }

  function addMilestone(actor, projectId, input) {
    requireActor(actor);
    const data = parse(addMilestoneInputSchema, input);
    const dueAt = parseIsoDateBounded(data.dueAt);
    return tx(() => {
      const row = loadProjectOrFail(projectId);
      if (row.archived === 1) E(409, 'archived');
      if (!(row.owner_subject === actor.subject || isAdmin(actor)))
        E(403, 'forbidden');
      const members = JSON.parse(row.members_json);
      const assigneeInScope =
        data.assignee === row.owner_subject ||
        members.some((m) => m.subject === data.assignee);
      if (!assigneeInScope) E(400, 'assignee_out_of_scope');
      const c = countMilestonesStmt.get(projectId).c;
      if (c >= MAX_MILESTONES_PER_PROJECT) E(409, 'milestone_quota');
      const id = randomUUID();
      const ts = nowIso();
      insertMilestone.run(
        id,
        projectId,
        data.title.trim(),
        data.assignee,
        dueAt,
        ts,
        ts,
      );
      insertAudit.run(
        projectId,
        'milestone_add',
        actor.subject,
        actor.name.trim(),
        ts,
        data.title.trim(),
      );
      return rowToProject(selectProject.get(projectId), actor);
    });
  }

  function setMilestone(actor, projectId, milestoneId, input) {
    requireActor(actor);
    const data = parse(setMilestoneInputSchema, input);
    if (typeof milestoneId !== 'string' || !/^[0-9a-f-]{36}$/.test(milestoneId))
      E(404, 'not_found');
    return tx(() => {
      const row = loadProjectOrFail(projectId);
      if (row.archived === 1) E(409, 'archived');
      const mrow = selectMilestone.get(milestoneId, projectId);
      if (!mrow) E(404, 'not_found');
      const ownerOrAdmin =
        row.owner_subject === actor.subject || isAdmin(actor);
      const isAssignee = mrow.assignee === actor.subject;
      if (!(ownerOrAdmin || isAssignee)) E(403, 'forbidden');
      if (mrow.revision !== data.revision) E(409, 'revision_conflict');
      if (mrow.status === data.status) E(409, 'no_change');
      const ts = nowIso();
      const r = updateMilestoneCAS.run(
        data.status,
        ts,
        milestoneId,
        projectId,
        data.revision,
      );
      if (r.changes !== 1) E(409, 'revision_conflict');
      insertAudit.run(
        projectId,
        data.status === 'done' ? 'milestone_done' : 'milestone_reopen',
        actor.subject,
        actor.name.trim(),
        ts,
        mrow.title,
      );
      return rowToProject(selectProject.get(projectId), actor);
    });
  }

  function listTodos(actor) {
    requireActor(actor);
    const items = [];
    // Admin: all pending projects.
    if (isAdmin(actor)) {
      for (const row of pendingProjects.all()) {
        items.push({
          id: 'review:' + row.id,
          kind: 'project_review',
          title: row.name,
          projectId: row.id,
          projectName: row.name,
          dueAt: null,
          revision: row.revision,
          status: row.phase,
          action: 'project',
        });
      }
    }
    // Own needs_changes projects.
    for (const row of ownedNeedsChanges.all(actor.subject)) {
      items.push({
        id: 'revision:' + row.id,
        kind: 'project_revision',
        title: row.name,
        projectId: row.id,
        projectName: row.name,
        dueAt: null,
        revision: row.revision,
        status: row.phase,
        action: 'project',
      });
    }
    // Milestones assigned to actor and still open on non-archived projects.
    for (const r of todosForAssignee.all(actor.subject)) {
      items.push({
        id: 'milestone:' + r.mid,
        kind: 'milestone',
        title: r.title,
        projectId: r.project_id,
        projectName: r.project_name,
        dueAt: r.due_at,
        revision: r.revision,
        status: r.status,
        action: 'milestone',
        milestoneId: r.mid,
      });
    }
    return {items};
  }

  function audit(actor, id) {
    requireActor(actor);
    loadProjectOrFail(id); // visibility == project visibility == lab member.
    const rows = latestAudit.all(id, MAX_AUDIT_RETURN);
    return rows.map((r) => ({
      action: r.action,
      actorName: r.actor_name,
      at: r.at,
      note: r.note,
    }));
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      tightenSidecars(dbPath);
    } catch {
      /* ignore */
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }

  return {
    list: wrapInternal(list),
    get: wrapInternal(get),
    create: wrapInternal(create),
    update: wrapInternal(update),
    apply: wrapInternal(apply),
    review: wrapInternal(review),
    archive: wrapInternal(archive),
    addMilestone: wrapInternal(addMilestone),
    setMilestone: wrapInternal(setMilestone),
    listTodos: wrapInternal(listTodos),
    audit: wrapInternal(audit),
    close,
  };
}
