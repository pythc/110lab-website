// Read only the existing application's visible enterprise directory. Profiles
// here are project candidates, never login sessions or administrator grants.
const ORIGIN='https://open.feishu.cn';
const MAX_MEMBERS=1000,MAX_DEPARTMENTS=100;
export class DirectoryError extends Error {constructor(){super('企业成员暂时无法同步');}}
export function createWorkspaceDirectory({config,fetchImpl=fetch,now=Date.now}){
  let token=null,tokenExpires=0,cached=null,expires=0,pending=null,retryAfter=0;
  async function request(path,{body,signal}={}){
    try{
      const response=await fetchImpl(ORIGIN+'/open-apis/'+path,{method:body?'POST':'GET',redirect:'error',signal,
        headers:body?{'Content-Type':'application/json'}:{Authorization:'Bearer '+token},...(body?{body:JSON.stringify(body)}:{})});
      if(!response.ok)throw new DirectoryError();
      const parts=[];let size=0;const reader=response.body.getReader();
      try{for(;;){const {done,value}=await reader.read();if(done)break;if((size+=value.byteLength)>512*1024){await reader.cancel();throw new DirectoryError();}parts.push(value);}}finally{reader.releaseLock();}
      const value=JSON.parse(Buffer.concat(parts).toString('utf8'));
      if(value?.code!==0)throw new DirectoryError();return value;
    }catch{throw new DirectoryError();}
  }
  async function pages(path,params,signal,limit){
    const result=[],seen=new Set();let cursor='';
    for(let page=0;page<25;page++){
      const query=new URLSearchParams({...params,page_size:'50',...(cursor?{page_token:cursor}:{})});
      const {data}=await request(path+'?'+query,{signal});
      if(!data||!Array.isArray(data.items)||typeof data.has_more!=='boolean')throw new DirectoryError();
      result.push(...data.items);if(result.length>limit)throw new DirectoryError();
      if(!data.has_more)return result;
      cursor=data.page_token;if(typeof cursor!=='string'||!cursor||cursor.length>2048||seen.has(cursor))throw new DirectoryError();seen.add(cursor);
    }
    throw new DirectoryError();
  }
  async function refresh(){
    const signal=AbortSignal.timeout(10000);
    if(!token||tokenExpires<=now()){
      const value=await request('auth/v3/tenant_access_token/internal',{body:{app_id:config.appId,app_secret:config.appSecret},signal});
      if(typeof value.tenant_access_token!=='string'||!value.tenant_access_token||value.tenant_access_token.length>2048||!Number.isInteger(value.expire)||value.expire<120||value.expire>86400)throw new DirectoryError();
      token=value.tenant_access_token;tokenExpires=now()+(value.expire-60)*1000;
    }
    const departments=await pages('contact/v3/departments/0/children',{department_id_type:'open_department_id',fetch_child:'true'},signal,MAX_DEPARTMENTS);
    const ids=new Set(['0']);
    for(const row of departments){const id=row.open_department_id;if(typeof id!=='string'||!/^od-[a-zA-Z0-9_-]{1,100}$/.test(id))throw new DirectoryError();ids.add(id);}
    const members=new Map();let rows=0;
    for(const id of ids){
      const users=await pages('contact/v3/users/find_by_department',{department_id:id,department_id_type:'open_department_id',user_id_type:'union_id'},signal,MAX_MEMBERS);
      if((rows+=users.length)>5000)throw new DirectoryError();
      for(const user of users){
        if(user.status?.is_resigned||user.status?.is_exited||user.status?.is_frozen||user.is_frozen)continue;
        if(!/^on_[a-zA-Z0-9_-]{10,100}$/.test(user.union_id||'')||typeof user.name!=='string'||!user.name.trim()||user.name.length>80||/[\x00-\x1f\x7f]/.test(user.name))throw new DirectoryError();
        const subject=config.tenantKey+':'+user.union_id;
        // Email fields may be omitted by the provider's field permissions.
        // Do not invent an address or fall back to a personal contact email.
        const email=typeof user.enterprise_email==='string'&&/^[-a-zA-Z0-9._+]+@110-lab\.cn$/i.test(user.enterprise_email)?user.enterprise_email.toLowerCase():'';
        members.set(subject,{subject,name:user.name.trim(),email});if(members.size>MAX_MEMBERS)throw new DirectoryError();
      }
    }
    return [...members.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
  }
  return {async list({fresh=false}={}){
    if(!fresh&&cached&&expires>now())return cached.map(m=>({...m}));
    if(pending)return pending;
    if(retryAfter>now())throw new DirectoryError();
    pending=refresh().then(members=>{cached=members;expires=now()+60000;retryAfter=0;return members.map(m=>({...m}));})
      .catch(()=>{token=null;tokenExpires=0;cached=null;expires=0;retryAfter=now()+30000;throw new DirectoryError();})
      .finally(()=>{pending=null;});
    return pending;
  }};
}
