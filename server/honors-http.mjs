import { join } from "node:path";
import { z } from "zod";
import { openHonorsStore, HonorsError } from "./honors-store.mjs";
import { readHonorCertificate } from "./honors-upload.mjs";
import { MailAuthError } from "./mail-auth.mjs";
import { MailAccessError } from "./mail-access-store.mjs";
const json = (res, status, value) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex",
  });
  res.end(JSON.stringify(value));
};
async function body(req) {
  if (
    String(req.headers["content-type"] || "").split(";")[0] !==
    "application/json"
  )
    throw new HonorsError(415, "请求格式无效");
  const chunks = [];
  let size = 0;
  await new Promise((resolve, reject) => {
    let done = false;
    const finish = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off("data", data);
      req.off("end", end);
      req.off("error", abort);
      req.off("aborted", abort);
      if (e) {
        req.resume();
        reject(e);
      } else resolve();
    };
    const data = (c) => {
      if ((size += c.length) > 32768) finish(new HonorsError(413, "内容过长"));
      else chunks.push(c);
    };
    const end = () => finish(),
      abort = () => finish(new HonorsError(400, "请求中断"));
    const timer = setTimeout(
      () => finish(new HonorsError(408, "请求超时")),
      8000,
    );
    timer.unref();
    req.on("data", data);
    req.once("end", end);
    req.once("error", abort);
    req.once("aborted", abort);
  });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HonorsError(400, "请求格式无效");
  }
}
export function createHonorsHttp({
  mail,
  projects = () => [],
  localTest = false,
  directory = mail?.workspaceDirectory &&
    join(mail.workspaceDirectory, "honors"),
  store: provided,
  now = Date.now,
} = {}) {
  const enabled = !!mail?.enabled && !!directory,
    store = enabled ? provided || openHonorsStore({ directory, now }) : null,
    uploads = new Set(),
    writes = new Map();
  async function canonical(actor, input, previous) {
    if (!input?.fields || !Array.isArray(input.fields.members))
      throw new HonorsError(400, "请填写荣誉资料");
    const raw = input.fields;
    if (raw.members.length > 50)
      throw new HonorsError(400, "获奖成员不能超过 50 人");
    const list = await mail.projectMembers(actor.subject),
      members = new Map((list.members || []).map((m) => [m.subject, m]));
    members.set(actor.subject, actor);
    for (const m of previous?.members || [])
      if (!members.has(m.subject)) members.set(m.subject, m);
    const selected = raw.members.map((m) => {
      const person = members.get(m.subject);
      if (!person) throw new HonorsError(400, "请选择目录中的获奖成员");
      return { subject: person.subject, name: person.name };
    });
    const project = raw.projectId
      ? projects(actor).find((p) => p.id === raw.projectId)
      : null;
    if (raw.projectId && !project && previous?.projectId !== raw.projectId)
      throw new HonorsError(400, "请选择有效项目");
    return {
      ...input,
      fields: {
        ...raw,
        projectName:
          project?.name || (raw.projectId ? previous?.projectName : "") || "",
        members: selected,
      },
    };
  }
  return {
    enabled,
    close() {
      if (!provided) store?.close();
    },
    todos: (actor) => store?.todos(actor) || { items: [] },
    async handle(req, res, path, host) {
      if (!path.startsWith("/api/honors/")) return false;
      try {
        const local = localTest && ["localhost", "127.0.0.1"].includes(host);
        if (host !== "internal.110-lab.cn" && !local)
          throw new HonorsError(404, "Not found");
        if (!store) throw new HonorsError(503, "荣誉登记尚未启用");
        if (!["GET", "POST"].includes(req.method))
          throw new HonorsError(405, "请求方式无效");
        const embedded = path.startsWith("/api/honors/embedded/"),
          route = path.slice(embedded ? 21 : 12),
          write = req.method === "POST";
        if (
          write &&
          (!(
            req.headers.origin === "https://internal.110-lab.cn" ||
            (local && req.headers.origin === "http://" + req.headers.host)
          ) ||
            (req.headers["sec-fetch-site"] &&
              req.headers["sec-fetch-site"] !== "same-origin"))
        )
          throw new HonorsError(403, "请通过荣誉登记页面操作");
        let actor = mail.identity(req, { embedded, write });
        if (!write) {
          if (route === "session") json(res, 200, actor);
          else if (route === "records") json(res, 200, store.list(actor));
          else if (route === "options") {
            const directory = await mail.projectMembers(actor.subject);
            const next = mail.identity(req, { embedded });
            if (next.subject !== actor.subject)
              throw new HonorsError(401, "登录身份已改变");
            json(res, 200, {
              ...directory,
              projects: projects(next).map((p) => ({ id: p.id, name: p.name })),
            });
          } else {
            const m =
              /^records\/([a-f0-9-]{36})(?:\/(history|certificate))?$/.exec(
                route,
              );
            if (!m) throw new HonorsError(404, "Not found");
            if (m[2] === "certificate") {
              const f = store.certificate(actor, m[1]);
              res.writeHead(200, {
                "Content-Type": f.mime,
                "Content-Length": f.bytes,
                "Content-Disposition":
                  "attachment; filename=certificate; filename*=UTF-8''" +
                  encodeURIComponent(f.filename),
                "Cache-Control": "private, no-store",
                "Content-Security-Policy": "default-src 'none'; sandbox",
                "X-Content-Type-Options": "nosniff",
              });
              res.end(f.buffer);
            } else
              json(
                res,
                200,
                m[2] === "history"
                  ? store.history(actor, m[1])
                  : store.get(actor, m[1]),
              );
          }
        } else {
          for (const [key, value] of writes)
            if (now() - value.at > 60000) writes.delete(key);
          const throttle = writes.get(actor.subject) || { at: now(), count: 0 };
          writes.set(actor.subject, throttle);
          if (++throttle.count > 60)
            throw new HonorsError(429, "操作频繁 请稍后重试");
          const m =
            /^records\/([a-f0-9-]{36})\/(update|actions|certificate)$/.exec(
              route,
            );
          if (route !== "records" && !m)
            throw new HonorsError(404, "Not found");
          const initial = actor.subject;
          if (m?.[2] === "certificate") {
            const r = store.get(actor, m[1]);
            if (!r.canEdit) throw new HonorsError(403, "当前记录不能修改");
            if (uploads.size >= 2 || uploads.has(actor.subject))
              throw new HonorsError(429, "已有证书正在上传");
            uploads.add(initial);
            try {
              const value = await readHonorCertificate(req);
              actor = mail.identity(req, { embedded, write: true });
              if (actor.subject !== initial)
                throw new HonorsError(401, "登录身份已改变");
              json(res, 200, store.attach(actor, m[1], value));
            } finally {
              uploads.delete(initial);
            }
          } else {
            const input = await body(req),
              value =
                route === "records"
                  ? await canonical(actor, input)
                  : m[2] === "update"
                    ? await canonical(actor, input, store.get(actor, m[1]))
                    : input;
            actor = mail.identity(req, { embedded, write: true });
            if (actor.subject !== initial)
              throw new HonorsError(401, "登录身份已改变");
            json(
              res,
              route === "records" ? 201 : 200,
              route === "records"
                ? store.create(actor, value)
                : m[2] === "update"
                  ? store.update(actor, m[1], value)
                  : store.action(actor, m[1], value),
            );
          }
        }
      } catch (e) {
        req.resume();
        if (res.headersSent || res.destroyed) return true;
        if (
          e instanceof HonorsError ||
          e instanceof MailAuthError ||
          e instanceof MailAccessError
        )
          json(res, e.status, { error: e.message });
        else if (e instanceof z.ZodError)
          json(res, 400, { error: "请检查荣誉名称 日期 级别和成员等字段" });
        else {
          console.error("Honors request failed", e.code || e.name);
          json(res, 503, { error: "荣誉登记暂时不可用 请重试" });
        }
      }
      return true;
    },
  };
}
