const SVG_NS = 'http://www.w3.org/2000/svg';
const STATUS = {
  available: '可用',
  intranet: '内网',
  disabled: '尚未启用'
};

const runtime = {
  opener: null,
  apps: [],
  listening: false,
  messageTimer: 0,
  attempt: 0
};
let embeddedIds = new Set();

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function iconSvg(kind) {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24',
    width: '22',
    height: '22',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.7',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true'
  });
  if (kind === 'grading') {
    svg.append(
      svgEl('path', {d: 'M7 3.5h7.2L19 8.2V20.5H7z'}),
      svgEl('path', {d: 'M14.2 3.5V8.2H19'}),
      svgEl('path', {d: 'M9.2 14.2l1.8 1.8 3.6-3.8'})
    );
  } else if (kind === 'assessment') {
    svg.append(
      svgEl('rect', {x: '7', y: '3.5', width: '10', height: '17', rx: '2'}),
      svgEl('path', {d: 'M9.5 3.5h5V6h-5z'}),
      svgEl('path', {d: 'M9.5 11h5'}),
      svgEl('path', {d: 'M9.5 14.5h3.5'})
    );
  } else if (kind === 'requirements') {
    svg.append(
      svgEl('path', {d: 'M9 7h10'}),
      svgEl('path', {d: 'M9 12h10'}),
      svgEl('path', {d: 'M9 17h7'}),
      svgEl('circle', {cx: '5.5', cy: '7', r: '1', fill: 'currentColor', stroke: 'none'}),
      svgEl('circle', {cx: '5.5', cy: '12', r: '1', fill: 'currentColor', stroke: 'none'}),
      svgEl('circle', {cx: '5.5', cy: '17', r: '1', fill: 'currentColor', stroke: 'none'})
    );
  } else if (kind === 'recruitment') {
    svg.append(svgEl('circle',{cx:'9',cy:'8',r:'3'}),svgEl('path',{d:'M3 20v-2a6 6 0 0 1 12 0v2M17 7h4M17 12h4M18 17v4M16 19h4'}));
  } else if (kind === 'projects') {
    svg.append(svgEl('rect',{x:'3',y:'5',width:'18',height:'15',rx:'2'}),svgEl('path',{d:'M8 5V3h8v2M3 11h18M12 9v4'}));
  } else if (kind === 'mail') {
    svg.append(svgEl('rect', {x:'3',y:'5',width:'18',height:'14',rx:'2'}),svgEl('path',{d:'m4 6 8 6 8-6'}));
  } else if (kind === 'home') {
    svg.append(
      svgEl('path', {d: 'M4 11 12 4.5 20 11'}),
      svgEl('path', {d: 'M6.8 10.2V19.5h10.4V10.2'})
    );
  } else if (kind === 'updates') {
    svg.append(
      svgEl('path', {d: 'M4 12a8 8 0 0 1 13.5-5.8'}),
      svgEl('path', {d: 'M20 12a8 8 0 0 1-13.5 5.8'}),
      svgEl('path', {d: 'M15.5 4.2H20V8.5'}),
      svgEl('path', {d: 'M8.5 19.8H4V15.5'})
    );
  } else {
    svg.append(
      svgEl('rect', {x: '4', y: '4', width: '6.5', height: '6.5', rx: '1.5'}),
      svgEl('rect', {x: '13.5', y: '4', width: '6.5', height: '6.5', rx: '1.5'}),
      svgEl('rect', {x: '4', y: '13.5', width: '6.5', height: '6.5', rx: '1.5'}),
      svgEl('rect', {x: '13.5', y: '13.5', width: '6.5', height: '6.5', rx: '1.5'})
    );
  }
  return svg;
}

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

function safeHttpUrl(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim();
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return candidate;
  } catch {
    return '';
  }
}

function knownStatus(status) {
  return status === 'available' || status === 'intranet' || status === 'disabled' ? status : 'unknown';
}

function showLinkError() {
  const message = document.querySelector('#link-message');
  if (!message) return;
  window.clearTimeout(runtime.messageTimer);
  message.hidden = false;
  message.textContent = '暂时无法打开链接，请稍后重试。';
  runtime.messageTimer = window.setTimeout(() => {
    message.hidden = true;
    message.textContent = '';
  }, 5000);
}

function clearLinkError() {
  const message = document.querySelector('#link-message');
  if (!message) return;
  window.clearTimeout(runtime.messageTimer);
  message.hidden = true;
  message.textContent = '';
}

