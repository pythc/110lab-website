import {randomUUID} from 'node:crypto';
import {z} from 'zod';

export const assessmentUserIdSchema=z.uuid();
export const offerChangeSchema=z.object({requestId:z.uuid(),revision:z.number().int().min(0),assessmentUserId:assessmentUserIdSchema,enabled:z.boolean(),note:z.string().trim().max(1000).default('')}).strict();
export const assessmentOfferAccountSchema=z.object({id:assessmentUserIdSchema,name:z.string().trim().min(1).max(80),studentNo:z.string().trim().min(1).max(40),email:z.string().email().max(254)}).strict();
const responseSchema=z.object({userId:assessmentUserIdSchema,grantId:z.uuid(),revision:z.number().int().positive(),decision:z.enum(['ACCEPTED','DECLINED'])}).strict();

// Recruitment owns this list. Assessment supplies the authenticated, immutable
// account id; names, email addresses and recruitment decisions never grant access.
export function createRecruitmentOffers({db,stamp,tx,mutate,requireOperator,audit,fail}){
  db.exec(`CREATE TABLE IF NOT EXISTS recruitment_offers(assessment_user_id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  const get=id=>{const row=db.prepare('SELECT data FROM recruitment_offers WHERE assessment_user_id=?').get(id);return row?JSON.parse(row.data):null;};
  const access=entry=>entry?.enabled?{allowed:true,grantId:entry.id,revision:entry.revision,status:entry.status}:{allowed:false};
  const save=entry=>db.prepare('INSERT INTO recruitment_offers VALUES(?,?) ON CONFLICT(assessment_user_id) DO UPDATE SET data=excluded.data').run(entry.assessmentUserId,JSON.stringify(entry));
  return {
    listOffers(actor){requireOperator(actor);return {items:db.prepare('SELECT data FROM recruitment_offers ORDER BY json_extract(data,\'$.updatedAt\') DESC,assessment_user_id').all().map(r=>JSON.parse(r.data))};},
    setOffer(actor,raw,account){
      requireOperator(actor);const input=offerChangeSchema.parse(raw);
      const profile=input.enabled?assessmentOfferAccountSchema.parse(account):null;
      if(profile&&profile.id!==input.assessmentUserId)fail(400,'考核账号不匹配 请重新选择');
      return mutate(actor,input,'offer:'+input.assessmentUserId,()=>{
        const previous=get(input.assessmentUserId);
        if((previous?.revision||0)!==input.revision)fail(409,'Offer 名单已更新 请刷新后重试');
        if(!previous&&!input.enabled)fail(404,'此账号不在 Offer 名单中');
        if(previous?.enabled===input.enabled)fail(409,'此账号的访问状态已改变 请刷新后重试');
        if(!previous&&Number(db.prepare('SELECT COUNT(*) n FROM recruitment_offers').get().n)>=10000)fail(429,'Offer 名单已达上限');
        const at=stamp(),entry={...previous,...(profile?{assessmentUserId:profile.id,name:profile.name,studentNo:profile.studentNo,email:profile.email}:{}),id:previous?.id||randomUUID(),enabled:input.enabled,revision:input.revision+1,status:input.enabled?'PENDING':previous.status,respondedAt:input.enabled?null:previous.respondedAt,note:input.note,createdAt:previous?.createdAt||at,updatedAt:at,updatedBy:actor.name||actor.subject};
        save(entry);
        audit(actor,input.enabled?'offer_access_granted':'offer_access_revoked',{grantId:entry.id,assessmentUserId:entry.assessmentUserId,revision:entry.revision,note:entry.note});
        return entry;
      });
    },
    offerAccess(userId){
      const entry=get(assessmentUserIdSchema.parse(userId));
      return access(entry);
    },
    respondOffer(raw){
      const input=responseSchema.parse(raw);
      return tx(()=>{
        const entry=get(input.userId);
        if(!entry?.enabled||entry.id!==input.grantId||entry.revision!==input.revision)fail(409,'Offer 已变更或撤销 请重新打开页面');
        if(entry.status===input.decision)return access(entry);
        if(entry.status!=='PENDING')fail(409,'已提交过不同的答复 请联系招新管理员');
        entry.status=input.decision;entry.respondedAt=stamp();save(entry);
        audit({subject:'assessment:'+input.userId},'offer_response',{grantId:entry.id,revision:entry.revision,decision:entry.status,at:entry.respondedAt});
        return access(entry);
      });
    },
  };
}
