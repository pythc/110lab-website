import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve, sep } from 'node:path';

const CORPORATE_DOMAIN = '110-lab.cn';
const MAX_ADMINISTRATORS = 100;
const MAX_SUBJECT_LENGTH = 256;
const MAX_NAME_LENGTH = 80;
const MAX_EMAIL_LENGTH = 254;
const MAX_AUDIT_LIMIT = 100;
const DEFAULT_AUDIT_LIMIT = 50;
const BUSY_TIMEOUT_MS = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS identities (
  subject TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS administrators (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT UNIQUE,
  role TEXT NOT NULL,
  active INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (role = 'super_admin' AND active = 1 AND subject IS NOT NULL)
    OR (role = 'admin' AND active = 1 AND subject IS NOT NULL)
  )
) STRICT;

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_subject TEXT,
  actor_email TEXT,
  target_email TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS one_active_super
  ON administrators(role)
  WHERE role = 'super_admin' AND active = 1;
`;

/**
 * Structured store error. `status` is an HTTP-style code. `message` is a
 * static string and never includes SQL, paths, or caller secrets.
 */
export class MailAccessError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'MailAccessError';
    this.status = status;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, MailAccessError);
    }
  }
}

/**
 * Open a private mail-administrator role store.
 * The bootstrap owner is granted super administrator only when the database
 * is first created. Later opens never restore that grant.
 */
export function openMailAccessStore(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new MailAccessError(400, 'invalid store options');
  }
  const now = options.now === undefined ? Date.now : options.now;
  if (typeof now !== 'function') {
    throw new MailAccessError(400, 'invalid clock');
  }
  const owner = validateBootstrapOwner(options.bootstrapOwner);
  const path = prepareDatabaseLocation(options.filename);
  const snapshot = lstatSync(path);
  let db;
  try {
    db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
    db.enableDefensive(true);
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA secure_delete = ON');
    tightenSidecars(path);
    assertUnchangedRegularFile(path, snapshot);
    bootstrap(db, owner, now);
    tightenSidecars(path);
    assertUnchangedRegularFile(path, snapshot);
  } catch (err) {
    if (db) {
      try {
        db.close();
      } catch {
        // The original failure is the one callers need.
      }
    }
    throw asStoreError(err);
  }
  return createApi(db, path, now);
}

function createApi(db, path, now) {
  let closed = false;

  const identityBySubject = db.prepare(`
    SELECT subject, email, name
    FROM identities
    WHERE subject = ?
  `);
  const identityByEmail = db.prepare(`
    SELECT subject, email, name
    FROM identities
    WHERE email = ?
  `);
  const adminByEmail = db.prepare(`
    SELECT email, name, subject, role, active
    FROM administrators
    WHERE email = ?
  `);
  const profileBySubject = db.prepare(`
    SELECT i.subject AS subject, i.email AS email, i.name AS name,
           a.role AS role, a.active AS active
    FROM identities i
    LEFT JOIN administrators a ON a.subject = i.subject
    WHERE i.subject = ?
  `);
  const effectiveAdminBySubject = db.prepare(`
    SELECT i.subject AS subject, i.email AS email, i.name AS name, a.role AS role
    FROM identities i
    INNER JOIN administrators a
      ON a.subject = i.subject
     AND a.active = 1
     AND a.role IN ('admin', 'super_admin')
    WHERE i.subject = ?
  `);
  const superBySubject = db.prepare(`
    SELECT email, name, subject, role
    FROM administrators
    WHERE subject = ? AND role = 'super_admin' AND active = 1
  `);
  const listAdmins = db.prepare(`
    SELECT email, name, subject, role, active
    FROM administrators
    ORDER BY
      CASE
        WHEN role = 'super_admin' THEN 0
        WHEN active = 1 THEN 1
        ELSE 2
      END,
      email ASC
  `);
  const countAdmins = db.prepare(`SELECT COUNT(*) AS c FROM administrators`);
  const countSupers = db.prepare(`
    SELECT COUNT(*) AS c
    FROM administrators
    WHERE role = 'super_admin' AND active = 1
  `);
  const readRevisionStmt = db.prepare(`SELECT value FROM meta WHERE key = 'revision'`);
  const writeRevisionStmt = db.prepare(`
    UPDATE meta SET value = ? WHERE key = 'revision' AND value = ?
  `);
  const insertIdentity = db.prepare(`
    INSERT INTO identities (subject, email, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateIdentityName = db.prepare(`
    UPDATE identities SET name = ?, updated_at = ? WHERE subject = ?
  `);
  const updateAdminNameByEmail = db.prepare(`
    UPDATE administrators SET name = ?, updated_at = ? WHERE email = ?
  `);
  const insertAdmin = db.prepare(`
    INSERT INTO administrators (email, name, subject, role, active, created_at, updated_at)
    VALUES (?, ?, ?, 'admin', 1, ?, ?)
  `);
  const deleteOrdinaryAdmin = db.prepare(`
    DELETE FROM administrators
    WHERE email = ? AND role = 'admin'
  `);
  const demoteSuper = db.prepare(`
    UPDATE administrators
    SET role = 'admin', updated_at = ?
    WHERE subject = ? AND role = 'super_admin' AND active = 1
  `);
  const promoteAdmin = db.prepare(`
    UPDATE administrators
    SET role = 'super_admin', updated_at = ?
    WHERE email = ? AND role = 'admin' AND active = 1 AND subject IS NOT NULL
  `);
  const insertAudit = db.prepare(`
    INSERT INTO audit_log (at, action, actor_subject, actor_email, target_email)
    VALUES (?, ?, ?, ?, ?)
  `);
  const readAudit = db.prepare(`
    SELECT at, action, actor_subject, actor_email, target_email
    FROM audit_log
    ORDER BY id DESC
    LIMIT ?
  `);

  function ensureOpen() {
    if (closed) throw new MailAccessError(400, 'store closed');
  }

  function transaction(fn) {
    ensureOpen();
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      throw asStoreError(err);
    }
    try {
      const result = fn();
      db.exec('COMMIT');
      tightenSidecars(path);
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw asStoreError(err);
    }
  }

  function readTransaction(fn) {
    ensureOpen();
    try {
      db.exec('BEGIN');
    } catch (err) {
      throw asStoreError(err);
    }
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw asStoreError(err);
    }
  }

  function revision() {
    const row = readRevisionStmt.get();
    if (!row) throw new MailAccessError(500, 'store operation failed');
    const value = Number(row.value);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new MailAccessError(500, 'store operation failed');
    }
    return value;
  }

  function assertRevision(expected) {
    if (revision() !== expected) throw new MailAccessError(409, 'revision conflict');
  }

  function bumpRevision() {
    const current = revision();
    const next = current + 1;
    const result = writeRevisionStmt.run(String(next), String(current));
    if (result.changes !== 1) throw new MailAccessError(409, 'revision conflict');
    return next;
  }

  function assertOneSuper() {
    const row = countSupers.get();
    if (!row || row.c !== 1) throw new MailAccessError(500, 'store operation failed');
  }

  function requireSuper(subject) {
    const row = superBySubject.get(subject);
    if (!row) throw new MailAccessError(403, 'forbidden');
    return row;
  }

  function profileFrom(row) {
    if (!row) throw new MailAccessError(404, 'not found');
    let role = 'member';
    if (row.active === 1 && (row.role === 'admin' || row.role === 'super_admin')) {
      role = row.role;
    }
    return {
      subject: row.subject,
      email: row.email,
      name: row.name,
      role,
    };
  }

  function toAdmin(row) {
    return {
      email: row.email,
      name: row.name,
      subject: row.subject == null ? null : row.subject,
      role: row.role,
      active: row.active === 1,
    };
  }

  function auditEntry(row) {
    return {
      at: row.at,
      action: row.action,
      actorSubject: row.actor_subject == null ? null : row.actor_subject,
      actorEmail: row.actor_email == null ? null : row.actor_email,
      targetEmail: row.target_email == null ? null : row.target_email,
    };
  }

  function registerIdentity(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new MailAccessError(400, 'invalid identity');
    }
    const subject = validateSubject(input.subject);
    const email = canonicalizeEmail(input.email, { corporate: true });
    const name = validateName(input.name);
    const ts = readNow(now);
    return transaction(() => {
      const existing = identityBySubject.get(subject);
      if (existing) {
        if (existing.email !== email) throw new MailAccessError(409, 'email cannot be changed');
        const linked = adminByEmail.get(email);
        if (linked && linked.subject != null && linked.subject !== subject) {
          throw new MailAccessError(409, 'duplicate email');
        }
        updateIdentityName.run(name, ts, subject);
        updateAdminNameByEmail.run(name, ts, email);
        const profile = profileBySubject.get(subject);
        return profileFrom(profile);
      }

      const emailOwner = identityByEmail.get(email);
      if (emailOwner) throw new MailAccessError(409, 'duplicate email');
      const admin = adminByEmail.get(email);
      if (admin && admin.subject != null && admin.subject !== subject) {
        throw new MailAccessError(409, 'duplicate email');
      }

      insertIdentity.run(subject, email, name, ts, ts);
      return profileFrom(profileBySubject.get(subject));
    });
  }

  function me(subject) {
    const subjectValue = validateSubject(subject);
    ensureOpen();
    try {
      return profileFrom(profileBySubject.get(subjectValue));
    } catch (err) {
      throw asStoreError(err);
    }
  }

  function listAdministrators(subject) {
    const subjectValue = validateSubject(subject);
    return readTransaction(() => {
      requireSuper(subjectValue);
      return {
        revision: revision(),
        administrators: listAdmins.all().map(toAdmin),
      };
    });
  }

  function listMembers(subject) {
    const value = validateSubject(subject);
    return readTransaction(() => {
      requireSuper(value);
      return db.prepare('SELECT subject,email,name FROM identities ORDER BY email').all();
    });
  }

  function grantAdministrator(actorSubject, email, expectedRevision) {
    const actor = validateSubject(actorSubject);
    const emailValue = canonicalizeEmail(email, { corporate: true });
    const expected = validateRevision(expectedRevision);
    const ts = readNow(now);
    return transaction(() => {
      const superRow = requireSuper(actor);
      assertRevision(expected);
      const existing = adminByEmail.get(emailValue);
      if (existing) throw new MailAccessError(409, 'administrator already exists');
      const count = countAdmins.get();
      if (!count || count.c >= MAX_ADMINISTRATORS) {
        throw new MailAccessError(409, 'administrator limit reached');
      }
      const identity = identityByEmail.get(emailValue);
      if (!identity) throw new MailAccessError(409, 'member must log in first');
      const name = identity.name;
      insertAdmin.run(emailValue, name, identity.subject, ts, ts);
      insertAudit.run(ts, 'grant', superRow.subject, superRow.email, emailValue);
      const next = bumpRevision();
      assertOneSuper();
      return {
        revision: next,
        email: emailValue,
        name,
        subject: identity.subject,
        role: 'admin',
        active: true,
      };
    });
  }

  function revokeAdministrator(actorSubject, email, expectedRevision) {
    const actor = validateSubject(actorSubject);
    const emailValue = canonicalizeEmail(email, { corporate: true });
    const expected = validateRevision(expectedRevision);
    const ts = readNow(now);
    return transaction(() => {
      const superRow = requireSuper(actor);
      assertRevision(expected);
      const existing = adminByEmail.get(emailValue);
      if (!existing) throw new MailAccessError(404, 'administrator not found');
      if (existing.role === 'super_admin') {
        throw new MailAccessError(403, 'cannot revoke super administrator');
      }
      const removed = deleteOrdinaryAdmin.run(emailValue);
      if (removed.changes !== 1) throw new MailAccessError(409, 'conflict');
      insertAudit.run(ts, 'revoke', superRow.subject, superRow.email, emailValue);
      const next = bumpRevision();
      assertOneSuper();
      return { revision: next, email: emailValue, active: false };
    });
  }

  function transferSuperAdministrator(actorSubject, targetEmail, expectedRevision) {
    const actor = validateSubject(actorSubject);
    const emailValue = canonicalizeEmail(targetEmail, { corporate: true });
    const expected = validateRevision(expectedRevision);
    const ts = readNow(now);
    return transaction(() => {
      const superRow = requireSuper(actor);
      assertRevision(expected);
      const target = adminByEmail.get(emailValue);
      if (!target || target.role !== 'admin' || target.active !== 1 || target.subject == null) {
        throw new MailAccessError(409, 'target must be an active administrator');
      }
      if (target.subject === superRow.subject || target.email === superRow.email) {
        throw new MailAccessError(409, 'target must be an active administrator');
      }
      const demoted = demoteSuper.run(ts, superRow.subject);
      if (demoted.changes !== 1) throw new MailAccessError(409, 'conflict');
      const promoted = promoteAdmin.run(ts, emailValue);
      if (promoted.changes !== 1) throw new MailAccessError(409, 'conflict');
      assertOneSuper();
      insertAudit.run(ts, 'transfer', superRow.subject, superRow.email, emailValue);
      const next = bumpRevision();
      return {
        revision: next,
        previous: {
          subject: superRow.subject,
          email: superRow.email,
          role: 'admin',
        },
        superAdmin: {
          subject: target.subject,
          email: target.email,
          role: 'super_admin',
        },
      };
    });
  }

  function audit(subject, limit = DEFAULT_AUDIT_LIMIT) {
    const subjectValue = validateSubject(subject);
    const bounded = validateLimit(limit);
    return readTransaction(() => {
      requireSuper(subjectValue);
      return {
        entries: readAudit.all(bounded).map(auditEntry),
      };
    });
  }

  function assertAdministrator(subject) {
    const subjectValue = validateSubject(subject);
    ensureOpen();
    let row;
    try {
      row = effectiveAdminBySubject.get(subjectValue);
    } catch (err) {
      throw asStoreError(err);
    }
    if (!row) throw new MailAccessError(403, 'forbidden');
    return {
      subject: row.subject,
      email: row.email,
      name: row.name,
      role: row.role,
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    let failure;
    try {
      tightenSidecars(path);
    } catch (err) {
      failure = asStoreError(err);
    }
    try {
      db.close();
    } catch (err) {
      failure = failure ?? asStoreError(err);
    }
    if (failure) throw failure;
  }

  return {
    registerIdentity,
    me,
    listAdministrators,
    listMembers,
    grantAdministrator,
    revokeAdministrator,
    transferSuperAdministrator,
    audit,
    assertAdministrator,
    close,
  };
}

