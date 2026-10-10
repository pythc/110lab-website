import {createLabSession} from './lab-session.js';
import {createInterviewWorkspace} from './recruitment-interviews.js';
const $=id=>document.getElementById(id);let workspace=null,identity=null;
const status=(message='',error=false)=>{const n=$('ri-status');n.textContent=message;n.hidden=!message;n.dataset.error=error;};
const session=createLabSession({apiRoot:'/api/recruitment-interviewer/',onStatus:status,onChange:p=>{
  $('ri-person').textContent=p?.name||'未登录';$('ri-login').hidden=!!p;
  if(identity!==p?.subject){workspace?.destroy();workspace=null;identity=p?.subject;}
  if(p&&!workspace){workspace=createInterviewWorkspace({session,root:$('ri-content'),assignment:new URL(location.href).searchParams.get('assignment'),onStatus:status});void workspace.load();}
  else if(!p)status('通过飞书登录后，查看分配给自己的面试');
}});
$('ri-login').onclick=()=>session.login();$('ri-refresh').onclick=()=>{if(!workspace?.dirty()||confirm('刷新会放弃未提交的填写内容，继续？'))void workspace?.load(true);};
window.addEventListener('beforeunload',e=>{if(workspace?.dirty()){e.preventDefault();e.returnValue='';}});
void session.load();
