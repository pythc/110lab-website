import {createRelay,loadCredentials} from '../plugin/110lab/mcp/requirements-client.mjs';

const APP='https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x';
const text=(value,max=240)=>typeof value==='string'?value.slice(0,max):'';
const date=value=>{if(value===null||value===undefined||value==='')return null;const d=new Date(value);return Number.isFinite(d.getTime())?d.toISOString():null;};
const terminal=new Set(['已发布','已关闭','已取消','已完成']);

// The personal token is checked by the existing requirement platform. Claims
// are used for filtering only AFTER a successful upstream authenticated read.
// Neither the token nor the transport key ever travels to the portal server.
export function createRequirementTodos({readCredentials=loadCredentials,makeRelay=createRelay}={}){
  let pending;
  async function read(){
    let credentials;try{credentials=readCredentials();}catch{return {state:'not_configured',items:[]};}
    try{
      const relay=makeRelay({readCredentials:()=>credentials,timeoutMs:25000});
      let id=0;
      const rpc=async(method,params)=>{
        const current=++id,response=await relay({jsonrpc:'2.0',id:current,method,params});
        const value=response.find(r=>r.id===current);if(!value?.result||value.error||value.result.isError)throw new Error('Source unavailable');return value.result;
      };
      await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'110lab-personal-todos',version:'0.9.0'}});
      await relay({jsonrpc:'2.0',method:'notifications/initialized'});
      const call=async(name,args)=>{const r=await rpc('tools/call',{name,arguments:args});const data=r.structuredContent||JSON.parse(r.content?.find(x=>x.type==='text')?.text||'null');if(!data||typeof data!=='object')throw new Error('Invalid source');return data;};
      // Sequential calls avoid racing session headers on the stateful relay.
      const requirements=await call('requirements_list',{limit:100});
      const claims=JSON.parse(Buffer.from(credentials.personalToken.split('.')[1],'base64url').toString('utf8'));
      if(typeof claims.employeeId!=='string'||!claims.employeeId||claims.employeeId.length>200)throw new Error('Missing identity');
      const prs=await call('pull_requests_list',{state:'OPEN',limit:100});
      if(!Array.isArray(requirements.requirements)||!Array.isArray(prs.pullRequests)||!Array.isArray(prs.reviewerCandidates))throw new Error('Invalid source');
      const mine=requirements.requirements.filter(r=>!terminal.has(r.status)&&Array.isArray(r.personnelUserIds?.handlers)&&r.personnelUserIds.handlers.includes(claims.employeeId));
      const logins=new Set(prs.reviewerCandidates.filter(c=>c.feishuEmployeeId===claims.employeeId&&typeof c.login==='string').map(c=>c.login.toLowerCase()));
      const reviews=prs.pullRequests.filter(r=>r.state==='OPEN'&&Array.isArray(r.requestedReviewers)&&r.requestedReviewers.some(p=>typeof p.login==='string'&&logins.has(p.login.toLowerCase())));
      return {state:'ready',accountName:text(claims.name,80),partial:requirements.requirements.length>=100||prs.pullRequests.length>=100,stale:prs.stale===true,refreshedAt:new Date().toISOString(),items:[
        ...mine.map(r=>({id:'requirement:'+text(r.id,200),kind:'requirement',title:text(r.code,40)+' '+text(r.title),status:text(r.status,80),projectName:text(r.project,120),dueAt:date(r.deadlineAt),url:APP+'/requirements/'+encodeURIComponent(text(r.id,200))})),
        ...reviews.filter(r=>Number.isSafeInteger(r.number)&&r.number>0).map(r=>({id:'review:'+r.number,kind:'requirement',title:'评审 #'+r.number+' '+text(r.title),status:'待我评审',projectName:text(r.repository,120),dueAt:null,url:APP+'/pull-requests/'+r.number}))
      ]};
    }catch{return {state:'unavailable',items:[]};}
  }
  return ()=>pending||=(read().finally(()=>{pending=null;}));
}
