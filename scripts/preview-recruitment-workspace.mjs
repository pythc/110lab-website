import {previewPdfFixture,previewDocxFixture} from '../tests/fixtures/resume-preview.mjs';
// Disposable loopback-only fixtures. Never loads production config or outbound providers.
import {createServer} from 'node:http';
import {readFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {openRecruitmentWorkflowStore} from '../server/recruitment-workflow-store.mjs';
import {createRecruitmentWorkflowHttp} from '../server/recruitment-workflow-http.mjs';
import {runWorkflowDeliveryOnce} from '../server/recruitment-workflow-worker.mjs';
import {serveAsset} from '../server/assets.mjs';
import {MailAuthError} from '../server/mail-auth.mjs';
const directory=await mkdtemp(join(tmpdir(),'110lab-workspace-preview-'));
let clock=Date.now()-86400000;
const actor={subject:'fixture:on_preview0000001',name:'林老师（虚构）',email:'interviewer@example.com',role:'super_admin',csrf:randomBytes(24).toString('hex')};
const s=openRecruitmentWorkflowStore({directory,deliveryMode:'dry-run',now:()=>clock});
const action=(c,name,values={})=>s.act(actor,c.id,{requestId:randomUUID(),revision:c.revision,action:name,...values});
const command=(c,name,values={})=>s[name](actor,c.id,{requestId:randomUUID(),revision:c.revision,...values});
const drain=async()=>{while(await runWorkflowDeliveryOnce(s,{mode:'dry-run',roleForSubject:()=>actor.role,intervalMs:0}));};
const buffer=previewPdfFixture(),docxBuffer=await previewDocxFixture(await readFile(new URL('../src/assets/110lab-icon.png',import.meta.url)));
const image=s.saveImage(actor,{requestId:randomUUID(),data:(await readFile(new URL('../src/assets/110lab-icon.png',import.meta.url))).toString('base64')});
const t=s.templates(actor).items.find(t=>(t.kind||'interview')==='interview');s.saveTemplate(actor,{requestId:randomUUID(),template:{...t,html:'<p style="text-align:center"><img src="cid:lab-'+image.id+'" width="160" alt="110lab"></p><h2 style="text-align:center">期待与你见面</h2><p>{{name}} 同学你好</p><p>感谢你申请 {{group}}，邀请你参加本次面试。</p><p>面试时间：{{interviewTime}}</p><p>面试官：{{interviewerName}}</p><p>会议链接：{{location}}</p><p>联系方式：{{interviewerContact}}</p><p style="text-align:right">110 实验室</p>'}});
const names=['陈知夏','周一凡','沈予安','许望','林予','苏可','陆溪'];
for(let i=0;i<names.length;i++){
 let c=s.create(actor,{requestId:randomUUID(),name:names[i]+'（虚构）',email:'candidate'+i+'@example.com',group:i%2?'产品组':'开发组',summary:'有图像识别与前端项目经历，希望参与实验室项目。此资料仅用于本地流程验证。'});
 c=s.attachResume(actor,c.id,{requestId:randomUUID(),revision:c.revision,buffer:i===0?docxBuffer:buffer,filename:i===0?'虚构简历.docx':'虚构简历.pdf',extension:i===0?'docx':'pdf',bytes:(i===0?docxBuffer:buffer).length,sha256:createHash('sha256').update(i===0?docxBuffer:buffer).digest('hex')});
 if(i===0)continue;
 c=action(c,'screen',{assessmentRequired:i===1,note:'本地测试'});if(i<3)continue;
 c=s.assignInterviewer(actor,c.id,{requestId:randomUUID(),revision:c.revision,subject:actor.subject},actor);await drain();c=s.get(actor,c.id);if(i===3)continue;
 s.proposeInterview(actor,c.assignment.id,{requestId:randomUUID(),revision:c.assignment.revision,at:new Date(clock+(i===4?172800000:3600000)).toISOString(),email:actor.email,contact:actor.email,location:'https://example.com/meeting'});c=s.get(actor,c.id);if(i===4)continue;
 const template=s.templates(actor).items[0];c=action(c,'prepare_notice',{templateId:template.id,templateRevision:template.revision,values:{}});c=action(c,'send_notice',{previewHash:s.preview(actor,c.id,'interview').previewHash});await drain();
 if(i===6){const old=clock;clock+=7200000;c=s.get(actor,c.id);s.submitFeedback(actor,c.assignment.id,{requestId:randomUUID(),revision:c.assignment.revision,score:86,note:'项目讲解清晰，具备实践能力。仅为虚构评价。',recommendation:'recommend'});clock=old;}
}
clock=Date.now();
const mail={enabled:true,workspaceDirectory:directory,roleForSubject:()=>actor.role,projectMembers:async()=>({members:[actor,{subject:'fixture:on_hrpreview00001',name:'陈老师（虚构）',email:'hr@example.test'}],source:'fixture'}),identity(req,{write}={}){if(write&&req.headers['x-csrf-token']!==actor.csrf)throw new MailAuthError(403,'CSRF');return actor;}};
const workflow=createRecruitmentWorkflowHttp({mail,enabled:true,store:s,localTest:true,deliveryMode:'dry-run'});
const csp="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'";
const server=createServer(async(req,res)=>{try{
 if(req.headers.host!=='127.0.0.1:4196'){res.writeHead(421);res.end();return;}
 const path=new URL(req.url,'http://local').pathname;res.setHeader('Cache-Control','no-store');
 if(await workflow.handle(req,res,path,'127.0.0.1'))return;
 if(path.startsWith('/assets/')&&await serveAsset(req,res,path.slice(8)))return;
 if(['/recruitment','/recruitment/embedded','/recruitment/interviewer'].includes(path)){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':csp});res.end(await readFile(new URL('../dist/'+(path==='/recruitment/interviewer'?'recruitment-interviewer':'recruitment')+'.html',import.meta.url)));return;}
 res.writeHead(404);res.end();
}catch(e){console.error(e.message);res.writeHead(500);res.end('Preview error');}});
server.listen(4196,'127.0.0.1',()=>console.log('Fictional preview http://127.0.0.1:4196/recruitment — no external delivery'));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(async()=>{await workflow.close();s.close();process.exit(0);}));
