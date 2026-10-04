import { createLabSession } from "./lab-session.js";
const $ = (id) => document.getElementById(id);
const LABEL = {
  draft: "草稿",
  pending: "待审核",
  approved: "已通过",
  returned: "待修改",
  archived: "已归档",
};
const ACTION = {
  create: "创建登记",
  update: "更新资料",
  certificate: "上传证书",
  submit: "提交审核",
  withdraw: "撤回审核",
  approve: "审核通过",
  return: "退回修改",
  archive: "归档",
  restore: "恢复为草稿",
};
const ROLE = { member: "成员", admin: "管理员", super_admin: "超级管理员" };
const state = {
  profile: null,
  items: [],
  levels: [],
  tab: "approved",
  options: null,
  current: null,
  editing: null,
  selected: new Set(),
  epoch: 0,
  read: 0,
  busy: false,
};
const node = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const message = (id, text = "", error = false) => {
  const n = $(id);
  n.textContent = text;
  n.hidden = !text;
  if (id === "notice") n.classList.toggle("error", error);
};
const admin = () => ["admin", "super_admin"].includes(state.profile?.role);
const badge = (r) =>
  node("span", LABEL[r.status] || r.status, "badge badge-" + r.status);
const button = (text, fn, cls) => {
  const b = node("button", text, cls);
  b.type = "button";
  b.onclick = fn;
  return b;
};
const pendingWrites = new Map();
const session = createLabSession({
  apiRoot: "/api/honors/",
  onStatus: (text, error) => message("notice", text, error),
  onChange: (profile) => {
    const changed =
      profile?.subject !== state.profile?.subject ||
      profile?.role !== state.profile?.role;
    state.profile = profile;
    if (changed) {
      pendingWrites.clear();
      state.epoch++;
      state.read++;
      state.items = [];
      state.options = null;
      state.current = null;
      state.editing = null;
      state.selected.clear();
      for (const id of ["editor", "detail"]) $(id).close();
      $("form").reset();
      $("upload-form").reset();
      $("records").replaceChildren();
      $("detail-body").replaceChildren();
      $("history").replaceChildren();
      $("certificate-info").replaceChildren();
    }
    $("identity").textContent = profile
      ? `${profile.name} · ${ROLE[profile.role] || "成员"}`
      : "未登录";
    $("login").hidden = !!profile;
    $("logout").hidden = !profile;
    $("content").hidden = !profile;
    $("signed-out").hidden = !!profile;
    $("review-tab").hidden = !admin();
    $("archive-tab").hidden = !admin();
    if (!admin() && ["review", "archive"].includes(state.tab))
      state.tab = "approved";
    if (profile) void refresh();
  },
});
if (session.embedded) document.body.classList.add("embedded");
function fillSelect(select, items, { first } = {}) {
  select.replaceChildren();
  if (first) select.append(new Option(first.label, first.value));
  for (const item of items) select.append(new Option(item.label, item.value));
}
function render() {
  const counts = {
    approved: state.items.filter((r) => r.status === "approved").length,
    mine: state.items.filter((r) => r.ownerSubject === state.profile?.subject)
      .length,
    review: state.items.filter((r) => r.status === "pending").length,
  };
  for (const [tab, count] of Object.entries(counts))
    $("count-" + tab).textContent = count;
  for (const b of document.querySelectorAll("[data-tab]"))
    b.setAttribute("aria-pressed", String(b.dataset.tab === state.tab));
  const search = $("search").value.trim().toLowerCase(),
    level = $("level-filter").value;
  const rows = state.items.filter(
    (r) =>
      (state.tab === "mine"
        ? r.ownerSubject === state.profile?.subject
        : state.tab === "review"
          ? r.status === "pending"
          : state.tab === "archive"
            ? r.status === "archived"
            : r.status === "approved") &&
      (!level || r.level === level) &&
      (!search ||
        [r.name, r.projectName, r.organizer, ...r.members.map((m) => m.name)]
          .join(" ")
          .toLowerCase()
          .includes(search)),
  );
  $("records").replaceChildren();
  $("empty").hidden = !!rows.length;
  $("result-count").textContent = `${rows.length} 条记录`;
  for (const r of rows) {
    const tr = node("tr"),
      title = node("td");
    title.append(
      node("div", r.name, "row-title"),
      node("div", r.projectName || r.organizer, "row-sub"),
    );
    const level = node("td");
    level.append(
      node("div", r.level === "其他" ? r.levelNote : r.level),
      node("div", r.prize, "row-sub"),
    );
    const status = node("td");
    status.append(badge(r));
    const action = node("td");
    action.append(button("查看", () => void openDetail(r.id), "text-button"));
    tr.append(
      title,
      level,
      node("td", r.members.map((m) => m.name).join("、")),
      node("td", r.awardedAt),
      status,
      action,
    );
    $("records").append(tr);
  }
}
async function refresh() {
  const epoch = state.epoch,
    serial = ++state.read;
  try {
    const result = await session.request("records");
    if (epoch !== state.epoch || serial !== state.read || !state.profile)
      return;
    state.items = result.items;
    state.levels = result.levels;
    const previous = $("level-filter").value;
    fillSelect(
      $("level-filter"),
      state.levels.map((l) => ({ label: l, value: l })),
      { first: { label: "全部级别", value: "" } },
    );
    $("level-filter").value = previous;
    render();
  } catch (e) {
    if (epoch === state.epoch) message("notice", e.message, true);
  }
}
async function options() {
  const epoch = state.epoch,
    value = await session.request("options");
  if (epoch !== state.epoch) throw new Error("登录状态已改变");
  state.options = value;
  return value;
}
function members() {
  const known = new Map(
    (state.options?.members || []).map((m) => [m.subject, m]),
  );
  for (const m of state.editing?.members || [])
    if (!known.has(m.subject)) known.set(m.subject, m);
  known.set(state.profile.subject, state.profile);
  const q = $("member-search").value.trim().toLowerCase(),
    owner = state.editing?.ownerSubject || state.profile.subject;
  $("members").replaceChildren();
  for (const m of known.values()) {
    if (q && !m.name.toLowerCase().includes(q)) continue;
    const label = node("label", undefined, "member"),
      input = node("input");
    input.type = "checkbox";
    input.checked = state.selected.has(m.subject);
    input.disabled = m.subject === owner;
    input.onchange = () => {
      if (input.checked) state.selected.add(m.subject);
      else state.selected.delete(m.subject);
    };
    label.append(
      input,
      node("span", m.name + (m.subject === owner ? " · 提交者" : "")),
    );
    $("members").append(label);
  }
  $("members-hint").textContent = state.options?.unavailable
    ? "成员目录暂时不可用 已保留当前成员 可稍后重新打开登记表"
    : "提交者本人保留在获奖成员中";
}
async function edit(r = null) {
  const epoch = state.epoch;
  try {
    await options();
    if (epoch !== state.epoch || !state.profile) return;
    state.editing = r;
    state.selected = new Set(
      r ? r.members.map((m) => m.subject) : [state.profile.subject],
    );
    $("form").reset();
    $("editor-title").textContent = r ? "编辑荣誉" : "登记荣誉";
    fillSelect(
      $("form-level"),
      state.levels.map((l) => ({ label: l, value: l })),
      { first: { label: "请选择级别", value: "" } },
    );
    const projects = [...(state.options.projects || [])];
    if (r?.projectId && !projects.some((p) => p.id === r.projectId))
      projects.push({ id: r.projectId, name: r.projectName });
    fillSelect(
      $("form-project"),
      projects.map((p) => ({ label: p.name, value: p.id })),
      { first: { label: "不关联项目", value: "" } },
    );
    if (r)
      for (const name of [
        "name",
        "organizer",
        "level",
        "levelNote",
        "prize",
        "awardedAt",
        "projectId",
        "description",
      ])
        $("form").elements.namedItem(name).value = r[name] || "";
    $("member-search").value = "";
    levelChanged();
    members();
    message("form-error");
    $("detail").close();
    $("editor").showModal();
  } catch (e) {
    if (epoch === state.epoch) message("notice", e.message, true);
  }
}
function levelChanged() {
  const other = $("form-level").value === "其他";
  $("level-note-label").hidden = !other;
  $("form").elements.namedItem("levelNote").required = other;
}
function busy(value) {
  state.busy = value;
  for (const dialog of [$("editor"), $("detail")]) {
    for (const control of dialog.querySelectorAll(
      "button,input,select,textarea",
    )) {
      if (value) {
        control.dataset.wasDisabled = String(control.disabled);
        control.disabled = true;
      } else if (control.dataset.wasDisabled !== undefined) {
        control.disabled = control.dataset.wasDisabled === "true";
        delete control.dataset.wasDisabled;
      }
    }
  }
  $("new").disabled = value;
  $("logout").disabled = value;
}
async function perform(errorId, fn) {
  if (state.busy) return;
  const epoch = state.epoch;
  busy(true);
  message(errorId);
  try {
    await fn(epoch);
  } catch (e) {
    if (epoch === state.epoch) message(errorId, e.message, true);
  } finally {
    busy(false);
  }
}
// A lost response must not create another award when the member retries.
async function write(path, data) {
  const key = JSON.stringify([state.epoch, path, data]);
  const requestId = pendingWrites.get(key) || crypto.randomUUID();
  pendingWrites.set(key, requestId);
  try {
    const result = await session.request(path, {
      method: "POST",
      data: { ...data, requestId },
    });
    pendingWrites.delete(key);
    return result;
  } catch (error) {
    if (error.status >= 400 && error.status < 500) pendingWrites.delete(key);
    throw error;
  }
}
$("form").onsubmit = (event) => {
  event.preventDefault();
  const form = new FormData($("form")),
    fields = Object.fromEntries(
      [...form].map(([k, v]) => [k, String(v).trim()]),
    );
  fields.projectId = fields.projectId || null;
  fields.projectName = "";
  fields.members = [...state.selected].map((subject) => ({ subject }));
  if (fields.level !== "其他") fields.levelNote = "";
  void perform("form-error", async (epoch) => {
    const r = state.editing,
      value = await write(r ? `records/${r.id}/update` : "records", {
        ...(r ? { revision: r.revision } : {}),
        fields,
      });
    if (epoch !== state.epoch) return;
    $("editor").close();
    state.tab = "mine";
    await refresh();
    await openDetail(value.id);
  });
};
let detailRead = 0;
async function openDetail(id) {
  const epoch = state.epoch,
    serial = ++detailRead;
  try {
    const [r, history] = await Promise.all([
      session.request("records/" + id),
      session.request("records/" + id + "/history"),
    ]);
    if (epoch !== state.epoch || serial !== detailRead || !state.profile)
      return;
    state.current = r;
    $("detail-title").textContent = r.name;
    $("detail-body").replaceChildren(badge(r));
    const dl = node("dl", undefined, "details-grid");
    for (const [name, value] of [
      [
        "级别 / 等次",
        `${r.level === "其他" ? r.levelNote : r.level} · ${r.prize}`,
      ],
      ["获奖日期", r.awardedAt],
      ["主办单位", r.organizer],
      ["关联项目", r.projectName || "未关联"],
      ["获奖成员", r.members.map((m) => m.name).join("、")],
      ["提交者", r.ownerName],
    ]) {
      const group = node("div");
      group.append(node("dt", name), node("dd", value));
      dl.append(group);
    }
    $("detail-body").append(dl);
    if (r.description)
      $("detail-body").append(node("p", r.description, "description"));
    if (r.reviewNote)
      $("detail-body").append(
        node("p", "审核意见 · " + r.reviewNote, "description"),
      );
    $("certificate-info").replaceChildren(
      r.certificate
        ? button(r.certificate.filename, () => void download(r), "text-button")
        : node("p", "尚未上传证书", "form-hint"),
    );
    $("upload-form").hidden = !r.canEdit;
    $("upload-form").reset();
    $("review-note-wrap").hidden = !r.canReview;
    $("review-note").value = "";
    message("detail-error");
    $("history").replaceChildren();
    for (const event of history.events) {
      const li = node("li");
      li.append(
        node(
          "strong",
          `${ACTION[event.action] || event.action} · ${event.actorName}`,
        ),
        node("div", new Date(event.at).toLocaleString("zh-CN")),
      );
      if (event.note) li.append(node("p", event.note));
      $("history").append(li);
    }
    $("detail-actions").replaceChildren();
    if (r.canEdit)
      $("detail-actions").append(button("编辑资料", () => void edit(r)));
    for (const [allowed, action, label, cls] of [
      [r.canSubmit, "submit", "提交审核", "primary"],
      [r.canWithdraw, "withdraw", "撤回审核", ""],
      [r.canReview, "return", "退回修改", "danger"],
      [r.canReview, "approve", "审核通过", "primary"],
      [r.canArchive, "archive", "归档", ""],
      [r.canRestore, "restore", "恢复为草稿", ""],
    ])
      if (allowed)
        $("detail-actions").append(button(label, () => void act(action), cls));
    if (!$("detail").open) $("detail").showModal();
  } catch (e) {
    if (epoch === state.epoch)
      message($("detail").open ? "detail-error" : "notice", e.message, true);
  }
}
async function download(r) {
  try {
    const blob = await session.download(`records/${r.id}/certificate`),
      url = URL.createObjectURL(blob),
      a = node("a");
    a.href = url;
    a.download = r.certificate.filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    message("detail-error", e.message, true);
  }
}
async function act(action) {
  const r = state.current;
  if (!r) return;
  const note = $("review-note").value.trim();
  if (action === "return" && !note) {
    message("detail-error", "请填写退回原因", true);
    $("review-note").focus();
    return;
  }
  await perform("detail-error", async (epoch) => {
    const updated = await write(`records/${r.id}/actions`, {
      revision: r.revision,
      action,
      note: r.canReview ? note : "",
    });
    if (epoch !== state.epoch) return;
    await refresh();
    await openDetail(updated.id);
  });
}
$("upload-form").onsubmit = (event) => {
  event.preventDefault();
  void perform("detail-error", async (epoch) => {
    const r = state.current,
      file = $("certificate").files[0];
    if (
      !file ||
      file.size > 5 * 1024 * 1024 ||
      !file.size ||
      !/\.(pdf|png|jpe?g)$/i.test(file.name)
    )
      throw new Error("请上传不超过 5MB 的 PDF PNG 或 JPG 证书");
    const form = new FormData();
    form.set("requestId", crypto.randomUUID());
    form.set("revision", String(r.revision));
    form.set("certificate", file);
    await session.upload(`records/${r.id}/certificate`, form);
    if (epoch !== state.epoch) return;
    await refresh();
    await openDetail(r.id);
  });
};
for (const b of document.querySelectorAll("[data-close]"))
  b.onclick = () => {
    if (!state.busy) $(b.dataset.close).close();
  };