function bootstrap(db, owner, now) {
  try {
    db.exec(SCHEMA);
  } catch (err) {
    throw asStoreError(err);
  }
  const fp = fingerprint(owner);
  const existing = db.prepare(`SELECT value FROM meta WHERE key = 'bootstrap_fingerprint'`).get();
  if (existing) {
    if (existing.value !== fp) throw new MailAccessError(409, 'migration-required');
    const supers = db.prepare(`
      SELECT COUNT(*) AS c FROM administrators WHERE role = 'super_admin' AND active = 1
    `).get();
    if (!supers || supers.c !== 1) throw new MailAccessError(500, 'store operation failed');
    return;
  }
  const occupied = db.prepare(`SELECT COUNT(*) AS c FROM administrators`).get();
  if (occupied && occupied.c !== 0) throw new MailAccessError(409, 'migration-required');

  const ts = readNow(now);
  db.exec('BEGIN IMMEDIATE');
  try {
    const again = db.prepare(`SELECT value FROM meta WHERE key = 'bootstrap_fingerprint'`).get();
    if (again) {
      if (again.value !== fp) throw new MailAccessError(409, 'migration-required');
      db.exec('COMMIT');
      return;
    }
    db.prepare(`INSERT INTO meta (key, value) VALUES ('bootstrap_fingerprint', ?)`).run(fp);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('revision', '1')`).run();
    db.prepare(`
      INSERT INTO identities (subject, email, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(owner.subject, owner.email, owner.name, ts, ts);
    db.prepare(`
      INSERT INTO administrators (email, name, subject, role, active, created_at, updated_at)
      VALUES (?, ?, ?, 'super_admin', 1, ?, ?)
    `).run(owner.email, owner.name, owner.subject, ts, ts);
    db.prepare(`
      INSERT INTO audit_log (at, action, actor_subject, actor_email, target_email)
      VALUES (?, 'bootstrap', ?, ?, ?)
    `).run(ts, owner.subject, owner.email, owner.email);
    const supers = db.prepare(`
      SELECT COUNT(*) AS c FROM administrators WHERE role = 'super_admin' AND active = 1
    `).get();
    if (!supers || supers.c !== 1) throw new MailAccessError(500, 'store operation failed');
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    throw asStoreError(err);
  }
}

function validateBootstrapOwner(owner) {
  if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) {
    throw new MailAccessError(400, 'invalid bootstrap owner');
  }
  return {
    subject: validateSubject(owner.subject),
    email: canonicalizeEmail(owner.email, { corporate: true }),
    name: validateName(owner.name),
  };
}

