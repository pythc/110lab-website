import {randomUUID} from 'node:crypto';
import {previewHash} from './recruitment-templates.mjs';

export const AUTOMATIC_RECRUITMENT_KINDS=['hr_intake','hr_feedback_reminder','interviewer_feedback_reminder'];
export const isRecruitmentIm=kind=>['feishu','interviewer',...AUTOMATIC_RECRUITMENT_KINDS].includes(kind);
export const interviewEnd=interview=>Date.parse(interview?.at)+(interview?.durationMinutes||30)*60000;
const scheduleKey=c=>previewHash({assignment:c.assignment.id,approvedAt:c.assignment.approvedAt,interview:c.interview});

export function createRecruitmentNotifications({db,now,tx,get,roles,modeFor,deliveryEvent,fail}){
  db.exec(`CREATE TABLE IF NOT EXISTS recruitment_notification_events(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,distributed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS recruitment_notification_meta(id INTEGER PRIMARY KEY CHECK(id=1),activated_at INTEGER NOT NULL);`);
  db.prepare('INSERT OR IGNORE INTO recruitment_notification_meta VALUES(1,?)').run(now());
  const activatedAt=db.prepare('SELECT activated_at FROM recruitment_notification_meta WHERE id=1').get().activated_at;
  const pendingFeedback=c=>!c.archived&&c.stage==='interview'&&c.assignment?.status==='approved'&&!c.assignment.feedback&&Number.isFinite(interviewEnd(c.interview));
  function record(c,kind,key,payload={}){db.prepare('INSERT OR IGNORE INTO recruitment_notification_events(id,candidate_id,kind,payload) VALUES(?,?,?,?)').run(key,c.id,kind,JSON.stringify(payload));}
  function enqueue(c,kind,subject,payload){
    const id=randomUUID(),at=now();
    db.prepare("INSERT INTO deliveries(id,candidate_id,kind,mode,status,payload,actor,created_at,updated_at,next_at) VALUES(?,?,?,?,'QUEUED',?,'recruitment-system',?,?,?)").run(id,c.id,kind,modeFor(c),JSON.stringify({...payload,subject,candidateId:c.id,candidateName:c.name,group:c.group}),at,at,at);
    deliveryEvent(id,'QUEUED');
  }
  return {
    recordIntake(c){record(c,'hr_intake','intake:'+c.id);},
    // Event creation and fan-out commit together. A restart or second worker
    // cannot fan out twice. No pre-upgrade applications/past interviews backfill.
    scheduleNotifications(){return tx(()=>{
      const candidates=db.prepare("SELECT data FROM candidates WHERE json_extract(data,'$.stage')='interview' AND json_extract(data,'$.assignment.status')='approved'").all();
      for(const {data} of candidates){const c=JSON.parse(data),end=interviewEnd(c.interview);if(!pendingFeedback(c)||end<activatedAt||end>now())continue;
        const key=scheduleKey(c),payload={scheduleKey:key,assignmentId:c.assignment.id,endAt:new Date(end).toISOString(),interviewerName:c.assignment.name};
        record(c,'hr_feedback_reminder','hr-feedback:'+key,payload);record(c,'interviewer_feedback_reminder','interviewer-feedback:'+key,payload);
      }
      let queued=0;
      for(const row of db.prepare('SELECT * FROM recruitment_notification_events WHERE distributed=0 ORDER BY rowid').all()){
        const c=get(row.candidate_id),p=JSON.parse(row.payload),feedback=row.kind!=='hr_intake';
        if(c.archived||['accepted','rejected'].includes(c.stage)||feedback&&(!pendingFeedback(c)||scheduleKey(c)!==p.scheduleKey)){
          db.prepare('UPDATE recruitment_notification_events SET distributed=1 WHERE id=?').run(row.id);continue;
        }
        const recipients=row.kind==='interviewer_feedback_reminder'?[c.assignment]:roles.members();
        if(!recipients.length)continue; // Kept durably until the first HR is configured.
        for(const recipient of recipients){enqueue(c,row.kind,recipient.subject,{...p,recipientName:recipient.name,url:row.kind==='interviewer_feedback_reminder'?'https://internal.110-lab.cn/recruitment/interviewer?assignment='+c.assignment.id:'https://internal.110-lab.cn/recruitment?candidate='+c.id});queued++;}
        db.prepare('UPDATE recruitment_notification_events SET distributed=1 WHERE id=?').run(row.id);
      }
      return queued;
    });},
    validateNotification(row,c){
      if(!AUTOMATIC_RECRUITMENT_KINDS.includes(row.kind))return false;
      if(c.archived||['accepted','rejected'].includes(c.stage))fail(409,'招新流程已结束');
      if(row.kind.startsWith('hr_')&&!roles.isHr(row.payload.subject))fail(403,'收件人的 HR 权限已撤销');
      if(row.kind!=='hr_intake'){
        if(!pendingFeedback(c)||scheduleKey(c)!==row.payload.scheduleKey||interviewEnd(c.interview)>now())fail(409,'面评已提交或面试安排已改变');
        if(row.kind==='interviewer_feedback_reminder'&&c.assignment.subject!==row.payload.subject)fail(403,'面试官已改变');
      }
      return true;
    },
    notificationStatus(){return {hrCount:roles.members().length,pendingHrEvents:db.prepare("SELECT count(*) n FROM recruitment_notification_events WHERE distributed=0 AND kind LIKE 'hr_%'").get().n};},
  };
}
