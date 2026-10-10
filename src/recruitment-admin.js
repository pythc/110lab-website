import Uppy from '@uppy/core';
import Dashboard from '@uppy/dashboard';
import zhCN from '@uppy/locales/lib/zh_CN.js';
import {mailEditor,mailPreview} from './recruitment-mail-editor.js';
import {createLabSession} from './lab-session.js';

const $=id=>document.getElementById(id);
const stages=[['screening','初筛'],['assessment','考核'],['interview','面试'],['decision','待决策'],['accepted','已录取'],['rejected','未通过']];
const labels=Object.fromEntries(stages);
const linkedCandidate=new URL(location.href).searchParams.get('candidate');
const noticeLabels={draft:'待确认',queued:'等待处理',failed:'发送失败',unknown:'结果待核实',sent:'服务商已接收',simulated:'模拟完成'};
const deliveryLabels={HELD:'未发送',QUEUED:'等待处理',SENDING:'处理中',RETRYING:'等待重试',FAILED:'发送失败',UNKNOWN:'结果待核实',SENT:'服务商已接收',SIMULATED:'模拟完成 未外发'};
const state={profile:null,items:[],selected:null,archived:false,epoch:0,load:0,opening:0,busy:false,form:null,uppy:null,abort:null};
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
const button=(text,fn,cls='rt-button')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;};
const date=value=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'';
const terminal=c=>['accepted','rejected'].includes(c.stage);
const canManage=profile=>['admin','super_admin'].includes(profile?.role);
const status=(text='',error=false)=>{const n=$('rt-status');n.textContent=text;n.hidden=!text;n.dataset.error=String(error);};
const destroyUpload=()=>{state.abort?.abort();state.abort=null;state.uppy?.destroy();state.uppy=null;};
function closeForm(force=false){if(state.busy&&!force)return;$('rt-form-dialog').close();state.form?.editor?.destroy();state.form=null;}
function closeDetail(force=false){if(state.busy&&!force)return;state.opening++;destroyUpload();$('rt-detail').close();state.selected=null;}
function setBusy(value){
  state.busy=value;state.form?.editor?.setDisabled(value);
  for(const id of ['rt-new','rt-new-empty','rt-templates','rt-settings','rt-refresh','rt-logout','rt-form-submit','rt-form-cancel','rt-form-close','rt-detail-close','rt-detail-done','rt-upload-submit'])$(id).disabled=value;
  for(const b of $('rt-detail-actions').querySelectorAll('button'))b.disabled=value;
  for(const b of $('rt-resume-info').querySelectorAll('button'))b.disabled=value;
  for(const control of $('rt-form-fields').querySelectorAll('input,textarea,select'))control.disabled=value;
  state.uppy?.getPlugin('Dashboard')?.setOptions({disabled:value});
}
function clearPrivate(){
  status();
  state.epoch++;state.load++;state.opening++;state.openedLinked=false;
  closeForm(true);closeDetail(true);state.items=[];state.profile=null;setBusy(false);
  $('rt-deliveries').replaceChildren();$('rt-rows').replaceChildren();$('rt-count').textContent='';$('rt-metrics').replaceChildren();$('rt-detail-info').replaceChildren();$('rt-events').replaceChildren();$('rt-current').replaceChildren();$('rt-detail-actions').replaceChildren();$('rt-form-fields').replaceChildren();$('rt-resume-info').replaceChildren();$('rt-upload').replaceChildren();
  for(const id of ['rt-detail-title','rt-detail-stage','rt-notice-body','rt-notice-subject','rt-upload-status','rt-detail-updated'])$(id).textContent='';
  $('rt-search').value='';$('rt-stage').value='';$('rt-group').replaceChildren(new Option('所有组别',''));
}
const session=createLabSession({apiRoot:'/api/recruitment-admin/',onStatus:status,onChange:profile=>{
  const changed=profile?.subject!==state.profile?.subject||profile?.role!==state.profile?.role;
  if(changed||!profile)clearPrivate();
  state.profile=profile;
  const allowed=canManage(profile);
  $('rt-content').hidden=!allowed;$('rt-locked').hidden=allowed;
  $('rt-login').hidden=!!profile;$('rt-logout').hidden=!profile;
  $('rt-login-main').hidden=!!profile;$('rt-settings').hidden=profile?.role!=='super_admin';
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
  if(c.assignment?.status==='submitted'&&c.stage==='interview')stage.append(el('span','rt-notice-alert','安排待审核'));
  if([c.notification?.status,c.resultNotification?.status].includes('failed'))stage.append(el('span','rt-notice-alert','邮件发送失败'));
  if(c.assignment?.notificationStatus==='FAILED')stage.append(el('span','rt-notice-alert','面试官通知失败'));
  if([c.notification?.status,c.resultNotification?.status].includes('unknown'))stage.append(el('span','rt-notice-alert','发送结果待核实'));
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
  if(c.assignment){const a=c.assignment;summary.push('面试官 '+a.name+' · '+({requested:'等待面试官填写',submitted:'待管理员审核',changes_requested:'已退回修改',approved:'安排已确认'}[a.status]||a.status));if(a.proposal&&a.status!=='approved')summary.push('待审核安排 '+date(a.proposal.at)+' · '+a.proposal.location+' · '+a.proposal.contact);}
  if(c.decisionNote)summary.push('决策记录 '+c.decisionNote);
  if(!summary.length)summary.push(({screening:'查看资料后 完成初筛并选择后续安排',assessment:'考核进行中 完成后记录成绩',interview:'安排面试并审核通知内容',decision:'根据评价记录确认本次决策'})[c.stage]||'流程已结束');
  $('rt-current').replaceChildren(...summary.map(v=>el('p','rt-current-summary',v)));
  const actions=[];
  const add=(text,action,values,cls)=>actions.push(button(text,()=>openForm(action,values),cls||'rt-button'));
  if(!c.archived){
    if(c.stage==='screening'){add('通过初筛','screen',{},'rt-button rt-primary');}
    if(c.stage==='assessment')add('记录考核结果','assessment',{},'rt-button rt-primary');
    if(c.stage==='interview'){
      if(!['sent','queued','unknown'].includes(c.notification?.status))add(c.assignment?'重新分配面试官':'分配面试官','assign_interviewer');
      if(c.assignment?.status==='submitted')add('退回修改','return_interview');
      if((c.assignment?.status==='submitted'||!c.assignment&&c.interview)&&!['queued','unknown'].includes(c.notification?.status))add('生成邮件预览','prepare_notice');
      if(c.notification?.status==='draft')actions.push(button('检查并确认邮件',()=>void previewDelivery('interview'),'rt-button rt-primary'));
      if(['simulated','sent'].includes(c.notification?.status))add('记录面试反馈','interview',{},'rt-button rt-primary');
    }
    if(c.stage==='decision')add('录取并预览通知','prepare_outcome',{outcome:'accepted'},'rt-button rt-primary');
    if(!terminal(c))add('未通过并预览通知','prepare_outcome',{outcome:'rejected'},'rt-button rt-danger');
    else{if(['failed','draft'].includes(c.resultNotification?.status))add('重新生成结果通知','prepare_outcome',{outcome:c.stage});add('归档候选人','archive');}
  }
  if(!c.archived&&c.resultNotification?.status==='draft')actions.push(button('检查并确认结果邮件',()=>void previewDelivery('outcome'),'rt-button rt-primary'));
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
  if(c.resume){const box=el('div','rt-resume-file');box.append(el('strong','',c.resume.filename),el('p','',Math.ceil(c.resume.bytes/1024)+' KB · '+'永久保留'),button('下载简历',()=>void downloadResume(c)));$('rt-resume-info').append(box);}
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
  try{const blob=await session.download('candidates/'+c.id+'/resume');if(epoch!==state.epoch)return;const url=URL.createObjectURL(blob),link=el('a');link.href=url;link.download=c.resume.filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
  catch(error){if(epoch===state.epoch)status(error.message,true);}finally{if(epoch===state.epoch)setBusy(false);}
}
const actionTitles={send_receipt:'检查并发送投递回执',assign_interviewer:'分配飞书面试官',return_interview:'退回面试安排',prepare_outcome:'结果邮件预览',send_outcome:'确认决定并发送结果邮件',create:'新建候选人',screen:'完成初筛',assessment:'记录考核结果',schedule:'安排面试',interview:'记录面试反馈',accept:'确认录取',reject:'结束为未通过',archive:'归档候选人',prepare_notice:'生成邮件预览',send_notice:'逐人确认面试邮件',confirm_forward:'确认简历转送',sync_feishu:'确认飞书联动',retry_delivery:'重试投递',resolve_delivery:'核实投递结果',settings:'邮箱设置',templates:'邮件模板'};
function field(name,label,{type='text',value='',required=true,maxLength=2000,placeholder='',min,max}={}){
  const wrap=el('label','rt-field'),input=el(type==='textarea'?'textarea':'input');input.name=name;if(type!=='textarea')input.type=type;input.value=value;input.required=required;input.maxLength=maxLength;input.placeholder=placeholder;if(min!==undefined)input.min=min;if(max!==undefined)input.max=max;
  wrap.append(el('span','',label),input);$('rt-form-fields').append(wrap);return input;
}
function openForm(action,values={}){
  if(state.busy||!canManage(state.profile))return;
  const c=state.selected;if(!['create','settings','templates'].includes(action)&&(!c||c.archived&&action!=='resolve_delivery'))return;
  state.form={action,values,id:['create','settings','templates'].includes(action)?null:c.id,revision:c?.revision,request:null};
  const fields=$('rt-form-fields');fields.replaceChildren();$('rt-form-error').hidden=true;
  $('rt-form-dialog').classList.toggle('rt-mail-form',['templates','send_notice','send_outcome','send_receipt'].includes(action));
  $('rt-form-title').textContent=actionTitles[action];$('rt-form-submit').textContent=action==='create'?'建立候选人':'确认';
  const intro=text=>fields.append(el('p','rt-form-intro',text));
  if(action==='create'){
    field('name','姓名',{maxLength:80,placeholder:'候选人姓名'});
    const group=field('group','应聘组别',{maxLength:60,placeholder:'选择或填写组别'});group.setAttribute('list','rt-group-options');
    const options=el('datalist');options.id='rt-group-options';options.append(...[...new Set(['产品组','开发组','测试运维组',...state.items.map(v=>v.group)])].map(v=>new Option(v,v)));fields.append(options);
    field('email','联系邮箱',{type:'email',maxLength:254,placeholder:'name@example.com'});
    intro('姓名和邮箱用于投递与招新联系');
    field('summary','简历摘要',{type:'textarea',required:false,placeholder:'项目经历 专长或希望探索的方向'});
  }else if(action==='screen'){
    const wrap=el('label','rt-checkbox'),check=el('input');check.type='checkbox';check.name='assessmentRequired';check.checked=values.assessmentRequired??true;
    wrap.append(check,el('span','','安排考核'));fields.append(wrap);intro('关闭后进入面试安排');field('note','初筛记录',{type:'textarea',required:false});
  }else if(action==='assessment'||action==='interview'){
    intro(action==='assessment'?'记录考核成绩与评价':'记录本次面试的反馈');field('score','评分',{type:'number',min:0,max:100});field('note','评价记录',{type:'textarea'});
  }else if(action==='assign_interviewer'){void interviewerSelect(state.form);
  }else if(action==='return_interview'){field('note','修改说明',{type:'textarea',maxLength:2000});
  }else if(action==='prepare_outcome'){field('note','发给候选人的结果说明',{type:'textarea',maxLength:2000});void templateVariables(state.form,values.outcome);
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
  }else if(action==='retry_delivery'){const job=c.deliveries.find(d=>d.id===values.deliveryId);intro('仅重试该任务的原始内容 不修改收件人和模板');fields.append(el('pre','rt-form-preview',['feishu','interviewer'].includes(job.kind)?JSON.stringify(job.payload.fields||job.payload,null,2):`发件 ${job.payload.from}\n收件 ${job.payload.to}\n回复 ${job.payload.replyTo}\n\n${job.payload.subject}\n\n${job.payload.body}`));const wrap=el('label','rt-checkbox'),check=el('input');check.type='checkbox';check.required=true;wrap.append(check,el('span','','我已检查此候选人的重试内容'));fields.append(wrap);
  }else if(action==='resolve_delivery'){
    selectField('outcome','核实结果',[['not_sent','确认未发送'],['sent','确认服务商已接收']]);field('note','核实依据',{type:'textarea'});
  }else if(action==='settings'){renderSettings(values.settings);
  }else if(action==='templates'){renderTemplateEditor(values.templates);
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
  if(context.action==='return_interview')value.note=text('note');
  if(['prepare_notice','prepare_outcome'].includes(context.action)){const template=context.templates?.find(t=>t.id===text('templateId'));if(!template)throw new Error('请选择邮件模板');Object.assign(value,{templateId:template.id,templateRevision:template.revision,sender:text('sender'),values:Object.fromEntries(template.variables.map(v=>[v.key,text('variable:'+v.key)]))});}
  if(context.action==='prepare_outcome'){delete value.sender;value.outcome=context.values.outcome;value.note=text('note');}
  if(['send_notice','send_outcome','send_receipt','confirm_forward','sync_feishu'].includes(context.action))value.previewHash=context.values.preview.previewHash;
  if(['retry_delivery','resolve_delivery'].includes(context.action))value.deliveryId=context.values.deliveryId;
  if(context.action==='resolve_delivery')Object.assign(value,{outcome:text('outcome'),note:text('note')});
  if(context.action==='settings')return settingsPayload(data,context);
  if(context.action==='templates')return templatePayload(data,context);
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
    closeForm(true);if(!['settings','templates'].includes(context.action)){state.selected=result;await refreshSelected(result.id,epoch);if(epoch!==state.epoch)return;if(!$('rt-detail').open)$('rt-detail').showModal();}
    status('已保存');
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
    head.append(el('strong','',({interview:'面试邮件',receipt:'投递回执',outcome:'结果邮件',interviewer:'面试官通知',application:'简历转送',feishu:'历史表格同步'})[job.kind]),el('span','rt-pill',deliveryLabels[job.status]));
    box.append(head,el('p','rt-help',date(job.updatedAt)+' · '+(job.mode==='live'?'正式任务':'模拟任务')+' · 尝试 '+job.attempts+' 次'),el('p','rt-help','任务 '+job.id+(job.error?' · '+job.error:'')));
    const detail=el('details'),summary=el('summary','','查看已确认内容和处理记录');
    detail.append(summary,el('pre','rt-form-preview',['feishu','interviewer'].includes(job.kind)?JSON.stringify(job.payload.fields||job.payload,null,2):`发件 ${job.payload.from}\n收件 ${job.payload.to}\n回复 ${job.payload.replyTo}\n\n${job.payload.subject}\n\n${job.payload.body}`));
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
    const [result,settings]=await Promise.all([session.request('templates'),session.request('settings')]);if(state.form!==context||epoch!==state.epoch)return;result.items=result.items.filter(t=>(t.kind||'interview')===kind);context.templates=result.items;if(kind==='interview')selectField('sender','发件邮箱',settings.mailboxes.filter(m=>m.enabled).map(m=>[m.address,m.label+' · '+m.address]),settings.sender);
    const selector=selectField('templateId','邮件模板',result.items.map(t=>[t.id,t.name])),container=el('div','rt-form-fields');$('rt-form-fields').append(container);
    const render=()=>{container.replaceChildren();const t=result.items.find(t=>t.id===selector.value);if(!t)return;container.append(el('p','rt-help','姓名、组别与面试安排自动填入 下一步检查完整邮件'));
      for(const v of t.variables){const n=field('variable:'+v.key,v.label,{value:v.defaultValue,required:v.required,maxLength:1000});container.append(n.parentElement);}
      container.append(el('pre','rt-form-preview',t.body));};selector.addEventListener('change',render);render();
  }catch(e){if(state.form===context){$('rt-form-error').hidden=false;$('rt-form-error').textContent=e.message;}}
  finally{if(state.form===context&&epoch===state.epoch)$('rt-form-submit').disabled=false;}
}
const variableNames={name:'候选人姓名',group:'应聘组别',interviewTime:'面试时间',interviewerName:'面试官姓名',interviewerEmail:'面试官邮箱',interviewerContact:'面试官联系方式',location:'地点或会议链接',applicationId:'投递编号',decisionNote:'结果说明'};
function renderTemplateEditor(templates){
  const context=state.form;context.templates=templates;
  const selector=selectField('editingTemplate','选择模板',[...templates.map(t=>[t.id,t.name]),['new','新建模板']]);
  const content=el('div','rt-form-fields');$('rt-form-fields').append(content);
  const render=()=>{
    const t=templates.find(t=>t.id===selector.value)||{id:crypto.randomUUID(),revision:0,name:'',subject:'[110实验室面试邀请] {{name}}',body:'{{name}} 同学你好\n\n面试时间：{{interviewTime}}\n面试官：{{interviewerName}}\n联系方式：{{interviewerContact}}\n地点：{{location}}',variables:[]};context.editingTemplate=t;
    context.editor?.destroy();content.replaceChildren();
    const kind=selectField('kind','模板用途',[['interview','面试邀请'],['receipt','投递回执'],['accepted','录取通知'],['rejected','未通过通知']],t.kind||'interview');content.append(kind.parentElement);
    for(const [key,label,type,maxLength]of [['name','模板名称','text',80],['subject','主题','text',180]]){const n=field(key,label,{value:t[key],type,maxLength});content.append(n.parentElement);}
    context.editor=mailEditor(session,t,content,message=>{ $('rt-form-error').hidden=false;$('rt-form-error').textContent=message;});
    content.append(el('p','rt-help','可用变量 '+Object.entries(variableNames).map(([k,v])=>`{{${k}}} ${v}`).join(' · ')));
    const rows=el('div','rt-variable-rows');rows.id='rt-variable-rows';content.append(el('h3','','自定义变量'),rows);
    for(const v of t.variables)variableRow(rows,v);
    content.append(button('添加变量',()=>{if(rows.children.length<20)variableRow(rows);}),el('p','rt-help','在主题或正文使用 {{变量名}} 发送前为每位候选人填写'));
  };selector.addEventListener('change',render);render();
}
function variableRow(container,value={key:'',label:'',defaultValue:'',required:true}){
  const row=el('div','rt-config-row');
  for(const [key,label,max]of [['key','变量名 如 interviewRoom',40],['label','显示名称',60],['defaultValue','默认值',500]]){
    const input=el('input');input.dataset.key=key;input.placeholder=label;input.setAttribute('aria-label',label);input.value=value[key];input.maxLength=max;input.required=key!=='defaultValue';row.append(input);
  }
  const label=el('label','rt-checkbox'),required=el('input');required.type='checkbox';required.dataset.key='required';required.checked=value.required;label.append(required,el('span','','必填'));row.append(label,button('移除',()=>row.remove()));container.append(row);
}
function templatePayload(data,context){
  const t=context.editingTemplate;if(!t)throw new Error('模板尚未加载');
  return {template:{id:t.id,revision:t.revision,name:String(data.get('name')||'').trim(),subject:String(data.get('subject')||'').trim(),kind:String(data.get('kind')), ...context.editor.value(),variables:[...$('rt-variable-rows').children].map(row=>Object.fromEntries([...row.querySelectorAll('[data-key]')].map(input=>[input.dataset.key,input.type==='checkbox'?input.checked:input.value.trim()])))}};
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
for(const [id,action,route] of [['rt-templates','templates','templates'],['rt-settings','settings','settings']])$(id).addEventListener('click',async()=>{
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
