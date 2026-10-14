import {lstatSync,readFileSync} from 'node:fs';
const ORIGIN='https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x';
export class ProjectSyncError extends Error {
  constructor(code,{permanent=false}={}){super(code);this.code=code;this.permanent=permanent;}
}
export function createProjectSyncClient({configPath=process.env.PORTAL_REQUIREMENTS_PROJECT_CONFIG,fetcher=fetch}={}) {
  function key() {
    try {
      const s=lstatSync(configPath);
      if(!s.isFile()||s.isSymbolicLink()||s.mode&0o077||s.size>8192)throw new Error();
      const v=JSON.parse(readFileSync(configPath,'utf8'));
      if(typeof v.openApiKey!=='string'||!v.openApiKey||v.openApiKey.length>4096||!/^[\x21-\x7e]+$/.test(v.openApiKey))throw new Error();
      return v.openApiKey;
    }catch{throw new ProjectSyncError('CONNECTION_NOT_CONFIGURED',{permanent:true});}
  }
  async function call(action,input) {
    let response;
    const credential=key();
    try {response=await fetcher(ORIGIN+'/openapi/workspace/projects/'+action,{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+credential},
      body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(15000),
    });}catch{throw new ProjectSyncError('CONNECTION_UNCONFIRMED');}
    if(!response.ok){await response.body?.cancel();throw new ProjectSyncError(
      [401,403].includes(response.status)?'CONNECTION_FORBIDDEN':response.status===409?'PROJECT_CONFLICT':'PLATFORM_UNAVAILABLE',
      {permanent:[400,401,403,409,422].includes(response.status)});}
    const parts=[];let size=0;
    try {for await(const p of response.body){if((size+=p.length)>16384)throw new Error();parts.push(p);}
      const v=JSON.parse(Buffer.concat(parts));return v.data??v;
    }catch{throw new ProjectSyncError('INVALID_PLATFORM_RESPONSE');}
  }
  function project(v,input) {
    if(!v||v.sourceProjectId!==input.sourceProjectId||v.projectId!==input.sourceProjectId||v.projectName!==input.name||v.projectSummary!==input.summary)throw new ProjectSyncError('PROJECT_RESPONSE_MISMATCH',{permanent:true});
    let url;try{url=new URL(v.projectUrl);}catch{throw new ProjectSyncError('INVALID_PLATFORM_RESPONSE');}
    if(url.origin!==new URL(ORIGIN).origin||url.pathname!==new URL(ORIGIN).pathname+'/requirements'||url.username||url.password||url.hash||url.searchParams.get('project')!==input.name||[...url.searchParams.keys()].some(k=>k!=='project'))throw new ProjectSyncError('INVALID_PLATFORM_RESPONSE');
    return {projectId:v.projectId,url:url.href};
  }
  return {async ensure(job) {
    const input={sourceProjectId:job.id,name:job.name,summary:job.summary};
    const found=await call('lookup',{sourceProjectId:job.id});
    if(!found||!Object.hasOwn(found,'project'))throw new ProjectSyncError('INVALID_PLATFORM_RESPONSE');
    return project(found.project??await call('sync',input),input);
  }};
}