for (const id of ["editor", "detail"])
  $(id).addEventListener("cancel", (e) => {
    if (state.busy) e.preventDefault();
  });
for (const b of document.querySelectorAll("[data-tab]"))
  b.onclick = () => {
    state.tab = b.dataset.tab;
    render();
  };
$("search").oninput = render;
$("level-filter").onchange = render;
$("member-search").oninput = members;
$("form-level").onchange = levelChanged;
$("new").onclick = () => void edit();
$("refresh").onclick = () => void refresh();
$("login").onclick = () => void session.login();
$("logout").onclick = () =>
  void session.logout().catch((e) => message("notice", e.message, true));
async function resume() {
  if (!document.hidden && !state.busy && !$("editor").open && !$("detail").open)
    await session.load();
}
window.addEventListener("focus", () => void resume());
document.addEventListener("visibilitychange", () => void resume());
window.addEventListener("message", (e) => {
  if (e.source !== parent) return;
  if (e.data?.type === "110lab-workspace-activated") void resume();
  if (
    e.data?.type === "110lab-workspace-select-honor" &&
    state.profile &&
    !state.busy &&
    /^[a-f0-9-]{36}$/.test(e.data.honorId || "")
  )
    void openDetail(e.data.honorId);
});
setInterval(() => void resume(), 60000);
await session.load();
const requested = new URLSearchParams(location.search).get("record");
if (state.profile && /^[a-f0-9-]{36}$/.test(requested || ""))
  await openDetail(requested);
