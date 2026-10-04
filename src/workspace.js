// 110lab workspace frontend. Entry: initWorkspace(). No deps, textContent only.
const PATHNAME = typeof location !== 'undefined' ? String(location.pathname || '') : '';
const PROJECTS_PAGE = PATHNAME === '/projects/' || PATHNAME === '/projects' || PATHNAME === '/projects/embedded'
  || PATHNAME.endsWith('/projects') || PATHNAME.endsWith('/projects/embedded');
const EMBEDDED = PATHNAME === '/workbench/embedded' || PATHNAME.endsWith('/workbench/embedded')
  || PATHNAME === '/projects/embedded' || PATHNAME.endsWith('/projects/embedded');
const MAIL_PREFIX = '/api/mail/' + (EMBEDDED ? 'embedded/' : '');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);
const DELIVERY_LABEL={RECEIVED:'已接收',SENDING:'发送中',RETRYING:'重试中',SENT:'已发送',FAILED:'发送失败',UNKNOWN:'发送结果待核实',EXPIRED:'文件已到保留期限'};
const PREFIX = '/api/workspace/' + (EMBEDDED ? 'embedded/' : '');
const ROLE_LABEL = { super_admin: '实验室超级管理员', admin: '实验室管理员', member: '实验室成员' };
const PHASE_LABEL = { exploring: '探索中', pending: '审核中', active: '进行中', needs_changes: '需修改' };
const PHASE_BADGE = { exploring: 'ws-badge-indigo', pending: 'ws-badge-amber', active: 'ws-badge-teal', needs_changes: 'ws-badge-rose' };
const PROJECT_FILTERS = { active: 1, mine: 1, archived: 1 };
const TODO_FILTERS = { all: 1, assigned: 1, reviews: 1, recruitment: 1 };
const TODO_KIND_LABEL = { milestone: '里程碑', project_review: '项目审核', project_revision: '项目修改', recruitment: '招新', requirement: '需求' };

const state = {
  profile: null, csrf: '', members: [], projects: [], todos: [], todoSources: null,
  requirements: null, requirementsStandaloneHint: false,
  todoFilter: 'all', projectFilter: 'active',
  selectedTodoKey: null, selectedProjectId: null,
  generation: 0, busy: false, dialogOpen: false, reqRequestId: null, reqTimer: null,
  // Enterprise directory metadata. Preserved across searches and refreshes so a
  // transient directory failure never clears the already picked members list.
  membersSource: '', membersUnavailable: false, membersLoaded: false, membersLoading: false, membersError: '',
  pendingProjectId: null,
};
// Picker local state for the currently open project dialog.
const projectPicker = { profiles:new Map(), selected: new Set(), search: '', ownerSubject: '' };
let activeDialog = null, activeDialogContext = null;

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null && text !== '') n.textContent = String(text);
  return n;
}
const setHidden = (node, hidden) => { if (node) node.hidden = !!hidden; };
const clear = (node) => { if (node) node.replaceChildren(); };
const sameUser = (subject) => !!(state.profile && subject && state.profile.subject === subject);
const isAdminLike = () => !!(state.profile && (state.profile.role === 'admin' || state.profile.role === 'super_admin'));
const isSuperAdmin = () => !!(state.profile && state.profile.role === 'super_admin');

function isSafeHttpsUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try { const u=new URL(value);return value.length<=2000&&u.protocol==='https:'&&!u.username&&!u.password&&!/[\u0000-\u0020\u007f]/.test(value); } catch { return false; }
}
function isGithubRepoUrl(value) {
  if (!isSafeHttpsUrl(value)) return false;
  try {
    const u = new URL(value);
    if (u.hostname !== 'github.com') return false;
    const parts = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
    return parts.length === 2 && parts[0].length > 0 && parts[1].replace(/\.git$/, '').length > 0;
  } catch { return false; }
}
function fmtDateTime(value) {
  if (!value) return '';
  const d = new Date(value); if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtDateOnly(value) {
  if (!value) return '';
  const d = new Date(value); if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function localDateInputToIsoEndOfDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return Number.isNaN(d.getTime())||d.getFullYear()!==Number(m[1])||d.getMonth()+1!==Number(m[2])||d.getDate()!==Number(m[3]) ? null : d.toISOString();
}
function isOverdue(dueAt) {
  if (!dueAt) return false;
  const d = new Date(dueAt);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}

function setStatus(text, kind) {
  const node = $('ws-status'); if (!node) return;
  node.textContent = text || ''; node.hidden = !text; node.dataset.kind = kind || '';
}

async function api(path, { method = 'GET', data } = {}) {
  const headers = {};
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
  let res;
  try {
    res = await fetch((['auth/start','auth/redeem','logout'].includes(path)?MAIL_PREFIX:PREFIX) + path, {
      method, credentials: 'same-origin', headers,
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { throw Object.assign(new Error('网络暂不可用'), { status: 0, cause: e }); }
  let value = null; try { value = await res.json(); } catch { value = null; }
  if (!res.ok) { const err = new Error((value && value.error) || '操作失败'); err.status = res.status; err.data = value; throw err; }
  return value || {};
}

function postToParent(message) {
  if (!EMBEDDED || typeof window === 'undefined' || window.parent === window) return false;
  try { window.parent.postMessage(message, '*'); return true; } catch { return false; }
}
function openExternal(url) {
  if (!isSafeHttpsUrl(url)) return;
  if (EMBEDDED && postToParent({ type: '110lab-workspace-open-link', url })) return;
  try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* ignore */ }
}
function openApp(id) {
  if (!['public-mail', 'assessment', 'requirements'].includes(id)) return;
  if (EMBEDDED) postToParent({ type: '110lab-workspace-open-app', id });
  else openExternal({
    'public-mail':'https://internal.110-lab.cn/mail',assessment:'https://47.109.176.127',requirements:'https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x'
  }[id]);
}
// Navigate to a project by id. Projects now live on their own application page
// so the standalone workbench and embedded host both route through /projects.
function navigateToProject(projectId) {
  if (!isUuid(projectId)) return;
  if (PROJECTS_PAGE) {
    // On the project page we only need to switch selection to the requested id
    // after the project list has loaded.
    if (state.projects.some((p) => p.id === projectId)) {
      state.selectedProjectId = projectId; state.pendingProjectId = null;
      renderProjects(); renderProjectSide();
    } else {
      state.pendingProjectId = projectId;
    }
    return;
  }
  if (EMBEDDED) { postToParent({ type: '110lab-workspace-open-app', id: 'projects', projectId }); return; }
  try { location.assign('/projects?project=' + encodeURIComponent(projectId)); } catch { /* ignore */ }
}

function toastError(err) {
  if (!err) return;
  if (err.status === 401) {
    clearIdentity();
    setStatus('登录状态已失效 请重新登录', 'error'); return;
  }
  if (err.status === 403) { setStatus('权限已变更 正在刷新', 'error'); void loadSession(); return; }
  if (err.status === 409) { setStatus(err.message+' 请刷新后重试', 'error'); return; }
  setStatus(err.message || '操作失败', 'error');
}

function currentTab() {
  const t = $('ws-tab-todos');
  return t && t.getAttribute('aria-selected') === 'true' ? 'todos' : 'projects';
}
function selectTab(id) {
  const tTodos = $('ws-tab-todos'), tProjects = $('ws-tab-projects');
  if (!tTodos || !tProjects) return;
  tTodos.setAttribute('aria-selected', String(id === 'todos'));
  tProjects.setAttribute('aria-selected', String(id === 'projects'));
  setHidden($('ws-panel-todos'), id !== 'todos');
  setHidden($('ws-panel-projects'), id !== 'projects');
}

function renderShell() {
  if($('ws-title'))$('ws-title').textContent=PROJECTS_PAGE?'项目立项':'工作台';
  setHidden($('ws-recruit-history'),!isAdminLike());
  const greet = $('ws-greeting'), chip = $('ws-role-chip'), login = $('ws-login'), logout = $('ws-logout');
  const admin = $('ws-admin-settings'), needed = $('ws-login-needed'), perms = $('ws-permissions-hint');
  const tabs = $('ws-tabs'), newBtn = $('ws-project-new');
  const reviewsChip = document.querySelector('[data-todo-filter="reviews"]');
  const recruitChip = document.querySelector('[data-todo-filter="recruitment"]');
  const loginHint = $('ws-login-hint');
  if (!state.profile) {
    if (greet) greet.textContent = PROJECTS_PAGE ? '项目立项' : '你的项目与协作';
    setHidden(chip, true); setHidden(login, false); setHidden(logout, true); setHidden(admin, true);
    setHidden(needed, false); setHidden(perms, true); setHidden(tabs, true); setHidden(newBtn, true);
    setHidden($('ws-panel-todos'), true); setHidden($('ws-panel-projects'), true);
    setHidden(reviewsChip, true); setHidden(recruitChip, true);
    if (loginHint) {
      loginHint.textContent = PROJECTS_PAGE
        ? '登录后可查看、创建和维护实验室项目。'
        : '登录后可同步你的待办、里程碑和项目变更。';
      loginHint.hidden = false;
    }
    const neededTitle = needed?.querySelector?.('p');
    if (neededTitle) neededTitle.textContent = PROJECTS_PAGE
      ? '通过飞书登录 查看和维护实验室项目'
      : '通过飞书登录 查看个人待办和项目空间';
    return;
  }
  const name = state.profile.name || state.profile.email || '成员';
  if (greet) greet.textContent = PROJECTS_PAGE ? '项目立项' : name+'的工作台';
  if (chip) { chip.textContent = ROLE_LABEL[state.profile.role] || '成员'; chip.dataset.role = state.profile.role || 'member'; chip.hidden = false; }
  setHidden(login, true); setHidden(logout, false); setHidden(admin, !isSuperAdmin()); setHidden(needed, true);
  if (perms) {
    perms.textContent = isSuperAdmin() ? '实验室超级管理员：可管理授权与超管转让。管理员共同处理项目审批、招新与通知邮箱。'
      : isAdminLike() ? '实验室管理员：可处理项目审批、招新待办与通知邮箱事务。'
      : '实验室成员：可创建并维护自己负责的项目。';
    perms.hidden = true;
  }
  // Tabs only make sense on the workbench. The projects page shows a single panel.
  setHidden(tabs, PROJECTS_PAGE);
  setHidden(reviewsChip, !isAdminLike());
  setHidden(recruitChip, !isAdminLike());
  if (PROJECTS_PAGE) {
    setHidden($('ws-panel-todos'), true);
    setHidden($('ws-panel-projects'), false);
    setHidden(newBtn, false);
  } else {
    // Workbench no longer shows the project tab or panel; everything project
    // related moved to the standalone projects page.
    setHidden($('ws-tab-projects'), true);
    setHidden($('ws-panel-projects'), true);
    setHidden($('ws-panel-todos'), false);
    setHidden(newBtn, true);
  }
}

function updateCounts() {
  const tCount = $('ws-tab-todos-count'), pCount = $('ws-tab-projects-count');
  const vt = filteredTodos().length, vp = filteredProjects().length;
  if (tCount) { tCount.textContent = vt > 0 ? String(vt) : ''; tCount.hidden = vt === 0; }
  if (pCount) { pCount.textContent = vp > 0 ? String(vp) : ''; pCount.hidden = vp === 0; }
}

function todoKey(item) { return item.kind + ':' + (item.id || ''); }

function filteredTodos() {
  const items = Array.isArray(state.todos) ? state.todos.slice() : [];
  const req = (state.requirements && Array.isArray(state.requirements.items)) ? state.requirements.items : [];
  const all = items.concat(req.map(r => ({
    id: 'req:' + r.id, kind: 'requirement', title: r.title, projectName: r.projectName || '',
    dueAt: r.dueAt || null, status: r.status || '', action: null, url: r.url || null, source: 'requirements',
  })));
  let list;
  if (state.todoFilter === 'assigned') list = all.filter(x => x.kind === 'milestone' || x.kind === 'requirement');
  else if (state.todoFilter === 'reviews') list = all.filter(x => x.kind === 'project_review' || x.kind === 'project_revision');
  else if (state.todoFilter === 'recruitment') list = all.filter(x => x.kind === 'recruitment');
  else list = all;
  list.sort((a, b) => {
    const ao = isOverdue(a.dueAt), bo = isOverdue(b.dueAt);
    if (ao !== bo) return ao ? -1 : 1;
    const ad = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
    const bd = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
    if (ad !== bd) return ad - bd;
    return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN');
  });
  return list;
}

function filteredProjects() {
  const list = Array.isArray(state.projects) ? state.projects.slice() : [];
  const filtered = state.projectFilter === 'mine' ? list.filter(p => !p.archived && isMemberOrOwner(p))
    : state.projectFilter === 'archived' ? list.filter(p => p.archived)
    : list.filter(p => !p.archived);
  filtered.sort((a, b) => (new Date(b.updatedAt || 0).getTime()) - (new Date(a.updatedAt || 0).getTime()));
  return filtered;
}

function isMemberOrOwner(project) {
  if (!project || !state.profile) return false;
  if (project.ownerSubject === state.profile.subject) return true;
  return (project.members || []).some(m => m.subject === state.profile.subject);
}

function renderTodos() {
  const list = $('ws-todo-list'), empty = $('ws-todo-empty');
  if (!list) return;
  const items = filteredTodos(); clear(list);
  for (const item of items) {
    const li = el('li', 'ws-item');
    li.setAttribute('role', 'button'); li.setAttribute('tabindex', '0');
    const key = todoKey(item);
    if (state.selectedTodoKey === key) li.setAttribute('aria-current', 'true');
    const row = el('div', 'ws-item-row');
    row.append(el('div', 'ws-item-title', item.title || '(无标题)'));
    li.append(row);
    const meta = el('div', 'ws-item-meta');
    meta.append(el('span', 'ws-badge ws-badge-indigo', TODO_KIND_LABEL[item.kind] || '待办'));
    if (item.projectName) meta.append(el('span', '', '· ' + item.projectName));
    if (item.dueAt) {
      const overdue = isOverdue(item.dueAt);
      meta.append(el('span', 'ws-badge ' + (overdue ? 'ws-badge-overdue' : 'ws-badge-amber'), (overdue ? '逾期 ' : '截止 ') + fmtDateOnly(item.dueAt)));
    }
    if (item.kind === 'recruitment') {
      if (item.deliveryStatus) meta.append(el('span', 'ws-badge', '邮件'+(DELIVERY_LABEL[item.deliveryStatus]||item.deliveryStatus)));
      if (item.group) meta.append(el('span', '', '· ' + item.group));
    }
    li.append(meta);
    const activate = () => { state.selectedTodoKey = key; renderTodos(); renderTodoSide(); };
    li.onclick = activate;
    li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } };
    list.append(li);
  }
  if (empty) {empty.hidden = items.length > 0;if(empty.id==='ws-todo-empty')empty.textContent='当前没有已加载的待办';}
  updateCounts();
}

function sideRow(label, value) {
  const row = el('p', 'ws-side-row');
  row.append(el('strong', '', label + '：'));
  row.append(document.createTextNode(String(value)));
  return row;
}

function renderTodoSide() {
  const side = $('ws-todo-side'); if (!side) return;
  clear(side);
  const items = filteredTodos();
  const current = items.find(x => todoKey(x) === state.selectedTodoKey);
  if (!current) { side.append(el('p', 'ws-side-hint', '选择左侧条目查看详情。')); return; }
  side.append(el('h3', '', current.title || '(无标题)'));
  const meta = el('div', 'ws-side-meta');
  meta.append(el('span', 'ws-badge ws-badge-indigo', TODO_KIND_LABEL[current.kind] || '待办'));
  if (current.dueAt) {
    const overdue = isOverdue(current.dueAt);
    meta.append(el('span', 'ws-badge ' + (overdue ? 'ws-badge-overdue' : 'ws-badge-amber'), (overdue ? '逾期 ' : '截止 ') + fmtDateOnly(current.dueAt)));
  }
  side.append(meta);
  if (current.projectName) side.append(sideRow('项目', current.projectName));
  if (current.status) side.append(sideRow('状态', ({open:'待处理',done:'已完成'})[current.status]||String(current.status)));
  if (current.kind === 'recruitment') renderRecruitmentDetail(side, current);
  else if (current.kind === 'requirement') renderRequirementDetail(side, current);
  else if (current.kind === 'milestone') renderMilestoneDetail(side, current);
  else if (current.kind === 'project_review' || current.kind === 'project_revision') renderProjectTodoDetail(side, current);
}

function renderRecruitmentDetail(side, item) {
  if (item.receivedAt) side.append(sideRow('收件时间', fmtDateTime(item.receivedAt)));
  if (item.deliveryStatus) side.append(sideRow('邮件投递', DELIVERY_LABEL[item.deliveryStatus]||item.deliveryStatus));
  const actions = el('div', 'ws-side-actions');
  const mailBtn = el('button', 'ws-btn ws-btn-ghost', '打开公共邮箱');
  mailBtn.type = 'button'; mailBtn.onclick = () => openApp('public-mail');
  actions.append(mailBtn);
  const handleBtn = el('button', 'ws-btn ws-btn-primary', '标记为已处理');
  handleBtn.type = 'button'; handleBtn.disabled = !isAdminLike();
  handleBtn.onclick = () => openRecruitDialog(item);
  actions.append(handleBtn);
  side.append(actions);
}

function renderRequirementDetail(side, item) {
  if (state.requirements) {
    const src = el('p', 'ws-side-row');
    src.append(el('strong', '', '来源：'));
    src.append(document.createTextNode('需求平台 · ' + (state.requirements.accountName || '')));
    side.append(src);
  }
  const actions = el('div', 'ws-side-actions');
  if (isSafeHttpsUrl(item.url)) {
    const btn = el('button', 'ws-btn ws-btn-ghost', '在需求平台查看');
    btn.type = 'button'; btn.onclick = () => openExternal(item.url);
    actions.append(btn);
  } else if (!EMBEDDED) {
    side.append(el('p', 'ws-side-row', '需求待办在 110lab 插件中同步。'));
  }
  if (actions.children.length > 0) side.append(actions);
}

function renderMilestoneDetail(side, item) {
  const project = state.projects.find(p => p.id === item.projectId);
  const actions = el('div', 'ws-side-actions');
  const openBtn = el('button', 'ws-btn ws-btn-ghost', '查看项目');
  openBtn.type = 'button'; openBtn.disabled = !isUuid(item.projectId);
  openBtn.onclick = () => navigateToProject(item.projectId);
  actions.append(openBtn);
  if (item.milestoneId && project) {
    const ms = (project.milestones || []).find(m => m.id === item.milestoneId);
    if (ms && ms.status !== 'done') {
      const canFinish = isMemberOrOwner(project) && (sameUser(ms.assignee) || project.canEdit || isAdminLike());
      const btn = el('button', 'ws-btn ws-btn-primary', '完成');
      btn.type = 'button'; btn.disabled = !canFinish;
      btn.onclick = () => openMsDoneDialog(project, ms);
      actions.append(btn);
    }
  }
  side.append(actions);
}

function renderProjectTodoDetail(side, item) {
  const actions = el('div', 'ws-side-actions');
  const openBtn = el('button', 'ws-btn ws-btn-primary', '打开项目');
  openBtn.type = 'button'; openBtn.disabled = !isUuid(item.projectId);
  openBtn.onclick = () => navigateToProject(item.projectId);
  actions.append(openBtn);
  side.append(actions);
}

function renderProjects() {
  const list = $('ws-project-list'), empty = $('ws-project-empty');
  if (!list) return;
  const items = filteredProjects(); clear(list);
  for (const p of items) {
    const li = el('li', 'ws-item');
    li.setAttribute('role', 'button'); li.setAttribute('tabindex', '0');
    if (state.selectedProjectId === p.id) li.setAttribute('aria-current', 'true');
    const row = el('div', 'ws-item-row');
    row.append(el('div', 'ws-item-title', p.name || '(未命名)'));
    row.append(el('span', 'ws-badge ' + (PHASE_BADGE[p.phase] || 'ws-badge-indigo'), PHASE_LABEL[p.phase] || p.phase || ''));
    li.append(row);
    const meta = el('div', 'ws-item-meta');
    const ownerName = p.ownerName || p.ownerEmail || p.ownerSubject || '';
    if (ownerName) meta.append(el('span', '', '负责人 ' + ownerName));
    const memberCount = Array.isArray(p.members) ? p.members.length + 1 : 1;
    meta.append(el('span', '', '· 共 ' + memberCount + ' 人'));
    if (p.archived) meta.append(el('span', 'ws-badge', '已归档'));
    li.append(meta);
    const activate = () => { state.selectedProjectId = p.id; renderProjects(); renderProjectSide(); };
    li.onclick = activate;
    li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } };
    list.append(li);
  }
  if (empty) {empty.hidden = items.length > 0;if(empty.id==='ws-todo-empty')empty.textContent='当前没有已加载的待办';}
  updateCounts();
}

