import {parseBody,serializeBody,renderPreview} from './admin-markdown.js';
const login=document.querySelector('#login-form'),editor=document.querySelector('#editor-form'),manager=document.querySelector('#manager'),status=document.querySelector('#admin-status'),list=document.querySelector('#draft-list'),publishDialog=document.querySelector('#publish-dialog'),withdrawDialog=document.querySelector('#withdraw-dialog'),previewButton=document.querySelector('#preview-update'),withdrawButton=document.querySelector('#withdraw-update'),confirmPublic=document.querySelector('#confirm-public'),publishButton=document.querySelector('#publish-update');
let session,current=null,rows=[],dirty=false,busy=false;
const say=message=>{status.textContent=message;};
function mode(loggedIn){manager.hidden=!loggedIn;document.querySelector('#login-panel').hidden=loggedIn;document.querySelector('#logout').hidden=!loggedIn;if(!loggedIn){session=null;current=null;rows=[];dirty=false;list.replaceChildren();editor.reset();publishDialog.close();withdrawDialog.close();}}
async function api(path,body){
  const r=await fetch('/api/admin/'+path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json',...(session?{'X-CSRF-Token':session.csrf}:{})}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  const data=await r.json();if(!r.ok){if(r.status===401&&path!=='login')mode(false);throw Object.assign(new Error(data.error||'暂时无法完成操作'),{status:r.status});}return data;
}
const content=()=>({title:editor.elements.title.value.trim(),summary:editor.elements.summary.value.trim(),body:parseBody(editor.elements.body.value),link:editor.elements.link.value.trim()||null});
function changed(){dirty=true;previewButton.disabled=true;document.querySelector('#draft-state').textContent='未保存修改';}
editor.addEventListener('input',changed);
function renderList(){
  list.replaceChildren();document.querySelector('#list-empty').hidden=rows.length>0;
  for(const row of rows){const li=document.createElement('li'),b=document.createElement('button'),title=document.createElement('strong'),label=document.createElement('span');b.type='button';b.className='draft-select';b.setAttribute('aria-current',String(current?.id===row.id));title.textContent=row.draft.title;
    const state=row.published?(JSON.stringify({...row.draft})===JSON.stringify({title:row.published.title,summary:row.published.summary,body:row.published.body,link:row.published.link})?'已发布':'有未发布修改'):'草稿';
    label.textContent=state+' · '+new Date(row.updatedAt).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'});b.append(title,label);b.addEventListener('click',()=>{if(dirty&&!confirm('有未保存修改 确认离开当前草稿吗'))return;select(row);});li.append(b);list.append(li);}
}
function select(row){
  current=row;dirty=false;editor.reset();document.querySelector('#editor-title').textContent=row?'编辑动态':'新建动态';
  if(row){for(const key of ['title','summary','link'])editor.elements[key].value=row.draft[key]||'';editor.elements.body.value=serializeBody(row.draft.body);}
  previewButton.disabled=!row;withdrawButton.hidden=!row?.published;document.querySelector('#draft-state').textContent=row?(row.published?'已发布':'草稿'):'未保存';renderList();
}
async function refresh(selected){rows=(await api('updates')).updates;if(selected)select(rows.find(r=>r.id===selected)||null);else renderList();}
async function action(fn){if(busy)return;busy=true;for(const b of document.querySelectorAll('#manager button,#publish-dialog button,#withdraw-dialog button'))b.disabled=true;try{await fn();}catch(e){say(e.status===409?e.message+' 保存前请重新选择这条动态':e.message);}finally{busy=false;for(const b of document.querySelectorAll('#manager button,#publish-dialog button,#withdraw-dialog button'))b.disabled=false;previewButton.disabled=!current||dirty;publishButton.disabled=!confirmPublic.checked;}}
login.addEventListener('submit',async e=>{e.preventDefault();const b=login.querySelector('button');b.disabled=true;try{session=await api('login',{username:login.elements.username.value,password:login.elements.password.value});login.elements.password.value='';mode(true);await refresh();select(null);say('');}catch(error){say(error.message);}finally{b.disabled=false;}});
editor.addEventListener('submit',e=>{e.preventDefault();action(async()=>{const value=content();const result=current?await api('updates/'+current.id,{revision:current.revision,content:value}):await api('updates',value);await refresh(result.id);say('草稿已保存');});});
document.querySelector('#new-update').addEventListener('click',()=>{if(dirty&&!confirm('有未保存修改 确认新建动态吗'))return;select(null);say('');editor.elements.title.focus();});
previewButton.addEventListener('click',()=>{if(!current||dirty)return;confirmPublic.checked=false;publishButton.disabled=true;renderPreview(current.draft,document.querySelector('#public-preview'));publishDialog.showModal();});
confirmPublic.addEventListener('change',()=>{publishButton.disabled=!confirmPublic.checked||busy;});
publishButton.addEventListener('click',()=>{if(!current||dirty||!confirmPublic.checked)return;action(async()=>{const result=await api('updates/'+current.id+'/publish',{revision:current.revision,confirmPublic:true});publishDialog.close();await refresh(result.id);say('已发布 官网会自动刷新显示');});});
withdrawButton.addEventListener('click',()=>{if(current?.published)withdrawDialog.showModal();});
document.querySelector('#confirm-withdraw').addEventListener('click',()=>{if(!current)return;action(async()=>{const result=await api('updates/'+current.id+'/withdraw',{revision:current.revision});withdrawDialog.close();await refresh(result.id);say('已撤回 草稿仍保留');});});
document.querySelector('#logout').addEventListener('click',()=>{if(dirty&&!confirm('有未保存修改 确认退出吗'))return;action(async()=>{await api('logout',{});mode(false);say('已退出登录');});});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
try{session=await api('session');mode(true);await refresh();select(null);}catch(e){mode(false);if(e.status!==401)say(e.message);}