function validateSubject(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_SUBJECT_LENGTH) {
    throw new MailAccessError(400, 'invalid subject');
  }
  if (Buffer.byteLength(value) > 2048 || hasDisallowedChars(value)) {
    throw new MailAccessError(400, 'invalid subject');
  }
  return value;
}

function validateName(value) {
  if (typeof value !== 'string') throw new MailAccessError(400, 'invalid name');
  const name = value.trim();
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
    throw new MailAccessError(400, 'invalid name');
  }
  if (Buffer.byteLength(name) > 800 || hasDisallowedChars(name)) {
    throw new MailAccessError(400, 'invalid name');
  }
  return name;
}

function canonicalizeEmail(value, { corporate }) {
  if (typeof value !== 'string' || value.length < 3 || value.length > MAX_EMAIL_LENGTH) {
    throw new MailAccessError(400, 'invalid email');
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) throw new MailAccessError(400, 'invalid email');
  }
  const email = value.toLowerCase();
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) throw new MailAccessError(400, 'invalid email');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!isLocalPart(local) || !isDomain(domain)) throw new MailAccessError(400, 'invalid email');
  if (corporate && domain !== CORPORATE_DOMAIN) {
    throw new MailAccessError(400, 'corporate email required');
  }
  return email;
}

function isLocalPart(local) {
  if (local.length < 1 || local.length > 64) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  return /^[a-z0-9._%+-]+$/.test(local);
}