function renderProjectSide() {
  const side = $('ws-project-side'); if (!side) return;
  clear(side);
  const project = state.projects.find(p => p.id === state.selectedProjectId);
  if (!project) { side.append(el('p', 'ws-side-hint', '选择左侧项目查看详情。')); return; }
  side.append(el('h3', '', project.name || '(未命名)'));
  const meta = el('div', 'ws-side-meta');
  meta.append(el('span', 'ws-badge ' + (PHASE_BADGE[project.phase] || 'ws-badge-indigo'), PHASE_LABEL[project.phase] || project.phase || ''));
  if (project.archived) meta.append(el('span', 'ws-badge', '已归档'));
  side.append(meta);
  if (project.summary) side.append(el('p', 'ws-side-row', project.summary));
  const ownerName = project.ownerName || project.ownerEmail || project.ownerSubject || '';
  if (ownerName) side.append(sideRow('负责人', ownerName));
  if (Array.isArray(project.members) && project.members.length > 0) {
    const names = project.members.map(m => m.name || m.email || m.subject).filter(Boolean).join('、');
    if (names) side.append(sideRow('成员', names));
  }
  if (project.application) side.append(sideRow('立项说明', project.application));
  if (project.reviewNote) side.append(sideRow('审核备注', project.reviewNote));
  const linkEntries = [];
  if (project.links) {
    if (project.links.repository && isGithubRepoUrl(project.links.repository)) linkEntries.push(['代码仓库', project.links.repository]);
    if (project.links.requirements && isSafeHttpsUrl(project.links.requirements)) linkEntries.push(['需求', project.links.requirements]);
    if (project.links.docs && isSafeHttpsUrl(project.links.docs)) linkEntries.push(['文档', project.links.docs]);
    if (project.links.demo && isSafeHttpsUrl(project.links.demo)) linkEntries.push(['演示', project.links.demo]);
  }
  if (linkEntries.length > 0) {
    side.append(el('h4', '', '链接'));
    const ul = el('ul', 'ws-link-list');
    for (const [label, url] of linkEntries) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.textContent = label; a.href = url; a.rel = 'noopener noreferrer'; a.target = '_blank';
      a.onclick = (e) => { if (EMBEDDED) { e.preventDefault(); openExternal(url); } };
      li.append(a); ul.append(li);
    }
    side.append(ul);
  }
  renderMilestones(side, project);
  renderProjectActions(side, project);
}

