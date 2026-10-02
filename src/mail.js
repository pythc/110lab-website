const embedded=location.pathname==='/mail/embedded',prefix='/api/mail/'+(embedded?'embedded/':'');
let csrf='',revision=null,profile=null,flow=null,busy=false,generation=0,action=null;
const $=id=>document.getElementById(id),labels={super_admin:'超级管理员',admin:'普通管理员',member:'普通成员'};
function message(text=''){ $('message').textContent=text;$('message').hidden=!text; }
async function api(path,{method='GET',data}={}){
  const res=await fetch(prefix+path,{method,credentials:'same-origin',headers:{...(data===undefined?{}:{'Content-Type':'application/json'}),...(method==='POST'&&csrf?{'X-CSRF-Token':csrf}:{})},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(15000)});
  const value=await res.json();if(!res.ok)throw Object.assign(new Error(value.error||'操作失败'),{status:res.status});return value;
}
function tab(id){for(const name of ['mailboxes','administrators','audit'])$(name).hidden=name!==id;document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===id)));}
function clearIdentity(){profile=null;csrf='';revision=null;$('identity').textContent='未登录';$('login').hidden=false;$('logout').hidden=true;$('admin-list').replaceChildren();$('audit-list').replaceChildren();$('member').replaceChildren(new Option('选择成员',''));document.querySelectorAll('[data-tab]:not([data-tab="mailboxes"])').forEach(b=>b.hidden=true);tab('mailboxes');}
function ask(kind,email){action={kind,email,revision};$('confirm-title').textContent={grant:'添加管理员',revoke:'移除管理员',transfer:'转让超级管理员'}[kind];$('confirm-text').textContent=email;$('transfer-warning').hidden=kind!=='transfer';$('confirmation').showModal();}
function renderAdministrators(list,members){
  revision=list.revision;$('admin-list').replaceChildren();$('member').replaceChildren(new Option('选择成员',''));
  for(const a of list.administrators){const row=document.createElement('li'),info=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('small');info.className='admin-info';name.textContent=a.name||a.email;detail.textContent=a.email;info.append(name,detail);row.append(info);
    if(a.role==='super_admin'){const tag=document.createElement('span');tag.className='owner-badge';tag.textContent='超级管理员';row.append(tag);}
    else{const actions=document.createElement('div');actions.className='row-actions';for(const [kind,title] of [['transfer','转让'],['revoke','移除']]){const button=document.createElement('button');button.type='button';button.textContent=title;button.setAttribute('aria-label',title+' '+a.email);button.disabled=kind==='transfer'&&!a.active;button.onclick=()=>ask(kind,a.email);actions.append(button);}row.append(actions);}
    $('admin-list').append(row);
  }
  const existing=new Set(list.administrators.map(a=>a.email));for(const m of members)if(!existing.has(m.email))$('member').append(new Option(m.name+' · '+m.email,m.email));
}
function renderAudit(events){$('audit-list').replaceChildren();for(const e of events){const row=document.createElement('li'),info=document.createElement('div'),text=document.createElement('p'),time=document.createElement('small');info.className='audit-info';text.textContent=({grant:'添加管理员',revoke:'移除管理员',transfer:'转让超级管理员',bootstrap:'初始化超级管理员'}[e.action]||e.action)+' · '+(e.targetEmail||'');const date=e.at;time.textContent=(date?new Date(date).toLocaleString('zh-CN'):'')+' · '+(e.actorEmail||'');info.append(text,time);row.append(info);$('audit-list').append(row);}}
async function load(){
  const epoch=++generation;
  try{const me=await api('session');if(epoch!==generation)return;profile=me;csrf=me.csrf;$('identity').textContent=me.name+' · '+labels[me.role];$('login').hidden=true;$('logout').hidden=false;$('handoff').hidden=true;
    const superAdmin=me.role==='super_admin';document.querySelectorAll('[data-tab]:not([data-tab="mailboxes"])').forEach(b=>b.hidden=!superAdmin);
    if(!superAdmin){$('admin-list').replaceChildren();$('audit-list').replaceChildren();$('member').replaceChildren(new Option('选择成员',''));tab('mailboxes');return;}
    const [admins,members,audit]=await Promise.all([api('administrators'),api('members'),api('audit')]);if(epoch!==generation)return;renderAdministrators(admins,members.members);renderAudit(audit.events);
  }catch(e){if(epoch!==generation)return;if(e.status===401){clearIdentity();return;}if(e.status===403){clearIdentity();message('管理员权限已变更 请重新加载');return;}message(e.message);}
}
async function login(){
  if(busy)return;busy=true;message('');$('login').disabled=true;$('reauth').disabled=true;
  try{flow=await api('auth/start',{method:'POST',data:{}});$('continue-login').href=flow.launchUrl;$('handoff').hidden=false;$('manual-login').open=false;$('login-code').value='';
    if(embedded&&window.parent!==window)requestHostLogin();else location.assign(flow.launchUrl);
  }catch(e){flow=null;$('handoff').hidden=true;message(e.message);}finally{busy=false;$('login').disabled=false;$('reauth').disabled=false;}
}
function requestHostLogin(){if(flow)window.parent.postMessage({type:'110lab-mail-open-login',state:flow.state,url:flow.launchUrl},'*');}
$('continue-login').onclick=e=>{if(embedded&&window.parent!==window){e.preventDefault();login();}};
$('open-mailbox').onclick=e=>{if(embedded&&window.parent!==window){e.preventDefault();window.parent.postMessage({type:'110lab-mail-open-mailbox',url:'https://www.feishu.cn/mail'},'*');}};
async function redeem(ticket){if(busy||!flow)return;busy=true;try{await api('auth/redeem',{method:'POST',data:{state:flow.state,ticket}});flow=null;$('login-code').value='';message('');await load();}catch(e){message(e.message);}finally{busy=false;}}
$('login').onclick=login;$('reauth').onclick=login;
$('code-form').onsubmit=e=>{e.preventDefault();redeem($('login-code').value.trim());};
window.addEventListener('message',e=>{const m=e.data;if(!embedded||e.source!==window.parent)return;
  if(m?.type==='110lab-mail-mailbox-result'){if(!m.opened)message('飞书邮箱未打开 请使用独立窗口');return;}
  if(!flow||m?.type!=='110lab-mail-open-result'||m.state!==flow.state)return;message(m.opened?'请在打开的飞书页面完成授权':'授权窗口未打开 请点击上方链接重试');
});
$('logout').onclick=async()=>{if(busy)return;busy=true;try{await api('logout',{method:'POST',data:{}});generation++;flow=null;clearIdentity();message('');}catch(e){message(e.message);}finally{busy=false;}};
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>tab(b.dataset.tab));
$('grant-form').onsubmit=e=>{e.preventDefault();if($('member').value)ask('grant',$('member').value);};
$('confirmation').addEventListener('close',async()=>{const pending=action;action=null;if($('confirmation').returnValue!=='confirm'||!pending||busy)return;busy=true;$('confirm-action').disabled=true;try{await api('administrators/'+pending.kind,{method:'POST',data:{email:pending.email,revision:pending.revision,confirmed:true}});message('已更新');await load();}catch(e){message(e.message);if([401,403,409].includes(e.status))await load();}finally{busy=false;$('confirm-action').disabled=false;}});
window.addEventListener('focus',()=>{if(!busy&&!flow)load();});
setInterval(()=>{if(!document.hidden&&!busy&&!flow&&profile)load();},60000);
try{const config=await api('config');$('login').disabled=!config.loginAvailable;if(config.loginAvailable)await load();else message('飞书登录尚未配置');}catch(e){$('login').disabled=true;message(e.message);}