function isDomain(domain) {
  if (domain.length < 1 || domain.length > 253) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/.test(tld)) return false;
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
    if (!/^[a-z0-9-]+$/.test(label)) return false;
  }
  return true;
}

function validateRevision(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new MailAccessError(400, 'invalid revision');
  }
  return value;
}

function validateLimit(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_AUDIT_LIMIT) {
    throw new MailAccessError(400, 'invalid limit');
  }
  return value;
}

function hasDisallowedChars(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
    if (code >= 0x80 && code <= 0x9f) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
    if (code === 0x2028 || code === 0x2029) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
  }
  return false;
}

function fingerprint(owner) {
  return createHash('sha256')
    .update('mail-access-store/bootstrap/v1\0', 'utf8')
    .update(owner.subject, 'utf8')
    .update('\0', 'utf8')
    .update(owner.email, 'utf8')
    .update('\0', 'utf8')
    .update(owner.name, 'utf8')
    .digest('hex');
}

function readNow(now) {
  let value;
  try {
    value = now();
  } catch (err) {
    if (err instanceof MailAccessError) throw err;
    throw new MailAccessError(500, 'invalid clock');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MailAccessError(500, 'invalid clock');
  }
  return Math.trunc(value);
}

function asStoreError(err) {
  if (err instanceof MailAccessError) return err;
  return new MailAccessError(500, 'store operation failed');
}