function renderMilestones(side, project) {
  side.append(el('h4', '', '里程碑'));
  const ms = Array.isArray(project.milestones) ? project.milestones.slice() : [];
  ms.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'done' ? 1 : -1;
    const ad = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
    const bd = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
    return ad - bd;
  });
  const ul = el('ul', 'ws-ms-list');
  if (ms.length === 0) ul.append(el('li', 'ws-side-hint', '尚无里程碑。'));
  const owner = { subject: project.ownerSubject, name: project.ownerName, email: project.ownerEmail };
  const assigneePool = [owner].concat(project.members || []);
  for (const m of ms) {
    const li = el('li', 'ws-ms-item'); li.dataset.status = m.status;
    const text = el('div', 'ws-ms-text');
    text.append(el('div', 'ws-ms-title', m.title || ''));
    const found = assigneePool.find(x => x && x.subject === m.assignee);
    const assigneeName = (found && (found.name || found.email)) || m.assignee || '';
    const parts = [];
    if (assigneeName) parts.push('负责人 ' + assigneeName);
    if (m.dueAt) parts.push((isOverdue(m.dueAt) && m.status !== 'done' ? '逾期 ' : '截止 ') + fmtDateOnly(m.dueAt));
    text.append(el('div', 'ws-ms-meta', parts.join(' · ')));
    li.append(text);
    const canFinish = m.canChange===true;
    const btn = el('button', 'ws-ms-done-btn', m.status === 'done' ? '重新打开' : '完成');
    btn.type = 'button'; btn.dataset.done = m.status === 'done' ? 'true' : 'false';
    btn.disabled = !canFinish||state.busy;
    btn.onclick = () => openMsDoneDialog(project, m);
    li.append(btn); ul.append(li);
  }
  side.append(ul);
}

function renderProjectActions(side, project) {
  const actions = el('div', 'ws-side-actions');
  const add = (cls, text, fn, enabled = true) => { if (!enabled) return; const b = el('button', 'ws-btn ' + cls, text); b.type = 'button'; b.onclick = fn; actions.append(b); };
  add('ws-btn-ghost', '编辑', () => openProjectDialog(project), project.canEdit && project.phase !== 'pending');
  add('ws-btn-primary', '提交立项', () => openApplyDialog(project), project.canApply && (project.phase === 'exploring' || project.phase === 'needs_changes'));
  add('ws-btn-primary', '审核', () => openReviewDialog(project), project.canReview && project.phase === 'pending');
  add('ws-btn-ghost', '新建里程碑', () => openMilestoneDialog(project), project.canEdit);
  add(project.archived ? 'ws-btn-ghost' : 'ws-btn-danger', project.archived ? '取消归档' : '归档', () => openArchiveDialog(project), (sameUser(project.ownerSubject)||isAdminLike()) && project.phase !== 'pending');
  add('ws-btn-ghost','操作记录',()=>showHistory(project));
  if (actions.children.length > 0) side.append(actions);
}

async function showHistory(project=null){
  $('ws-history-title').textContent=project?'项目操作记录':'招新处理记录';
  const list=$('ws-history-list');list.replaceChildren(el('li','ws-side-hint','加载中'));
  openDialog('ws-dialog-history',{});const epoch=state.generation;
  try{
    const r=await api(project?'projects/'+project.id+'/audit':'recruitment/history');
    if(epoch!==state.generation||!state.profile)return;list.replaceChildren();
    const labels={create:'创建项目',update:'修改资料',apply:'提交立项',approve:'批准立项',return:'退回修改',archive:'归档项目',restore:'恢复项目',milestone_add:'新建里程碑',milestone_done:'完成里程碑',milestone_reopen:'重开里程碑'};
    for(const row of r.events){const li=el('li','ws-item');li.append(el('strong','',row.actorName+' · '+(project?(labels[row.action]||'更新项目'):'处理投递 '+row.id.slice(0,8))),el('p','ws-ms-meta',fmtDateTime(row.at)));if(row.note)li.append(el('p','ws-side-row',row.note));list.append(li);}
    if(!r.events.length)list.append(el('li','ws-side-hint','暂无记录'));
  }catch(e){if(epoch===state.generation){list.replaceChildren(el('li','ws-side-hint',e.message));if([401,403].includes(e.status))toastError(e);}}
}

function openDialog(id, context) {
  const dlg = $(id); if (!dlg || typeof dlg.showModal !== 'function') return;
  activeDialog = dlg; activeDialogContext = context || null; state.dialogOpen = true;
  const errNode = dlg.querySelector('.ws-form-error');
  if (errNode) { errNode.textContent = ''; errNode.hidden = true; }
  try { dlg.showModal(); } catch { /* already open */ }
}
function closeDialog(dlg) {
  const target = dlg || activeDialog; if (!target) return;
  try { target.close(); } catch { /* ignore */ }
  if (target === activeDialog) { activeDialog = null; activeDialogContext = null; state.dialogOpen = false; }
}
function setFormError(dlg, text) {
  const node = dlg && dlg.querySelector('.ws-form-error'); if (!node) return;
  node.textContent = text || ''; node.hidden = !text;
}
function setFormBusy(form, busy) {
  if (!form) return;
  for (const node of form.querySelectorAll('input, textarea, select, button')) node.disabled = !!busy;
}

// Member picker — searchable checkbox list that is resilient to directory
// failures. Already selected members are kept visible even when the directory
// is unavailable so a hiccup never silently discards saved choices.
function memberSearchMatches(member, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    String(member.name || '').toLowerCase().includes(q) ||
    String(member.email || '').toLowerCase().includes(q) ||
    String(member.subject || '').toLowerCase().includes(q)
  );
}

