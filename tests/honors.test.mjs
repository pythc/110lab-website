import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { openHonorsStore } from "../server/honors-store.mjs";
import { createHonorsHttp } from "../server/honors-http.mjs";
import { MailAuthError } from "../server/mail-auth.mjs";
const member = {
    subject: "fictional:member",
    name: "虚构成员",
    role: "member",
  },
  other = { subject: "fictional:other", name: "同名成员", role: "member" },
  admin = { subject: "fictional:admin", name: "虚构管理员", role: "admin" };
const fields = {
  name: "虚构奖项",
  organizer: "测试主办方",
  level: "国家级",
  levelNote: "",
  prize: "一等奖",
  awardedAt: "2026-09-01",
  projectId: null,
  projectName: "",
  members: [member].map(({ subject, name }) => ({ subject, name })),
  description: "仅用于测试",
};
const input = () => ({ requestId: randomUUID(), fields });
const action = (store, actor, r, name, note = "") =>
  store.action(actor, r.id, {
    requestId: randomUUID(),
    revision: r.revision,
    action: name,
    note,
  });
test("honors lifecycle preserves history, hides pending data, rejects stale writes and enforces live roles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honors-test-"));
  let store = openHonorsStore({ directory: dir });
  try {
    const data = input();
    let r = store.create(member, data);
    assert.equal(store.create(member, data).id, r.id);
    assert.equal(store.list(other).items.length, 0);
    assert.throws(
      () =>
        store.create(member, {
          ...data,
          fields: { ...fields, name: "Changed" },
        }),
      { status: 409 },
    );
    assert.throws(() => store.get(other, r.id), { status: 404 });
    assert.throws(
      () =>
        store.update(other, r.id, {
          requestId: randomUUID(),
          revision: r.revision,
          fields,
        }),
      { status: 403 },
    );
    r = action(store, member, r, "submit");
    assert.equal(store.todos(admin).items.length, 1);
    assert.equal(store.todos(member).items.length, 0);
    assert.throws(() => action(store, member, r, "approve"), { status: 403 });
    assert.throws(() => action(store, admin, r, "return"), { status: 400 });
    assert.throws(
      () =>
        store.update(member, r.id, {
          requestId: randomUUID(),
          revision: r.revision,
          fields,
        }),
      { status: 409 },
    );
    r = action(store, admin, r, "return", "请补齐获奖日期");
    assert.equal(store.todos(member).items.length, 1);
    r = action(store, member, r, "submit");
    r = action(store, admin, r, "approve");
    assert.equal(store.list(other).items.length, 1);
    assert.throws(
      () =>
        store.update(member, r.id, {
          requestId: randomUUID(),
          revision: 1,
          fields,
        }),
      { status: 409 },
    );
    r = store.update(member, r.id, {
      requestId: randomUUID(),
      revision: r.revision,
      fields: { ...fields, prize: "二等奖" },
    });
    assert.equal(r.status, "draft");
    assert.equal(store.list(other).items.length, 0);
    r = action(store, member, r, "submit");
    r = action(store, admin, r, "approve");
    r = action(store, admin, r, "archive");
    assert.equal(store.list(other).items.length, 0);
    r = action(store, admin, r, "restore");
    assert.equal(r.status, "draft");
    assert.equal(store.history(member, r.id).events.length, 10);
    store.close();
    store = openHonorsStore({ directory: dir });
    assert.equal(store.get(member, r.id).prize, "二等奖");
    assert.throws(() =>
      store.create(member, {
        ...input(),
        fields: { ...fields, awardedAt: "2026-02-30" },
      }),
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("certificate storage is private, idempotent, revisioned and quota bounded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honors-file-")),
    store = openHonorsStore({ directory: dir, maxStoredBytes: 20 });
  try {
    let r = store.create(member, input());
    const buffer = Buffer.from("%PDF-fixture"),
      file = {
        requestId: randomUUID(),
        revision: r.revision,
        filename: "测试.pdf",
        mime: "application/pdf",
        bytes: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        buffer,
      };
    r = store.attach(member, r.id, file);
    assert.equal(
      store.attach(member, r.id, file).certificate.id,
      r.certificate.id,
    );
    assert.throws(() => store.certificate(other, r.id), { status: 404 });
    assert.deepEqual(store.certificate(member, r.id).buffer, buffer);
    assert.throws(
      () =>
        store.attach(member, r.id, {
          ...file,
          requestId: randomUUID(),
          revision: r.revision,
        }),
      { status: 507 },
    );
    r = action(store, member, r, "submit");
    r = action(store, admin, r, "approve");
    assert.equal(store.certificate(other, r.id).bytes, buffer.length);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("honors HTTP validates identity, origin, CSRF, canonical directory and certificate contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "honors-http-"));
  let revoked = false;
  const mail = {
    enabled: true,
    workspaceDirectory: directory,
    identity(req, { embedded, write } = {}) {
      const key = req.headers["x-fixture-user"];
      const actor = { member, admin, other }[key];
      if (!actor || revoked) throw new MailAuthError(401, "请登录");
      if (write && req.headers["x-csrf-token"] !== "fictional")
        throw new MailAuthError(403, "CSRF");
      return { ...actor, csrf: "fictional", embedded };
    },
    projectMembers: async () => ({
      members: [member, other, admin],
      source: "feishu",
    }),
  };
  const honors = createHonorsHttp({ mail, localTest: true });
  const server = createServer(async (req, res) => {
    if (
      !(await honors.handle(
        req,
        res,
        new URL(req.url, "http://localhost").pathname,
        req.headers.host.split(":")[0],
      ))
    ) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (
    path,
    {
      actor = "member",
      body,
      form,
      origin = base,
      csrf = "fictional",
      host,
    } = {},
  ) => {
    const source = new Request(base + "/api/honors/" + path, {
      method: body || form ? "POST" : "GET",
      headers: {
        "X-Fixture-User": actor,
        "X-CSRF-Token": csrf,
        Origin: origin,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: form || (body && JSON.stringify(body)),
    });
    const bytes =
      body || form ? Buffer.from(await source.arrayBuffer()) : undefined;
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        source.url,
        {
          method: source.method,
          headers: {
            ...Object.fromEntries(source.headers),
            ...(host ? { Host: host } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: res.headers,
              }),
            ),
          );
        },
      );
      req.on("error", reject);
      req.end(bytes);
    });
  };
  try {
    assert.equal((await call("records", { actor: "" })).status, 401);
    assert.equal((await call("records", { host: "110-lab.cn" })).status, 404);
    assert.equal(
      (await call("records", { body: input(), origin: "https://evil.example" }))
        .status,
      403,
    );
    assert.equal(
      (await call("records", { body: input(), csrf: "bad" })).status,
      403,
    );
    const created = await call("embedded/records", {
      body: {
        ...input(),
        fields: {
          ...fields,
          members: [{ subject: member.subject, name: "forged" }],
        },
      },
    });
    assert.equal(created.status, 201);
    let r = await created.json();
    assert.equal(r.members[0].name, member.name);
    assert.equal(
      (await call("records/" + r.id, { actor: "other" })).status,
      404,
    );
    const upload = (file, type = "application/pdf") => {
      const f = new FormData();
      f.set("requestId", randomUUID());
      f.set("revision", String(r.revision));
      f.set("certificate", new Blob([file], { type }), "虚构.pdf");
      return f;
    };
    assert.equal(
      (await call(`records/${r.id}/certificate`, { form: upload("not pdf") }))
        .status,
      400,
    );
    assert.equal(
      (
        await call(`records/${r.id}/certificate`, {
          form: upload(new Uint8Array(5 * 1024 * 1024 + 1)),
        })
      ).status,
      413,
    );
    const pdf = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n";
    const attached = await call(`records/${r.id}/certificate`, {
      form: upload(pdf),
    });
    assert.equal(attached.status, 200, await attached.clone().text());
    r = await attached.json();
    const download = await call(`records/${r.id}/certificate`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition"), /^attachment/);
    assert.equal(download.headers.get("cache-control"), "private, no-store");
    assert.equal(await download.text(), pdf);
    assert.equal(
      (await call(`records/${r.id}/certificate`, { actor: "other" })).status,
      404,
    );
    assert.equal(
      (
        await call("records", {
          body: {
            ...input(),
            fields: {
              ...fields,
              members: [{ subject: "forged", name: "Fake" }],
            },
          },
        })
      ).status,
      400,
    );
    mail.projectMembers = async () => {
      revoked = true;
      return { members: [member] };
    };
    assert.equal((await call("records", { body: input() })).status, 401);
  } finally {
    await new Promise((r) => server.close(r));
    honors.close();
    await rm(directory, { recursive: true, force: true });
  }
});
