import {createLabSession} from './lab-session.js';
const $=id=>document.getElementById(id),id=new URL(location.href).searchParams.get('id');
let preview,busy=false;
const labels={'recruitment.notice':'确认面试通知','recruitment.feishu':'确认飞书同步','mail.send':'确认邮件发送','updates.publish':'确认官网发布','updates.withdraw':'确认撤回动态'};
function status(text){$('status').textContent=text;}
function field(label,value){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=typeof value==='string'?value:Array.isArray(value)?value.join('、'):JSON.stringify(value);$('meta').append(dt,dd);}
function block(text){const pre=document.createElement('pre');pre.textContent=text;$('body').append(pre);}
const session=createLabSession({apiRoot:'/api/business/',onStatus:status,onChange(profile){$('login').hidden=!!profile;$('details').hidden=true;if(profile)void load();else status('请使用发起这次操作的飞书身份登录');}});
async function load(){try{preview=await session.request('confirmations/'+encodeURIComponent(id));$('title').textContent=labels[preview.kind]||'确认操作';$('meta').replaceChildren();$('body').replaceChildren();$('reviewed').checked=false;
  field('当前身份',session.profile.name);field('有效期',new Date(preview.expiresAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+' 北京时间');
  const p=preview.preview;
  if(preview.kind==='mail.send'||preview.kind==='recruitment.notice'){
    const m=p.fields||p.payload;field('发件邮箱',m.mailbox||m.from);field('收件人',m.to);if(m.cc?.length)field('抄送',m.cc);if(m.bcc?.length)field('密送',m.bcc);field('回复地址',m.replyTo||m.mailbox||m.from);field('主题',m.subject);if(m.attachments?.length)field('附件',(p.attachmentDetails||[]).map(a=>a.filename+' · '+Math.ceil(a.bytes/1024)+' KB'));block(m.body);
  }else if(preview.kind.startsWith('updates.')){field('公开网站',p.website);if(p.content){field('标题',p.content.title);field('摘要',p.content.summary);for(const b of p.content.body){const el=document.createElement(b.type==='heading'?'h2':b.type==='list'?'ul':'p');const spans=v=>{const e=document.createElement('span');for(const s of v){const n=document.createElement(s.href?'a':s.bold?'strong':'span');n.textContent=s.text;if(s.href){n.href=s.href;n.target='_blank';n.rel='noopener noreferrer';}e.append(n);}return e;};if(b.type==='list')for(const item of b.items){const li=document.createElement('li');li.append(spans(item));el.append(li);}else el.append(spans(b.content));$('body').append(el);}if(p.content.link)field('跳转链接',p.content.link);}else{field('将撤回',p.currentPublic?.title);block(p.currentPublic?.summary||'');}}
  else{field('目标应用',p.payload.appId);field('目标表格',p.payload.target);field('目标记录',p.payload.recordId||'新建');block(JSON.stringify(p.payload.fields,null,2));}
  $('notice').textContent=p.mode==='dry-run'?'本次为模拟操作 不发送邮件 不写入飞书':preview.kind.startsWith('updates.')?'确认内容适合公开 后续将执行指定的官网变更':'确认后会允许执行上方指定操作 请逐项检查';
  $('confirmation').hidden=preview.state!=='PENDING_CONFIRMATION';$('details').hidden=false;status(preview.state==='APPROVED'?'已确认 请返回对话继续执行':preview.state==='COMPLETED'?'本次操作已经执行':'仅确认当前预览 内容改变后需要重新确认');
}catch(e){$('details').hidden=true;status(e.message);}}
$('login').onclick=()=>session.login();
$('confirmation').onsubmit=async e=>{e.preventDefault();if(busy||!preview||!$('reviewed').checked)return;busy=true;$('approve').disabled=true;try{await session.request('confirmations/'+id,{method:'POST',data:{fingerprint:preview.fingerprint}});await load();}catch(e){status(e.message);}finally{busy=false;$('approve').disabled=false;}};
if(location.pathname.endsWith('/embedded'))document.body.classList.add('embedded');
if(!/^[a-f0-9-]{36}$/.test(id||'')){status('确认链接无效');$('login').hidden=true;}else await session.load();