function renderMemberPicker() {
  const list = $('ws-field-members-list'); if (!list) return;
  clear(list);
  const owner = projectPicker.ownerSubject;
  const selected = projectPicker.selected;
  const query = projectPicker.search || '';
  // Known universe: directory entries plus any already picked subjects so
  // picks persist even when the directory is unavailable or filtered out.
  const byId = new Map();
  for (const m of state.members || []) if (m && m.subject && m.subject !== owner) byId.set(m.subject, m);
  for (const subject of selected) {
    if (subject === owner || byId.has(subject)) continue;
    byId.set(subject, projectPicker.profiles.get(subject)||{ subject, name: '', email: '' });
  }
  const all = Array.from(byId.values());
  const visible = all.filter((m) => selected.has(m.subject) || memberSearchMatches(m, query));
  visible.sort((a, b) => {
    const sa = selected.has(a.subject), sb = selected.has(b.subject);
    if (sa !== sb) return sa ? -1 : 1;
    return String(a.name || a.email || a.subject).localeCompare(String(b.name || b.email || b.subject), 'zh-CN');
  });

  const summary = $('ws-field-members-summary');
  if (summary) {
    const parts = ['已选 ' + selected.size + ' 人'];
    if (state.membersLoading && !state.membersLoaded) parts.push('目录加载中…');
    else if (state.membersUnavailable) parts.push('企业目录暂不可用');
    else if (state.membersSource) parts.push('来源：' + (state.membersSource === 'feishu' ? '飞书通讯录' : '已登录成员'));
    summary.textContent = parts.join(' · ');
  }
  const status = $('ws-field-members-status');
  if (status) {
    let text = '';
    if (state.membersLoading && !state.membersLoaded) text = '正在加载企业目录…';
    else if (state.membersUnavailable) text = '企业目录暂时无法读取，已保留当前选择。可点击刷新重试。';
    else if (state.membersError) text = state.membersError;
    status.textContent = text; status.hidden = !text;
  }

  if (visible.length === 0) {
    const empty = el('p', 'ws-member-empty');
    empty.textContent = query ? '没有匹配的成员。' : (state.membersUnavailable ? '企业目录暂不可用。' : '目录中暂无其他成员。');
    list.append(empty);
    return;
  }

  for (const m of visible) {
    const row = el('label', 'ws-member-row');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = m.subject;
    cb.checked = selected.has(m.subject);
    cb.addEventListener('change', () => {
      if (cb.checked) {selected.add(m.subject);projectPicker.profiles.set(m.subject,m);} else selected.delete(m.subject);
      renderMemberPicker();
    });
    const text = el('span', 'ws-member-text');
    const name = el('span', 'ws-member-name', m.name || m.email || m.subject);
    text.append(name);
    const emailValue = m.email ? String(m.email) : '';
    if (emailValue) text.append(el('span', 'ws-member-email', emailValue));
    if (!byId.get(m.subject)?.name && !byId.get(m.subject)?.email) {
      text.append(el('span', 'ws-member-email', '（已选成员，未在当前目录命中）'));
    }
    row.append(cb, text);
    list.append(row);
  }
}

function refreshMemberPicker() { renderMemberPicker(); updateMemberPickerSaveState(); }

function updateMemberPickerSaveState() {
  const submit = $('ws-form-project-submit'); if (!submit) return;
  // Disable save while the directory is still being loaded for the first time
  // so the user never submits before seeing the picker populate.
  if (state.membersLoading && !state.membersLoaded) { submit.disabled = true; return; }
  if (!state.busy) submit.disabled = false;
}

function populateAssigneeSelect(select, project) {
  if (!select) return; clear(select);
  const seen = new Set();
  const owner = { subject: project.ownerSubject, name: project.ownerName, email: project.ownerEmail };
  for (const m of [owner].concat(project.members || [])) {
    if (!m || !m.subject || seen.has(m.subject)) continue;
    seen.add(m.subject);
    const opt = document.createElement('option');
    opt.value = m.subject;
    const label = (m.name || m.email || m.subject) + (m.email ? ' · ' + m.email : '');
    opt.textContent = label + (m.subject === project.ownerSubject ? '（负责人）' : '');
    select.append(opt);
  }
}

function openProjectDialog(project) {
  const dlg = $('ws-dialog-project'), form = $('ws-form-project');
  if (!dlg || !form) return;
  form.reset();
  $('ws-form-project-title').textContent = project ? '编辑项目' : '新建项目';
  $('ws-field-name').value = project ? (project.name || '') : '';
  $('ws-field-summary').value = project ? (project.summary || '') : '';
  // Reset the picker local state so stale selections never leak between opens.
  projectPicker.selected = new Set(
    project && Array.isArray(project.members)
      ? project.members.map((m) => m && m.subject).filter(Boolean)
      : []
  );
  projectPicker.profiles=new Map((project?.members||[]).map(m=>[m.subject,m]));
  projectPicker.search = '';
  projectPicker.ownerSubject = (project && project.ownerSubject) || state.profile?.subject || '';
  const searchInput = $('ws-field-members-search'); if (searchInput) searchInput.value = '';
  const links = (project && project.links) || {};
  $('ws-field-link-repo').value = links.repository || '';
  $('ws-field-link-req').value = links.requirements || '';
  $('ws-field-link-docs').value = links.docs || '';
  $('ws-field-link-demo').value = links.demo || '';
  openDialog('ws-dialog-project', { project });
  const fields = dlg.querySelector('.ws-project-fields');
  if (fields) fields.scrollTop = 0;
  $('ws-field-name').focus({ preventScroll: true });
  // Ensure the enterprise directory is loaded (or refreshed) on every open so
  // long-lived dialogs see new teammates.
  void loadMembers({ refresh: true });
  refreshMemberPicker();
}

function collectProjectForm() {
  const name = String($('ws-field-name').value || '').trim();
  const summary = String($('ws-field-summary').value || '').trim();
  // Send plain {subject} rows; the server rejects any subject that is not in
  // its own enterprise directory, so arbitrary / stale ids cannot slip through.
  const owner = projectPicker.ownerSubject;
  const subjects = Array.from(projectPicker.selected).filter((s) => typeof s === 'string' && s && s !== owner);
  const members = subjects.map((subject) => ({ subject }));
  const links = {
    repository: String($('ws-field-link-repo').value || '').trim(),
    requirements: String($('ws-field-link-req').value || '').trim(),
    docs: String($('ws-field-link-docs').value || '').trim(),
    demo: String($('ws-field-link-demo').value || '').trim(),
  };
  if (name.length === 0 || name.length > 80) return { error: '名称长度需为 1-80' };
  if (summary.length === 0 || summary.length > 800) return { error: '简介长度需为 1-800' };
  if (links.repository && !isGithubRepoUrl(links.repository)) return { error: '代码仓库仅支持 https://github.com/owner/repo' };
  for (const [key, label] of [['requirements', '需求'], ['docs', '文档'], ['demo', '演示']]) {
    if (links[key] && !isSafeHttpsUrl(links[key])) return { error: label + '链接需为 https:// 开头' };
  }
  return { name, summary, members, links };
}

