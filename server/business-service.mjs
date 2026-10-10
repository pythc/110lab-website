import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {extractAttachmentText} from './attachment-text.mjs';
import {BUSINESS_TOOL_MAP,BUSINESS_TOOLS} from './business-tools.mjs';
import {assertBusinessScope,isLabAdmin} from './business-scopes.mjs';
import {openBusinessState,fail,paginate} from './business-state.mjs';
import {digest} from './durable-command.mjs';
import {createBusinessMailProvider} from './business-mail-provider.mjs';
import {validateHonorFile} from './honors-upload.mjs';
import {validateResume,resumeTypes} from './recruitment-files.mjs';
import {z} from 'zod';
import {businessReference as reference,parseBusinessReference} from './business-reference.mjs';

const has=(r,q)=>!q||JSON.stringify(r).toLocaleLowerCase().includes(q.toLocaleLowerCase());
const revision=(r,v)=>{if(r.revision!==v)fail('REVISION_CONFLICT','内容已更新 请重新读取');};
const inDates=(value,a)=>!((a.from&&String(value).slice(0,10)<a.from)||(a.to&&String(value).slice(0,10)>a.to));
const publicActor=a=>({subject:a.subject,name:a.name,email:a.email,role:a.role,recruitmentRole:a.recruitmentRole});
const UUID=z.uuid();

