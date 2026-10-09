import {createHash} from 'node:crypto';
import {z} from 'zod';
import {cleanMailHtml,escapeHtml,imageIds} from './recruitment-rich-mail.mjs';

export const DEFAULT_RECRUITMENT_MAILBOX='noreply@110-lab.cn';
export const RECRUITMENT_FEISHU_APP_ID='cli_aae419847eb85bcf';
export const workflowText=(max,min=0)=>z.string().trim().min(min).max(max).refine(v=>!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v));
export const mailboxSchema=z.email().max(254).transform(v=>v.toLowerCase());
export const VARIABLE_LABELS=Object.freeze({name:'姓名',group:'应聘组别',interviewTime:'面试时间',interviewerName:'面试官姓名',interviewerEmail:'面试官邮箱',interviewerContact:'面试官联系方式',location:'地点或会议链接',applicationId:'投递编号',decisionNote:'结果说明'});
const variableName=z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/);
export const templateSchema=z.object({
  id:z.uuid(),revision:z.number().int().min(0),name:workflowText(80,1),
  kind:z.enum(['interview','receipt','accepted','rejected']).default('interview'),html:workflowText(60000).default(''),
  subject:workflowText(180,1).refine(v=>!/[\r\n]/.test(v)),body:workflowText(12000,1),
  variables:z.array(z.object({key:variableName,label:workflowText(60,1),required:z.boolean(),defaultValue:workflowText(500)}).strict()).max(20),
}).strict().superRefine((value,ctx)=>{
  const keys=value.variables.map(v=>v.key);
  if(new Set(keys).size!==keys.length||keys.some(k=>Object.hasOwn(VARIABLE_LABELS,k)||['constructor','prototype','__proto__'].includes(k)))ctx.addIssue({code:'custom',message:'自定义变量重复或占用系统变量'});
  const allowed=new Set([...Object.keys(VARIABLE_LABELS),...keys]);
  for(const source of [value.subject,value.body,value.html]){
    for(const match of source.matchAll(/\{\{([^{}]*)\}\}/g))if(!allowed.has(match[1].trim()))ctx.addIssue({code:'custom',message:'模板含未定义变量 '+match[1]});
    if(/[{}]/.test(source.replace(/\{\{[^{}]*\}\}/g,'')))ctx.addIssue({code:'custom',message:'变量格式为 {{name}}'});
  }
});
export function defaultInterviewTemplate(){return {
  id:'11011011-0110-4110-8110-110110110110',revision:1,name:'面试邀请',variables:[],
  subject:'[110实验室面试邀请] {{name}}-{{group}}',
  body:'{{name}} 同学你好\n\n感谢你申请加入 110 实验室，现邀请你参加 {{group}} 面试。\n\n面试时间：{{interviewTime}}\n地点或会议链接：{{location}}\n面试官：{{interviewerName}}\n联系方式：{{interviewerContact}}\n\n如需调整时间，请回复此邮件联系面试官。\n\n110 实验室',
};}
export function renderRecruitmentTemplate(template,candidate,values={}){
  const parsed=z.record(z.string(),workflowText(1000)).parse(values);
  const allowed=new Set(['interviewerEmail','interviewerContact',...template.variables.map(v=>v.key)]);
  if(Object.keys(parsed).some(k=>!allowed.has(k)))throw new Error('存在未定义或不可覆盖的模板变量');
  const variables=Object.assign(Object.create(null),{
    name:candidate.name,group:candidate.group,
    applicationId:candidate.id||'',decisionNote:candidate.decisionNote||'',
    interviewTime:candidate.interview?.at?new Date(candidate.interview.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+'（北京时间）':'',
    interviewerName:candidate.interview?.interviewer||'',location:candidate.interview?.location||'',
    interviewerEmail:parsed.interviewerEmail||candidate.interview?.email||'',
    interviewerContact:parsed.interviewerContact||candidate.interview?.contact||'',
  });
  for(const v of template.variables)variables[v.key]=parsed[v.key]??v.defaultValue;
  const missing=new Set();
  for(const v of template.variables)if(v.required&&!variables[v.key])missing.add(v.label);
  const substitute=(source,html=false)=>source.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,(_,key)=>{
    if(!variables[key]&&(Object.hasOwn(VARIABLE_LABELS,key)||template.variables.find(v=>v.key===key)?.required))missing.add(VARIABLE_LABELS[key]||template.variables.find(v=>v.key===key)?.label||key);
    return html?escapeHtml(variables[key]||''):variables[key]||'';
  });
  const subject=substitute(template.subject),body=substitute(template.body),html=cleanMailHtml(substitute(cleanMailHtml(template.html||''),true));
  if(missing.size)throw new Error('请填写变量：'+[...missing].join('、'));
  const replyTo=mailboxSchema.safeParse(variables.interviewerEmail);
  if((template.kind||'interview')==='interview'&&!replyTo.success)throw new Error('请填写面试官的有效联系邮箱 用于接收候选人回复');
  if(/[\r\n]/.test(subject)||subject.length>300)throw new Error('邮件主题过长或包含换行');
  if(body.length>20000)throw new Error('邮件正文过长');
  return {subject,body,html,imageIds:imageIds(html),replyTo:replyTo.success?replyTo.data:DEFAULT_RECRUITMENT_MAILBOX,variables};
}
export const renderInterviewTemplate=renderRecruitmentTemplate;
export function defaultRecruitmentTemplates(){return [defaultInterviewTemplate(),...[['receipt','投递回执','简历已收到','感谢你申请加入 110 实验室。你的 {{group}} 简历已收到，编号 {{applicationId}}。我们将审核资料，并通过邮件通知后续安排。'],['accepted','录取通知','录取通知','祝贺你通过 110 实验室 {{group}} 的招新选拔。后续安排：{{decisionNote}}'],['rejected','未通过通知','招新结果','感谢你对 110 实验室 {{group}} 的关注。本次申请未通过，感谢你的时间与投入。{{decisionNote}}']].map(([kind,name,title,body],i)=>({id:'11011011-0110-4110-8110-11011011011'+(i+1),revision:1,kind,name,subject:'[110实验室'+title+'] {{name}}',body:'{{name}} 同学你好\n\n'+body+'\n\n110 实验室',html:'',variables:[]}))];}
export const previewHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
