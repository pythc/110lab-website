import {createRelay,loadCredentials} from '../plugin/110lab/mcp/requirements-client.mjs';

const APP='https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x';
const text=(value,max=240)=>typeof value==='string'?value.slice(0,max):'';
const date=value=>{if(value===null||value===undefined||value==='')return null;const d=new Date(typeof value==='string'&&/^\d{11,14}$/.test(value)?Number(value):value);return Number.isFinite(d.getTime())?d.toISOString():null;};
const terminal=new Set(['已发布','已关闭']);

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
      // The source performs identity matching and filters before pagination.
      // Old servers use open IDs in list handlers; never match display names.
      const discovery=await rpc('tools/list',{});
      let mine=[],partial=false,stale=false,accountName='';
      const claims=JSON.parse(Buffer.from(credentials.personalToken.split('.')[1],'base64url').toString('utf8'));
      if(discovery.tools?.some(t=>t.name==='my_requirement_todos')){
        let complete=false;
        for(let attempt=0;attempt<2&&!complete;attempt++){
          mine=[];let cursor;const seen=new Set();
          for(let page=0;page<100;page++){
            const result=await call('my_requirement_todos',{limit:100,...(cursor?{cursor}:{})});
            if(result.restartRequired)break;
            if(!Array.isArray(result.requirements)||!Number.isSafeInteger(result.total)||result.total<0)throw new Error('Invalid source');
            accountName=text(result.accountName,80);stale||=result.stale===true;
            for(const item of result.requirements){if(typeof item.id!=='string'||seen.has(item.id))throw new Error('Inconsistent source');seen.add(item.id);mine.push(item);}
            if(!result.nextCursor){if(mine.length!==result.total)throw new Error('Incomplete source');complete=true;break;}
            if(typeof result.nextCursor!=='string'||result.nextCursor===cursor)throw new Error('Invalid cursor');
            cursor=result.nextCursor;
            if(page===99){partial=true;complete=true;}
          }
        }
        if(!complete)throw new Error('Source changed during read');
      }else{
        const requirements=await call('requirements_list',{limit:100});
        if(!Array.isArray(requirements.requirements)||typeof claims.openId!=='string'||!claims.openId)throw new Error('Missing identity');
        mine=requirements.requirements.filter(r=>!terminal.has(r.status)&&Array.isArray(r.handlers)&&r.handlers.some(person=>person.id===claims.openId));
        accountName=text(claims.name,80);partial=requirements.requirements.length>=100;
      }
      let reviews=[],reviewState='ready';
      try{
        if(typeof claims.employeeId!=='string'||!claims.employeeId)throw new Error('Missing identity');
        const prs=await call('pull_requests_list',{state:'OPEN',limit:100});
        if(!Array.isArray(prs.pullRequests)||!Array.isArray(prs.reviewerCandidates))throw new Error('Invalid source');
        const logins=new Set(prs.reviewerCandidates.filter(c=>c.feishuEmployeeId===claims.employeeId&&typeof c.login==='string').map(c=>c.login.toLowerCase()));
        reviews=prs.pullRequests.filter(r=>r.state==='OPEN'&&Array.isArray(r.requestedReviewers)&&r.requestedReviewers.some(p=>typeof p.login==='string'&&logins.has(p.login.toLowerCase())));
        partial||=prs.pullRequests.length>=100;stale||=prs.stale===true;
      }catch{reviewState='unavailable';}

      return {state:'ready',accountName,partial,stale,reviewState,refreshedAt:new Date().toISOString(),items:[
        ...mine.map(r=>({id:'requirement:'+text(r.id,200),kind:'requirement',title:text(r.code,40)+' '+text(r.title),status:text(r.status,80),projectName:text(r.project,120),dueAt:date(r.deadlineAt),url:APP+'/requirements/'+encodeURIComponent(text(r.id,200))})),
        ...reviews.filter(r=>Number.isSafeInteger(r.number)&&r.number>0).map(r=>({id:'review:'+r.number,kind:'requirement',title:'评审 #'+r.number+' '+text(r.title),status:'待我评审',projectName:text(r.repository,120),dueAt:null,url:APP+'/pull-requests/'+r.number}))
      ]};
    }catch{return {state:'unavailable',items:[]};}
  }
  return ()=>pending||=(read().finally(()=>{pending=null;}));
}
