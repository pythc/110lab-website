import {z} from 'zod';
import {previewHash} from './recruitment-templates.mjs';

export const isRecruitmentLabAdmin=actor=>['admin','super_admin'].includes(actor?.role);

// Recruitment membership never changes the shared laboratory/mail role.
export function createRecruitmentRoles({db,now,tx,fail,audit}){
  db.exec(`CREATE TABLE IF NOT EXISTS recruitment_hr(subject TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS recruitment_roles_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO recruitment_roles_revision VALUES(1,1);`);
  const members=()=>db.prepare('SELECT data FROM recruitment_hr ORDER BY subject').all().map(r=>JSON.parse(r.data));
  const isHr=subject=>!!subject&&!!db.prepare('SELECT 1 FROM recruitment_hr WHERE subject=?').get(subject);
  const canManage=actor=>!!actor?.subject&&(isRecruitmentLabAdmin(actor)||isHr(actor.subject));
  const requireOperator=actor=>{if(!actor?.subject)fail(401,'请先通过飞书登录');if(!canManage(actor))fail(403,'需要招新 HR 或实验室管理员权限');return actor;};
  const requireLabAdmin=actor=>{if(!actor?.subject)fail(401,'请先通过飞书登录');if(!isRecruitmentLabAdmin(actor))fail(403,'仅实验室管理员可配置 HR');return actor;};
  const snapshot=()=>({revision:db.prepare('SELECT revision FROM recruitment_roles_revision WHERE id=1').get().revision,members:members()});
  return {members,isHr,canManage,requireOperator,requireLabAdmin,
    session(actor){return {...actor,recruitmentRole:isRecruitmentLabAdmin(actor)?'admin':isHr(actor.subject)?'hr':'interviewer',recruitmentCapabilities:{manage:canManage(actor),manageHr:isRecruitmentLabAdmin(actor),ownInterviews:true}};},
    listHr(actor){requireLabAdmin(actor);return snapshot();},
    setHr(actor,raw,member){
      requireLabAdmin(actor);
      const input=z.object({requestId:z.uuid(),revision:z.number().int().positive(),subject:z.string().min(1).max(200),enabled:z.boolean()}).strict().parse(raw);
      if(input.enabled&&(!member||member.subject!==input.subject||!/^.+:on_[a-zA-Z0-9_-]{10,100}$/.test(member.subject)))fail(400,'请选择飞书通讯录中的成员');
      return tx(()=>{
        requireLabAdmin(actor);
        const fingerprint=previewHash({target:'recruitment-hr',input});
        const previous=db.prepare('SELECT fingerprint,result FROM requests WHERE actor=? AND request_id=?').get(actor.subject,input.requestId);
        if(previous){if(previous.fingerprint!==fingerprint)fail(409,'同一请求内容已改变');return JSON.parse(previous.result);}
        if(snapshot().revision!==input.revision)fail(409,'HR 名单已更新 请刷新后重试');
        if(input.enabled){const value={subject:member.subject,name:member.name,email:member.email||'',grantedBy:actor.subject,grantedAt:new Date(now()).toISOString()};db.prepare('INSERT INTO recruitment_hr VALUES(?,?) ON CONFLICT(subject) DO UPDATE SET data=excluded.data').run(member.subject,JSON.stringify(value));}
        else db.prepare('DELETE FROM recruitment_hr WHERE subject=?').run(input.subject);
        db.prepare('UPDATE recruitment_roles_revision SET revision=revision+1 WHERE id=1').run();
        audit(actor,input.enabled?'recruitment_hr_granted':'recruitment_hr_revoked',{subject:input.subject});
        const result=snapshot();db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(actor.subject,input.requestId,fingerprint,JSON.stringify(result));return result;
      });
    },
  };
}