function prepareDatabaseLocation(filename) {
  if (typeof filename !== 'string' || filename.length < 1 || filename.length > 4096) {
    throw new MailAccessError(400, 'invalid database filename');
  }
  if (filename === ':memory:' || filename.includes('\0') || hasDisallowedChars(filename)) {
    throw new MailAccessError(400, 'invalid database filename');
  }
  const abs = resolve(filename);
  for (const segment of abs.split(sep)) {
    if (segment.toLowerCase() === 'release') {
      throw new MailAccessError(400, 'database path must be outside release');
    }
  }
  const dir = dirname(abs);
  const parent = dirname(dir);
  if (parent === dir) throw new MailAccessError(400, 'invalid database filename');

  let parentBefore;
  try {
    parentBefore = lstatSync(parent);
  } catch {
    throw new MailAccessError(400, 'database directory parent must exist');
  }
  if (parentBefore.isSymbolicLink()) {
    let followed;
    try {
      followed = statSync(parent);
    } catch {
      throw new MailAccessError(400, 'database directory parent must exist');
    }
    if (!followed.isDirectory()) throw new MailAccessError(400, 'database directory parent must exist');
  } else if (!parentBefore.isDirectory()) {
    throw new MailAccessError(400, 'database directory parent must exist');
  }

  ensurePrivateDirectory(dir);
  ensurePrivateDatabaseFile(abs);

  let parentAfter;
  try {
    parentAfter = lstatSync(parent);
  } catch {
    throw new MailAccessError(500, 'database directory parent permissions changed');
  }
  if (
    parentAfter.mode !== parentBefore.mode
    || parentAfter.ino !== parentBefore.ino
    || parentAfter.dev !== parentBefore.dev
  ) {
    throw new MailAccessError(500, 'database directory parent permissions changed');
  }
  return abs;
}

