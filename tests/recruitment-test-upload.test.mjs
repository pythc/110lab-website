import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRecruitmentTestHttp} from '../server/recruitment-test-http.mjs';
import {openRecruitmentTestStore, TEST_RESUME_RETENTION_MS} from '../server/recruitment-test-store.mjs';
import {MailAuthError} from '../server/mail-auth.mjs';

const pdf=Buffer.from('%PDF-1.4\n% Fictional recruitment test only\n%%EOF\n');
const person={subject:'fictional:upload-admin',name:'虚构管理员',role:'admin',csrf:'test-csrf'};

test('private resumes validate uploads, reject stale/duplicate writes, survive restart and expire',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'110lab-test-resume-'));
  let clock=Date.now(),role='admin';
  const mail={enabled:true,workspaceDirectory:directory,identity(req,{write}={}){
    if(req.headers.cookie!=='fictional=admin')throw new MailAuthError(401,'未登录');
    if(write&&req.headers['x-csrf-token']!=='test-csrf')throw new MailAuthError(403,'CSRF');
    return {...person,role};
  }};
  const app=createRecruitmentTestHttp({mail,now:()=>clock});
  const server=createServer(async(req,res)=>{
    if(!await app.handle(req,res,new URL(req.url,'http://localhost').pathname,req.headers.host)){res.writeHead(404);res.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));app.close();await rm(directory,{recursive:true,force:true});});
  const base='/api/recruitment-test/';
  const call=(path,{body,headers={},onPartial}={})=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path:base+path,method:body?'POST':'GET',headers:{Host:'internal.110-lab.cn',Origin:'https://internal.110-lab.cn',Cookie:'fictional=admin','X-CSRF-Token':'test-csrf',...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        const buffer=Buffer.concat(chunks);let value;try{value=JSON.parse(buffer.toString());}catch{}
        resolve({status:res.statusCode,headers:res.headers,buffer,value});
      });
    });
    req.on('error',reject);
    if(onPartial){req.write(body.subarray(0,100));setTimeout(()=>{onPartial();req.end(body.subarray(100));},25);}
    else req.end(body);
  });
  const candidate=await call('candidates',{body:JSON.stringify({requestId:randomUUID(),name:'虚构测试生',group:'人工智能组',email:'fiction@example.com',summary:'测试资料'}),headers:{'Content-Type':'application/json; charset=utf-8'}});
  assert.equal(candidate.status,201);
  const id=candidate.value.id;
  const upload=async({content=pdf,filename='虚构简历.pdf',type='application/pdf',revision=1,requestId=randomUUID(),extra=false,...options}={})=>{
    const form=new FormData();form.set('requestId',requestId);form.set('revision',String(revision));
    form.append('resume',new Blob([content],{type}),filename);
    if(extra)form.append('resume',new Blob([pdf],{type:'application/pdf'}),'second.pdf');
    const payload=new Request('http://localhost',{method:'POST',body:form});
    return call('candidates/'+id+'/resume',{...options,body:Buffer.from(await payload.arrayBuffer()),headers:{'Content-Type':payload.headers.get('content-type'),...options.headers}});
  };
  assert.equal((await upload({headers:{Cookie:''}})).status,401);
  assert.equal((await upload({headers:{'X-CSRF-Token':'wrong'}})).status,403);
  assert.equal((await upload({headers:{Origin:'https://other.example'}})).status,403);
  assert.equal((await upload({headers:{Host:'110-lab.cn'}})).status,404);
  assert.equal((await upload({filename:'cv.exe'})).status,415);
  assert.equal((await upload({filename:'cv.docx',type:'application/octet-stream'})).status,400);
  assert.equal((await upload({content:Buffer.from('not a pdf')})).status,400);
  assert.equal((await upload({content:Buffer.alloc(10*1024*1024+1)})).status,413);
  assert.equal((await upload({extra:true})).status,400);
  assert.equal((await upload({onPartial:()=>{role='member';}})).status,403);
  role='admin';
  const key=randomUUID(),ok=await upload({requestId:key});
  assert.equal(ok.status,200);assert.equal(ok.value.revision,2);assert.equal(ok.value.resume.bytes,pdf.length);
  assert.equal(ok.value.resume.filename,'虚构简历.pdf');
  assert.equal(Object.hasOwn(ok.value.resume,'url'),false);
  const duplicate=await upload({requestId:key});
  assert.equal(duplicate.status,200);assert.equal(duplicate.value.revision,2);
  assert.equal((await upload()).status,409);
  assert.equal((await upload({requestId:key,filename:'changed.pdf'})).status,409);
  const downloaded=await call('candidates/'+id+'/resume');
  assert.equal(downloaded.status,200);assert.deepEqual(downloaded.buffer,pdf);
  assert.match(downloaded.headers['cache-control'],/no-store/);assert.match(downloaded.headers['content-disposition'],/^attachment/);
  assert.equal((await call('candidates/'+id+'/resume',{headers:{Cookie:''}})).status,401);
  role='member';assert.equal((await call('candidates/'+id+'/resume')).status,403);role='admin';
  const reopened=openRecruitmentTestStore({directory,now:()=>clock});
  assert.deepEqual(reopened.readResume(person,id).buffer,pdf);
  clock+=TEST_RESUME_RETENTION_MS+1;
  assert.equal((await call('candidates/'+id+'/resume')).status,404);
  assert.equal((await call('candidates/'+id)).value.resume,null);
  assert.equal(reopened.cleanup().changes,1);
  assert.equal(reopened.cleanup().changes,0);
  reopened.close();
});
