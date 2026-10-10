import {createRecruitmentRoleWorkspace} from './recruitment-roles.js';
import {saveResumeFile} from './resume-download.js';
import Uppy from '@uppy/core';
import Dashboard from '@uppy/dashboard';
import zhCN from '@uppy/locales/lib/zh_CN.js';
import {mailPreview} from './recruitment-mail-editor.js';
import {createLabSession} from './lab-session.js';
import {candidateTask,notificationIssue,taskViews} from './recruitment-tasks.js';
import {createInterviewWorkspace} from './recruitment-interviews.js';
import {createTemplateWorkspace} from './recruitment-template-workspace.js';

const $=id=>document.getElementById(id);
const stages=[['screening','初筛'],['assessment','考核'],['interview','面试'],['decision','待决策'],['accepted','已录取'],['rejected','未通过']];
const labels=Object.fromEntries(stages);
const linkedCandidate=new URL(location.href).searchParams.get('candidate');
const noticeLabels={draft:'待确认',queued:'等待处理',failed:'发送失败',unknown:'结果待核实',sent:'服务商已接收',simulated:'模拟完成'};
const deliveryLabels={HELD:'未发送',QUEUED:'等待处理',SENDING:'处理中',RETRYING:'等待重试',FAILED:'发送失败',UNKNOWN:'结果待核实',SENT:'服务商已接收',SIMULATED:'模拟完成 未外发'};
const state={view:'candidates',queue:'all',filtered:[],detailTab:'work',profile:null,items:[],selected:null,archived:false,epoch:0,load:0,opening:0,busy:false,form:null,uppy:null,abort:null};
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
const button=(text,fn,cls='rt-button')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const date=value=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'';
const terminal=c=>['accepted','rejected'].includes(c.stage);
const canManage=profile=>profile?.recruitmentCapabilities?.manage===true;
const status=(text='',error=false)=>{const n=$('rt-status');n.textContent=text;n.hidden=!text;n.dataset.error=String(error);};
const destroyUpload=()=>{state.abort?.abort();state.abort=null;state.uppy?.destroy();state.uppy=null;};
function closeForm(force=false){if(state.busy&&!force)return;clearTimeout(state.form?.previewTimer);$('rt-form-dialog').close();state.form?.editor?.destroy();state.form=null;}
function closeDetail(force=false){if(state.busy&&!force)return;state.opening++;destroyUpload();clearResumePreview();$('rt-detail').hidden=true;state.selected=null;$('rt-content').hidden=state.view!=='candidates'||!canManage(state.profile);}
function setBusy(value){
  state.busy=value;state.form?.editor?.setDisabled(value);
  for(const id of ['rt-new','rt-new-empty','rt-settings','rt-refresh','rt-logout','rt-form-submit','rt-form-cancel','rt-form-close','rt-detail-close','rt-detail-done','rt-upload-submit'])if($(id))$(id).disabled=value;
  for(const b of $('rt-detail-actions').querySelectorAll('button'))b.disabled=value;
  for(const b of $('rt-resume-info').querySelectorAll('button'))b.disabled=value;
  for(const control of $('rt-form-fields').querySelectorAll('input,textarea,select'))control.disabled=value;
  state.uppy?.getPlugin('Dashboard')?.setOptions({disabled:value});
}
function clearPrivate(){
  status();
  state.epoch++;state.load++;state.opening++;state.openedLinked=false;roleWorkspace?.destroy();roleWorkspace=null;templateWorkspace?.destroy();templateWorkspace=null;interviewWorkspace?.destroy();interviewWorkspace=null;$('rw-templates').replaceChildren();$('rw-interview-list').replaceChildren();
  closeForm(true);closeDetail(true);state.items=[];state.profile=null;setBusy(false);
  $('rt-deliveries').replaceChildren();$('rt-rows').replaceChildren();$('rt-count').textContent='';$('rt-metrics').replaceChildren();$('rt-detail-info').replaceChildren();$('rt-events').replaceChildren();$('rt-current').replaceChildren();$('rt-detail-actions').replaceChildren();$('rt-form-fields').replaceChildren();$('rt-resume-info').replaceChildren();$('rt-upload').replaceChildren();
  for(const id of ['rt-detail-title','rt-detail-stage','rt-notice-body','rt-notice-subject','rt-upload-status','rt-detail-updated'])$(id).textContent='';
  $('rt-search').value='';$('rt-stage').value='';$('rt-group').replaceChildren(new Option('所有组别',''));
}
let roleWorkspace=null,templateWorkspace=null,interviewWorkspace=null,resumeCleanup=null,resumeGeneration=0;
function clearResumePreview(){resumeGeneration++;resumeCleanup?.();resumeCleanup=null;$('rw-resume-preview').replaceChildren();}
const session=createLabSession({apiRoot:'/api/recruitment-admin/',onStatus:status,onChange:profile=>{
  const changed=profile?.subject!==state.profile?.subject||profile?.role!==state.profile?.role||profile?.recruitmentRole!==state.profile?.recruitmentRole;
  if(changed||!profile)clearPrivate();
  state.profile=profile;
  const allowed=canManage(profile);
  $('rt-content').hidden=!allowed||state.view!=='candidates'||!!state.selected;$('rt-locked').hidden=!!profile;$('rw-nav').hidden=!profile;
  for(const n of document.querySelectorAll('[data-view]'))n.hidden=n.dataset.view==='hr'?!profile?.recruitmentCapabilities?.manageHr:!allowed&&n.dataset.view!=='interviews';
  if(profile?.role!=='super_admin')$('rt-settings').hidden=true;
  if(!profile){$('rw-interviews').hidden=true;$('rw-templates').hidden=true;$('rw-hr').hidden=true;}
  $('rt-login').hidden=!!profile;$('rt-logout').hidden=!profile;
  $('rt-login-main').hidden=!!profile;$('rt-settings').hidden=profile?.role!=='super_admin';
  $('rt-person').textContent=profile?profile.name+' · '+(profile.recruitmentRole==='hr'?'HR':{super_admin:'超级管理员',admin:'管理员',member:'面试官'}[profile.role]||'面试官'):'未登录';
  $('rt-locked-title').textContent=profile?'暂无招新管理权限':'登录后管理招新';
  $('rt-locked-description').textContent=profile?'请联系实验室超级管理员开通管理员权限':'通过飞书登录后 实验室管理员可处理招新流程';
  if(allowed)void loadCandidates();
  if(profile&&!allowed&&state.view!=='interviews')void setView('interviews');
  else if(profile&&state.view==='interviews'&&!interviewWorkspace)void setView('interviews');
  else if(profile?.recruitmentCapabilities?.manageHr&&state.view==='hr'&&!roleWorkspace)void setView('hr');
  else if(state.view==='hr'&&!profile?.recruitmentCapabilities?.manageHr)void setView(allowed?'candidates':'interviews');
  else if(allowed&&state.view==='templates'&&!templateWorkspace)void setView('templates');
  if(!allowed)$('rt-mode').textContent=profile?'面试官工作区':'未连接';
}});
$('rt-back').hidden=session.embedded;
$('rt-stage').append(...stages.map(([value,label])=>new Option(label,value)));
async function loadCandidates(){
  if(!canManage(state.profile))return;const epoch=state.epoch,load=++state.load;
  try{
    const result=await session.request('candidates');
    if(epoch!==state.epoch||load!==state.load)return;
    state.items=result.items;state.mode=result.deliveryMode;$('rt-mode').textContent=result.testDeliveryEnabled?'仅指定测试地址可外发':result.deliveryMode==='live'?'正式发送':'仅模拟 不外发';
    const group=$('rt-group').value;const groups=[...new Set(state.items.map(c=>c.group))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
    $('rt-group').replaceChildren(new Option('所有组别',''),...groups.map(g=>new Option(g,g)));$('rt-group').value=groups.includes(group)?group:'';
    renderTable();
    if(!state.openedLinked&&/^[a-f0-9-]{36}$/.test(linkedCandidate||'')){state.openedLinked=true;void openCandidate(linkedCandidate);}
  }catch(error){if(epoch===state.epoch)status(error.message,true);}
}
function replaceCandidate(candidate){
  const index=state.items.findIndex(c=>c.id===candidate.id);
  if(index<0)state.items.unshift(candidate);else state.items[index]=candidate;
  if(state.selected?.id===candidate.id)state.selected=candidate;
  renderTable();
}
function renderTable(){
  const active=state.items.filter(c=>!c.archived),needsAdmin=active.filter(c=>['screening','assessment','assign','review','decision'].includes(candidateTask(c).key)).length;
  $('rt-metrics').replaceChildren(...[['待 HR 处理',needsAdmin],['等待面试官',active.filter(c=>candidateTask(c).key==='waiting').length],['通知异常',active.filter(notificationIssue).length],['已录取',active.filter(c=>c.stage==='accepted').length]].map(([label,count])=>{const n=el('div','rw-metric');n.append(el('span','',label),el('strong','',count));return n;}));
  $('rw-queues').replaceChildren(...[...taskViews.slice(0,4),['waiting','待面试官填写'],...taskViews.slice(4)].map(([key,title])=>{const count=active.filter(c=>key==='all'||key==='attention'?key==='all'||!!notificationIssue(c):candidateTask(c).key===key).length;const b=button(title+' '+count,()=>{state.queue=key;renderTable();},'rw-queue');b.setAttribute('aria-pressed',String(state.queue===key));return b;}));
  const query=$('rt-search').value.trim().toLocaleLowerCase(),group=$('rt-group').value,stage=$('rt-stage').value;
  const filtered=state.items.filter(c=>c.archived===state.archived&&(!stage||c.stage===stage)&&(!group||c.group===group)&&(!query||[c.name,c.email,c.group].some(v=>v.toLocaleLowerCase().includes(query)))&&(state.archived||state.queue==='all'||(state.queue==='attention'?!!notificationIssue(c):candidateTask(c).key===state.queue))).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
  state.filtered=filtered;
  $('rt-empty').hidden=state.items.length>0||state.archived;$('rt-list').hidden=!$('rt-empty').hidden;
  $('rt-active').setAttribute('aria-pressed',String(!state.archived));$('rt-archived').setAttribute('aria-pressed',String(state.archived));
  $('rt-rows').replaceChildren(...filtered.map(renderRow));
  if(!filtered.length){const row=el('tr'),cell=el('td','rt-table-empty','此分类下暂无候选人');cell.colSpan=6;row.append(cell);$('rt-rows').append(row);}
  $('rt-count').textContent='共 '+filtered.length+' 位候选人';
}
function renderRow(c){
  const task=candidateTask(c),row=el('tr');row.dataset.id=c.id;
  const person=el('td','rt-person-cell'),identity=el('div','rw-person-name');identity.append(el('span','rw-avatar',c.name.slice(0,1)),button(c.name,()=>void openCandidate(c.id),'rt-name-link'));person.append(identity,el('span','rt-email',c.group+' · '+c.email));
  const stage=el('td'),badge=el('span','rt-pill',labels[c.stage]);badge.dataset.stage=c.stage;stage.append(el('strong','rw-row-task',task.label),badge);
  const notification=el('td'),issue=notificationIssue(c);notification.append(el('span',issue?'rw-warning':'rt-muted',issue||(['queued'].includes(c.resultNotification?.status)?'结果等待发送':c.resultNotification?.status==='sent'?'结果已发送':c.notification?.status==='queued'?'邀请等待发送':c.notification?.status==='sent'?'邀请已发送':c.receiptStatus==='SENT'?'回执已发送':'—')));
  const actions=el('td','rt-row-actions');actions.append(button(task.action,()=>void openCandidate(c.id),'rt-table-action'));
  row.append(person,stage,el('td','rw-owner',task.owner||'—'),el('td','rw-time',date(c.interview?.at||c.assignment?.proposal?.at)||'待安排'),notification,actions);return row;
}
async function openCandidate(id){
  if(state.busy||!canManage(state.profile))return;const epoch=state.epoch,opening=++state.opening;
  try{
    const c=await session.request('candidates/'+id);
    if(epoch!==state.epoch||opening!==state.opening)return;
    state.selected=c;state.detailTab='work';renderDetail();$('rt-detail').hidden=false;$('rt-content').hidden=true;window.scrollTo({top:0});
  }catch(error){if(epoch===state.epoch)status(error.message,true);}
}
function renderDetail(){
  const c=state.selected;if(!c)return;destroyUpload();
  $('rt-detail-title').textContent=c.name;$('rt-detail-stage').textContent=labels[c.stage]+(c.archived?' · 已归档':'');
  const grid=el('div','rt-profile-grid');for(const [label,value] of [['应聘组别',c.group],['联系邮箱',c.email]]){const n=el('div');n.append(el('strong','',label),el('p','',value));grid.append(n);}
  $('rt-detail-info').replaceChildren(grid);$('rw-summary').textContent=c.summary||'可结合简历查看项目经历与能力';$('rw-task-title').textContent=candidateTask(c).label;
  const summary=[];
  if(c.assessment)summary.push('考核 '+c.assessment.score+' 分 · '+c.assessment.note);
  if(c.interview&&(!c.assignment||c.assignment.status==='approved')){summary.push('面试 '+date(c.interview.at)+' · '+(c.interview.durationMinutes||30)+' 分钟 · '+c.interview.interviewer+' · '+c.interview.location);if(c.interview.score!==undefined&&!c.assignment?.feedback)summary.push('面试反馈 '+c.interview.score+' 分 · '+c.interview.note);}
  if(c.assignment){const a=c.assignment;summary.push('面试官 '+a.name+' · '+({requested:'等待面试官填写',submitted:'待管理员审核',changes_requested:'已退回修改',approved:'安排已确认'}[a.status]||a.status));if(a.proposal&&a.status!=='approved')summary.push('待审核安排 '+date(a.proposal.at)+' · '+(a.proposal.durationMinutes||30)+' 分钟 · '+a.proposal.location+' · '+a.proposal.contact);}
  if(c.decisionNote)summary.push('决策记录 '+c.decisionNote);
  if(!summary.length)summary.push(({screening:'查看资料后 完成初筛并选择后续安排',assessment:'考核进行中 完成后记录成绩',interview:'安排面试并审核通知内容',decision:'根据评价记录确认本次决策'})[c.stage]||'流程已结束');
  $('rt-current').replaceChildren(...summary.map(v=>el('p','rt-current-summary',v)));
  const actions=[];
  const add=(text,action,values,cls)=>actions.push(button(text,()=>openForm(action,values),cls||'rt-button'));
  if(!c.archived){
    if(c.stage==='screening')add('审核通过，选择下一步','screen',{},'rt-button rt-primary');
    if(c.stage==='assessment')add('记录考核结果','assessment',{},'rt-button rt-primary');
    if(c.stage==='interview'){
      if(!c.assignment&&!c.interview)add('分配面试官','assign_interviewer',{},'rt-button rt-primary');
      else if(c.assignment?.status==='submitted'||!c.assignment&&c.interview&&!['sent','simulated','queued','unknown'].includes(c.notification?.status)){
        if(c.notification?.status==='draft')actions.push(button('继续审核并发送邀请',()=>void previewDelivery('interview'),'rt-button rt-primary'));
        else add('审核安排与邀请邮件','prepare_notice',{},'rt-button rt-primary');
        if(c.notification?.status==='draft')add('修改邀请内容','prepare_notice');
        if(c.assignment?.status==='submitted')add('退回修改','return_interview');
      }else if(c.assignment?.status==='approved')add('发起改期','reschedule');
      if(['requested','changes_requested','submitted'].includes(c.assignment?.status)&&!['queued','unknown'].includes(c.notification?.status))add('更换面试官','assign_interviewer');
      if(!c.assignment&&['simulated','sent'].includes(c.notification?.status))add('补录历史面试评价','interview');
    }
    if(c.stage==='decision')add('录取并审核通知','prepare_outcome',{outcome:'accepted'},'rt-button rt-primary');
    if(!terminal(c))add('未通过','prepare_outcome',{outcome:'rejected'},'rt-button rt-danger');
    else{if(['failed','draft'].includes(c.resultNotification?.status))add('重新准备结果通知','prepare_outcome',{outcome:c.stage},'rt-button rt-primary');add('归档候选人','archive');}
  }
  if(!c.archived&&c.resultNotification?.status==='draft'&&c.resultDraftValid)actions.push(button('继续审核'+(c.resultNotification.outcome==='accepted'?'录取':'未通过')+'通知',()=>void previewDelivery('outcome'),'rt-button'));
  const feedback=c.assignment?.feedback;$('rw-feedback').replaceChildren();
  if(feedback){$('rw-feedback').append(el('h3','','面试评价'),el('p','rw-score',feedback.score+' / 100'),el('p','',({recommend:'建议录取',consider:'建议进一步讨论',decline:'建议不录取'}[feedback.recommendation])),el('p','rw-feedback-note',feedback.note),el('p','rt-help',feedback.by+' · '+date(feedback.at)));}
  else if(c.assignment?.status==='approved')$('rw-feedback').append(el('p','rw-callout','等待 '+c.assignment.name+' 完成面试并提交评价'));
  for(const b of document.querySelectorAll('[data-detail-tab]'))b.setAttribute('aria-pressed',String(b.dataset.detailTab===state.detailTab));
  for(const panel of document.querySelectorAll('[data-detail-panel]'))panel.hidden=panel.dataset.detailPanel!==state.detailTab;
  const index=state.filtered.findIndex(v=>v.id===c.id);$('rw-previous').disabled=index<=0;$('rw-next').disabled=index<0||index>=state.filtered.length-1;
  const issue=notificationIssue(c);if(issue)actions.unshift(button(issue+' · 查看处理',()=>document.querySelector('[data-detail-tab=communications]').click(),'rt-button rw-warning'));
  $('rt-detail-actions').replaceChildren(...actions);renderDeliveries(c);
  $('rt-notice-section').hidden=!c.notification;
  $('rt-notice-state').textContent=c.notification?noticeLabels[c.notification.status]+(c.notification.attempts?' · '+c.notification.attempts+' 次尝试':''):'';
  $('rt-notice-subject').textContent=c.notification?`${c.notification.subject} · 发件 ${c.notification.from} · 回复 ${c.notification.replyTo}`:'';$('rt-notice-body').textContent=c.notification?.body||'';
  $('rt-events').replaceChildren(...[...c.events].reverse().map(event=>{const n=el('li'),head=el('div','rt-event-head');head.append(el('strong','',event.action),el('time','',date(event.at)));n.append(head,el('p','',event.actor+(event.note?' · '+event.note:'')));return n;}));
  $('rt-detail-updated').textContent='更新于 '+date(c.updatedAt);
  renderUpload(c);
}
function renderUpload(c){
  $('rt-resume-info').replaceChildren();$('rt-upload').replaceChildren();$('rt-upload-status').textContent='';
  clearResumePreview();$('rw-upload-disclosure').hidden=c.archived;
  if(c.resume){const box=el('div','rt-resume-file');box.append(el('strong','',c.resume.filename),el('p','',Math.ceil(c.resume.bytes/1024)+' KB · '+'永久保留'),button(c.resume.extension==='pdf'?'预览简历':'下载 DOCX 简历',()=>void (c.resume.extension==='pdf'?previewResume(c):downloadResume(c))),button('下载',()=>void downloadResume(c)));$('rt-resume-info').append(box);}
  $('rt-upload').hidden=c.archived;$('rt-upload-actions').hidden=c.archived;
  if(c.archived){if(!c.resume)$('rt-resume-info').append(el('p','rt-help','没有保存的简历'));return;}
  const epoch=state.epoch,instance=new Uppy({id:'110lab-recruitment-'+c.id,autoProceed:false,restrictions:{maxNumberOfFiles:1,minNumberOfFiles:1,maxFileSize:10*1024*1024,allowedFileTypes:['.pdf','.docx']},locale:zhCN});
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
    if(!instance.getFiles().length){$('rt-upload-status').textContent='请先选择简历';return;}
    setBusy(true);$('rt-upload-status').textContent='正在上传';
    try{if(instance.getFiles().some(f=>f.error))await instance.retryAll();else await instance.upload();
      if(epoch!==state.epoch||state.uppy!==instance)return;
      if(uploaded){await refreshSelected(c.id,epoch);$('rt-upload-status').textContent='简历已保存';}
    }catch(error){if(epoch===state.epoch)$('rt-upload-status').textContent=error.message;}
    finally{if(epoch===state.epoch)setBusy(false);}
  };
}
async function downloadResume(c){
  if(state.busy)return;const epoch=state.epoch;setBusy(true);
  try{status('正在下载简历');const blob=await session.download('candidates/'+c.id+'/resume');if(epoch!==state.epoch)return;await saveResumeFile(blob,c.resume.filename,{embedded:session.embedded,current:()=>epoch===state.epoch,onStatus:status});if(epoch===state.epoch)status('已发起简历下载，请查看客户端保存窗口或下载列表');}
  catch(error){if(epoch===state.epoch)status(error.message,true);}finally{if(epoch===state.epoch)setBusy(false);}
}
const actionTitles={reschedule:'发起面试改期',send_receipt:'检查并发送投递回执',assign_interviewer:'分配飞书面试官',return_interview:'退回面试安排',prepare_outcome:'结果邮件预览',send_outcome:'确认决定并发送结果邮件',create:'新建候选人',screen:'完成初筛',assessment:'记录考核结果',schedule:'安排面试',interview:'记录面试反馈',accept:'确认录取',reject:'结束为未通过',archive:'归档候选人',prepare_notice:'审核面试安排',send_notice:'审核并发送面试邀请',confirm_forward:'确认简历转送',sync_feishu:'确认飞书联动',retry_delivery:'重试投递',resolve_delivery:'核实投递结果',settings:'邮箱设置',templates:'邮件模板'};
function field(name,label,{type='text',value='',required=true,maxLength=2000,placeholder='',min,max}={}){
  const wrap=el('label','rt-field'),input=el(type==='textarea'?'textarea':'input');input.name=name;if(type!=='textarea')input.type=type;input.value=value;input.required=required;input.maxLength=maxLength;input.placeholder=placeholder;if(min!==undefined)input.min=min;if(max!==undefined)input.max=max;
  wrap.append(el('span','',label),input);$('rt-form-fields').append(wrap);return input;
}
function openForm(action,values={}){
  if(state.busy||!canManage(state.profile))return;
  const c=state.selected;if(!['create','settings','templates'].includes(action)&&(!c||c.archived&&action!=='resolve_delivery'))return;
  state.form={action,values,id:['create','settings','templates'].includes(action)?null:c.id,revision:c?.revision,request:null};
  const fields=$('rt-form-fields');fields.oninput=null;fields.replaceChildren();$('rt-form-error').hidden=true;
  $('rt-form-dialog').classList.toggle('rt-mail-form',['templates','prepare_notice','prepare_outcome','send_notice','send_outcome','send_receipt'].includes(action));
  $('rt-form-title').textContent=actionTitles[action];$('rt-form-submit').textContent=({create:'建立候选人',screen:'通过初筛',assessment:'保存考核结果',assign_interviewer:'分配并通知面试官',return_interview:'退回并通知',reschedule:'发起改期并通知',prepare_notice:'下一步：检查发送内容',prepare_outcome:'下一步：检查结果通知',send_notice:'批准安排并发送邀请',send_outcome:'确认决定并发送通知',send_receipt:'发送投递回执',settings:'保存设置'})[action]||'保存';
  $('rw-form-step').textContent=['prepare_notice','prepare_outcome'].includes(action)?'1 / 2 · 核对信息':['send_notice','send_outcome'].includes(action)?'2 / 2 · 确认发送':'';
  const intro=text=>fields.append(el('p','rt-form-intro',text));
  if(action==='create'){
    field('name','姓名',{maxLength:80,placeholder:'候选人姓名'});
    const group=field('group','应聘组别',{maxLength:60,placeholder:'选择或填写组别'});group.setAttribute('list','rt-group-options');
    const options=el('datalist');options.id='rt-group-options';options.append(...[...new Set(['产品组','开发组','测试运维组',...state.items.map(v=>v.group)])].map(v=>new Option(v,v)));fields.append(options);
    field('email','联系邮箱',{type:'email',maxLength:254,placeholder:'name@example.com'});
    intro('姓名和邮箱用于投递与招新联系');
    field('summary','简历摘要',{type:'textarea',required:false,placeholder:'项目经历 专长或希望探索的方向'});
  }else if(action==='screen'){
    const wrap=el('label','rt-checkbox'),check=el('input');check.type='checkbox';check.name='assessmentRequired';check.checked=values.assessmentRequired??false;
    wrap.append(check,el('span','','先进入考核'));fields.append(wrap);intro('不勾选时直接进入面试官分配；勾选后需要手工记录考核成绩。');field('note','初筛记录',{type:'textarea',required:false});
  }else if(action==='assessment'||action==='interview'){
    intro(action==='assessment'?'记录考核成绩与评价':'记录本次面试的反馈');field('score','评分',{type:'number',min:0,max:100});field('note','评价记录',{type:'textarea'});
  }else if(action==='assign_interviewer'){void interviewerSelect(state.form);
  }else if(action==='return_interview'||action==='reschedule'){if(action==='reschedule')intro('保留原安排并请面试官重新填写。新安排审核前，不会向候选人发送新邀请。');field('note','修改说明',{type:'textarea',maxLength:2000});
  }else if(action==='prepare_outcome'){field('note','发给候选人的结果说明',{type:'textarea',maxLength:2000,value:c.resultNotification?.outcome===values.outcome?c.resultNotification.decisionNote||'':''});void templateVariables(state.form,values.outcome);
  }else if(action==='schedule'){
    const local=value=>{const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
    field('at','面试时间',{type:'datetime-local',value:c.interview?.at?local(c.interview.at):'',min:local(Date.now()+60000)});
    intro('时间按本机时区 '+Intl.DateTimeFormat().resolvedOptions().timeZone+' 填写');
    field('interviewer','面试官',{value:c.interview?.interviewer||'',maxLength:80,placeholder:'面试官姓名'});field('email','面试官邮箱（候选人回复地址）',{type:'email',maxLength:254,value:c.interview?.email||''});field('contact','面试官联系方式',{maxLength:500,value:c.interview?.contact||''});field('location','地点或会议地址',{value:c.interview?.location||'',maxLength:500});
    if(c.notification)intro('修改安排后 通知需要重新审核');
  }else if(action==='prepare_notice'){
    void templateVariables(state.form);
  }else if(['send_notice','send_outcome','send_receipt','confirm_forward','sync_feishu'].includes(action)){
    const p=values.preview;intro(p.mode==='live'?'确认后将交给发送服务处理':'当前只执行模拟 不对外发送');
    if(action==='sync_feishu')fields.append(el('pre','rt-form-preview',JSON.stringify(p.payload,null,2)));
    else fields.append(el('p','rt-form-intro',`发件人 ${p.payload.from}\n收件人 ${p.payload.to}\n回复地址 ${p.payload.replyTo}`),el('strong','',p.payload.subject));
    if(p.payload.html)void mailPreview(session,p.payload,fields);else fields.append(el('pre','rt-form-preview',p.payload.body));
    const wrap=el('label','rt-checkbox'),check=el('input');check.type='checkbox';check.required=true;wrap.append(check,el('span','','我已逐项检查此候选人的收件地址和内容'));fields.append(wrap);
  }else if(action==='retry_delivery'){const job=c.deliveries.find(d=>d.id===values.deliveryId);intro('仅重试该任务的原始内容 不修改收件人和模板');fields.append(el('pre','rt-form-preview',['feishu','interviewer','hr_intake','hr_feedback_reminder','interviewer_feedback_reminder'].includes(job.kind)?JSON.stringify(job.payload.fields||job.payload,null,2):`发件 ${job.payload.from}\n收件 ${job.payload.to}\n回复 ${job.payload.replyTo}\n\n${job.payload.subject}\n\n${job.payload.body}`));const wrap=el('label','rt-checkbox'),check=el('input');check.type='checkbox';check.required=true;wrap.append(check,el('span','','我已检查此候选人的重试内容'));fields.append(wrap);
  }else if(action==='resolve_delivery'){
    selectField('outcome','核实结果',[['not_sent','确认未发送'],['sent','确认服务商已接收']]);field('note','核实依据',{type:'textarea'});
  }else if(action==='settings'){renderSettings(values.settings);
  }  else if(action==='accept'||action==='reject')field('note','决策理由',{type:'textarea'});
  else if(action==='archive')intro('归档后保留资料和操作记录 可在已归档中查看');
  $('rt-form-dialog').showModal();
}
function formPayload(context){
  const data=new FormData($('rt-form')),text=name=>String(data.get(name)||'').trim();
  if(context.action==='create')return {name:text('name'),email:text('email'),group:text('group'),summary:text('summary')};
  const value={revision:context.revision,action:context.action};
  if(context.action==='screen')Object.assign(value,{assessmentRequired:data.has('assessmentRequired'),note:text('note')});
  if(['assessment','interview'].includes(context.action))Object.assign(value,{score:Number(text('score')),note:text('note')});
  if(context.action==='schedule')Object.assign(value,{at:new Date(text('at')).toISOString(),interviewer:text('interviewer'),email:text('email'),contact:text('contact'),location:text('location')});
  if(context.action==='assign_interviewer')value.subject=text('memberSubject');
  if(['return_interview','reschedule'].includes(context.action))value.note=text('note');
  if(['prepare_notice','prepare_outcome'].includes(context.action)){const template=context.templates?.find(t=>t.id===text('templateId'));if(!template)throw new Error('请选择邮件模板');Object.assign(value,{templateId:template.id,templateRevision:template.revision,sender:text('sender'),values:Object.fromEntries(template.variables.map(v=>[v.key,text('variable:'+v.key)]))});}
  if(context.action==='prepare_outcome'){delete value.sender;value.outcome=context.values.outcome;value.note=text('note');}
  if(['send_notice','send_outcome','send_receipt','confirm_forward','sync_feishu'].includes(context.action))value.previewHash=context.values.preview.previewHash;
  if(['retry_delivery','resolve_delivery'].includes(context.action))value.deliveryId=context.values.deliveryId;
  if(context.action==='resolve_delivery')Object.assign(value,{outcome:text('outcome'),note:text('note')});
  if(context.action==='settings')return settingsPayload(data,context);
  if(['accept','reject'].includes(context.action))value.note=text('note');
  return value;
}
async function refreshSelected(id,epoch){
  try{const latest=await session.request('candidates/'+id);if(epoch!==state.epoch)return;replaceCandidate(latest);if(state.selected?.id===id)renderDetail();}
  catch(error){if(epoch===state.epoch)status(error.message,true);}
}
$('rt-form').addEventListener('submit',async event=>{
  event.preventDefault();if(state.busy||!state.form||!$('rt-form').reportValidity())return;
  const context=state.form,epoch=state.epoch;let payload;try{payload=formPayload(context);}catch(e){$('rt-form-error').hidden=false;$('rt-form-error').textContent=e.message;return;}const fingerprint=JSON.stringify(payload);
  if(context.request?.fingerprint!==fingerprint)context.request={fingerprint,id:crypto.randomUUID()};
  setBusy(true);$('rt-form-error').hidden=true;
  try{
    const result=await session.request(['settings','templates'].includes(context.action)?context.action:context.id?'candidates/'+context.id+'/actions':'candidates',{method:'POST',data:{...payload,requestId:context.request.id}});
    if(epoch!==state.epoch)return;
    closeForm(true);if(!['settings','templates'].includes(context.action)){state.selected=result;await refreshSelected(result.id,epoch);if(epoch!==state.epoch)return;$('rt-detail').hidden=false;$('rt-content').hidden=true;}
    status(({screen:'初筛已通过',assign_interviewer:'已分配，正在通知面试官',send_notice:'安排已批准，邀请已进入发送队列',send_outcome:'决定已保存，结果通知已进入发送队列',reschedule:'改期已发起，等待面试官重新填写'})[context.action]||'已保存');
    if(['prepare_notice','prepare_outcome'].includes(context.action)){setBusy(false);await previewDelivery(context.action==='prepare_notice'?'interview':'outcome');}
    void loadCandidates();
  }catch(error){
    if(epoch!==state.epoch)return;
    if(error.status===409&&context.id){await refreshSelected(context.id,epoch);if(epoch!==state.epoch)return;$('rt-form-error').hidden=false;$('rt-form-error').textContent=error.message+'。本次未提交，填写内容已保留；请复制需要保留的内容，关闭表单后重新检查最新资料。';}
    else{$('rt-form-error').hidden=false;$('rt-form-error').textContent=error.message;}
  }finally{if(epoch===state.epoch)setBusy(false);}
});
for(const id of ['rt-login','rt-login-main'])$(id).addEventListener('click',()=>void session.login());
$('rt-logout').addEventListener('click',async()=>{if(templateWorkspace?.busy()||interviewWorkspace?.busy())return;if((templateWorkspace?.dirty()||interviewWorkspace?.dirty())&&!confirm('有未保存的内容，确定退出？'))return;try{await session.logout();}catch(error){status(error.message,true);}});
$('rt-refresh').addEventListener('click',()=>{status();void session.load();if(state.selected)void refreshSelected(state.selected.id,state.epoch);});
for(const id of ['rt-new','rt-new-empty'])$(id).addEventListener('click',()=>openForm('create'));
for(const id of ['rt-detail-close','rt-detail-done'])$(id).addEventListener('click',()=>closeDetail());
for(const id of ['rt-form-close','rt-form-cancel'])$(id).addEventListener('click',()=>closeForm());

$('rt-form-dialog').addEventListener('cancel',event=>{event.preventDefault();closeForm();});
$('rt-active').addEventListener('click',()=>{state.archived=false;renderTable();});$('rt-archived').addEventListener('click',()=>{state.archived=true;renderTable();});
$('rt-search').addEventListener('input',renderTable);$('rt-group').addEventListener('change',renderTable);$('rt-stage').addEventListener('change',renderTable);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!state.busy)void session.load();});
window.addEventListener('message',event=>{if(session.embedded&&event.source===parent&&event.data?.type==='110lab-workspace-activated'&&!state.busy)void session.load();});
setInterval(()=>{if(!document.hidden&&!state.busy&&state.profile){void session.load();if(state.selected&&!$('rt-form-dialog').open&&!state.uppy?.getFiles().length&&state.selected.deliveries?.some(d=>['QUEUED','SENDING','RETRYING'].includes(d.status)))void refreshSelected(state.selected.id,state.epoch);}},10000);
void session.load();

