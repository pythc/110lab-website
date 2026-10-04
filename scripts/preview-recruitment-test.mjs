// Development-only fictional identity. This entrypoint is never packaged in
// the service or plugin and binds only to the loopback interface.
import {createServer} from 'node:http';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {randomBytes} from 'node:crypto';
import {createRecruitmentTestHttp} from '../server/recruitment-test-http.mjs';
import {MailAuthError} from '../server/mail-auth.mjs';

const {values}=parseArgs({options:{'data-directory':{type:'string'}}});
const persistent=!!values['data-directory'];
const directory=persistent?resolve(values['data-directory']):await mkdtemp(join(tmpdir(),'110lab-recruitment-preview-'));
const csrf=randomBytes(24).toString('hex');
let role='super_admin';
const mail={enabled:true,workspaceDirectory:directory,identity(req,{write}={}){
  if(role==='none')throw new MailAuthError(401,'请先登录');
  if(write&&req.headers['x-csrf-token']!==csrf)throw new MailAuthError(403,'CSRF');
  return {subject:'fictional:preview',name:'虚构管理员',email:'admin@example.com',role,csrf};
}};
const pilot=createRecruitmentTestHttp({mail,localTest:true});
const server=createServer(async(req,res)=>{
  if(!/^127\.0\.0\.1:\d+$/.test(req.headers.host||'')){res.writeHead(421);res.end();return;}
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  if(await pilot.handle(req,res,path,'127.0.0.1'))return;
  if(['/api/mail/logout','/api/mail/embedded/logout'].includes(path)&&req.method==='POST'&&req.headers['x-csrf-token']===csrf){role='none';res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return;}
  if(['/preview-role/member','/preview-role/super_admin','/preview-role/none'].includes(path)&&req.method==='GET'){
    role=path.split('/').at(-1);res.writeHead(303,{Location:'/layout-preview'});res.end();return;
  }
  if(path==='/'||path==='/layout-preview'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>110lab 招新本地预览</title><style>*{box-sizing:border-box}body{margin:0;background:#e8edf2;color:#475569;font:13px system-ui}header{display:flex;gap:20px;padding:10px 20px;flex-wrap:wrap;align-items:center}a{color:inherit}iframe{display:block;border:1px solid #dce3ec;width:min(1440px,100%);height:calc(100vh - 44px);margin:auto;background:white;border-radius:12px}body:has(input:checked) iframe{width:375px;height:650px;max-width:100%}</style><header><b>本地预览 · 虚构身份</b><label><input type="checkbox">窄屏 375px</label><a href="/preview-role/super_admin">超级管理员</a><a href="/preview-role/member">普通成员</a><a href="/preview-role/none">未登录</a></header><iframe title="招新流程测试" src="/recruitment-test/embedded"></iframe></html>`);return;
  }
  if(['/recruitment-test','/recruitment-test/embedded'].includes(path)){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end(await readFile(new URL('../dist/recruitment-test.html',import.meta.url),'utf8'));return;
  }
  res.writeHead(404);res.end();
});
server.listen(4194,'127.0.0.1',()=>console.log('Fictional-only preview: http://127.0.0.1:4194/layout-preview'));
const close=()=>server.close(async()=>{pilot.close();if(!persistent)await rm(directory,{recursive:true,force:true});process.exit(0);});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,close);
