import {RECRUITMENT_FEISHU_APP_ID} from './recruitment-templates.mjs';

// Outbound OpenAPI only: deliberately no WebSocket client or event subscription.
export function createRecruitmentFeishuProvider(config,{fetchImpl=fetch,now=Date.now}={}){
  if(config.appId!==RECRUITMENT_FEISHU_APP_ID||typeof config.appSecret!=='string'||config.appSecret.length<10)throw new Error('Invalid recruitment Feishu configuration');
  let token=null,expires=0;
  const endpoint='https://open.feishu.cn/open-apis';
  async function request(path,{method='POST',body,auth=true,signal}={}){
    if(auth&&(!token||expires<=now())){
      const value=await request('/auth/v3/tenant_access_token/internal',{body:{app_id:config.appId,app_secret:config.appSecret},auth:false,signal});
      if(!value.tenant_access_token)throw Object.assign(new Error('Feishu authentication failed'),{code:'FEISHU_AUTH',confirmedRejected:true});
      token=value.tenant_access_token;expires=now()+Math.max(0,Number(value.expire||0)-120)*1000;
    }
    const response=await fetchImpl(endpoint+path,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
    const value=await response.json();
    if(!response.ok||value.code!==0)throw Object.assign(new Error('Feishu API rejected request'),{code:'FEISHU_'+String(value.code||response.status).replace(/[^0-9]/g,''),confirmedRejected:response.status<500});
    return value;
  }
  return {async send(job,{signal}={}){
    const p=job.payload;
    // A union_id is shared by applications in this enterprise; never reuse an
    // open_id belonging to the workbench's different login application.
    const unionId=String(p.subject||'').split(':').at(-1);
    if(job.kind!=='interviewer'||!/^on_[a-zA-Z0-9_-]{10,100}$/.test(unionId)||p.url!=='https://internal.110-lab.cn/recruitment/interviewer?assignment='+p.assignmentId)throw Object.assign(new Error('Invalid interviewer target'),{code:'FEISHU_TARGET_INVALID',confirmedRejected:true});
    const text=`110 实验室面试安排\n\n候选人：${p.candidateName}\n应聘组别：${p.group}\n\n请通过下方入口选择面试时间、填写面试链接和联系方式。提交后由管理员审核，再通知候选人。${p.note?'\n管理员说明：'+p.note:''}\n\n${p.url}`;
    const result=await request('/im/v1/messages?receive_id_type=union_id',{body:{receive_id:unionId,msg_type:'text',content:JSON.stringify({text}),uuid:job.id},signal});
    if(!result.data?.message_id)throw Object.assign(new Error('Feishu result unconfirmed'),{code:'FEISHU_UNCONFIRMED'});
    return {messageId:result.data.message_id};
  }};
}