function openApplyDialog(project) {
  $('ws-form-apply-project').textContent = project.name || '';
  $('ws-field-application').value = project.application || '';
  openDialog('ws-dialog-apply', { project });
}
function openReviewDialog(project) {
  $('ws-form-review-project').textContent = project.name || '';
  $('ws-form-review').reset();
  openDialog('ws-dialog-review', { project });
}
function openArchiveDialog(project) {
  $('ws-form-archive-title').textContent = project.archived ? '取消归档' : '归档项目';
  $('ws-form-archive-project').textContent = project.name || '';
  $('ws-form-archive-submit').textContent = project.archived ? '取消归档' : '归档';
  openDialog('ws-dialog-archive', { project });
}
function openMilestoneDialog(project) {
  $('ws-form-milestone').reset();
  $('ws-form-milestone-project').textContent = project.name || '';
  populateAssigneeSelect($('ws-field-ms-assignee'), project);
  openDialog('ws-dialog-milestone', { project });
}
async function openMsDoneDialog(project, milestone) {
  if(state.busy)return;
  state.busy=true;renderProjectSide();
  try{
    await api('projects/'+project.id+'/milestones/'+milestone.id,{method:'POST',data:{revision:milestone.revision,status:milestone.status==='done'?'open':'done'}});
    await Promise.all([loadProjects(),loadTodos()]);setStatus(milestone.status==='done'?'里程碑已重新打开':'里程碑已完成','ok');
  }catch(e){toastError(e);}finally{state.busy=false;renderProjectSide();}
}
function openRecruitDialog(item) {
  $('ws-form-recruit-text').textContent = item.title || '';
  $('ws-form-recruit').reset();
  openDialog('ws-dialog-recruit', { item });
}

async function runSubmit(dlgId, formId, buildRequest, onSuccess) {
  const dlg = $(dlgId), form = $(formId);
  if (!dlg || !form || state.busy) return;
  const ctx = activeDialogContext || {};
  let req;
  try { req = buildRequest(ctx); } catch (e) { setFormError(dlg, e.message || '输入无效'); return; }
  if (!req) return;
  if (req.error) { setFormError(dlg, req.error); return; }
  state.busy = true; setFormBusy(form, true); setFormError(dlg, '');
  try {
    await api(req.path, { method: 'POST', data: req.data });
    closeDialog(dlg);
    if (req.status) setStatus(req.status, 'ok');
    if (typeof onSuccess === 'function') await onSuccess();
  } catch (err) {
    setFormError(dlg, err.message || '操作失败');
    if (err.status === 401 || err.status === 403) toastError(err);
  } finally {
    state.busy = false; setFormBusy(form, false);renderProjectSide();
  }
}

function submitProjectForm(e) {
  e.preventDefault();
  return runSubmit('ws-dialog-project', 'ws-form-project', (ctx) => {
    const parsed = collectProjectForm();
    if (parsed.error) return parsed;
    if (ctx.project) return { path: 'projects/' + encodeURIComponent(ctx.project.id) + '/update', data: { revision: ctx.project.revision, ...parsed }, status: '项目已更新' };
    return { path: 'projects', data: parsed, status: '项目已创建' };
  }, () => loadProjects());
}

function submitApplyForm(e) {
  e.preventDefault();
  return runSubmit('ws-dialog-apply', 'ws-form-apply', (ctx) => {
    const application = String($('ws-field-application').value || '').trim();
    if (application.length === 0 || application.length > 2000) return { error: '立项说明长度需为 1-2000' };
    return { path: 'projects/' + encodeURIComponent(ctx.project.id) + '/apply', data: { revision: ctx.project.revision, application }, status: '立项申请已提交' };
  }, async () => { await Promise.all([loadProjects(), loadTodos()]); });
}

function submitReviewForm(e) {
  e.preventDefault();
  return runSubmit('ws-dialog-review', 'ws-form-review', (ctx) => {
    const form = $('ws-form-review');
    const picked = form.querySelector('input[name="decision"]:checked');
    if (!picked) return { error: '请选择审核结果' };
    const decision = picked.value;
    const note = String($('ws-field-review-note').value || '').trim();
    if (note.length > 1000) return { error: '备注不能超过 1000 字' };
    if (decision === 'return' && note.length === 0) return { error: '退回需要填写备注' };
    return { path: 'projects/' + encodeURIComponent(ctx.project.id) + '/review', data: { revision: ctx.project.revision, decision, note }, status: '审核结果已记录' };
  }, async () => { await Promise.all([loadProjects(), loadTodos()]); });
}

function submitArchiveForm(e) {
  e.preventDefault();
  return runSubmit('ws-dialog-archive', 'ws-form-archive', (ctx) => ({
    path: 'projects/' + encodeURIComponent(ctx.project.id) + '/archive',
    data: { revision: ctx.project.revision, archived: !ctx.project.archived },
    status: ctx.project.archived ? '已取消归档' : '已归档',
  }), async () => { await Promise.all([loadProjects(),loadTodos()]); });
}

function submitMilestoneForm(e) {
  e.preventDefault();
  return runSubmit('ws-dialog-milestone', 'ws-form-milestone', (ctx) => {
    const title = String($('ws-field-ms-title').value || '').trim();
    const assignee = String($('ws-field-ms-assignee').value || '').trim();
    const dueRaw = String($('ws-field-ms-due').value || '').trim();
    if (title.length === 0 || title.length > 160) return { error: '标题长度需为 1-160' };
    if (!assignee) return { error: '请选择负责人' };
    const dueAt = dueRaw ? localDateInputToIsoEndOfDay(dueRaw) : null;
    if (dueRaw && !dueAt) return { error: '日期无效' };
    return { path: 'projects/' + encodeURIComponent(ctx.project.id) + '/milestones', data: { title, assignee, dueAt }, status: '里程碑已创建' };
  }, async () => { await Promise.all([loadProjects(), loadTodos()]); });
}

function submitMsDoneForm(e) {
  e.preventDefault();
  return runSubmit('ws-dialog-ms-done', 'ws-form-ms-done', (ctx) => ({
    path: 'projects/' + encodeURIComponent(ctx.project.id) + '/milestones/' + encodeURIComponent(ctx.milestone.id),
    data: { revision: ctx.milestone.revision, status: 'done' },
    status: '里程碑已完成',
  }), async () => { await Promise.all([loadProjects(), loadTodos()]); });
}

function submitRecruitForm(e) {
  e.preventDefault();
  return runSubmit('ws-dialog-recruit', 'ws-form-recruit', (ctx) => {
    const note = String($('ws-field-recruit-note').value || '').trim();
    if (note.length === 0 || note.length > 1000) return { error: '处理说明长度需为 1-1000' };
    const rawId = String(ctx.item.id || '').replace(/^recruitment:/, '');
    return { path: 'recruitment/' + encodeURIComponent(rawId) + '/handled', data: { note }, status: '已记录处理说明' };
  }, () => loadTodos());
}

