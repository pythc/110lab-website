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
export async function handleMailExternalRequest(event,{frame,openExternal,callTool}) {
  if(event.origin!=='https://internal.110-lab.cn'||event.source!==frame?.contentWindow)return false;
  const m=event.data;
  if(m?.type==='110lab-mail-host-login'&&/^[\w-]{43}$/.test(m.state||'')&&typeof m.fresh==='boolean'){
    let result,waitingForCallback=false;
    try{
      result=await callTool?.({name:'connect_110lab_mail',arguments:{state:m.state,fresh:m.fresh}});
      const authorization=result?._meta?.mailAuthorization;
      if(authorization){
        waitingForCallback=true;
        const url=new URL(authorization.url);
        if(result.isError||authorization.state!==m.state||url.origin!=='https://internal.110-lab.cn'||url.pathname!=='/authorize'||url.username||url.password||url.hash||typeof openExternal!=='function')throw new Error('Invalid login bridge');
        const opened=await openExternal(url.href);if(opened?.isError)throw new Error('Not opened');
        frame.contentWindow.postMessage({type:'110lab-mail-host-opened',state:m.state},'https://internal.110-lab.cn');
        const deadline=Date.now()+270000;
        for(;;){
          result=await callTool({name:'complete_110lab_mail_login',arguments:{state:m.state}});
          if(!result?._meta?.mailAuthorizationPending)break;
          if(result._meta.mailAuthorizationPending.state!==m.state||Date.now()>=deadline)throw new Error('Login expired');
          await new Promise(resolve=>setTimeout(resolve,1500));
        }
      }
    }catch{if(waitingForCallback)try{await callTool({name:'complete_110lab_mail_login',arguments:{state:m.state,cancel:true}});}catch{}result=null;}
    const handoff=result?._meta?.mailHandoff;
    const valid=!result?.isError&&handoff?.state===m.state&&/^[\w-]{43}$/.test(handoff?.ticket||'');
    frame.contentWindow.postMessage({type:'110lab-mail-host-result',state:m.state,...(valid?{ticket:handoff.ticket}:{updateRequired:!!result?._meta?.['mcp/www_authenticate']})},'https://internal.110-lab.cn');
    return true;
  }
  if(typeof openExternal!=='function')return false;
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
  let toolCaller=null,loginPending=false;
  const actions=document.createElement('div');
  actions.className='workspace-actions';actions.hidden=true;
  const external=document.createElement('a');external.target='_blank';external.rel='noopener noreferrer';external.textContent='独立打开';
  const retry=document.createElement('button');retry.type='button';retry.textContent='重新加载';
  let currentId='workbench';
  external.addEventListener('click',async event=>{if(!externalOpener)return;event.preventDefault();try{await externalOpener(external.href);}catch{}});
  retry.addEventListener('click',()=>{const page=pages.get(currentId);if(page)page.querySelector('iframe').src=EMBEDDED_APPS[currentId].url;});
  actions.append(external,retry);
  const outlet = document.createElement('div');
  outlet.className = 'workspace-outlet';
  outlet.hidden = true;
  main.after(outlet);
  document.querySelector('.masthead-inner')?.append(nav);
  document.querySelector('.masthead-inner')?.append(actions);

  function createPage(id) {
    const app = EMBEDDED_APPS[id];
    const page = document.createElement('section');
    page.className = 'embedded-page';
    page.tabIndex = -1;
    page.setAttribute('aria-label', app.title);
    const frame = document.createElement('iframe');
    frame.title = app.title;
    frame.referrerPolicy = 'no-referrer';
    frame.src = app.url;
    // Each app keeps its own login boundary. The parent never reads credentials,
    // session storage or page contents, and never executes business operations.
    page.append(frame);
    outlet.append(page);
    pages.set(id, page);
    return page;
  }

  function show(id) {
    if (id !== 'workbench' && !Object.hasOwn(EMBEDDED_APPS, id)) return;
    if (id !== 'workbench' && !pages.has(id)) createPage(id);
    currentId=id;actions.hidden=id==='workbench';
    if(id!=='workbench'){external.href=EMBEDDED_APPS[id].externalUrl||EMBEDDED_APPS[id].url;external.setAttribute('aria-label','独立打开'+EMBEDDED_APPS[id].title);retry.hidden=id!=='requirements';}
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
  window.addEventListener('message',async event=>{
    const page=pages.get('public-mail');
    if(!page||page.hidden)return;
    if(event.data?.type==='110lab-mail-host-login'){
      if(loginPending)return;loginPending=true;
      try{await handleMailExternalRequest(event,{frame:page.querySelector('iframe'),openExternal:externalOpener,callTool:toolCaller});}finally{loginPending=false;}
    }else await handleMailExternalRequest(event,{frame:page.querySelector('iframe'),openExternal:externalOpener,callTool:toolCaller});
  });
  return {show,setExternalOpener(opener){externalOpener=opener;},setToolCaller(caller){toolCaller=caller;}};
}
