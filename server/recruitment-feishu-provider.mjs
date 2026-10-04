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
    if(p.appId!==config.appId||!/^[A-Za-z0-9]{10,80}$/.test(p.target?.appToken||'')||!/^tbl[A-Za-z0-9]{5,60}$/.test(p.target?.tableId||''))throw Object.assign(new Error('Feishu target not configured'),{code:'FEISHU_NOT_CONFIGURED',confirmedRejected:true});
    const base='/bitable/v1/apps/'+p.target.appToken+'/tables/'+p.target.tableId+'/records';
    // Stable external key and provider idempotency prevent duplicate candidates
    // across retries and a timeout after record creation.
    let id=p.recordId;
    if(!id){
      const result=await request(base+'/search',{body:{field_names:['110lab编号'],filter:{conjunction:'and',conditions:[{field_name:'110lab编号',operator:'is',value:[p.candidateId]}]}},signal});
      const rows=result.data?.items||[];if(rows.length>1||result.data?.has_more)throw Object.assign(new Error('Duplicate external key'),{code:'FEISHU_DUPLICATE',confirmedRejected:true});id=rows[0]?.record_id;
    }
    if(id&&!/^rec[A-Za-z0-9]{5,80}$/.test(id))throw Object.assign(new Error('Invalid record id'),{code:'FEISHU_RECORD_ID',confirmedRejected:true});
    const result=await request(id?base+'/'+id:base+'?client_token='+p.candidateId,{method:id?'PUT':'POST',body:{fields:p.fields},signal});
    const recordId=result.data?.record?.record_id||id;
    if(!recordId)throw Object.assign(new Error('Feishu result unconfirmed'),{code:'FEISHU_UNCONFIRMED'});
    return {recordId};
  }};
}