function onExternalClick(event) {
  const link = event.target instanceof Element ? event.target.closest('a[target="_blank"]') : null;
  const exact = link?.getAttribute('href');
  if (!link || !runtime.opener || !exact || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
  event.preventDefault();
  const token = ++runtime.attempt;
  Promise.resolve()
    .then(() => runtime.opener(exact))
    .then(() => { if (token === runtime.attempt) clearLinkError(); })
    .catch(() => { if (token === runtime.attempt) showLinkError(); });
}

function createCard(app) {
  const status = knownStatus(app?.status);
  const href = safeHttpUrl(app?.url);
  const card = document.createElement(href ? 'a' : 'div');
  card.className = 'app-card' + (status === 'disabled' ? ' is-disabled' : '') + (href ? '' : ' is-static');
  card.dataset.status = status;
  if (app?.id != null) card.dataset.appId = String(app.id);
  if (href) {
    card.setAttribute('href', href);
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
  }

  const top = document.createElement('div');
  top.className = 'app-card-top';
  const icon = document.createElement('span');
  icon.className = 'app-icon';
  icon.append(iconSvg(app?.icon));
  const heading = document.createElement('div');
  heading.className = 'app-heading';
  const title = document.createElement('h3');
  const titleText = textOf(app?.title).trim();
  title.textContent = titleText || '未命名应用';
  heading.append(title);
  const edition = textOf(app?.edition).trim();
  if (edition) {
    const editionEl = document.createElement('p');
    editionEl.className = 'app-edition';
    editionEl.textContent = edition;
    heading.append(editionEl);
  }
  const badge = document.createElement('span');
  badge.className = 'app-status app-status-' + status;
  badge.textContent = STATUS[status] || '未标注';
  top.append(icon, heading, badge);

  const description = document.createElement('p');
  description.className = 'app-desc';
  description.textContent = textOf(app?.description);

  card.append(top, description);
  if (status === 'disabled') {
    const note = document.createElement('p');
    note.className = 'app-disabled-note';
    note.textContent = '尚未启用，打开后可能无法使用。';
    card.append(note);
  }
  if (!href) {
    const note = document.createElement('p');
    note.className = 'app-note';
    note.textContent = '未提供可打开的地址。';
    card.append(note);
  } else {
    const open = document.createElement('span');
    open.className = 'app-open';
    open.textContent = '打开';
    const hidden = document.createElement('span');
    hidden.className = 'visually-hidden';
    hidden.textContent = embeddedIds.has(app?.id) ? '（在插件内打开）' : '（在新窗口打开）';
    card.append(open, hidden);
  }
  return card;
}

function renderApps(query) {
  const grid = document.querySelector('#app-grid');
  const empty = document.querySelector('#app-empty');
  const count = document.querySelector('#app-count');
  const clear = document.querySelector('#app-search-clear');
  const q = textOf(query).trim().toLowerCase();
  const apps = runtime.apps;
  const shown = apps.filter(app => {
    if (!q) return true;
    return (textOf(app?.title) + '\n' + textOf(app?.description)).toLowerCase().includes(q);
  });
  if (clear) clear.hidden = textOf(query).length === 0;
  if (grid) {
    const items = shown.map(app => {
      const item = document.createElement('li');
      item.append(createCard(app));
      return item;
    });
    grid.replaceChildren(...items);
    grid.hidden = shown.length === 0;
  }
  if (empty) {
    empty.hidden = shown.length !== 0;
    empty.textContent = apps.length === 0 ? '当前没有可显示的应用。' : '没有匹配的应用。';
  }
  if (count) {
    count.textContent = q
      ? '显示 ' + shown.length + ' 个，共 ' + apps.length + ' 个'
      : apps.length + ' 个应用';
  }
}

function bindChrome() {
  if (runtime.listening) return;
  runtime.listening = true;
  document.addEventListener('click', onExternalClick);
  const form = document.querySelector('#app-search-form');
  const input = document.querySelector('#app-search');
  const clear = document.querySelector('#app-search-clear');
  form?.addEventListener('submit', event => event.preventDefault());
  input?.addEventListener('input', () => renderApps(input.value));
  input?.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !input.value) return;
    input.value = '';
    renderApps('');
  });
  clear?.addEventListener('click', () => {
    if (!input) return;
    input.value = '';
    renderApps('');
    input.focus();
  });
}

export function initWorkbench(config, options = {}) {
  embeddedIds = new Set(Array.isArray(options.embeddedIds) ? options.embeddedIds : []);
  runtime.apps = Array.isArray(config?.apps) ? config.apps : [];
  bindChrome();
  const input = document.querySelector('#app-search');
  renderApps(input?.value || '');
  return {
    setExternalOpener(fn) {
      runtime.opener = typeof fn === 'function' ? fn : null;
    }
  };
}