function ensurePrivateDirectory(dir) {
  let st = readLinkStat(dir, 'database directory unavailable');
  if (!st) {
    try {
      mkdirSync(dir, { recursive: false, mode: 0o700 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw new MailAccessError(400, 'database directory unavailable');
    }
    st = readLinkStat(dir, 'database directory unavailable');
    if (!st) throw new MailAccessError(400, 'database directory unavailable');
  }
  if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o1000) !== 0) {
    throw new MailAccessError(400, 'database directory must be a real directory');
  }
  if ((st.mode & 0o777) === 0o700) return;
  try {
    chmodSync(dir, 0o700);
  } catch {
    throw new MailAccessError(500, 'database directory permissions unavailable');
  }
  const after = readLinkStat(dir, 'database directory permissions unavailable');
  if (!after || after.isSymbolicLink() || !after.isDirectory() || (after.mode & 0o777) !== 0o700) {
    throw new MailAccessError(500, 'database directory permissions unavailable');
  }
}

function ensurePrivateDatabaseFile(abs) {
  const st = readLinkStat(abs, 'database file unavailable');
  if (!st) {
    createEmptyPrivateFile(abs);
    return;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new MailAccessError(400, 'database file must be a regular file');
  }
  let fd;
  try {
    fd = openSync(abs, constants.O_RDWR | constants.O_NOFOLLOW);
    assertEmptyOrDatabaseHeader(fd);
    const current = fstatSync(fd);
    if (!current.isFile()) throw new MailAccessError(400, 'database file must be a regular file');
    if ((current.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
  } catch (err) {
    if (err instanceof MailAccessError) throw err;
    if (err.code === 'ELOOP') throw new MailAccessError(400, 'database file must be a regular file');
    throw new MailAccessError(400, 'database file unavailable');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function createEmptyPrivateFile(abs) {
  let fd;
  try {
    fd = openSync(
      abs,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') {
      ensurePrivateDatabaseFile(abs);
      return;
    }
    if (err.code === 'ELOOP') throw new MailAccessError(400, 'database file must be a regular file');
    throw new MailAccessError(400, 'database file unavailable');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertEmptyOrDatabaseHeader(fd) {
  const current = fstatSync(fd);
  if (!current.isFile()) throw new MailAccessError(400, 'database file must be a regular file');
  if (current.size === 0) return;
  const header = Buffer.alloc(16);
  const bytes = readSync(fd, header, 0, 16, 0);
  if (bytes !== 16 || header.toString('utf8', 0, 15) !== 'SQLite format 3') {
    throw new MailAccessError(400, 'database file must be a regular file');
  }
}

function readLinkStat(path, message) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new MailAccessError(400, message);
  }
}

function tightenSidecars(abs) {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${abs}${suffix}`;
    let st;
    try {
      st = lstatSync(target);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw new MailAccessError(500, 'database file permissions unavailable');
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new MailAccessError(400, 'database file must be a regular file');
    }
    if ((st.mode & 0o777) === 0o600) continue;
    try {
      chmodSync(target, 0o600);
      const after = lstatSync(target);
      if (after.isSymbolicLink() || !after.isFile() || (after.mode & 0o777) !== 0o600) {
        throw new MailAccessError(500, 'database file permissions unavailable');
      }
    } catch (err) {
      if (err instanceof MailAccessError) throw err;
      throw new MailAccessError(500, 'database file permissions unavailable');
    }
  }
}

function assertUnchangedRegularFile(path, snapshot) {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new MailAccessError(400, 'database file must be a regular file');
  }
  if (st.ino !== snapshot.ino || st.dev !== snapshot.dev || (st.mode & 0o777) !== 0o600) {
    throw new MailAccessError(400, 'database file must be a regular file');
  }
}
