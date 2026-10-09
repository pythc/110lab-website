import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {workflowText as text,mailboxSchema,renderRecruitmentTemplate,previewHash} from './recruitment-templates.mjs';
import {imageIds,validateMailImage} from './recruitment-rich-mail.mjs';

// Uses the existing transaction and outbox. Nothing here calls a network API.
export function createRecruitmentLifecycle({db,now,stamp,get,put,event,tx,mutate,enqueue,settings,getTemplate,fail,requireAdmin,mode,modeFor,deliveryEvent}){
  const common={requestId:z.uuid(),revision:z.number().int().positive()};
  const assignment=c=>c.assignment;
  const cancelPending=(id,kinds,code)=>{for(const row of db.prepare("SELECT id,kind,status FROM deliveries WHERE candidate_id=? AND status IN ('QUEUED','RETRYING','SENDING','UNKNOWN')").all(id)){if(!kinds.includes(row.kind))continue;if(['SENDING','UNKNOWN'].includes(row.status))fail(409,'已有发送任务结果待核实');db.prepare("UPDATE deliveries SET status='FAILED',error=?,updated_at=? WHERE id=?").run(code,now(),row.id);deliveryEvent(row.id,'FAILED',code);}};
  const mailPayload=(c,t,values={})=>{
    const s=settings(),rendered=renderRecruitmentTemplate(t,c,values);
    const ids=imageIds(rendered.html);if(ids.length>8)fail(400,'每封邮件最多包含 8 张图片');
    let imageBytes=0;for(const id of ids){const row=db.prepare('SELECT length(content) bytes FROM mail_images WHERE id=?').get(id);if(!row)fail(400,'模板图片不存在');imageBytes+=row.bytes;}if(imageBytes>8*1024*1024)fail(413,'每封邮件图片总大小不能超过 8MB');
    return {...rendered,from:s.sender,to:c.email,replyTo:(t.kind||'interview')==='interview'||t.kind!=='receipt'&&c.interview?.email?rendered.replyTo:s.recipient,templateId:t.id,templateRevision:t.revision,settingsRevision:s.revision};
  };
  const assignmentView=(actor,c)=>{
    const a=assignment(c);if(!a||a.subject!==actor.subject)fail(404,'找不到分配给你的面试');
    return {id:c.id,name:c.name,group:c.group,assignment:a,interview:c.interview,stage:c.stage,archived:c.archived};
  };
  const journal=(actor,input,target,fn)=>{
    if(!actor?.subject)fail(401,'请先通过飞书登录');
    return tx(()=>{
      const fingerprint=previewHash({target,input}),old=db.prepare('SELECT fingerprint,result FROM requests WHERE actor=? AND request_id=?').get(actor.subject,input.requestId);
      if(old){if(old.fingerprint!==fingerprint)fail(409,'请求内容已改变');return JSON.parse(old.result);}
      const value=fn();db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(actor.subject,input.requestId,fingerprint,JSON.stringify(value));return value;
    });
  };
  return {
    mailPayload,
    receiptPayload(c){const t=getTemplate(settings().receiptTemplateId||'11011011-0110-4110-8110-110110110111');if(t.kind!=='receipt')fail(409,'请选择投递回执模板');return mailPayload(c,t);},
    saveImage(actor,raw){requireAdmin(actor);const input=z.object({requestId:z.uuid(),data:z.string().min(16).max(2800000).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict().parse(raw);
      return mutate(actor,input,'mail-image',()=>{const buffer=Buffer.from(input.data,'base64');if(buffer.toString('base64')!==input.data)fail(400,'图片编码无效');let meta;try{meta=validateMailImage(buffer);}catch(e){fail(400,e.message);}
        if(!db.prepare('SELECT id FROM mail_images WHERE id=?').get(meta.id)){
          const used=db.prepare('SELECT COALESCE(SUM(length(content)),0) n FROM mail_images').get().n;if(used+buffer.length>100*1024*1024)fail(413,'邮件图片存储已达上限');
          db.prepare('INSERT INTO mail_images VALUES(?,?,?,?)').run(meta.id,JSON.stringify(meta),buffer,stamp());
        }return meta;});
    },
    readImage(actor,id){requireAdmin(actor);const row=db.prepare('SELECT metadata,content FROM mail_images WHERE id=?').get(id);if(!row)fail(404,'图片不存在');return {...JSON.parse(row.metadata),buffer:Buffer.from(row.content)};},
    mailImages(payload){return imageIds(payload.html).map(id=>{const row=db.prepare('SELECT metadata,content FROM mail_images WHERE id=?').get(id);if(!row)fail(409,'邮件图片不存在');return {...JSON.parse(row.metadata),buffer:Buffer.from(row.content)};});},
    interviewerList(actor){if(!actor?.subject)fail(401,'请先登录');return {items:db.prepare("SELECT data FROM candidates WHERE json_extract(data,'$.assignment.subject')=? ORDER BY rowid DESC LIMIT 1000").all(actor.subject).map(r=>assignmentView(actor,JSON.parse(r.data)))};},
    interviewerGet(actor,id){const row=db.prepare("SELECT data FROM candidates WHERE json_extract(data,'$.assignment.id')=? AND json_extract(data,'$.assignment.subject')=?").get(id,actor.subject);if(!row)fail(404,'找不到分配给你的面试');return assignmentView(actor,JSON.parse(row.data));},
    proposeInterview(actor,id,raw){const input=z.object({...common,at:z.iso.datetime(),email:mailboxSchema,contact:text(500,1),location:z.url().max(500).refine(v=>new URL(v).protocol==='https:'&&!new URL(v).username&&!new URL(v).password,'请填写 HTTPS 面试链接')}).strict().parse(raw);
      return journal(actor,input,'interview-proposal:'+id,()=>{
        const row=db.prepare("SELECT data FROM candidates WHERE json_extract(data,'$.assignment.id')=? AND json_extract(data,'$.assignment.subject')=?").get(id,actor.subject);if(!row)fail(404,'找不到分配给你的面试');const c=JSON.parse(row.data),a=c.assignment;
        if(c.archived||c.stage!=='interview'||!['requested','changes_requested','submitted'].includes(a.status))fail(409,'这项面试安排已结束或审核 请联系管理员');
        if(a.revision!==input.revision)fail(409,'安排已更新 请刷新');const at=Date.parse(input.at);if(at<=now()||at>now()+366*86400000)fail(400,'请选择未来一年内的面试时间');
        a.proposal={at:input.at,interviewer:a.name,email:input.email,contact:input.contact,location:input.location};a.status='submitted';a.revision++;a.submittedAt=stamp();c.notification=null;c.revision++;event(c,actor,'面试官提交安排');put(c);return assignmentView(actor,c);
      });
    },
    assignInterviewer(actor,id,raw,member){const input=z.object({...common,subject:text(200,1)}).strict().parse(raw);if(!member||member.subject!==input.subject)fail(400,'请选择飞书通讯录中的成员');
      return mutate(actor,input,'assign:'+id,()=>{const c=get(id);if(c.revision!==input.revision||c.archived||c.stage!=='interview')fail(409,'候选人阶段已改变');
        if(db.prepare("SELECT id FROM deliveries WHERE candidate_id=? AND kind IN ('interview','interviewer') AND status IN ('SENDING','UNKNOWN')").get(id))fail(409,'已有发送任务结果待核实');
        if(c.notification?.status==='sent')fail(409,'面试邀请已发送 请先人工联系候选人调整');
        cancelPending(id,['interview','interviewer'],'ASSIGNMENT_REPLACED');
        const a={id:randomUUID(),subject:member.subject,name:member.name,email:member.email||'',status:'requested',revision:1,requestedAt:stamp()};
        c.assignment=a;c.interview=null;c.notification=null;c.revision++;
        const payload={assignmentId:a.id,subject:a.subject,name:a.name,candidateName:c.name,group:c.group,settingsRevision:settings().revision,url:'https://internal.110-lab.cn/recruitment/interviewer?assignment='+a.id};
        a.deliveryId=enqueue(c,actor,'interviewer',payload);event(c,actor,'分配面试官',member.name);put(c);return c;
      });
    },
    returnInterview(actor,id,raw){const input=z.object({...common,note:text(2000,1)}).strict().parse(raw);return mutate(actor,input,'return:'+id,()=>{
      const c=get(id),a=assignment(c);if(c.revision!==input.revision||c.archived||c.stage!=='interview'||a?.status!=='submitted')fail(409,'面试安排已改变');
      cancelPending(id,['interview','interviewer'],'ARRANGEMENT_RETURNED');
      a.status='changes_requested';a.revision++;a.reviewNote=input.note;c.notification=null;c.revision++;
      a.deliveryId=enqueue(c,actor,'interviewer',{assignmentId:a.id,subject:a.subject,name:a.name,candidateName:c.name,group:c.group,note:input.note,settingsRevision:settings().revision,url:'https://internal.110-lab.cn/recruitment/interviewer?assignment='+a.id});event(c,actor,'退回面试安排',input.note);put(c);return c;
    });},
    prepareOutcome(actor,id,raw){const input=z.object({...common,outcome:z.enum(['accepted','rejected']),note:text(2000,1),templateId:z.uuid(),templateRevision:z.number().int().positive(),values:z.record(z.string(),text(1000))}).strict().parse(raw);
      return mutate(actor,input,'prepare-outcome:'+id,()=>{const c=get(id);if(c.revision!==input.revision||c.archived)fail(409,'候选人已更新');
        if(c.stage===input.outcome? !['failed','draft'].includes(c.resultNotification?.status) : input.outcome==='accepted'?c.stage!=='decision':['accepted','rejected'].includes(c.stage))fail(409,'当前阶段不能执行此决定');
        if(db.prepare("SELECT id FROM deliveries WHERE candidate_id=? AND kind IN ('outcome','interview') AND status IN ('SENDING','UNKNOWN')").get(id))fail(409,'先核实正在发送的邮件');
        const t=getTemplate(input.templateId);if(t.kind!==input.outcome||t.revision!==input.templateRevision)fail(409,'请选择对应的最新结果模板');
        c.resultNotification={...mailPayload({...c,decisionNote:input.note},t,input.values),outcome:input.outcome,decisionNote:input.note,status:'draft'};c.revision++;event(c,actor,'生成结果邮件预览');put(c);return c;
      });
    },
    confirmOutcome(actor,id,raw){const input=z.object({...common,previewHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(raw);return mutate(actor,input,'confirm-outcome:'+id,()=>{
      const c=get(id),p=c.resultNotification;if(c.revision!==input.revision||c.archived||!p||p.status!=='draft'||previewHash(p)!==input.previewHash)fail(409,'结果预览已改变');
      if(c.stage!==p.outcome&&(p.outcome==='accepted'?c.stage!=='decision':['accepted','rejected'].includes(c.stage)))fail(409,'候选人阶段已改变');
      if(p.settingsRevision!==settings().revision||getTemplate(p.templateId).revision!==p.templateRevision)fail(409,'模板或邮箱已改变 请重新预览');
      if(db.prepare("SELECT id FROM deliveries WHERE candidate_id=? AND kind IN ('interview','interviewer') AND status IN ('SENDING','UNKNOWN')").get(id))fail(409,'面试通知正在发送或待核实');
      cancelPending(id,['interview','interviewer'],'CANDIDATE_CLOSED');
      c.stage=p.outcome;c.decisionNote=p.decisionNote;const job=enqueue(c,actor,'outcome',p);c.resultNotification={...p,status:'queued',deliveryId:job};c.revision++;event(c,actor,'确认结果并发送邮件',c.stage==='accepted'?'录取':'未通过');put(c);return c;
    });},
    previewOutcome(actor,id){requireAdmin(actor);const c=get(id);if(!c.resultNotification)fail(409,'请先生成结果邮件');return {payload:c.resultNotification,previewHash:previewHash(c.resultNotification),mode:modeFor(c)};},
  };
}
