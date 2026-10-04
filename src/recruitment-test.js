import Uppy from '@uppy/core';
import Dashboard from '@uppy/dashboard';
import zhCN from '@uppy/locales/lib/zh_CN.js';
import {createLabSession} from './lab-session.js';

const $=id=>document.getElementById(id);
const stages=[['screening','初筛'],['assessment','考核'],['interview','面试'],['decision','待决策'],['accepted','已录取'],['rejected','未通过']];
const labels=Object.fromEntries(stages);
const noticeLabels={draft:'待审核',approved:'已审核',failed:'模拟失败',simulated:'模拟成功'};
const state={profile:null,items:[],selected:null,archived:false,epoch:0,load:0,opening:0,busy:false,form:null,uppy:null,abort:null};
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
const button=(text,fn,cls='rt-button')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const date=value=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'';
const terminal=c=>['accepted','rejected'].includes(c.stage);
const canManage=profile=>['admin','super_admin'].includes(profile?.role);
const status=(text='',error=false)=>{const n=$('rt-status');n.textContent=text;n.hidden=!text;n.dataset.error=String(error);};
const destroyUpload=()=>{state.abort?.abort();state.abort=null;state.uppy?.destroy();state.uppy=null;};
function closeForm(force=false){if(state.busy&&!force)return;$('rt-form-dialog').close();state.form=null;}
function closeDetail(force=false){if(state.busy&&!force)return;state.opening++;destroyUpload();$('rt-detail').close();state.selected=null;}
function setBusy(value){
  state.busy=value;
  for(const id of ['rt-new','rt-new-empty','rt-refresh','rt-logout','rt-form-submit','rt-form-cancel','rt-form-close','rt-detail-close','rt-detail-done','rt-upload-submit'])$(id).disabled=value;
  for(const b of $('rt-detail-actions').querySelectorAll('button'))b.disabled=value;
  for(const b of $('rt-resume-info').querySelectorAll('button'))b.disabled=value;
  for(const control of $('rt-form-fields').querySelectorAll('input,textarea,select'))control.disabled=value;
  state.uppy?.getPlugin('Dashboard')?.setOptions({disabled:value});
}
function clearPrivate(){
  status();
  state.epoch++;state.load++;state.opening++;
  closeForm(true);closeDetail(true);state.items=[];state.profile=null;setBusy(false);
  $('rt-rows').replaceChildren();$('rt-count').textContent='';$('rt-metrics').replaceChildren();$('rt-detail-info').replaceChildren();$('rt-events').replaceChildren();$('rt-current').replaceChildren();$('rt-detail-actions').replaceChildren();$('rt-form-fields').replaceChildren();$('rt-resume-info').replaceChildren();$('rt-upload').replaceChildren();
  for(const id of ['rt-detail-title','rt-detail-stage','rt-notice-body','rt-notice-subject','rt-upload-status','rt-detail-updated'])$(id).textContent='';
  $('rt-search').value='';$('rt-stage').value='';$('rt-group').replaceChildren(new Option('所有组别',''));
}
const session=createLabSession({onStatus:status,onChange:profile=>{
  const changed=profile?.subject!==state.profile?.subject||profile?.role!==state.profile?.role;
  if(changed||!profile)clearPrivate();
  state.profile=profile;
  const allowed=canManage(profile);
  $('rt-content').hidden=!allowed;$('rt-locked').hidden=allowed;
  $('rt-login').hidden=!!profile;$('rt-logout').hidden=!profile;
  $('rt-login-main').hidden=!!profile;
  $('rt-person').textContent=profile?profile.name+' · '+({super_admin:'超级管理员',admin:'管理员',member:'普通成员'}[profile.role]||'成员'):'未登录';
  $('rt-locked-title').textContent=profile?'暂无招新管理权限':'登录后管理招新';
  $('rt-locked-description').textContent=profile?'请联系实验室超级管理员开通管理员权限':'通过飞书登录后 实验室管理员可处理招新流程';
  if(allowed)void loadCandidates();
}});
$('rt-back').hidden=session.embedded;
$('rt-stage').append(...stages.map(([value,label])=>new Option(label,value)));
async function loadCandidates(){
  if(!canManage(state.profile))return;const epoch=state.epoch,load=++state.load;
  try{
    const result=await session.request('candidates');
    if(epoch!==state.epoch||load!==state.load)return;
    state.items=result.items;
    const group=$('rt-group').value;const groups=[...new Set(state.items.map(c=>c.group))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
    $('rt-group').replaceChildren(new Option('所有组别',''),...groups.map(g=>new Option(g,g)));$('rt-group').value=groups.includes(group)?group:'';
    renderTable();
  }catch(error){if(epoch===state.epoch)status(error.message,true);}
}
function replaceCandidate(candidate){
  const index=state.items.findIndex(c=>c.id===candidate.id);
  if(index<0)state.items.unshift(candidate);else state.items[index]=candidate;
  if(state.selected?.id===candidate.id)state.selected=candidate;
  renderTable();
}
function renderTable(){
  const active=state.items.filter(c=>!c.archived),metrics=[['全部申请',state.items.length],['待处理',active.filter(c=>!terminal(c)).length],['已录取',state.items.filter(c=>c.stage==='accepted').length]];
  $('rt-metrics').replaceChildren(...metrics.map(([label,count])=>{const n=el('div','rt-metric');n.append(el('strong','',count),el('span','',label));return n;}));
  const query=$('rt-search').value.trim().toLocaleLowerCase(),group=$('rt-group').value,stage=$('rt-stage').value;
  const scope=state.items.filter(c=>c.archived===state.archived);
  const filtered=scope.filter(c=>(!stage||c.stage===stage)&&(!group||c.group===group)&&(!query||[c.name,c.email,c.group].some(v=>v.toLocaleLowerCase().includes(query)))).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
  $('rt-empty').hidden=state.items.length>0||state.archived;
  $('rt-list').hidden=!$('rt-empty').hidden;
  $('rt-active').setAttribute('aria-pressed',String(!state.archived));$('rt-archived').setAttribute('aria-pressed',String(state.archived));
  $('rt-rows').replaceChildren(...filtered.map(renderRow));
  if(!filtered.length){
    const row=el('tr'),cell=el('td','rt-table-empty',query||group||stage?'没有符合条件的候选人':state.archived?'暂无归档候选人':'暂无进行中的候选人');
    cell.colSpan=6;row.append(cell);$('rt-rows').append(row);
  }
  $('rt-count').textContent='共 '+filtered.length+' 位候选人';
}
function renderRow(c){
  const row=el('tr');row.dataset.id=c.id;
  const person=el('td','rt-person-cell'),name=button(c.name,()=>void openCandidate(c.id),'rt-name-link');
  person.append(name,el('span','rt-email',c.email));
  const stage=el('td'),badge=el('span','rt-pill',labels[c.stage]);badge.dataset.stage=c.stage;stage.append(badge);
  if(c.notification?.status==='failed')stage.append(el('span','rt-notice-alert','通知模拟失败'));
  const resume=el('td',c.resume?'rt-resume-present':'rt-muted',c.resume?'已上传':'未上传');
  const updated=el('td','rt-updated',date(c.updatedAt));updated.title=new Date(c.updatedAt).toLocaleString('zh-CN');
  const actions=el('td','rt-row-actions');actions.append(button('查看详情',()=>void openCandidate(c.id),'rt-table-action'));
  row.append(person,el('td','rt-group-cell',c.group),stage,resume,updated,actions);return row;
}
async function openCandidate(id){
  if(state.busy||!canManage(state.profile))return;const epoch=state.epoch,opening=++state.opening;
  try{
    const c=await session.request('candidates/'+id);
    if(epoch!==state.epoch||opening!==state.opening)return;
    state.selected=c;renderDetail();if(!$('rt-detail').open)$('rt-detail').showModal();
  }catch(error){if(epoch===state.epoch)status(error.message,true);}
}
function renderDetail(){
  const c=state.selected;if(!c)return;destroyUpload();
  $('rt-detail-title').textContent=c.name;$('rt-detail-stage').textContent=labels[c.stage]+(c.archived?' · 已归档':'');
  const grid=el('div','rt-profile-grid');for(const [label,value] of [['应聘组别',c.group],['联系邮箱',c.email]]){const n=el('div');n.append(el('strong','',label),el('p','',value));grid.append(n);}
  $('rt-detail-info').replaceChildren(grid,el('p','rt-profile-summary',c.summary||'尚未填写简历摘要'));
  const summary=[];
  if(c.assessment)summary.push('考核 '+c.assessment.score+' 分 · '+c.assessment.note);
  if(c.interview){summary.push('面试 '+date(c.interview.at)+' · '+c.interview.interviewer+' · '+c.interview.location);if(c.interview.score!==undefined)summary.push('面试反馈 '+c.interview.score+' 分 · '+c.interview.note);}
  if(c.decisionNote)summary.push('决策记录 '+c.decisionNote);
  if(!summary.length)summary.push(({screening:'查看资料后 完成初筛并选择后续安排',assessment:'考核进行中 完成后记录测试成绩',interview:'安排面试并审核通知内容',decision:'根据评价记录确认本次决策'})[c.stage]||'流程已结束');
  $('rt-current').replaceChildren(...summary.map(v=>el('p','rt-current-summary',v)));
  const actions=[];
  const add=(text,action,values,cls)=>actions.push(button(text,()=>openForm(action,values),cls||'rt-button'));
  if(!c.archived){
    if(c.stage==='screening'){add('通过初筛','screen',{},'rt-button rt-primary');}
    if(c.stage==='assessment')add('记录考核结果','assessment',{},'rt-button rt-primary');
    if(c.stage==='interview'){
      add(c.interview?'调整面试安排':'安排面试','schedule');
      if(c.notification?.status==='draft')add('审核通知','approve_notice',{},'rt-button rt-primary');
      if(['approved','failed'].includes(c.notification?.status)){add(c.notification.status==='failed'?'重试模拟通知':'模拟通知成功','simulate_notice',{fail:false},'rt-button rt-primary');add('模拟发送失败','simulate_notice',{fail:true});}
      if(c.notification?.status==='simulated')add('记录面试反馈','interview',{},'rt-button rt-primary');
    }
    if(c.stage==='decision')add('确认录取','accept',{},'rt-button rt-primary');
    if(!terminal(c))add('结束为未通过','reject',{},'rt-button rt-danger');
    else add('归档候选人','archive');
  }
  $('rt-detail-actions').replaceChildren(...actions);
  $('rt-notice-section').hidden=!c.notification;
  $('rt-notice-state').textContent=c.notification?noticeLabels[c.notification.status]+(c.notification.attempts?' · '+c.notification.attempts+' 次尝试':''):'';
  $('rt-notice-subject').textContent=c.notification?.subject||'';$('rt-notice-body').textContent=c.notification?.body||'';
  $('rt-events').replaceChildren(...[...c.events].reverse().map(event=>{const n=el('li'),head=el('div','rt-event-head');head.append(el('strong','',event.action),el('time','',date(event.at)));n.append(head,el('p','',event.actor+(event.note?' · '+event.note:'')));return n;}));
  $('rt-detail-updated').textContent='更新于 '+date(c.updatedAt);
  renderUpload(c);
}
function renderUpload(c){
  $('rt-resume-info').replaceChildren();$('rt-upload').replaceChildren();$('rt-upload-status').textContent='';
  if(c.resume){const box=el('div','rt-resume-file');box.append(el('strong','',c.resume.filename),el('p','',Math.ceil(c.resume.bytes/1024)+' KB · '+date(c.resume.expiresAt)+' 到期'),button('下载简历',()=>void downloadResume(c)));$('rt-resume-info').append(box);}
  $('rt-upload').hidden=c.archived;$('rt-upload-actions').hidden=c.archived;
  if(c.archived){if(!c.resume)$('rt-resume-info').append(el('p','rt-help','没有保存的测试简历'));return;}
  const epoch=state.epoch,instance=new Uppy({id:'110lab-test-'+c.id,autoProceed:false,restrictions:{maxNumberOfFiles:1,minNumberOfFiles:1,maxFileSize:10*1024*1024,allowedFileTypes:['.pdf','.docx']},locale:zhCN});
  state.uppy=instance;
  instance.use(Dashboard,{target:'#rt-upload',inline:true,width:'100%',height:180,hideUploadButton:true,hideRetryButton:true,hideCancelButton:true,disableThumbnailGenerator:true,proudlyDisplayPoweredByUppy:false,note:'PDF 或 DOCX'});
  let requestId=null,uploaded=null;
  instance.on('file-added',()=>{requestId=null;});instance.on('file-removed',()=>{requestId=null;});
  instance.on('restriction-failed',(_file,error)=>{$('rt-upload-status').textContent=error.message;});
  instance.addUploader(async ids=>{
    const file=instance.getFile(ids[0]);if(!file)return;
    requestId||=crypto.randomUUID();uploaded=null;
    const form=new FormData();form.set('requestId',requestId);form.set('revision',String(c.revision));form.append('resume',file.data,file.name);
    const controller=new AbortController();state.abort=controller;instance.emit('upload-start',[file]);
    try{
      const result=await session.upload('candidates/'+c.id+'/resume',form,controller.signal);
      if(epoch!==state.epoch||state.uppy!==instance)return;
      uploaded=result;instance.emit('upload-success',file,{status:200,body:result});
    }catch(error){
      if(epoch!==state.epoch||state.uppy!==instance)return;
      instance.emit('upload-error',file,error);$('rt-upload-status').textContent=error.message;
      if(error.status===409){requestId=null;await refreshSelected(c.id,epoch);$('rt-upload-status').textContent='资料已更新 请重新选择简历后上传';}
    }finally{if(state.abort===controller)state.abort=null;}
  });
  $('rt-upload-submit').onclick=async()=>{
    if(state.busy||state.uppy!==instance)return;
    if(!instance.getFiles().length){$('rt-upload-status').textContent='请先选择测试简历';return;}
    setBusy(true);$('rt-upload-status').textContent='正在上传';
    try{if(instance.getFiles().some(f=>f.error))await instance.retryAll();else await instance.upload();
      if(epoch!==state.epoch||state.uppy!==instance)return;
      if(uploaded){replaceCandidate(uploaded);renderDetail();$('rt-upload-status').textContent='简历已保存';}
    }catch(error){if(epoch===state.epoch)$('rt-upload-status').textContent=error.message;}
    finally{if(epoch===state.epoch)setBusy(false);}
  };
}
async function downloadResume(c){
  if(state.busy)return;const epoch=state.epoch;setBusy(true);
  try{const blob=await session.download('candidates/'+c.id+'/resume');if(epoch!==state.epoch)return;const url=URL.createObjectURL(blob),link=el('a');link.href=url;link.download=c.resume.filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
  catch(error){if(epoch===state.epoch)status(error.message,true);}finally{if(epoch===state.epoch)setBusy(false);}
}
const actionTitles={create:'新建候选人',screen:'完成初筛',assessment:'记录考核结果',schedule:'安排面试',approve_notice:'审核通知',simulate_notice:'模拟通知',interview:'记录面试反馈',accept:'确认录取',reject:'结束为未通过',archive:'归档候选人'};
function field(name,label,{type='text',value='',required=true,maxLength=2000,placeholder='',min,max}={}){
  const wrap=el('label','rt-field'),input=el(type==='textarea'?'textarea':'input');input.name=name;if(type!=='textarea')input.type=type;input.value=value;input.required=required;input.maxLength=maxLength;input.placeholder=placeholder;if(min!==undefined)input.min=min;if(max!==undefined)input.max=max;
  wrap.append(el('span','',label),input);$('rt-form-fields').append(wrap);return input;
}
function openForm(action,values={}){
  if(state.busy||!canManage(state.profile))return;
  const c=state.selected;if(action!=='create'&&(!c||c.archived))return;
  state.form={action,values,id:action==='create'?null:c.id,revision:c?.revision,request:null};
  const fields=$('rt-form-fields');fields.replaceChildren();$('rt-form-error').hidden=true;
  $('rt-form-title').textContent=actionTitles[action];$('rt-form-submit').textContent=action==='create'?'建立候选人':'确认';
  const intro=text=>fields.append(el('p','rt-form-intro',text));
  if(action==='create'){
    field('name','姓名',{maxLength:80,placeholder:'例如 虚构林澈'});
    const group=field('group','应聘组别',{maxLength:60,placeholder:'选择或填写组别'});group.setAttribute('list','rt-group-options');
    const options=el('datalist');options.id='rt-group-options';options.append(...[...new Set(['产品组','开发组','测试运维组',...state.items.map(v=>v.group)])].map(v=>new Option(v,v)));fields.append(options);
    field('email','联系邮箱',{type:'email',maxLength:254,placeholder:'name@example.com'});
    intro('仅支持 example.com、example.net、example.org 或 .test 虚构邮箱');
    field('summary','简历摘要',{type:'textarea',required:false,placeholder:'项目经历 专长或希望探索的方向'});
  }else if(action==='screen'){
    const wrap=el('label','rt-checkbox'),check=el('input');check.type='checkbox';check.name='assessmentRequired';check.checked=values.assessmentRequired??true;
    wrap.append(check,el('span','','安排考核'));fields.append(wrap);intro('关闭后进入面试安排');field('note','初筛记录',{type:'textarea',required:false});
  }else if(action==='assessment'||action==='interview'){
    intro(action==='assessment'?'记录测试考核成绩 不关联正式考核系统':'记录本次模拟面试的反馈');field('score','评分',{type:'number',min:0,max:100});field('note','评价记录',{type:'textarea'});
  }else if(action==='schedule'){
    const local=value=>{const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
    field('at','面试时间',{type:'datetime-local',value:c.interview?.at?local(c.interview.at):'',min:local(Date.now()+60000)});
    intro('时间按本机时区 '+Intl.DateTimeFormat().resolvedOptions().timeZone+' 填写');
    field('interviewer','面试官',{value:c.interview?.interviewer||'',maxLength:80,placeholder:'虚构面试官'});field('location','地点或会议地址',{value:c.interview?.location||'',maxLength:500});
    if(c.notification)intro('修改安排后 通知需要重新审核');
  }else if(action==='approve_notice'){
    intro('审核以下内容后 才能进行通知模拟');fields.append(el('strong','',c.notification?.subject||''),el('pre','rt-form-preview',c.notification?.body||''));
  }else if(action==='simulate_notice')intro(values.fail?'本次模拟发送失败 可在详情里重试 不会发送真实邮件':'本次模拟发送成功 不会发送真实邮件');
  else if(action==='accept'||action==='reject')field('note','决策理由',{type:'textarea'});
  else if(action==='archive')intro('归档后保留资料和操作记录 可在已归档中查看');
  $('rt-form-dialog').showModal();
}
function formPayload(context){
  const data=new FormData($('rt-form')),text=name=>String(data.get(name)||'').trim();
  if(context.action==='create')return {name:text('name'),email:text('email'),group:text('group'),summary:text('summary')};
  const value={revision:context.revision,action:context.action};
  if(context.action==='screen')Object.assign(value,{assessmentRequired:data.has('assessmentRequired'),note:text('note')});
  if(['assessment','interview'].includes(context.action))Object.assign(value,{score:Number(text('score')),note:text('note')});
  if(context.action==='schedule')Object.assign(value,{at:new Date(text('at')).toISOString(),interviewer:text('interviewer'),location:text('location')});
  if(context.action==='simulate_notice')value.fail=!!context.values.fail;
  if(['accept','reject'].includes(context.action))value.note=text('note');
  return value;
}
async function refreshSelected(id,epoch){
  try{const latest=await session.request('candidates/'+id);if(epoch!==state.epoch)return;replaceCandidate(latest);if(state.selected?.id===id)renderDetail();}
  catch(error){if(epoch===state.epoch)status(error.message,true);}
}
$('rt-form').addEventListener('submit',async event=>{
  event.preventDefault();if(state.busy||!state.form||!$('rt-form').reportValidity())return;
  const context=state.form,epoch=state.epoch,payload=formPayload(context),fingerprint=JSON.stringify(payload);
  if(context.request?.fingerprint!==fingerprint)context.request={fingerprint,id:crypto.randomUUID()};
  setBusy(true);$('rt-form-error').hidden=true;
  try{
    const result=await session.request(context.id?'candidates/'+context.id+'/actions':'candidates',{method:'POST',data:{...payload,requestId:context.request.id}});
    if(epoch!==state.epoch)return;
    closeForm(true);replaceCandidate(result);state.selected=result;renderDetail();if(!$('rt-detail').open)$('rt-detail').showModal();
    status(context.action==='simulate_notice'?(payload.fail?'模拟失败 已记录 可重试':'模拟成功 未发送真实邮件'):'已保存');
    void loadCandidates();
  }catch(error){
    if(epoch!==state.epoch)return;
    if(error.status===409&&context.id){closeForm(true);await refreshSelected(context.id,epoch);status(error.message+' 请查看最新资料后重新操作',true);}
    else{$('rt-form-error').hidden=false;$('rt-form-error').textContent=error.message;}
  }finally{if(epoch===state.epoch)setBusy(false);}
});
for(const id of ['rt-login','rt-login-main'])$(id).addEventListener('click',()=>void session.login());
$('rt-logout').addEventListener('click',async()=>{try{await session.logout();}catch(error){status(error.message,true);}});
$('rt-refresh').addEventListener('click',()=>{status();void session.load();if(state.selected)void refreshSelected(state.selected.id,state.epoch);});
for(const id of ['rt-new','rt-new-empty'])$(id).addEventListener('click',()=>openForm('create'));
for(const id of ['rt-detail-close','rt-detail-done'])$(id).addEventListener('click',()=>closeDetail());
for(const id of ['rt-form-close','rt-form-cancel'])$(id).addEventListener('click',()=>closeForm());
$('rt-detail').addEventListener('cancel',event=>{event.preventDefault();closeDetail();});
$('rt-form-dialog').addEventListener('cancel',event=>{event.preventDefault();closeForm();});
$('rt-active').addEventListener('click',()=>{state.archived=false;renderTable();});$('rt-archived').addEventListener('click',()=>{state.archived=true;renderTable();});
$('rt-search').addEventListener('input',renderTable);$('rt-group').addEventListener('change',renderTable);$('rt-stage').addEventListener('change',renderTable);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!state.busy)void session.load();});
window.addEventListener('message',event=>{if(session.embedded&&event.source===parent&&event.data?.type==='110lab-workspace-activated'&&!state.busy)void session.load();});
setInterval(()=>{if(!document.hidden&&!state.busy&&state.profile)void session.load();},30000);
void session.load();
