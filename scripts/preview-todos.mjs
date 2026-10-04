// Local-only visual fixture. No credentials or external provider calls.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

const profile={subject:'fictional:viewer',name:'虚构成员',role:'member'};
const items=Array.from({length:60},(_,i)=>({
  id:'fictional-'+i,kind:'requirement',title:`REQ-TEST-${String(i+1).padStart(3,'0')} 验证工作台待办列表的滚动和条目选择`,
  projectName:'本地虚构项目',status:'开发中',url:'https://example.test/requirements/'+i,
}));
const server=createServer(async(req,res)=>{
  if(!/^127\.0\.0\.1:\d+$/.test(req.headers.host||'')){res.writeHead(421).end();return;}
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET'){res.writeHead(405).end();return;}
  if(path==='/layout-preview'){
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>待办滚动 · 本地虚构数据</title><style>body{margin:0;font:13px system-ui;background:#e8edf2}header{padding:8px 16px}iframe{display:block;border:0;width:100%;height:calc(100dvh - 36px)}body:has(input:checked) iframe{width:375px;max-width:100%;height:700px;margin:auto}</style><header>本地虚构数据 <label><input type="checkbox">窄屏</label></header><iframe title="工作台待办" src="/workbench/embedded"></iframe><script>addEventListener('message',e=>{if(e.source!==document.querySelector('iframe').contentWindow||e.origin!==location.origin)return;if(e.data?.type==='110lab-workspace-requirements')e.source.postMessage({type:'110lab-workspace-requirements-result',requestId:e.data.requestId,result:{state:'ready',accountName:'虚构成员',items:[],reviewState:'ready'}},location.origin);});</script></html>`);return;
  }
  if(['/workbench','/workbench/embedded'].includes(path)){
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(await readFile(new URL('../dist/workbench.html',import.meta.url)));return;
  }
  const route=path.split('/').at(-1);
  const data={session:profile,members:{members:[profile],source:'fixture'},projects:{projects:[]},todos:{items}}[route];
  if(path.startsWith('/api/workspace/')&&data){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));return;}
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1',()=>console.log(`http://127.0.0.1:${server.address().port}/layout-preview`));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
