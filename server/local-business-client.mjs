import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {openSync,fstatSync,readSync,closeSync,constants} from 'node:fs';
import {basename,isAbsolute} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {UnauthorizedError,extractWWWAuthenticateParams,auth} from '@modelcontextprotocol/sdk/client/auth.js';
import {ISSUER,RESOURCE,portalFetch} from './local-portal-client.mjs';
import {BUSINESS_SCOPES} from './business-scopes.mjs';

const error=message=>({isError:true,content:[{type:'text',text:message}]});
export {credentialFile} from './local-credential-store.mjs';
import {credentialFile} from './local-credential-store.mjs';
export function createLocalBusinessClient({fetchImpl=portalFetch,storage=credentialFile(),timeoutMs=300000}={}){
  let saved={},job,connecting,callBusy=false,releaseLock;
  const persist=()=>storage.save(saved);
  const provider={
    get redirectUrl(){return job?.redirect;},
    get clientMetadata(){return {redirect_uris:[job.redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:Object.keys(BUSINESS_SCOPES).join(' ')};},
    state:()=>job.state,clientInformation:()=>saved.client,saveClientInformation:v=>{saved.client=v;persist();},
    tokens:()=>saved.tokens,saveTokens:v=>{saved.tokens=v;persist();},saveCodeVerifier:v=>{job.verifier=v;},codeVerifier:()=>job?.verifier,
    invalidateCredentials(scope){if(['all','client'].includes(scope))delete saved.client;if(['all','tokens'].includes(scope))delete saved.tokens;if(['all','verifier'].includes(scope)&&job)delete job.verifier;persist();},
    async validateResourceURL(server,resource){if(String(server)!==RESOURCE||resource!==RESOURCE)throw new Error('Unexpected resource');return new URL(RESOURCE);},
    redirectToAuthorization(url){if(!job||url.origin!==ISSUER||url.pathname!=='/authorize'||url.searchParams.get('redirect_uri')!==job.redirect||url.searchParams.get('client_id')!==saved.client?.client_id||url.searchParams.get('state')!==job.state||url.searchParams.get('code_challenge_method')!=='S256'||url.searchParams.get('resource')!==RESOURCE)throw new Error('Invalid authorization URL');job.url=url.href;},
  };
  // SDK 1.30 refreshes on insufficient_scope without changing the grant.
  // Start explicit consent instead; retain the registered client so existing
  // drafts/previews stay bound to the same client across incremental grants.
  const authenticatedFetch=async(input,init)=>{
    const response=await fetchImpl(input,init);
    if(response.status===403&&String(input)===RESOURCE){const challenge=extractWWWAuthenticateParams(response);if(challenge.error==='insufficient_scope'&&challenge.scope?.split(' ').every(s=>s in BUSINESS_SCOPES)){delete saved.tokens;persist();}}
    return response;
  };
  const client=new Client({name:'110lab-business-local',version:'1.0.0'}),transport=new StreamableHTTPClientTransport(new URL(RESOURCE),{authProvider:provider,fetch:authenticatedFetch});
  const ready=()=>connecting||=client.connect(transport).catch(e=>{connecting=null;throw e;});
  const end=j=>{j.done=true;clearTimeout(j.timer);j.server.close();j.server.closeIdleConnections();releaseLock?.();releaseLock=undefined;};
  async function listener(){
    const j={state:randomBytes(32).toString('base64url'),done:false};job=j;
    j.server=createServer(async(req,res)=>{
      const reply=(status,text)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});res.end(text);};
      let u;try{u=new URL(req.url,j.redirect);}catch{reply(400,'回调无效');return;}
      if(req.method!=='GET'||req.headers.host!==new URL(j.redirect).host||u.pathname!==new URL(j.redirect).pathname||j!==job||j.done||j.finishing||u.searchParams.getAll('state').length!==1||u.searchParams.get('state')!==j.state||u.searchParams.getAll('iss').length!==1||u.searchParams.get('iss')!==ISSUER){reply(400,'授权状态不匹配');return;}
      if(u.searchParams.has('error')){reply(400,'授权已取消');end(j);return;}
      if(u.searchParams.getAll('code').length!==1||!/^[\w-]{43}$/.test(u.searchParams.get('code')||'')){reply(400,'授权码无效');return;}
      j.finishing=true;try{await transport.finishAuth(u.searchParams.get('code'));reply(200,'110lab 业务授权完成 请返回对话继续');}catch{reply(400,'授权未完成 请返回重试');}finally{end(j);}
    });
    j.server.requestTimeout=10000;j.server.headersTimeout=10000;
    await new Promise((resolve,reject)=>{j.server.once('error',reject);j.server.listen(0,'127.0.0.1',resolve);});
    j.redirect=`http://127.0.0.1:${j.server.address().port}/callback/110lab_business`;
    j.timer=setTimeout(()=>end(j),timeoutMs);j.timer.unref();return j;
  }
  const pending=j=>({isError:true,content:[{type:'text',text:'请打开此链接授权所需的 110lab 业务能力，完成后重试原操作：'+j.url}],structuredContent:{code:'AUTH_REQUIRED',authorizationUrl:j.url}});
  return {
    async call(name,args){
      if(job&&!job.done&&job.url)return pending(job);
      if(callBusy)return error('另一个业务请求正在进行 请稍后重试');callBusy=true;let current;
      try{
        releaseLock=storage.acquire?.();saved=storage.load();current=await listener();
        if(!saved.client){const registration=await fetchImpl(ISSUER+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(provider.clientMetadata)});if(!registration.ok)throw new Error('Registration failed');provider.saveClientInformation(await registration.json());}
        await ready();
        const value=name==='lab_file_upload'?localUpload(args):args;
        const result=await client.callTool({name,arguments:value});
        const extra=result._meta?.['mcp/www_authenticate']?.[0];
        if(result.isError&&result.structuredContent?.code==='SCOPE_REQUIRED'&&typeof extra==='string'){
          const required=extractWWWAuthenticateParams(new Response(null,{headers:{'WWW-Authenticate':extra}})).scope?.split(' ');
          if(!required?.length||required.some(s=>!Object.hasOwn(BUSINESS_SCOPES,s)))throw new Error('Invalid scope challenge');
          const scope=[...new Set(['lab:identity',...(saved.tokens?.scope||'').split(' ').filter(Boolean),...required])].join(' ');delete saved.tokens;persist();
          await auth(provider,{serverUrl:new URL(RESOURCE),scope,fetchFn:authenticatedFetch});throw new UnauthorizedError();
        }
        end(current);return result;
      }catch(e){if(e instanceof UnauthorizedError&&current?.url)return pending(current);if(current)end(current);else{releaseLock?.();releaseLock=undefined;}return error(e.safe?e.message:'业务请求未取得可确认结果 请先查询原操作状态 不要重复提交');}
      finally{callBusy=false;}
    },
    async close(){if(job&&!job.done)end(job);await client.close();},
  };
}
export function localUpload(args){
  if(!args||Object.keys(args).some(k=>!['requestId','purpose','path'].includes(k))||typeof args.path!=='string'||!isAbsolute(args.path)||!['honor_certificate','mail_attachment'].includes(args.purpose)||!/^[-a-f0-9]{36}$/.test(args.requestId||''))throw Object.assign(new Error('请指定用户明确提供的附件绝对路径和上传用途'),{safe:true});
  const fd=openSync(args.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size<=0||stat.size>10*1024*1024)throw Object.assign(new Error('附件必须是 10MB 以内的普通文件'),{safe:true});const buffer=Buffer.alloc(stat.size);let offset=0;while(offset<buffer.length){const n=readSync(fd,buffer,offset,buffer.length-offset,offset);if(!n)break;offset+=n;}const after=fstatSync(fd);if(offset!==buffer.length||stat.mtimeMs!==after.mtimeMs||stat.size!==after.size)throw Object.assign(new Error('附件在读取时发生变化 请重试'),{safe:true});return {requestId:args.requestId,purpose:args.purpose,filename:basename(args.path),contentBase64:buffer.toString('base64')};}finally{closeSync(fd);}
}
