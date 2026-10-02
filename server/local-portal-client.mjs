import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {UnauthorizedError} from '@modelcontextprotocol/sdk/client/auth.js';

export const ISSUER='https://internal.110-lab.cn',RESOURCE=ISSUER+'/mcp/workbench-v6-1';
const secret=v=>typeof v==='string'&&/^[\w-]{43}$/.test(v);
const error=text=>({isError:true,content:[{type:'text',text}]});
const paths=new Set(['/mcp/workbench-v6-1','/.well-known/oauth-protected-resource/mcp/workbench-v6-1','/.well-known/oauth-protected-resource','/.well-known/oauth-authorization-server','/register','/token']);
export async function portalFetch(input,options={}){
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.origin!==ISSUER||!paths.has(url.pathname)||url.username||url.password)throw new Error('Unexpected OAuth destination');
  return fetch(input,{...options,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(15000),...(options.signal?[options.signal]:[])])});
}

// A public OAuth client lives in the local plugin process. No Feishu App Secret
// is shipped, and tokens/PKCE material never enter tool content or disk storage.
export function createMailLoginClient({fetchImpl=portalFetch,timeoutMs=260000}={}){
  let information,tokens,verifier,job,connecting;
  const provider={
    get redirectUrl(){return job?.redirect;},
    get clientMetadata(){return {redirect_uris:[job.redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:'mail:session'};},
    state:()=>job.oauthState,
    clientInformation:()=>information,saveClientInformation:value=>{information=value;},
    tokens:()=>tokens,saveTokens:value=>{if(!job||job.done)throw new Error('Login expired');tokens=value;},
    saveCodeVerifier:value=>{verifier=value;},codeVerifier:()=>verifier,
    invalidateCredentials(scope){if(['all','client'].includes(scope))information=undefined;if(['all','tokens'].includes(scope))tokens=undefined;if(['all','verifier'].includes(scope))verifier=undefined;},
    async validateResourceURL(server,resource){if(String(server)!==RESOURCE||resource!==RESOURCE)throw new Error('Unexpected resource');return new URL(RESOURCE);},
    redirectToAuthorization(url){
      if(!job||job.done||url.origin!==ISSUER||url.pathname!=='/authorize'||url.username||url.password||url.searchParams.get('redirect_uri')!==job.redirect||url.searchParams.get('client_id')!==information?.client_id||url.searchParams.get('state')!==job.oauthState||url.searchParams.get('code_challenge_method')!=='S256'||url.searchParams.get('resource')!==RESOURCE)throw new Error('Unexpected authorization page');
      job.authorization=url.href;
    }
  };
  const client=new Client({name:'110lab-local-login',version:'0.8.7'});
  const transport=new StreamableHTTPClientTransport(new URL(RESOURCE),{authProvider:provider,fetch:fetchImpl});
  const connect=()=>connecting ||= client.connect(transport).catch(e=>{connecting=null;throw e;});
  function closeListener(current){clearTimeout(current.timer);current.listener?.close();current.listener?.closeIdleConnections();}
  function settle(current,success){if(current.done)return;current.done=true;closeListener(current);current.resolve(success);}
  async function listener(current){
    const page=(res,status,title)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"});res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title} · 110lab</title><style>body{margin:60px auto;max-width:480px;padding:24px;font:16px/1.7 system-ui;color:#23304b;background:#f5f7fa}h1{font-size:24px}</style><h1>${title}</h1><p>请返回 110lab 公共邮箱管理</p></html>`);};
    current.listener=createServer(async(req,res)=>{
      let u;try{u=new URL(req.url,current.redirect);}catch{page(res,400,'回调无效');return;}
      const expected=new URL(current.redirect);
      if(req.method!=='GET'||req.headers.host!==expected.host||u.origin!==expected.origin||u.pathname!==expected.pathname){page(res,404,'页面不存在');return;}
      if(current!==job||current.done||current.callbackStarted||u.searchParams.getAll('state').length!==1||u.searchParams.get('state')!==current.oauthState||u.searchParams.getAll('iss').length!==1||u.searchParams.get('iss')!==ISSUER){page(res,400,'登录状态不匹配');return;}
      if(u.searchParams.has('error')){page(res,400,'授权未完成');settle(current,false);return;}
      if(u.searchParams.getAll('code').length!==1||!secret(u.searchParams.get('code'))){page(res,400,'回调无效');return;}
      current.callbackStarted=true;
      try{await transport.finishAuth(u.searchParams.get('code'));if(current.done)throw new Error('Expired');page(res,200,'已完成连接');settle(current,true);}
      catch{page(res,400,'连接未完成 请重新登录');settle(current,false);}
      finally{current.callbackFinished=true;}
    });
    current.listener.requestTimeout=10000;current.listener.headersTimeout=10000;
    await new Promise((resolve,reject)=>{current.listener.once('error',reject);current.listener.listen(0,'127.0.0.1',resolve);});
    current.redirect=`http://127.0.0.1:${current.listener.address().port}/callback/110lab_public_mail`;
    current.timer=setTimeout(()=>settle(current,false),timeoutMs);current.timer.unref();
  }
  return {
    async start({state,fresh=false}={}){
      if(!secret(state)||typeof fresh!=='boolean')return error('登录请求无效');
      if(job&&(!job.done||job.starting||job.callbackStarted&&!job.callbackFinished))return error('已有登录正在进行 请完成授权或稍后重试');
      const current={state,fresh,oauthState:randomBytes(32).toString('base64url'),done:false,starting:true};current.wait=new Promise(resolve=>{current.resolve=resolve;});job=current;
      try{
        await listener(current);await connect();
        const result=await client.callTool({name:'connect_110lab_mail',arguments:{state,fresh}});
        settle(current,false);return result;
      }catch(e){
        if(e instanceof UnauthorizedError&&current.authorization&&!current.done)return {content:[{type:'text',text:'请在飞书完成登录'}],_meta:{mailAuthorization:{state,url:current.authorization}}};
        settle(current,false);return error('无法启动飞书登录 请稍后重试');
      }finally{current.starting=false;}
    },
    async finish({state,cancel=false}={}){
      const current=job;if(!secret(state)||!current||current.state!==state||!current.authorization)return error('登录请求已失效 请重新登录');
      if(typeof cancel!=='boolean')return error('登录请求无效');
      if(cancel){settle(current,false);return {content:[{type:'text',text:'已取消本次连接'}]};}
      if(!current.done)return {content:[{type:'text',text:'等待用户完成飞书登录'}],_meta:{mailAuthorizationPending:{state}}};
      current.result ||= (async()=>{
        if(!await current.wait||current!==job)return error('授权未完成 请重新登录');
        try{return await client.callTool({name:'connect_110lab_mail',arguments:{state,fresh:current.fresh}});}catch{return error('连接未完成 请重新登录');}
      })();return current.result;
    },
    async close(){if(job)settle(job,false);await client.close();tokens=undefined;verifier=undefined;information=undefined;}
  };
}