function clearIdentity() {
  state.generation++;state.profile=null;state.csrf='';state.members=[];state.projects=[];state.todos=[];state.todoSources=null;state.requirements=null;
  state.selectedProjectId=null;state.selectedTodoKey=null;state.reqRequestId=null;state.todosReady=false;
  state.membersSource=''; state.membersUnavailable=false; state.membersLoaded=false; state.membersLoading=false; state.membersError='';
  state.pendingProjectId=null;
  projectPicker.selected = new Set(); projectPicker.profiles.clear(); projectPicker.search = ''; projectPicker.ownerSubject = '';
  clearTimeout(state.reqTimer);finishLogin();
  for(const dlg of document.querySelectorAll('.ws-dialog')){closeDialog(dlg);dlg.querySelector('form')?.reset();}
  $('ws-history-list')?.replaceChildren();
  renderShell();renderPanels();renderRequirementsSource();
}
async function loadSession() {
  const epoch=++state.generation;
  try{
    const me=await api('session');if(epoch!==state.generation)return;
    if(state.profile?.subject&&state.profile.subject!==me.subject){clearIdentity();void loadSession();return;}
    state.profile=me;state.csrf=me.csrf||'';renderShell();
    await Promise.all([loadMembers(),loadProjects(),loadTodos()]);
    if(epoch===state.generation&&state.profile)requestRequirements();
  }catch(e){if(epoch!==state.generation)return;if(e.status===401)clearIdentity();else setStatus(e.message,'error');}
}
// Read the enterprise directory. On transient failures we deliberately keep
// state.members untouched so already-selected teammates and the owner picker
// never silently disappear from an open dialog.
let membersRead=0;
async function loadMembers({ refresh = false } = {}) {
  const epoch = state.generation,serial=++membersRead;
  state.membersLoading = true; state.membersError = '';
  if (refresh) refreshMemberPicker();
  try {
    const r = await api('members');
    if (epoch !== state.generation || serial!==membersRead || !state.profile) return;
    state.members = Array.isArray(r?.members) ? r.members.filter((m) => m && typeof m.subject === 'string') : [];
    state.membersSource = typeof r?.source === 'string' ? r.source : '';
    state.membersUnavailable = !!r?.unavailable;
    state.membersLoaded = true;
    state.membersError = state.membersUnavailable ? '企业目录暂时无法读取，已保留当前选择。' : '';
  } catch (e) {
    if (epoch !== state.generation||serial!==membersRead) return;
    // Preserve previously known members; just surface a human readable error
    // next to the picker. 401/403 continue to drive the shared login flow.
    state.membersUnavailable = true;
    state.membersError = e.status === 0 ? '企业目录当前不可访问（网络）。' : (e.message || '企业目录读取失败');
    if (e.status === 401 || e.status === 403) toastError(e);
  } finally {
    if (epoch === state.generation&&serial===membersRead) {
      state.membersLoading = false;
      refreshMemberPicker();
    }
  }
}
let projectsRead=0,todosRead=0;
async function loadProjects() {
  const epoch=state.generation,serial=++projectsRead;
  try{
    const r=await api('projects');if(epoch!==state.generation||serial!==projectsRead||!state.profile)return;
    state.projects=r.projects||[];
    // If a specific project id was requested (via query string, parent host
    // message, or todo navigation) prefer it as the active selection.
    const requested = state.pendingProjectId;
    if (requested && state.projects.some((p) => p.id === requested)) {
      state.selectedProjectId = requested;
      state.pendingProjectId = null;
    } else if(!filteredProjects().some(x=>x.id===state.selectedProjectId)) {
      state.selectedProjectId=filteredProjects()[0]?.id||null;
    }
    renderProjects();renderProjectSide();
  }catch(e){if(epoch===state.generation&&serial===projectsRead)toastError(e);}
}
async function loadTodos() {
  const epoch=state.generation,serial=++todosRead;
  try{
    const r=await api('todos');if(epoch!==state.generation||serial!==todosRead||!state.profile)return;
    state.todos=r.items||[];state.todoSources=r.sources||null;state.todosReady=true;
    renderTodos();renderTodoSide();renderRequirementsSource();
  }catch(e){if(epoch===state.generation&&serial===todosRead){state.todosReady=false;toastError(e);}}
}

function renderPanels() { renderProjects(); renderProjectSide(); renderTodos(); renderTodoSide(); updateCounts(); }

function renderRequirementsSource() {
  const node = $('ws-req-source'); if (!node) return;
  clear(node); node.hidden = true;
  node.removeAttribute('data-partial'); node.removeAttribute('data-stale');
  const recruitment=state.todoSources?.recruitment;
  if(recruitment?.state==='unavailable'){node.append(document.createTextNode('招新待办暂时无法同步 · '));node.hidden=false;}
  if(recruitment?.partial){node.append(document.createTextNode('招新显示前 200 条 待处理后继续加载 · '));node.hidden=false;}
  if (!EMBEDDED) {
    if (state.requirementsStandaloneHint) {
      node.append(document.createTextNode('需求待办在 110lab 插件中同步。'));
      node.hidden = false;
    }
    return;
  }
  const r = state.requirements; if (!r) return;
  if (r.state === 'not_configured') { node.append(document.createTextNode('需求平台尚未配置。')); node.hidden = false; return; }
  if (r.state === 'unavailable') { node.append(document.createTextNode('需求平台暂时不可用。')); node.hidden = false; return; }
  node.append(document.createTextNode('需求平台 · ' + (r.accountName || '')));
  if (r.stale) { node.append(document.createTextNode(' · PR 缓存已过期')); node.dataset.stale = 'true'; }
  if (r.partial) { node.append(document.createTextNode(' · 已达来源 100 条上限 仅显示部分数据')); node.dataset.partial = 'true'; }
  node.hidden = false;
}

function requestRequirements() {
  if(!state.profile)return;
  if (!EMBEDDED) { state.requirementsStandaloneHint = true; renderRequirementsSource(); return; }
  if (typeof crypto === 'undefined' || !crypto.randomUUID) return;
  const requestId = crypto.randomUUID();
  state.reqRequestId = requestId;
  if (state.reqTimer) { clearTimeout(state.reqTimer); state.reqTimer = null; }
  if (!postToParent({ type: '110lab-workspace-requirements', requestId })) return;
  state.reqTimer = setTimeout(() => {
    if (state.reqRequestId !== requestId) return;
    if (state.profile) {
      state.requirements = { state: 'unavailable', items: [] };
      renderRequirementsSource(); renderTodos();
    }
  }, 65000);
}

async function handleParentMessage(ev) {
  if (!EMBEDDED || typeof window === 'undefined' || ev.source !== window.parent) return;
  const data = ev.data;
  if (!data || typeof data !== 'object') return;
  if(data.type==='110lab-workspace-activated'){if(!state.busy&&!state.dialogOpen)await loadSession();return;}
  if(data.type==='110lab-mail-host-opened'&&data.state===state.loginFlow?.state){setStatus('请在飞书完成授权 返回后自动登录');return;}
  if(data.type==='110lab-mail-host-result'&&data.state===state.loginFlow?.state){
    const flow=state.loginFlow;
    try{
      if(!/^[\w-]{43}$/.test(data.ticket||''))throw new Error('连接未完成 请重试或更新 110lab 插件');
      await api('auth/redeem',{method:'POST',data:{state:flow.state,ticket:data.ticket}});
      if(state.loginFlow!==flow)return;finishLogin();setStatus('');await loadSession();
    }catch(e){if(state.loginFlow===flow){finishLogin();setStatus(e.message,'error');}}return;
  }
  if (data.type === '110lab-workspace-requirements-result'&&state.profile) {
    if (!data.requestId || data.requestId !== state.reqRequestId) return;
    const r = data.result;
    if (!r || typeof r !== 'object') return;
    const stateValue = typeof r.state === 'string' ? r.state : 'unavailable';
    const accountName = typeof r.accountName === 'string' ? r.accountName : '';
    const stale = !!r.stale, partial = !!r.partial;
    const items = Array.isArray(r.items) ? r.items.filter(x => x && typeof x === 'object').map(x => ({
      id: typeof x.id === 'string' ? x.id : '',
      title: typeof x.title === 'string' ? x.title : '',
      kind: 'requirement',
      url: typeof x.url === 'string' && isSafeHttpsUrl(x.url) ? x.url : null,
      status: typeof x.status === 'string' ? x.status : '',
      dueAt: typeof x.dueAt === 'string' ? x.dueAt : null,
      projectName: typeof x.projectName === 'string' ? x.projectName : '',
    })).filter(x => x.id && x.title) : [];
    state.requirements = { state: stateValue, accountName, stale, partial, items };
    if (state.reqTimer) { clearTimeout(state.reqTimer); state.reqTimer = null; }
    renderRequirementsSource(); renderTodos(); renderTodoSide();
    return;
  }
  if (data.type === '110lab-workspace-ready') { requestRequirements(); return; }
  // Parent-driven project selection. Only accepts well-formed UUIDs from the
  // real parent frame (checked above via ev.source === window.parent).
  if (data.type === '110lab-workspace-select-project' && isUuid(data.projectId)) {
    if (!PROJECTS_PAGE) return;
    if (state.projects.some((p) => p.id === data.projectId)) {
      state.selectedProjectId = data.projectId; state.pendingProjectId = null;
      renderProjects(); renderProjectSide();
    } else {
      state.pendingProjectId = data.projectId;
    }
    return;
  }
}

