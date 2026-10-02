// Only these two owned applications can become embedded pages. Never accept a
// frame URL from tool results, query parameters, messages or local storage.
export const EMBEDDED_APPS = Object.freeze({
  assessment: Object.freeze({title: '考核系统', url: 'https://47.109.176.127'}),
  requirements: Object.freeze({title: '需求平台', url: 'https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x'})
});

export function initEmbeddedWorkspace() {
  const main = document.querySelector('main.shell');
  const footer = document.querySelector('.wb-footer');
  const brand = document.querySelector('.brand-product');
  if (!main) return null;
  const nav = document.createElement('nav');
  nav.className = 'workspace-nav';
  nav.setAttribute('aria-label', '工作区');
  const pages = new Map();
  const controls = new Map();
  const outlet = document.createElement('div');
  outlet.className = 'workspace-outlet';
  outlet.hidden = true;
  main.after(outlet);
  document.querySelector('.masthead-inner')?.append(nav);

  function createPage(id) {
    const app = EMBEDDED_APPS[id];
    const page = document.createElement('section');
    page.className = 'embedded-page';
    page.setAttribute('aria-label', app.title);
    const toolbar = document.createElement('div');
    toolbar.className = 'embedded-toolbar';
    const heading = document.createElement('h2');
    heading.textContent = app.title;
    const external = document.createElement('a');
    external.href = app.url;
    external.target = '_blank';
    external.rel = 'noopener noreferrer';
    external.textContent = '独立窗口打开';
    const frame = document.createElement('iframe');
    frame.title = app.title;
    frame.referrerPolicy = 'no-referrer';
    frame.src = app.url;
    // Each app keeps its own login boundary. The parent never reads credentials,
    // session storage or page contents, and never executes business operations.
    toolbar.append(heading, external);
    page.append(toolbar, frame);
    outlet.append(page);
    pages.set(id, page);
    return page;
  }

  function show(id) {
    if (id !== 'workbench' && !Object.hasOwn(EMBEDDED_APPS, id)) return;
    if (id !== 'workbench' && !pages.has(id)) createPage(id);
    main.hidden = id !== 'workbench';
    if (footer) footer.hidden = id !== 'workbench';
    outlet.hidden = id === 'workbench';
    for (const [key, page] of pages) page.hidden = key !== id;
    for (const [key, control] of controls) {
      control.setAttribute('aria-current', key === id ? 'page' : 'false');
    }
    if (brand) brand.textContent = id === 'workbench' ? '工作台' : EMBEDDED_APPS[id].title;
    // Keep already opened frames mounted while switching so an in-progress
    // answer or requirement edit is not reset by navigation in the plugin.
  }

  for (const [id, title] of [['workbench', '工作台'], ...Object.entries(EMBEDDED_APPS).map(([id, app]) => [id, app.title])]) {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = title;
    control.addEventListener('click', () => show(id));
    controls.set(id, control);
    nav.append(control);
  }
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const card = event.target instanceof Element ? event.target.closest('.app-card[data-app-id]') : null;
    const id = card?.dataset.appId;
    if (!id || !Object.hasOwn(EMBEDDED_APPS, id)) return;
    event.preventDefault();
    show(id);
    controls.get(id)?.focus();
  }, {capture: true});
  show('workbench');
  return {show};
}
