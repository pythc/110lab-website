// Loopback-only development entrypoint; deliberately excluded from releases.
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {createRecruitmentWorkflowHttp} from '../server/recruitment-workflow-http.mjs';
import {MailAuthError} from '../server/mail-auth.mjs';
const directory=resolve('artifacts/recruitment-workflow/local-data');await mkdir(directory,{recursive:true,mode:0o700});
const csrf=randomBytes(24).toString('hex');let role='super_admin';
const mail={projectMembers:async()=>({members:[{subject:'fictional:preview',name:'虚构管理员',email:'admin@example.com'}],source:'fixture'}),enabled:true,workspaceDirectory:directory,roleForSubject:()=>role,identity(req,{write}={}){if(role==='none')throw new MailAuthError(401,'请先登录');if(write&&req.headers['x-csrf-token']!==csrf)throw new MailAuthError(403,'CSRF');return {subject:'fictional:preview',name:'虚构管理员',email:'admin@example.com',role,csrf};}};
const workflow=createRecruitmentWorkflowHttp({mail,enabled:true,directory,localTest:true,deliveryMode:'dry-run'});
const server=createServer(async(req,res)=>{
 if(!/^127\.0\.0\.1:4195$/.test(req.headers.host||'')){res.writeHead(421);res.end();return;}
 res.setHeader('Cache-Control','no-store');const path=new URL(req.url,'http://local').pathname;
 if(await workflow.handle(req,res,path,'127.0.0.1'))return;
 if(['/recruitment','/recruitment/embedded','/recruitment/interviewer','/website'].includes(path)){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(await readFile(new URL(path==='/website'?'../dist/index.html':path==='/recruitment/interviewer'?'../dist/recruitment-interviewer.html':'../dist/recruitment.html',import.meta.url),'utf8'));return;}
 if(path==='/layout-preview'||path==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>招新联调预览</title><style>body{margin:0;font:14px system-ui}header{padding:12px;background:#eef2f6}iframe{border:0;width:100%;height:calc(100vh - 48px)}body:has(input:checked) iframe{width:375px;height:650px}</style><header>虚构身份 · 仅模拟 <label><input type="checkbox">窄屏</label> <a href="/website#join">官网投递</a></header><iframe title="招新管理" src="/recruitment/embedded"></iframe></html>');return;}
 res.writeHead(404);res.end();
});
server.listen(4195,'127.0.0.1',()=>console.log('Workflow preview http://127.0.0.1:4195/layout-preview'));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(async()=>{await workflow.close();process.exit(0);}));
