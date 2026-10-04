// Local visual fixture only. Excluded from deployment; no identity/provider calls.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const page=await readFile(new URL('../dist/mcp-confirm.html',import.meta.url));
const id='33333333-3333-4333-8333-333333333333';let state='PENDING_CONFIRMATION';
const server=createServer((req,res)=>{
  if(req.url.startsWith('/mcp-confirm')){res.setHeader('Content-Type','text/html');res.end(page);return;}
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/business/session'){res.end(JSON.stringify({subject:'fictional:owner',name:'虚构管理员',role:'super_admin',csrf:'fixture'}));return;}
  if(req.url==='/api/business/confirmations/'+id){if(req.method==='POST'){state='APPROVED';req.resume();}res.end(JSON.stringify({id,kind:'mail.send',state,expiresAt:new Date(Date.now()+600000).toISOString(),fingerprint:'f'.repeat(64),preview:{mode:'dry-run',fields:{mailbox:'noreply@notify.110-lab.cn',to:['candidate@example.test'],cc:[],bcc:[],replyTo:'interviewer@example.test',subject:'110 实验室 · 面试安排（虚构预览）',body:'林同学，你好\n\n感谢你关注 110 实验室。我们邀请你参加项目交流，请按约定时间与面试官联系。\n\n面试官：陈老师\n联系邮箱：interviewer@example.test\n\n本页只用于本地界面验收 不会发送邮件',attachments:[]}}}));return;}
  res.writeHead(404);res.end('{}');
});server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port+'/mcp-confirm?id='+id));
