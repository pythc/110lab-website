import {createLabSession} from './lab-session.js';
const status=document.querySelector('#status'),login=document.querySelector('#login'),next=document.querySelector('#continue');
const params=new URLSearchParams(location.search),state=params.get('state'),challenge=params.get('code_challenge');
let busy=false;
const valid=/^[\w-]{43}$/.test(state||'')&&/^[\w-]{43}$/.test(challenge||'')&&params.getAll('state').length===1&&params.getAll('code_challenge').length===1;
const session=createLabSession({apiRoot:'/api/mail/',onStatus:message=>{status.textContent=message;},onChange:profile=>{
  login.hidden=!!profile;next.hidden=!profile;
  if(!profile){status.textContent='使用实验室飞书身份登录';return;}
  if(!['admin','super_admin'].includes(profile.role)){next.hidden=true;status.textContent='考核管理仅向实验室管理员开放';return;}
  void enter();
}});
async function enter(){
  if(busy||!valid)return;busy=true;next.disabled=true;
  try{
    status.textContent='正在进入考核系统';
    const value=await session.request('sso/authorize',{method:'POST',data:{state,challenge,embedded:session.embedded}});
    const url=new URL(value.redirectUrl);
    if(url.origin!=='https://exam.110-lab.cn'||url.pathname!=='/api/auth/feishu/callback')throw new Error('登录返回地址无效');
    location.replace(url.href);
  }catch(error){status.textContent=error.message;busy=false;next.disabled=false;}
}
login.addEventListener('click',()=>session.login());next.addEventListener('click',enter);
if(valid)void session.load();else{status.textContent='登录链接已失效 请从考核系统重新进入';login.hidden=true;next.hidden=true;}
