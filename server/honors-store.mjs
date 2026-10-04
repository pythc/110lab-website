import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync, chmodSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";

export class HonorsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HonorsError(status, message);
};
export const HONOR_LEVELS = [
  "国际级",
  "国家级",
  "省级",
  "市级",
  "校级",
  "院级",
  "实验室级",
  "其他",
];
const text = (max, min = 0) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(s));
const subject = text(200, 1).regex(/^[\w.:@+-]+$/);
const fields = z
  .object({
    name: text(160, 1),
    organizer: text(160, 1),
    level: z.enum(HONOR_LEVELS),
    levelNote: text(80),
    prize: text(80, 1),
    awardedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => {
        const d = new Date(s + "T00:00:00Z");
        return (
          Number.isFinite(d.getTime()) &&
          d.toISOString().slice(0, 10) === s &&
          s >= "2000-01-01" &&
          s <= "2100-12-31"
        );
      }),
    projectId: z.uuid().nullable(),
    projectName: text(80),
    members: z
      .array(z.object({ subject, name: text(120, 1) }).strict())
      .min(1)
      .max(50),
    description: text(3000),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.level === "其他" && !v.levelNote)
      c.addIssue({ code: "custom", message: "请填写级别说明" });
    if (new Set(v.members.map((m) => m.subject)).size !== v.members.length)
      c.addIssue({ code: "custom", message: "获奖成员重复" });
  });