function selectField(name,label,options,value){
  const wrap=el('label','rt-field'),input=el('select');input.name=name;input.append(...options.map(([id,title])=>new Option(title,id)));if(value!==undefined)input.value=value;
  wrap.append(el('span','',label),input);$('rt-form-fields').append(wrap);return input;
}
async function previewDelivery(kind){
  if(state.busy||!state.selected)return;const c=state.selected,epoch=state.epoch;setBusy(true);
  try{const preview=await session.request('candidates/'+c.id+'/preview-'+kind);if(epoch!==state.epoch||state.selected?.id!==c.id)return;setBusy(false);openForm(({receipt:'send_receipt',interview:'send_notice',outcome:'send_outcome',application:'confirm_forward',feishu:'sync_feishu'})[kind],{preview});}
  catch(error){if(epoch===state.epoch)status(error.message,true);}finally{if(epoch===state.epoch)setBusy(false);}
}
function renderDeliveries(c){
  $('rt-deliveries').replaceChildren(...(c.deliveries||[]).map(job=>{
    const box=el('article','rt-delivery'),head=el('div','rt-section-heading');
    head.append(el('strong','',({interview:'面试邮件',receipt:'投递回执',outcome:'结果邮件',interviewer:'面试官通知',hr_intake:'HR 新投递提醒',hr_feedback_reminder:'HR 面评跟进提醒',interviewer_feedback_reminder:'面试官面评提醒',application:'简历转送',feishu:'历史表格同步'})[job.kind]),el('span','rt-pill',deliveryLabels[job.status]));
    box.append(head,el('p','rt-help',date(job.updatedAt)+(job.payload.recipientName?' · '+job.payload.recipientName:'')+' · '+(job.mode==='live'?'正式任务':'模拟任务')+' · 尝试 '+job.attempts+' 次'),el('p','rt-help','任务 '+job.id+(job.error?' · '+job.error:'')));
    const detail=el('details'),summary=el('summary','','查看已确认内容和处理记录');
    detail.append(summary,el('pre','rt-form-preview',['feishu','interviewer','hr_intake','hr_feedback_reminder','interviewer_feedback_reminder'].includes(job.kind)?JSON.stringify(job.payload.fields||job.payload,null,2):`发件 ${job.payload.from}\n收件 ${job.payload.to}\n回复 ${job.payload.replyTo}\n\n${job.payload.subject}\n\n${job.payload.body}`));
    for(const e of job.events||[])detail.append(el('p','rt-help',date(e.at)+' · '+(deliveryLabels[e.status]||e.status)+(e.code?' · '+e.code:'')));
    box.append(detail);
    if(!c.archived&&job.kind==='receipt'&&['FAILED','HELD','SIMULATED'].includes(job.status)&&c.deliveries.find(d=>d.kind==='receipt')?.id===job.id)box.append(button('重新预览回执',()=>void previewDelivery('receipt')));
    if(!c.archived&&job.status==='FAILED')box.append(button('检查后重试',()=>openForm('retry_delivery',{deliveryId:job.id})));
    if(job.status==='UNKNOWN')box.append(button('登记核实结果',()=>openForm('resolve_delivery',{deliveryId:job.id})));
    return box;
  }));
  if(!c.deliveries?.length)$('rt-deliveries').append(el('p','rt-help','暂无投递记录'));
}
async function templateVariables(context,kind='interview'){
  const epoch=state.epoch;$('rt-form-submit').disabled=true;
  try{
    const [result,settings]=await Promise.all([session.request('templates'),session.request('settings')]);if(state.form!==context||epoch!==state.epoch)return;
    result.items=result.items.filter(t=>(t.kind||'interview')===kind);context.templates=result.items;
    const c=state.selected,proposal=c.assignment?.proposal||c.interview,previous=kind==='interview'?c.notification:c.resultNotification?.outcome===kind?c.resultNotification:null;
    if(kind==='interview'&&proposal)$('rt-form-fields').append(el('p','rw-callout',c.name+' · '+date(proposal.at)+'\n面试官 '+(proposal.interviewer||c.assignment?.name)+'\n'+proposal.location+'\n回复邮箱 '+proposal.email));
    if(kind==='interview')selectField('sender','发件邮箱',settings.mailboxes.filter(m=>m.enabled).map(m=>[m.address,m.label+' · '+m.address]),previous?.from||settings.sender);
    const selector=selectField('templateId','邮件模板',result.items.map(t=>[t.id,t.name])),container=el('div','rt-form-fields'),preview=el('section','rw-composition-preview'),hint=el('p','rt-help','正在生成预览');
    $('rt-form-fields').append(container,hint,preview);if(result.items.some(t=>t.id===previous?.templateId))selector.value=previous.templateId;let generation=0;
    const update=async()=>{const gen=++generation;try{const p=formPayload(context);delete p.action;delete p.outcome;
      const result=await session.request('candidates/'+context.id+'/actions',{method:'POST',data:{...p,action:'preview_composition',kind}});
      if(state.form!==context||epoch!==state.epoch||gen!==generation)return;const content=el('div');await mailPreview(session,result.payload,content);if(state.form!==context||gen!==generation)return;
      preview.replaceChildren(el('h3','',result.payload.subject),content);hint.textContent='收件人 '+result.payload.to+' · 回复地址 '+result.payload.replyTo;
    }catch(e){if(state.form===context&&gen===generation){preview.replaceChildren();hint.textContent=e.message;}}};
    const queue=()=>{clearTimeout(context.previewTimer);generation++;context.previewTimer=setTimeout(()=>void update(),700);};
    const render=()=>{container.replaceChildren();const t=result.items.find(t=>t.id===selector.value);if(!t)return;
      for(const v of t.variables){const n=field('variable:'+v.key,v.label,{value:previous?.templateId===t.id?(previous.variables?.[v.key]??v.defaultValue):v.defaultValue,required:v.required,maxLength:1000});container.append(n.parentElement);}queue();};
    selector.addEventListener('change',render);$('rt-form-fields').oninput=queue;render();
    if(!result.items.length)throw Error('没有此用途的模板，请先在邮件模板中建立');
  }catch(e){if(state.form===context){$('rt-form-error').hidden=false;$('rt-form-error').textContent=e.message;}}
  finally{if(state.form===context&&epoch===state.epoch)$('rt-form-submit').disabled=!context.templates?.length;}
}
function renderSettings(s){
  const fields=$('rt-form-fields'),rows=el('div');rows.id='rt-mailbox-rows';
  fields.append(el('p','rt-help','收信地址用于官网投递说明与尚无面试官时的回复地址 发信地址用于招新邮件'),rows);
  const add=(value={address:'',label:'',enabled:true})=>{
    const row=el('div','rt-config-row');
    for(const [key,label]of [['address','邮箱地址'],['label','邮箱名称']]){const n=el('input');n.dataset.key=key;n.type=key==='address'?'email':'text';n.value=value[key];n.placeholder=label;n.setAttribute('aria-label',label);n.required=true;n.maxLength=key==='address'?254:80;row.append(n);}
    const label=el('label','rt-checkbox'),enabled=el('input');enabled.type='checkbox';enabled.dataset.key='enabled';enabled.checked=value.enabled;label.append(enabled,el('span','','启用'));row.append(label,button('移除',()=>row.remove()));rows.append(row);
  };
  for(const m of s.mailboxes)add(m);fields.append(button('添加可用邮箱',()=>{if(rows.children.length<10)add();}));
  field('sender','默认发件邮箱',{type:'email',value:s.sender,maxLength:254});field('recipient','收件邮箱 / 官网投递邮箱',{type:'email',value:s.recipient,maxLength:254});
  fields.append(el('p','rt-help','候选人、面试安排和审核记录保存在工作台 飞书仅发送面试官填写通知'));
  const context=state.form;context.settingsReady=false;$('rt-form-submit').disabled=true;void session.request('templates').then(({items})=>{if(state.form!==context)return;selectField('receiptTemplateId','自动投递回执模板',items.filter(t=>t.kind==='receipt').map(t=>[t.id,t.name]),s.receiptTemplateId||'11011011-0110-4110-8110-110110110111');context.settingsReady=true;$('rt-form-submit').disabled=false;}).catch(e=>{if(state.form===context){$('rt-form-error').hidden=false;$('rt-form-error').textContent=e.message;}});
}
function settingsPayload(data,context){if(!context.settingsReady)throw Error('请等待回执模板加载完成');return {revision:context.values.settings.revision,mailboxes:[...$('rt-mailbox-rows').children].map(row=>Object.fromEntries([...row.querySelectorAll('[data-key]')].map(n=>[n.dataset.key,n.type==='checkbox'?n.checked:n.value.trim()]))),sender:String(data.get('sender')).trim(),recipient:String(data.get('recipient')).trim(),receiptTemplateId:String(data.get('receiptTemplateId')||'11011011-0110-4110-8110-110110110111')};}
for(const [id,action,route] of [['rt-settings','settings','settings']])$(id).addEventListener('click',async()=>{
  if(state.busy)return;const epoch=state.epoch;setBusy(true);
  try{const result=await session.request(route);if(epoch!==state.epoch)return;setBusy(false);openForm(action,{[action]:route==='templates'?result.items:result});}
  catch(e){if(epoch===state.epoch)status(e.message,true);}finally{if(epoch===state.epoch)setBusy(false);}
});