export function createBusinessService({mail,workspace,honors,recruitment,updates,updatesEnabled,directory,freezeFile=process.env.PORTAL_BUSINESS_FREEZE_FILE||join(directory,'frozen'),mailProvider=createBusinessMailProvider(),now=Date.now}) {
  const state=openBusinessState({directory,now}),w=workspace.store,h=honors.store,r=recruitment.store;
  let busy=false,closing=false,activeJob;const throttle=new Map();
  const latest=actor=>({...((r?.recruitmentSession||((a)=>a))(mail.profile(actor.subject))),clientId:actor.clientId,scopes:actor.scopes});
  function check(a,scope){const next=latest(a);assertBusinessScope(next,scope);return next;}
  function requireStore(store){if(!store)fail('PROVIDER_NOT_READY','此应用尚未启用',503);return store;}
  function mailbox(a,address,kind='canRead') {
    if(!isLabAdmin(latest(a)))fail('FORBIDDEN','需要实验室管理员权限',403);
    const p=mailProvider.mailboxes().find(p=>p.address===address&&p.enabled);
    if(!p||!p[kind])fail('PROVIDER_NOT_READY','此邮箱尚未配置所需收发能力',503);
    if(mail.mailboxReady&&!mail.mailboxReady(a.subject,address))fail('FORBIDDEN','邮箱权限尚未同步完成',403);
    return p;
  }
  const canonicalProject=async(a,args)=>workspace.canonicalMembers(a,args.fields,args.id?requireStore(w).get(a,args.id).members:[]);
  const resource=a=>({reference:a});
  const pv=(a,kind,scope,payload,requestId)=>state.createPreview(a,{kind,scope,payload,requestId});
  const entry=(a,id)=>({...requireStore(w).get(a,id),events:w.audit(a,id),webUrl:'https://internal.110-lab.cn/projects?project='+id});
  const news=(a,id)=>{check(a,'updates:read');if(!updatesEnabled)fail('PROVIDER_NOT_READY','动态管理尚未启用',503);return updates.get(id);};
  const updateReady=()=>{if(!updatesEnabled)fail('PROVIDER_NOT_READY','动态管理尚未启用',503);};
  const previewPayload=(a,p)=>{
    if(p.kind.startsWith('updates.')){updateReady();const current=updates.get(p.preview.id);revision(current,p.preview.expectedRevision);if(digest(current)!==p.preview.snapshotHash)fail('PREVIEW_STALE','动态内容已改变');}
    if(p.kind==='recruitment.feishu')fail('TOOL_RETIRED','表格同步已停用 请在招新工作台分配面试官');
    if(p.kind.startsWith('recruitment.')){requireStore(r);const current=r.get(a,p.preview.id);revision(current,p.preview.expectedRevision);const value=r.preview(a,p.preview.id,p.kind.endsWith('notice')?'interview':'feishu');if(digest(value)!==p.preview.snapshotHash)fail('PREVIEW_STALE','候选人或预览已改变');const settings=r.settings(a);if(value.payload.settingsRevision!==settings.revision)fail('PREVIEW_STALE','招新配置已改变');if(value.payload.templateId&&r.templates(a).items.find(t=>t.id===value.payload.templateId)?.revision!==value.payload.templateRevision)fail('PREVIEW_STALE','模板已改变');}
    if(p.kind==='mail.send'){const d=state.draft(a,p.preview.id);revision(d,p.preview.expectedRevision);mailbox(a,d.fields.mailbox,'canSend');if(p.preview.providerRevision!==mailProvider.revision||p.preview.mode!==mailProvider.mode||digest(d.fields)!==digest(p.preview.fields))fail('PREVIEW_STALE','邮件或发信配置已改变');for(const id of d.fields.attachments)state.artifact(a,id,'mail_attachment');}
  };
  const calls={
    lab_whoami(a){return {...publicActor(a),scopes:a.scopes,capabilities:BUSINESS_TOOLS.filter(t=>t.scope&&a.scopes.includes(t.scope)&&(!/^(recruitment|mail|updates):/.test(t.scope)&&!t.scope.endsWith(':review')||isLabAdmin(a)||t.scope.startsWith('recruitment:')&&(t.scope==='recruitment:read'||a.recruitmentRole==='hr'))).map(t=>t.name),applications:{projects:!!w,honors:!!h,recruitment:!!r,updates:!!updatesEnabled,mail:mailProvider.mailboxes().some(p=>p.enabled)},mailMode:mailProvider.mode};},
    async lab_members_search(a,args){const result=await mail.projectMembers(a.subject);check(a,'lab:directory:read');return {...paginate(result.members.filter(m=>has([m.name,m.email],args.query)),args,a.subject),source:result.source,unavailable:result.unavailable};},
    lab_projects_list(a,args){const rows=requireStore(w).list(a).projects.filter(p=>p.archived===args.archived&&(!args.phase||p.phase===args.phase)&&(!args.mine||p.ownerSubject===a.subject||p.members.some(m=>m.subject===a.subject))&&has([p.name,p.summary],args.query));return paginate(rows.map(p=>({id:p.id,name:p.name,summary:p.summary,phase:p.phase,ownerName:p.ownerName,revision:p.revision,updatedAt:p.updatedAt})),args,a.subject);},
    lab_project_get(a,{id}){return entry(a,id);},
    async lab_project_save(a,args){const canonical=await canonicalProject(a,args);a=check(a,'projects:write');if(args.id&&requireStore(w).get(a,args.id).ownerSubject!==a.subject&&!isLabAdmin(a))fail('FORBIDDEN','当前项目不能编辑',403);return requireStore(w).durable(a,args.requestId,'project_save',{...args,clientId:a.clientId},()=>args.id?w.update(a,args.id,{...canonical,revision:args.expectedRevision}):w.create(a,canonical));},
    lab_project_apply(a,args){requireStore(w);const p=w.get(a,args.id);if(p.ownerSubject!==a.subject&&!isLabAdmin(a))fail('FORBIDDEN','仅负责人或管理员可操作',403);return w.durable(a,args.requestId,'project_apply',args,()=>w.apply(a,args.id,{revision:args.expectedRevision,application:args.application}));},
    lab_project_review(a,args){return requireStore(w).durable(a,args.requestId,'project_review',args,()=>w.review(a,args.id,{revision:args.expectedRevision,decision:args.decision,note:args.note}));},
    lab_project_milestone_save(a,args){requireStore(w);const p=w.get(a,args.projectId);if(args.milestoneId){if(args.fields||!args.status||!args.expectedRevision)fail('VALIDATION_ERROR','更新里程碑仅接受版本及状态',400);if(!p.milestones.find(m=>m.id===args.milestoneId)?.canChange)fail('FORBIDDEN','没有修改里程碑的权限',403);}else if(!args.fields||args.status||args.expectedRevision||p.ownerSubject!==a.subject&&!isLabAdmin(a))fail('VALIDATION_ERROR','请填写新里程碑资料并确认权限',400);return w.durable(a,args.requestId,'milestone_save',args,()=>args.milestoneId?w.setMilestone(a,args.projectId,args.milestoneId,{revision:args.expectedRevision,status:args.status}):w.addMilestone(a,args.projectId,args.fields));},
    lab_honors_list(a,args){return paginate(requireStore(h).list(a).items.filter(v=>(!args.status||v.status===args.status)&&(!args.projectId||v.projectId===args.projectId)&&(!args.level||v.level===args.level)&&(!args.member||v.members.some(m=>m.subject===args.member))&&inDates(v.awardedAt,args)&&has([v.name,v.organizer,v.prize],args.query)).map(v=>({id:v.id,name:v.name,prize:v.prize,level:v.level,awardedAt:v.awardedAt,members:v.members,projectId:v.projectId,status:v.status,revision:v.revision})),args,a.subject);},
    lab_honor_get(a,{id}){const value=requireStore(h).get(a,id);return {...value,history:h.history(a,id),certificate:value.certificate?{...value.certificate,...resource(reference('honor',id))}:null,webUrl:'https://internal.110-lab.cn/honors?record='+id};},
    async lab_honor_save(a,args){requireStore(h);const old=args.id?h.get(a,args.id):null;const canonical=await honors.canonical(a,{fields:{...args.fields,projectName:''}},old);a=check(a,'honors:write');return args.id?h.update(a,args.id,{requestId:args.requestId,revision:args.expectedRevision,...canonical}):h.create(a,{requestId:args.requestId,...canonical});},
    lab_honor_certificate_attach(a,args){const file=state.artifact(a,args.artifactId,'honor_certificate');const value=requireStore(h).attach(a,args.id,{requestId:args.requestId,revision:args.expectedRevision,filename:file.filename,mime:file.mime,bytes:file.bytes,sha256:file.sha256,buffer:file.buffer});state.bindArtifact(a,args.artifactId,'honor_certificate');return value;},
    lab_honor_submit(a,args){return requireStore(h).action(a,args.id,{requestId:args.requestId,revision:args.expectedRevision,action:'submit',note:''});},
    lab_honor_withdraw(a,args){return requireStore(h).action(a,args.id,{requestId:args.requestId,revision:args.expectedRevision,action:'withdraw',note:''});},
    lab_honor_review(a,args){return requireStore(h).action(a,args.id,{requestId:args.requestId,revision:args.expectedRevision,action:args.decision,note:args.note});},
    lab_candidates_list(a,args){return paginate(requireStore(r).list(a).items.filter(c=>(!args.group||c.group===args.group)&&(!args.stage||c.stage===args.stage)&&(!args.notificationStatus||c.notification?.status===args.notificationStatus)&&inDates(c.createdAt,args)&&has([c.name,c.group],args.query)).map(c=>({id:c.id,name:c.name,group:c.group,stage:c.stage,revision:c.revision,createdAt:c.createdAt,notificationStatus:c.notification?.status||'NOT_SENT'})),args,a.subject);},
    lab_candidate_get(a,{id}){const c=requireStore(r).get(a,id);return {...c,resume:c.resume?{...c.resume,...resource(reference('resume',id))}:null,webUrl:'https://internal.110-lab.cn/recruitment?candidate='+id};},
    lab_recruitment_options(a,args){requireStore(r);const settings=r.settings(a);return {templates:r.templates(a).items.filter(t=>!args.templateId||t.id===args.templateId),settings,mode:r.mode};},
    lab_recruitment_template_save(a,args){return requireStore(r).saveTemplate(a,args);},
    lab_candidate_record(a,args){return requireStore(r).act(a,args.id,{...args.record,requestId:args.requestId,revision:args.expectedRevision});},
    lab_candidate_decide(a,args){return requireStore(r).act(a,args.id,{requestId:args.requestId,revision:args.expectedRevision,action:args.decision,note:args.note});},
    lab_recruitment_notice_preview(a,args){requireStore(r);const c=r.act(a,args.id,{requestId:args.requestId,revision:args.expectedRevision,action:'prepare_notice',templateId:args.templateId,templateRevision:args.templateRevision,values:args.values,...args.sender?{sender:args.sender}:{}});const snapshot=r.preview(a,c.id,'interview');return pv(a,'recruitment.notice','recruitment:send',{id:c.id,expectedRevision:c.revision,snapshotHash:digest(snapshot),...snapshot},args.requestId);},
    lab_mailboxes_list(a){return {items:mailProvider.mailboxes().map(p=>({...p,authorized:!mail.mailboxReady||mail.mailboxReady(a.subject,p.address)})),mode:mailProvider.mode};},
    async lab_mail_messages_list(a,args){mailbox(a,args.mailbox);const result=await mailProvider.list(args.mailbox,args);a=check(a,'mail:read');mailbox(a,args.mailbox);return result;},
    async lab_mail_message_get(a,args){mailbox(a,args.mailbox);const result=await mailProvider.get(args.mailbox,args.messageId);a=check(a,'mail:read');mailbox(a,args.mailbox);return {...result,attachments:result.attachments.map(f=>({...f,reference:reference('mail',args.mailbox,args.messageId,String(f.index))})),untrustedContent:true};},
    async lab_mail_draft_save(a,args){mailbox(a,args.fields.mailbox,'canSend');const fields={...args.fields};if(fields.replyMessageId){assertBusinessScope(a,'mail:read');const original=await mailProvider.get(fields.mailbox,fields.replyMessageId);const recipients=original.replyTo?.length?original.replyTo:original.from;if(fields.to.length!==1||fields.to[0]!==recipients[0]?.address?.toLowerCase())fail('VALIDATION_ERROR','回复收件人与原邮件不一致 请检查后另建新邮件',400);fields.inReplyTo=original.messageId;fields.references=original.references;}a=check(a,'mail:draft');mailbox(a,fields.mailbox,'canSend');let total=0;for(const id of fields.attachments)total+=state.artifact(a,id,'mail_attachment').bytes;if(total>10*1024*1024)fail('ATTACHMENT_TOO_LARGE','附件总大小不能超过 10MB',413);const d=state.saveDraft(a,{...args,fields});for(const id of fields.attachments)state.bindArtifact(a,id,'mail_attachment');return pv(a,'mail.send','mail:send',{id:d.id,expectedRevision:d.revision,fields:d.fields,attachmentDetails:d.fields.attachments.map(id=>{const {buffer,...meta}=state.artifact(a,id,'mail_attachment');return meta;}),providerRevision:mailProvider.revision,mode:mailProvider.mode},derived(args.requestId,'preview'));},
    lab_updates_list(a,args){updateReady();return paginate(updates.listDrafts().filter(v=>(!args.status||(args.status==='published'?!!v.published:!v.published))&&has([v.draft.title,v.draft.summary],args.query)).map(v=>({id:v.id,title:v.draft.title,summary:v.draft.summary,published:!!v.published,revision:v.revision,updatedAt:v.updatedAt})),args,a.subject);},
    lab_update_get(a,{id}){return {...news(a,id),webUrl:'https://internal.110-lab.cn/admin'};},
    lab_update_draft_save(a,args){updateReady();return updates.durable(a,args.requestId,'update_draft_save',{clientId:a.clientId,...args},()=>{const v=args.id?updates.edit(args.id,args.expectedRevision,args.content):updates.create(args.content);return v;});},
    lab_update_publication_preview(a,args){updateReady();const snapshot=updates.get(args.id);revision(snapshot,args.expectedRevision);if(args.action==='withdraw'&&!snapshot.published)fail('VALIDATION_ERROR','此动态尚未发布',400);return pv(a,'updates.'+args.action,'updates:publish',{id:args.id,expectedRevision:args.expectedRevision,website:'https://110-lab.cn',snapshotHash:digest(snapshot),currentPublic:snapshot.published,content:args.action==='publish'?snapshot.draft:null},args.requestId);},
  };
  // The immutable preview ID, not a model-selected retry ID, identifies effects.
  for(const [name,kind]of [['lab_recruitment_notice_send','recruitment.notice'],['lab_update_publish','updates.publish'],['lab_update_withdraw','updates.withdraw'],['lab_mail_send','mail.send']])calls[name]=(a,args)=>state.execute(a,args.previewId,kind,(p,key,recovery)=>{
    if(kind.startsWith('updates.')){updateReady();return updates.durable(a,key,kind,p,()=>{previewPayload(a,{kind,preview:p});return kind==='updates.publish'?updates.publish(p.id,p.expectedRevision,{publicConfirmed:true}):updates.withdraw(p.id,p.expectedRevision);},recovery);}
    if(kind.startsWith('recruitment.')){requireStore(r);if(recovery.replayOnly&&!r.commandCommitted(a,key))fail('PREVIEW_STALE','预览已过期且没有已提交任务 请重新生成');if(p.mode!==r.preview(a,p.id,'interview').mode)fail('PREVIEW_STALE','发送模式已改变');const value=r.act(a,p.id,{requestId:key,revision:p.expectedRevision,action:kind==='recruitment.notice'?'send_notice':'sync_feishu',previewHash:p.previewHash});const c=r.get(a,value.id);const job=kind==='recruitment.notice'?c.notification?.deliveryId:c.deliveries.find(d=>d.kind==='feishu')?.id;return {operationId:job||key,state:'QUEUED',mode:p.mode,mailStatus:'NOT_SENT',candidateId:value.id};}
    if(!recovery.replayOnly)previewPayload(a,{kind,preview:p});return state.queueMail(a,key,p,recovery);
  });
  calls.lab_operation_get=(a,{operationId})=>{let value;try{value=state.operation(a,operationId);}catch(e){if(e.code!=='NOT_FOUND')throw e;check(a,'recruitment:read');return requireStore(r).inspectDelivery(a,operationId);}check(a,value.scope);return value;};
  calls.lab_file_upload=async(a,args)=>{
    const scope=args.purpose==='honor_certificate'?'honors:write':'mail:draft';check(a,scope);
    if(!/^[^/\\\u0000-\u001f\u007f]{1,180}$/.test(args.filename)||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.contentBase64))fail('VALIDATION_ERROR','附件名称或编码无效',400);
    const buffer=Buffer.from(args.contentBase64,'base64');if(!buffer.length||buffer.length>10*1024*1024)fail('ATTACHMENT_TOO_LARGE','附件不能超过 10MB',413);
    const ext=args.filename.split('.').at(-1).toLowerCase(),mime=({pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',docx:resumeTypes.docx,txt:'text/plain'})[ext];
    if(args.purpose==='honor_certificate'||['png','jpg','jpeg'].includes(ext))await validateHonorFile(buffer,args.filename,mime);
    else if(['pdf','docx'].includes(ext))await validateResume(buffer,args.filename,mime);
    else if(ext!=='txt'||buffer.includes(0))fail('VALIDATION_ERROR','支持 PDF DOCX PNG JPG TXT 附件',400);
    a=check(a,scope);return state.putArtifact(a,{...args,mime,buffer});
  };
  async function attachment(a,{reference:ref}){
    let url,parts;try{url=parseBusinessReference(ref);parts=url.pathname.slice(1).split('/').map(decodeURIComponent);}catch{fail('NOT_FOUND','附件不存在',404);}
    let f,scope;
    if(url.hostname==='honor'&&parts.length===1){scope='honors:read';a=check(a,scope);f=requireStore(h).certificate(a,UUID.parse(parts[0]));}
    else if(url.hostname==='resume'&&parts.length===1){scope='recruitment:read';a=check(a,scope);f=requireStore(r).readResume(a,UUID.parse(parts[0]));f.mime=resumeTypes[f.extension];}
    else if(url.hostname==='mail'&&parts.length===3&&/^\d{1,3}$/.test(parts[2])){scope='mail:read';a=check(a,scope);mailbox(a,parts[0]);f=await mailProvider.attachment(parts[0],parts[1],Number(parts[2]));a=check(a,scope);mailbox(a,parts[0]);}
    else fail('NOT_FOUND','附件不存在',404);
    if(f.buffer.length>10*1024*1024)fail('ATTACHMENT_TOO_LARGE','附件过大 请在原应用查看',413);
    const extraction=await extractAttachmentText(f.buffer,f.mime);a=check(a,scope);if(url.hostname==='resume')r.get(a,parts[0]);if(url.hostname==='honor')h.get(a,parts[0]);if(url.hostname==='mail')mailbox(a,parts[0]);
    return {extraction,reference:reference(url.hostname,...parts),filename:f.filename,mime:f.mime,bytes:f.buffer.length,contentBase64:f.buffer.toString('base64'),untrustedContent:true};
  }
  calls.lab_attachment_read=attachment;
  state.recoverMail();
  async function tick(){if(busy||closing||existsSync(freezeFile))return;busy=true;try{
    state.recoverMail();const job=state.claimMail();if(!job)return;
    try{const a={...mail.profile(job.subject),clientId:job.client,scopes:['mail:send']};previewPayload(a,{kind:'mail.send',preview:job.payload});if(job.payload.providerRevision!==mailProvider.revision||job.payload.mode!==mailProvider.mode)fail('PREVIEW_STALE','发信配置已改变');
      const files=job.payload.fields.attachments.map(id=>state.artifact(a,id,'mail_attachment'));
      if(mailProvider.mode==='dry-run')state.finishMail(job.id,'SIMULATED',{message:'模拟发送 未连接发信服务器'});
      else{check(a,'mail:send');const result=await mailProvider.send(job.payload.fields.mailbox,job.payload.fields,files,job.id);state.finishMail(job.id,result.rejected.length?'PARTIAL':'SMTP_ACCEPTED',{...result,message:'SMTP 已返回结果 不代表收件人已收到或阅读'});}
    }catch(e){state.finishMail(job.id,e.status||['EAUTH','ECONNECTION','ETIMEDOUT'].includes(e.code)&&['CONN','AUTH'].includes(e.command)?'FAILED':'UNKNOWN',{code:e.code||'DELIVERY_UNCONFIRMED',message:e.status?'权限或配置检查失败 未外发':'投递结果需要核实 不自动重发'});}
  }finally{busy=false;}}
  const timer=setInterval(()=>{if(!busy){activeJob=tick();activeJob.catch(()=>{});}},1000);timer.unref();
  return {
    state,mailProvider,
    async call(name,input,actor){const def=BUSINESS_TOOL_MAP.get(name);if(!def)fail('NOT_FOUND','工具不存在',404);const args=def.inputSchema.parse(input||{});let a=latest(actor);if(!def.annotations.readOnlyHint&&existsSync(freezeFile))fail('MAINTENANCE','业务操作暂时维护中 请稍后重试',503);if(def.scope)a=check(a,def.scope);const time=now(),k=a.subject+':'+(def.annotations.readOnlyHint?'r':'w'),old=throttle.get(k);const count=old&&time-old.at<60000?old:{at:time,n:0};if(++count.n>(def.annotations.readOnlyHint?180:60))fail('RATE_LIMITED','操作频繁 请稍后再试',429);throttle.set(k,count);if(throttle.size>2000)for(const [key,row]of throttle)if(time-row.at>60000)throttle.delete(key);
      const result=await calls[name](a,args);if(!def.annotations.readOnlyHint)state.audit(a,name,result?.id||result?.operationId||args.id||'');return result;
    },
    getConfirmation(actor,id){const p=state.preview(actor,id,{web:true}),a={...latest(actor),clientId:p.clientId,scopes:[p.scope]};check(a,p.scope);if(p.state!=='COMPLETED')previewPayload(a,p);return p;},
    confirm(actor,id,fingerprint){const p=this.getConfirmation(actor,id);return state.approve(actor,id,fingerprint||p.fingerprint);},
    async close(){closing=true;clearInterval(timer);await activeJob;mailProvider.close();state.close();},
    runMail:tick,
  };
}

// Deterministic UUID for a second idempotent step of the same request.
function derived(id,purpose){const h=digest({id,purpose});return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;}
