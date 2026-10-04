// Loopback-only fictional identity; never included in the release archive.
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { createHonorsHttp } from "../server/honors-http.mjs";
import { openHonorsStore } from "../server/honors-store.mjs";
import { MailAuthError } from "../server/mail-auth.mjs";
const directory = await mkdtemp(join(tmpdir(), "110lab-honors-preview-")),
  csrf = randomBytes(24).toString("hex");
const people = [
  { subject: "fictional:lin", name: "林序", role: "member" },
  { subject: "fictional:chen", name: "陈知夏", role: "member" },
  { subject: "fictional:admin", name: "虚构管理员", role: "admin" },
];
let actor = people[0];
const store = openHonorsStore({ directory: join(directory, "honors") });
for (const [index, name, level, prize] of [
  [0, "中国大学生计算机设计大赛", "国家级", "二等奖"],
  [1, "大学生创新创业训练计划", "省级", "优秀项目"],
]) {
  let r = store.create(people[0], {
    requestId: randomUUID(),
    fields: {
      name,
      organizer: "虚构主办方 · 本地演示",
      level,
      levelNote: "",
      prize,
      awardedAt: "2026-09-20",
      projectId: null,
      projectName: "",
      members: people
        .slice(0, 2)
        .map(({ subject, name }) => ({ subject, name })),
      description: "虚构数据 仅用于验证登记与审核流程",
    },
  });
  r = store.action(people[0], r.id, {
    requestId: randomUUID(),
    revision: r.revision,
    action: "submit",
    note: "",
  });
  if (index === 0)
    store.action(people[2], r.id, {
      requestId: randomUUID(),
      revision: r.revision,
      action: "approve",
      note: "虚构审核",
    });
}
const mail = {
  enabled: true,
  workspaceDirectory: directory,
  identity(req, { write } = {}) {
    if (write && req.headers["x-csrf-token"] !== csrf)
      throw new MailAuthError(403, "CSRF");
    return { ...actor, csrf };
  },
  projectMembers: async () => ({ members: people, source: "feishu" }),
};
const honors = createHonorsHttp({ mail, store, localTest: true });
const server = createServer(async (req, res) => {
  if (req.headers.host !== "127.0.0.1:4196") {
    res.writeHead(421);
    res.end();
    return;
  }
  const path = new URL(req.url, "http://localhost").pathname;
  res.setHeader("Cache-Control", "no-store");
  if (await honors.handle(req, res, path, "127.0.0.1")) return;
  if (["/preview/member", "/preview/admin"].includes(path)) {
    actor = people[path.endsWith("/admin") ? 2 : 0];
    res.writeHead(303, { Location: "/honors/embedded" });
    res.end();
    return;
  }
  if (["/honors", "/honors/embedded"].includes(path)) {
    let html = await readFile(
      new URL("../dist/honors.html", import.meta.url),
      "utf8",
    );
    html = html.replace(
      "<body>",
      '<body><div style="font:12px system-ui;padding:8px 20px;background:#fff6df">本地虚构数据 · <a href="/preview/member">成员身份</a> · <a href="/preview/admin">管理员身份</a></div>',
    );
    res.writeHead(200, { "Content-Type": "text/html;charset=utf-8" });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(4196, "127.0.0.1", () =>
  console.log("Fictional-only preview http://127.0.0.1:4196/honors/embedded"),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () =>
    server.close(async () => {
      honors.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
      process.exit(0);
    }),
  );
