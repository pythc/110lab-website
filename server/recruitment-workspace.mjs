import {z} from 'zod';
import {workflowText as text,templateSchema,previewHash} from './recruitment-templates.mjs';

// Business drafts belong to the business facts that were reviewed, not to
// delivery retries or polling revisions. Keep superseded drafts for audit.
export const decisionContext=c=>previewHash({stage:c.stage,assessment:c.assessment,interview:c.interview,assignment:c.assignment&&{id:c.assignment.id,status:c.assignment.status,proposal:c.assignment.proposal,feedback:c.assignment.feedback}});
export function invalidateOutcome(c,at){
  if(c.resultNotification?.status!=='draft')return;
  (c.draftHistory||=[]).push({...c.resultNotification,supersededAt:at});
  c.resultNotification=null;
}

export function createRecruitmentWorkspace({db,now,stamp,get,put,event,mutate,enqueue,settings,getTemplate,fail,requireAdmin,readResume,lifecycle,journal,assignmentView,cancelPending}){
  const common={requestId:z.uuid(),revision:z.number().int().positive()};
  const editable=(c,revision)=>{if(c.revision!==revision||c.archived)fail(409,'候选人已更新 请重新打开后操作');};
  return {
    previewTemplate(actor,raw){
      requireAdmin(actor);
      const input=z.object({template:templateSchema,values:z.record(z.string(),text(1000)).default({}),sample:z.object({name:text(80,1),group:text(60,1)}).strict().optional()}).strict().parse(raw);
      const sample={id:'00000000-0000-4000-8000-000000000001',name:input.sample?.name||'林同学',group:input.sample?.group||'开发组',email:'candidate@example.com',decisionNote:'欢迎加入 110 实验室，请留意后续报到安排。',interview:{at:'2026-11-01T06:00:00Z',interviewer:'陈老师',email:'interviewer@example.com',contact:'interviewer@example.com',location:'https://example.com/meeting'}};
      try{return {payload:lifecycle.mailPayload(sample,input.template,{...Object.fromEntries(input.template.variables.map(v=>[v.key,v.defaultValue||(v.required?'示例'+v.label:'')])),...input.values}),sample:true};}catch(e){if(e.status)throw e;fail(400,e.message);}
    },
    previewComposition(actor,id,raw){
      requireAdmin(actor);
      const input=z.object({revision:z.number().int().positive(),templateId:z.uuid(),templateRevision:z.number().int().positive(),kind:z.enum(['interview','accepted','rejected']),note:text(2000).default(''),values:z.record(z.string(),text(1000)).default({}),sender:z.string().optional()}).strict().parse(raw);
      const c=get(id);editable(c,input.revision);const t=getTemplate(input.templateId);
      if((t.kind||'interview')!==input.kind||t.revision!==input.templateRevision)fail(409,'模板已改变 请重新选择');
      if(input.kind==='interview'&&(c.stage!=='interview'||!(c.assignment?.status==='submitted'||!c.assignment&&c.interview)))fail(409,'面试安排尚未提交');
      const source={...c,decisionNote:input.note,interview:input.kind==='interview'&&c.assignment?c.assignment.proposal:c.interview};
      try{const payload=lifecycle.mailPayload(source,t,input.values);if(input.sender){if(!settings().mailboxes.some(m=>m.enabled&&m.address===input.sender))fail(400,'请选择已启用邮箱');payload.from=input.sender;}return {payload};}catch(e){if(e.status)throw e;fail(400,e.message);}
    },
    interviewerResume(actor,id){const c=get(id);assignmentView(actor,c);return readResume(id);},
    submitFeedback(actor,id,raw){
      const input=z.object({...common,score:z.number().min(0).max(100),note:text(4000,1),recommendation:z.enum(['recommend','consider','decline'])}).strict().parse(raw);
      return journal(actor,input,'feedback:'+id,()=>{
        const row=db.prepare("SELECT data FROM candidates WHERE json_extract(data,'$.assignment.id')=? AND json_extract(data,'$.assignment.subject')=?").get(id,actor.subject);
        if(!row)fail(404,'找不到分配给你的面试');const c=JSON.parse(row.data),a=c.assignment;
        if(c.archived||c.stage!=='interview'||a.status!=='approved'||a.revision!==input.revision||!c.interview)fail(409,'面试已更新或已提交评价 请刷新');
        if(Date.parse(c.interview.at)>now())fail(409,'面试开始后才能提交评价');
        a.feedback={score:input.score,note:input.note,recommendation:input.recommendation,by:actor.name||actor.subject,subject:actor.subject,at:stamp()};a.revision++;
        c.interview={...c.interview,score:input.score,note:input.note};invalidateOutcome(c,stamp());c.stage='decision';c.revision++;
        event(c,actor,'面试官提交评价');put(c);return assignmentView(actor,c);
      });
    },
    requestReschedule(actor,id,raw){
      const input=z.object({...common,note:text(2000,1)}).strict().parse(raw);
      return mutate(actor,input,'reschedule:'+id,()=>{
        const c=get(id);editable(c,input.revision);const a=c.assignment;
        if(c.stage!=='interview'||!a||a.status!=='approved')fail(409,'仅已确认的面试可以发起改期');
        cancelPending(id,['interview','interviewer'],'RESCHEDULE_REQUESTED');
        (c.interviewHistory||=[]).push({assignment:structuredClone(a),interview:c.interview,notification:c.notification,changedAt:stamp(),reason:input.note});
        a.status='changes_requested';a.reviewNote=input.note;a.revision++;c.notification=null;c.interview=null;invalidateOutcome(c,stamp());c.revision++;
        a.deliveryId=enqueue(c,actor,'interviewer',{assignmentId:a.id,subject:a.subject,name:a.name,candidateName:c.name,group:c.group,note:'面试改期：'+input.note,settingsRevision:settings().revision,url:'https://internal.110-lab.cn/recruitment/interviewer?assignment='+a.id});
        event(c,actor,'发起面试改期',input.note);put(c);return c;
      });
    },
  };
}