function finishLogin(){clearTimeout(state.loginTimer);state.loginFlow=null;state.busy=false;if($('ws-login'))$('ws-login').disabled=false;}
async function doLogin() {
  if(state.busy)return;state.busy=true;$('ws-login').disabled=true;setStatus('');
  try{
    const flow=await api('auth/start',{method:'POST',data:{}});
    const url=new URL(flow.launchUrl);
    if(!/^[\w-]{43}$/.test(flow.state||'')||url.origin!=='https://internal.110-lab.cn'||url.pathname!=='/mail/auth/launch')throw new Error('登录入口无效');
    state.loginFlow=flow;
    if(EMBEDDED){
      if(!postToParent({type:'110lab-mail-host-login',state:flow.state,fresh:false}))throw new Error('请从 110lab 插件打开工作台');
      setStatus('正在打开飞书授权');
      state.loginTimer=setTimeout(()=>{if(state.loginFlow===flow){finishLogin();setStatus('授权超时 请重试','error');}},285000);
    }else location.assign(flow.launchUrl);
  }catch(e){finishLogin();setStatus(e.message,'error');}
}
async function doLogout(){
  if(state.busy)return;state.busy=true;state.generation++;$('ws-logout').disabled=true;
  try{await api('logout',{method:'POST',data:{}});clearIdentity();setStatus('已退出');}
  catch(e){toastError(e);}finally{state.busy=false;$('ws-logout').disabled=false;}
}

function bindEvents() {
  $('ws-recruit-history').onclick=()=>showHistory();
  if (EMBEDDED && document && document.body) document.body.classList.add('is-workbench-embedded');
  if (PROJECTS_PAGE && document && document.body) document.body.classList.add('is-workspace-projects');
  // On the standalone projects page, honor ?project=<uuid> if it was supplied.
  if (PROJECTS_PAGE && typeof location !== 'undefined' && typeof location.search === 'string') {
    try {
      const params = new URLSearchParams(location.search);
      const requested = params.get('project');
      if (isUuid(requested)) state.pendingProjectId = requested;
    } catch { /* ignore */ }
  }
  // Member picker events — bound once, read picker state on each interaction.
  const memberSearch = $('ws-field-members-search');
  if (memberSearch) memberSearch.addEventListener('input', (e) => {
    projectPicker.search = String(e.target.value || '');
    renderMemberPicker();
  });
  const memberRefresh = $('ws-field-members-refresh');
  if (memberRefresh) memberRefresh.addEventListener('click', () => {
    if (state.membersLoading) return;
    void loadMembers({ refresh: true });
  });
  const loginBtn = $('ws-login'); if (loginBtn) loginBtn.onclick = () => { void doLogin(); };
  const logoutBtn = $('ws-logout'); if (logoutBtn) logoutBtn.onclick = () => { void doLogout(); };
  const adminBtn = $('ws-admin-settings'); if (adminBtn) adminBtn.onclick = () => { if (isSuperAdmin()) openApp('public-mail'); };
  const tTodos = $('ws-tab-todos'); if (tTodos) tTodos.onclick = () => selectTab('todos');
  const tProjects = $('ws-tab-projects'); if (tProjects) tProjects.onclick = () => selectTab('projects');
  for (const chip of document.querySelectorAll('[data-todo-filter]')) {
    chip.onclick = () => {
      const value = chip.dataset.todoFilter;
      if (!TODO_FILTERS[value]) return;
      state.todoFilter = value;
      for (const o of document.querySelectorAll('[data-todo-filter]')) o.setAttribute('aria-pressed', String(o.dataset.todoFilter === value));
      state.selectedTodoKey = null; renderTodos(); renderTodoSide();
    };
  }
  for (const chip of document.querySelectorAll('[data-project-filter]')) {
    chip.onclick = () => {
      const value = chip.dataset.projectFilter;
      if (!PROJECT_FILTERS[value]) return;
      state.projectFilter = value;
      for (const o of document.querySelectorAll('[data-project-filter]')) o.setAttribute('aria-pressed', String(o.dataset.projectFilter === value));
      state.selectedProjectId = null; renderProjects(); renderProjectSide();
    };
  }
  const todosRefresh = $('ws-todos-refresh');
  if (todosRefresh) todosRefresh.onclick = () => { if (!state.busy) { void loadTodos(); requestRequirements(); } };
  const projectsRefresh = $('ws-projects-refresh');
  if (projectsRefresh) projectsRefresh.onclick = () => { if (!state.busy) void loadProjects(); };
  const newBtn = $('ws-project-new'); if (newBtn) newBtn.onclick = () => openProjectDialog(null);
  for (const btn of document.querySelectorAll('[data-ws-close]')) {
    btn.onclick = () => { closeDialog(btn.closest('dialog')); };
  }
  for (const dlg of document.querySelectorAll('.ws-dialog')) {
    dlg.addEventListener('close', () => {
      if (dlg === activeDialog) { activeDialog = null; activeDialogContext = null; state.dialogOpen = false; }
    });
  }
  const formHandlers = [
    ['ws-form-project', submitProjectForm], ['ws-form-apply', submitApplyForm],
    ['ws-form-review', submitReviewForm], ['ws-form-archive', submitArchiveForm],
    ['ws-form-milestone', submitMilestoneForm], ['ws-form-ms-done', submitMsDoneForm],
    ['ws-form-recruit', submitRecruitForm],
  ];
  for (const [id, handler] of formHandlers) { const f = $(id); if (f) f.addEventListener('submit', handler); }
  if (typeof window !== 'undefined') {
    window.addEventListener('message', handleParentMessage);
    window.addEventListener('focus', () => { if (!state.busy && !state.dialogOpen && state.profile) { void loadSession(); } });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !state.busy && !state.dialogOpen && state.profile) { void loadSession(); }
    });
    setInterval(() => {
      if (document.hidden || state.busy || state.dialogOpen || !state.profile) return;
      void loadSession();
    }, 60000);
  }
}

export function initWorkspace() {
  const root = $('ws-root'); if (!root) return;
  if (root.dataset.wsInit === 'true') return;
  root.dataset.wsInit = 'true';
  bindEvents();
  renderShell(); renderPanels(); renderRequirementsSource();
  void loadSession();
}
export default initWorkspace;