async function interviewerSelect(context){
  const epoch=state.epoch;$('rt-form-submit').disabled=true;
  try{const result=await session.request('members');if(state.form!==context||epoch!==state.epoch)return;
    const search=field('memberSearch','搜索成员',{required:false,placeholder:'姓名或邮箱'}),select=selectField('memberSubject','面试官',[],state.selected?.assignment?.subject);select.required=true;select.className='rt-member-select';
    const render=()=>{const old=select.value,q=search.value.trim().toLowerCase();select.replaceChildren(new Option('请选择飞书成员',''),...result.members.filter(m=>(m.name+' '+m.email).toLowerCase().includes(q)).map(m=>new Option(m.name+(m.email?' · '+m.email:''),m.subject)));if([...select.options].some(o=>o.value===old))select.value=old;};search.addEventListener('input',render);render();
    $('rt-form-fields').append(el('p','rt-help','确认后 招新工作流应用将向所选面试官发送填写入口'));
  }catch(e){if(state.form===context){$('rt-form-error').hidden=false;$('rt-form-error').textContent=e.message;}}
  finally{if(state.form===context&&epoch===state.epoch)$('rt-form-submit').disabled=false;}
}

async function setView(view){
  if(state.busy||templateWorkspace?.busy()||interviewWorkspace?.busy()||roleWorkspace?.busy())return;
  if(view==='hr'&&!state.profile?.recruitmentCapabilities?.manageHr)return;
  if(templateWorkspace?.dirty()&&!confirm('模板有未保存的内容。离开并放弃这些修改？'))return;
  if(interviewWorkspace?.dirty()&&!confirm('面试表单有未保存的内容。离开并放弃这些修改？'))return;
  roleWorkspace?.destroy();roleWorkspace=null;templateWorkspace?.destroy();templateWorkspace=null;interviewWorkspace?.destroy();interviewWorkspace=null;
  closeDetail(true);state.view=view;
  $('rt-content').hidden=view!=='candidates'||!canManage(state.profile);$('rw-interviews').hidden=view!=='interviews';$('rw-templates').hidden=view!=='templates';$('rw-hr').hidden=view!=='hr';
  for(const b of document.querySelectorAll('[data-view]')){if(b.dataset.view===view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
  status();
  if(view==='hr'){roleWorkspace=createRecruitmentRoleWorkspace({session,root:$('rw-hr'),onStatus:status});await roleWorkspace.load();}
  if(view==='candidates')await loadCandidates();
  if(view==='interviews'){interviewWorkspace=createInterviewWorkspace({session,root:$('rw-interview-list'),route:'my-interviews',onStatus:status});await interviewWorkspace.load();}
  if(view==='templates'){templateWorkspace=createTemplateWorkspace({session,root:$('rw-templates'),onStatus:status});await templateWorkspace.load();}
}
for(const b of document.querySelectorAll('[data-view]'))if(b.dataset.view!=='settings')b.addEventListener('click',()=>void setView(b.dataset.view));
for(const b of document.querySelectorAll('[data-detail-tab]'))b.addEventListener('click',()=>{state.detailTab=b.dataset.detailTab;for(const button of document.querySelectorAll('[data-detail-tab]'))button.setAttribute('aria-pressed',String(button===b));for(const panel of document.querySelectorAll('[data-detail-panel]'))panel.hidden=panel.dataset.detailPanel!==state.detailTab;});
$('rw-interviews-refresh').onclick=()=>{if(interviewWorkspace?.busy())return;if(!interviewWorkspace?.dirty()||confirm('刷新会放弃未提交的填写内容，继续？'))void interviewWorkspace?.load(true);};
for(const[id,step]of [['rw-previous',-1],['rw-next',1]])$(id).onclick=()=>{const index=state.filtered.findIndex(c=>c.id===state.selected?.id);const c=state.filtered[index+step];if(c)void openCandidate(c.id);};
window.addEventListener('beforeunload',e=>{if(templateWorkspace?.dirty()||interviewWorkspace?.dirty()){e.preventDefault();e.returnValue='';}});
async function previewResume(c){
  clearResumePreview();const target=$('rw-resume-preview'),id=c.id,epoch=state.epoch,generation=resumeGeneration;target.textContent='正在加载简历';
  const current=()=>epoch===state.epoch&&state.selected?.id===id&&generation===resumeGeneration;
  try{const moduleUrl='/assets/recruitment-pdf-preview-v1.mjs';const [blob,{previewPdf}]=await Promise.all([session.download('candidates/'+id+'/resume'),import(moduleUrl)]);if(!current())return;const cleanup=await previewPdf(blob,target,current);if(current())resumeCleanup=cleanup;else cleanup?.();}
  catch(e){if(current())target.textContent='无法预览此 PDF，请使用下载查看。';}
}