const base = { requestId: z.uuid(), revision: z.number().int().positive() };
const hash = (v) => createHash("sha256").update(v).digest("hex");
const isAdmin = (a) => ["admin", "super_admin"].includes(a?.role);
const identity = (a) => {
  if (!a?.subject || !["member", "admin", "super_admin"].includes(a.role))
    fail(401, "请先通过飞书登录");
};
export function openHonorsStore({
  directory,
  now = Date.now,
  maxStoredBytes = 512 * 1024 * 1024,
} = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const st = lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink())
    throw new Error("Unsafe honors directory");
  chmodSync(directory, 0o700);
  const filename = join(directory, "honors.sqlite");
  try {
    closeSync(openSync(filename, "wx", 0o600));
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  if (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink())
    throw new Error("Unsafe honors database");
  chmodSync(filename, 0o600);
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS honors(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS certificates(id TEXT PRIMARY KEY,honor_id TEXT NOT NULL,metadata TEXT NOT NULL,content BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS revisions(honor_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(honor_id,revision));
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,honor_id TEXT NOT NULL,at TEXT NOT NULL,actor TEXT NOT NULL,actor_name TEXT NOT NULL,action TEXT NOT NULL,note TEXT NOT NULL,revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(actor TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor,id));`);
  const stamp = () => new Date(now()).toISOString();
  const raw = (id) => {
    const row = db.prepare("SELECT data FROM honors WHERE id=?").get(id);
    if (!row) fail(404, "荣誉记录不存在");
    return JSON.parse(row.data);
  };
  const canView = (a, r) =>
    isAdmin(a) || r.ownerSubject === a.subject || r.status === "approved";
  const canEdit = (a, r) => isAdmin(a) || r.ownerSubject === a.subject;
  const view = (a, r) => ({
    ...r,
    canEdit: canEdit(a, r) && !["pending", "archived"].includes(r.status),
    canSubmit: canEdit(a, r) && ["draft", "returned"].includes(r.status),
    canWithdraw: canEdit(a, r) && r.status === "pending",
    canReview: isAdmin(a) && r.status === "pending",
    canArchive: isAdmin(a) && r.status === "approved",
    canRestore: isAdmin(a) && r.status === "archived",
  });
  const get = (a, id) => {
    identity(a);
    const r = raw(id);
    if (!canView(a, r)) fail(404, "荣誉记录不存在");
    return view(a, r);
  };
  const write = (a, r, action, note = "") => {
    r.updatedAt = stamp();
    db.prepare("INSERT INTO revisions VALUES(?,?,?)").run(
      r.id,
      r.revision,
      JSON.stringify(r),
    );
    db.prepare(
      "INSERT INTO honors VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    ).run(r.id, JSON.stringify(r));
    db.prepare(
      "INSERT INTO audit(honor_id,at,actor,actor_name,action,note,revision) VALUES(?,?,?,?,?,?,?)",
    ).run(r.id, r.updatedAt, a.subject, a.name || "", action, note, r.revision);
    return view(a, r);
  };
  const transaction = (a, input, op, fn) => {
    identity(a);
    z.uuid().parse(input.requestId);
    const fingerprint = hash(JSON.stringify({ op, input }));
    db.exec("BEGIN IMMEDIATE");
    try {
      const prev = db
        .prepare(
          "SELECT fingerprint,result FROM requests WHERE actor=? AND id=?",
        )
        .get(a.subject, input.requestId);
      if (prev) {
        if (prev.fingerprint !== fingerprint)
          fail(409, "同一操作标识不能用于不同内容");
        db.exec("COMMIT");
        return JSON.parse(prev.result);
      }
      const result = fn();
      db.prepare("INSERT INTO requests VALUES(?,?,?,?)").run(
        a.subject,
        input.requestId,
        fingerprint,
        JSON.stringify(result),
      );
      db.exec("COMMIT");
      return result;
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    }
  };
  const revision = (r, n) => {
    if (r.revision !== n) fail(409, "记录已更新 请刷新后重试");
  };
  return {
    close: () => db.close(),
    get,
    list(a) {
      identity(a);
      const rows = db
        .prepare("SELECT data FROM honors")
        .all()
        .map((r) => JSON.parse(r.data))
        .filter((r) => canView(a, r))
        .map((r) => view(a, r))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { items: rows, levels: HONOR_LEVELS };
    },
    history(a, id) {
      get(a, id);
      return {
        events: db
          .prepare(
            "SELECT at,actor_name AS actorName,action,note,revision FROM audit WHERE honor_id=? ORDER BY id DESC",
          )
          .all(id),
      };
    },
    create(a, input) {
      identity(a);
      const parsed = z
        .object({ requestId: z.uuid(), fields })
        .strict()
        .parse(input);
      return transaction(a, parsed, "create", () => {
        if (!parsed.fields.members.some((m) => m.subject === a.subject))
          fail(400, "请在获奖成员中包含提交者本人");
        if (db.prepare("SELECT COUNT(*) n FROM honors").get().n >= 10000)
          fail(409, "荣誉记录已达上限 请联系管理员");
        if (
          db
            .prepare(
              "SELECT COUNT(*) n FROM honors WHERE json_extract(data,'$.ownerSubject')=?",
            )
            .get(a.subject).n >= 500
        )
          fail(409, "个人荣誉记录已达上限");
        const r = {
          ...parsed.fields,
          id: randomUUID(),
          ownerSubject: a.subject,
          ownerName: a.name || "",
          status: "draft",
          revision: 1,
          createdAt: stamp(),
          certificate: null,
          reviewNote: "",
        };
        return write(a, r, "create");
      });
    },
    update(a, id, input) {
      identity(a);
      if (!canEdit(a, raw(id))) fail(403, "仅提交者和管理员可修改");
      const parsed = z
        .object({ ...base, fields })
        .strict()
        .parse(input);
      return transaction(a, parsed, "update:" + id, () => {
        const r = raw(id);
        revision(r, parsed.revision);
        if (["pending", "archived"].includes(r.status))
          fail(409, "请先撤回审核 或联系管理员");
        if (!parsed.fields.members.some((m) => m.subject === r.ownerSubject))
          fail(400, "提交者须保留在获奖成员中");
        return write(
          a,
          {
            ...r,
            ...parsed.fields,
            status: "draft",
            reviewNote: "",
            revision: r.revision + 1,
          },
          "update",
        );
      });
    },
    action(a, id, input) {
      identity(a);
      const parsed = z
        .object({
          ...base,
          action: z.enum([
            "submit",
            "withdraw",
            "approve",
            "return",
            "archive",
            "restore",
          ]),
          note: text(2000).default(""),
        })
        .strict()
        .parse(input);
      const r = raw(id);
      if (
        ["approve", "return", "archive", "restore"].includes(parsed.action)
          ? !isAdmin(a)
          : !canEdit(a, r)
      )
        fail(403, "没有此操作的权限");
      return transaction(a, parsed, parsed.action + ":" + id, () => {
        const r = raw(id);
        revision(r, parsed.revision);
        const transitions = {
          submit: { draft: "pending", returned: "pending" },
          withdraw: { pending: "draft" },
          approve: { pending: "approved" },
          return: { pending: "returned" },
          archive: { approved: "archived" },
          restore: { archived: "draft" },
        };
        const next = transitions[parsed.action][r.status];
        if (!next) fail(409, "当前状态不能执行此操作");
        if (parsed.action === "return" && !parsed.note)
          fail(400, "退回时请填写原因");
        r.status = next;
        r.revision++;
        r.reviewNote = ["approve", "return", "archive", "restore"].includes(
          parsed.action,
        )
          ? parsed.note
          : "";
        return write(a, r, parsed.action, parsed.note);
      });
    },
    attach(a, id, input) {
      identity(a);
      if (!canEdit(a, raw(id))) fail(403, "没有修改证书的权限");
      const { buffer, ...v } = input;
      z.object({
        ...base,
        filename: text(180, 1),
        mime: z.enum(["application/pdf", "image/png", "image/jpeg"]),
        bytes: z
          .number()
          .int()
          .positive()
          .max(5 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
        .strict()
        .parse(v);
      if (
        !Buffer.isBuffer(buffer) ||
        buffer.length !== v.bytes ||
        hash(buffer) !== v.sha256
      )
        fail(400, "证书完整性校验失败");
      return transaction(a, v, "certificate:" + id, () => {
        const r = raw(id);
        revision(r, v.revision);
        if (["pending", "archived"].includes(r.status))
          fail(409, "请先撤回审核后再修改证书");
        const used = db
          .prepare(
            "SELECT COALESCE(SUM(length(content)),0) n FROM certificates",
          )
          .get().n;
        if (used + v.bytes > maxStoredBytes)
          fail(507, "证书存储空间不足 请联系管理员扩容");
        const certificate = {
          id: randomUUID(),
          filename: v.filename,
          mime: v.mime,
          bytes: v.bytes,
          sha256: v.sha256,
          createdAt: stamp(),
        };
        db.prepare("INSERT INTO certificates VALUES(?,?,?,?)").run(
          certificate.id,
          id,
          JSON.stringify(certificate),
          buffer,
        );
        r.certificate = certificate;
        r.status = "draft";
        r.reviewNote = "";
        r.revision++;
        return write(a, r, "certificate");
      });
    },
    certificate(a, id) {
      const r = get(a, id);
      if (!r.certificate) fail(404, "尚未上传证书");
      const f = db
        .prepare(
          "SELECT content,metadata FROM certificates WHERE id=? AND honor_id=?",
        )
        .get(r.certificate.id, id);
      if (!f) fail(404, "证书不存在");
      return { ...JSON.parse(f.metadata), buffer: Buffer.from(f.content) };
    },
    todos(a) {
      identity(a);
      return {
        items: db
          .prepare("SELECT data FROM honors")
          .all()
          .map((r) => JSON.parse(r.data))
          .filter(
            (r) =>
              (isAdmin(a) && r.status === "pending") ||
              (r.ownerSubject === a.subject && r.status === "returned"),
          )
          .map((r) => ({
            id: "honor:" + r.id,
            kind: "honor",
            title: r.name,
            projectName: r.projectName,
            status: r.status === "pending" ? "待审核" : "待修改",
            dueAt: null,
            honorId: r.id,
          })),
      };
    },
  };
}
