const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
export function createRecruitmentRoleWorkspace({session,root,onStatus}){
  let disposed=false,generation=0,busy=false,snapshot=null,members=[];
  const button=(title,fn)=>{const n=el('button',title,'rt-button');n.type='button';n.onclick=fn;return n;};
  async function load(){
    const gen=++generation;root.setAttribute('aria-busy','true');
    try{const [roles,directory]=await Promise.all([session.request('hr'),session.request('members')]);if(disposed||gen!==generation)return;snapshot=roles;members=directory.members;render(directory.unavailable);}
    catch(e){if(!disposed)onStatus(e.message,true);}finally{if(!disposed&&gen===generation)root.removeAttribute('aria-busy');}
  }
  async function change(subject,enabled){
    if(busy)return;if(!enabled&&!confirm('移除此成员的 HR 权限？其面试官身份保留，尚未发送给该成员的 HR 提醒会停止。'))return;
    busy=true;for(const n of root.querySelectorAll('button,select,input'))n.disabled=true;
    try{await session.request('hr',{method:'POST',data:{requestId:crypto.randomUUID(),revision:snapshot.revision,subject,enabled}});if(disposed)return;onStatus(enabled?'已添加 HR':'已移除 HR');await load();}
    catch(e){if(!disposed){onStatus(e.message,true);await load();}}
    finally{busy=false;}
  }
  function render(unavailable){
    root.replaceChildren();const heading=el('div',undefined,'rw-page-heading'),copy=el('div');copy.append(el('h2','人员与权限'),el('p','实验室管理员管理 HR，所有成员默认具有面试官身份'));heading.append(copy,button('刷新名单',()=>void load()));root.append(heading);
    const explanation=el('section',undefined,'rw-panel');
    explanation.append(el('h3','权限范围'),el('p','实验室管理员：处理全部招新、维护模板、配置 HR。邮箱配置仍由超级管理员负责。'),el('p','HR：查看和处理候选人、维护邮件模板、确认录取与通知。'),el('p','面试官：只查看分配给自己的候选人，并填写本人的面试安排和面评。'));
    root.append(explanation);
    const panel=el('section',undefined,'rw-panel');panel.append(el('h3','HR 名单 · '+snapshot.members.length+' 人'));
    if(!snapshot.members.length)panel.append(el('p','尚未设置 HR。新的投递提醒会保留在队列中，配置 HR 后发送。','rw-callout'));
    if(snapshot.pendingHrEvents)panel.append(el('p','等待分发的提醒 '+snapshot.pendingHrEvents+' 条','rt-help'));
    if(unavailable)panel.append(el('p','通讯录暂时不可用，请稍后刷新。已有 HR 权限保持有效。','rw-callout'));
    const label=el('label',undefined,'rt-field'),search=el('input');search.type='search';search.placeholder='搜索飞书姓名或邮箱';label.append(el('span','添加 HR'),search);
    const select=el('select');select.setAttribute('aria-label','选择飞书成员');const chosen=new Set(snapshot.members.map(m=>m.subject));
    const filter=()=>{const q=search.value.trim().toLowerCase();select.replaceChildren(new Option('请选择成员',''),...members.filter(m=>!chosen.has(m.subject)&&[m.name,m.email].join(' ').toLowerCase().includes(q)).map(m=>new Option(m.name+(m.email?' · '+m.email:''),m.subject)));};filter();search.oninput=filter;
    label.append(select);panel.append(label,button('添加为 HR',()=>{if(select.value)void change(select.value,true);else onStatus('请先选择一位飞书成员',true);}));
    const list=el('div',undefined,'rw-hr-list');for(const m of snapshot.members){const row=el('div',undefined,'rw-hr-row'),identity=el('div');identity.append(el('strong',m.name),el('p',m.email||'飞书成员','rt-help'));row.append(identity,button('移除 HR',()=>void change(m.subject,false)));list.append(row);}panel.append(list);root.append(panel);
    const notice=el('section',undefined,'rw-panel');notice.append(el('h3','自动提醒'),el('p','每份新的官网投递会通知所有 HR。面试默认 30 分钟，可在安排时调整；计划结束后未提交面评，分别提醒 HR 和面试官一次。'),el('p','通知由“招新工作流”应用发送。候选人详情中的“邮件与通知”可查看发送结果。','rt-help'));root.append(notice);
  }
  return {load,busy:()=>busy,destroy(){disposed=true;generation++;root.replaceChildren();}};
}
