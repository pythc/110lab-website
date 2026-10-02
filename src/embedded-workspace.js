// Only these owned applications can become embedded pages. Never accept a
// frame URL from tool results, query parameters, messages or local storage.
export const EMBEDDED_APPS = Object.freeze({
  'public-mail': Object.freeze({title:'公共邮箱管理',url:'https://internal.110-lab.cn/mail/embedded',externalUrl:'https://internal.110-lab.cn/mail',nav:false}),
  assessment: Object.freeze({title: '考核系统', url: 'https://47.109.176.127'}),
  requirements: Object.freeze({title: '需求平台', url: 'https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x'}),
  'updates-admin': Object.freeze({
    title: '动态管理',
    url: 'https://internal.110-lab.cn/admin/embedded',
    externalUrl: 'https://internal.110-lab.cn/admin',
    nav: false
  })
});

// Nested application pages cannot open a Codex window themselves. Forward only
// these two exact destinations through the host bridge, never arbitrary links.
export async function handleMailExternalRequest(event,{frame,openExternal}) {
  if(event.origin!=='https://internal.110-lab.cn'||event.source!==frame?.contentWindow||typeof openExternal!=='function')return false;
  const m=event.data;
  if(m?.type==='110lab-mail-open-login'&&/^[\w-]{43}$/.test(m.state||'')&&m.url==='https://internal.110-lab.cn/mail/auth/launch?state='+m.state){
    let opened=false;
    try{const result=await openExternal(m.url);opened=result?.isError!==true;}catch{}
    frame.contentWindow.postMessage({type:'110lab-mail-open-result',state:m.state,opened},'https://internal.110-lab.cn');
    return true;
  }
  if(m?.type==='110lab-mail-open-mailbox'&&m.url==='https://www.feishu.cn/mail'){
    let opened=false;
    try{const result=await openExternal(m.url);opened=result?.isError!==true;}catch{}
    frame.contentWindow.postMessage({type:'110lab-mail-mailbox-result',opened},'https://internal.110-lab.cn');
    return true;
  }
  return false;
}

export function initEmbeddedWorkspace() {
  const main = document.querySelector('main.shell');
  const footer = document.querySelector('.wb-footer');
  const brand = document.querySelector('.brand-product');
  if (!main) return null;
  document.body?.classList.add('is-mcp-workspace');
  const nav = document.createElement('nav');
  nav.className = 'workspace-nav';
  nav.setAttribute('aria-label', '工作区');
  const pages = new Map();
  const controls = new Map();
  let externalOpener=null;
  const outlet = document.createElement('div');
  outlet.className = 'workspace-outlet';
  outlet.hidden = true;
  main.after(outlet);
  document.querySelector('.masthead-inner')?.append(nav);

  function createPage(id) {
    const app = EMBEDDED_APPS[id];
    const page = document.createElement('section');
    page.className = 'embedded-page';
    page.tabIndex = -1;
    page.setAttribute('aria-label', app.title);
    const toolbar = document.createElement('div');
    toolbar.className = 'embedded-toolbar';
    const heading = document.createElement('h2');
    heading.textContent = app.title;
    const external = document.createElement('a');
    external.href = app.externalUrl || app.url;
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
    if (id === 'requirements') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '重新加载';
      retry.addEventListener('click', () => { frame.src = app.url; });
      toolbar.append(retry);
    }
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

  const navApps = Object.entries(EMBEDDED_APPS).filter(([, app]) => app.nav !== false);
  for (const [id, title] of [['workbench', '工作台'], ...navApps.map(([id, app]) => [id, app.title])]) {
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
    (controls.get(id) || pages.get(id))?.focus();
  }, {capture: true});
  show('workbench');
  window.addEventListener('message',event=>{
    const page=pages.get('public-mail');
    if(page&&!page.hidden)void handleMailExternalRequest(event,{frame:page.querySelector('iframe'),openExternal:externalOpener});
  });
  return {show,setExternalOpener(opener){externalOpener=opener;}};
}
