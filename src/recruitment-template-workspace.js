import {mailEditor,mailPreview} from './recruitment-mail-editor.js';
import {templateKinds,variableNames} from './recruitment-tasks.js';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
export function createTemplateWorkspace({session,root,onStatus=()=>{}}){
  let templates=[],current=null,editor=null,dirty=false,busy=false,disposed=false,generation=0,previewGeneration=0,timer=null,request=null,kind='all',controls={},variables=[],lastField='body',subjectSelection={start:0,end:0};
  const button=(text,fn,cls='rt-button')=>{const b=el('button',text,cls);b.type='button';b.onclick=fn;return b;};
  const heading=el('div',undefined,'rw-page-heading'),title=el('div');title.append(el('h2','邮件模板'),el('p','编辑一次，在每位候选人的通知中复用'));heading.append(title,button('新建模板',()=>openNew(),'rt-button rt-primary'));
  const layout=el('div',undefined,'rw-template-layout'),sidebar=el('aside',undefined,'rw-template-sidebar'),main=el('div',undefined,'rw-template-main');
  root.replaceChildren(heading,layout);layout.append(sidebar,main);
  const changed=()=>{dirty=true;request=null;queuePreview();updateSavedState();};
  function updateSavedState(){if(controls.saved)controls.saved.textContent=busy?'正在保存':dirty?'有未保存的修改':'已保存';}
  function payload(){if(!current)throw Error('请选择模板');return {...current,name:controls.name.value.trim(),kind:controls.kind.value,subject:controls.subject.value.trim(),...editor.value(),variables:variables.map(v=>({key:v.key.value.trim(),label:v.label.value.trim(),defaultValue:v.defaultValue.value,required:v.required.checked}))};}
  async function load(){const gen=++generation;try{const result=await session.request('templates');if(disposed||gen!==generation)return;templates=result.items;renderSidebar();if(templates.length)render(templates[0]);}catch(e){onStatus(e.message,true);}}
  function mayLeave(){return !busy&&(!dirty&&!editor?.pending||confirm('模板尚未保存，切换会放弃当前修改。继续？'));}
  function renderSidebar(){
    sidebar.replaceChildren();const filter=el('select');filter.setAttribute('aria-label','按模板用途筛选');filter.append(new Option('全部模板','all'),...Object.entries(templateKinds).map(([k,v])=>new Option(v,k)));filter.value=kind;filter.onchange=()=>{kind=filter.value;renderSidebar();};sidebar.append(filter);
    for(const t of templates.filter(t=>kind==='all'||(t.kind||'interview')===kind)){const b=button('',()=>{if(mayLeave())render(t);},'rw-template-item');b.append(el('span',templateKinds[t.kind||'interview'],'rw-eyebrow'),el('strong',t.name));b.setAttribute('aria-current',String(current?.id===t.id));sidebar.append(b);}
  }
  function openNew(){if(!mayLeave())return;render({id:crypto.randomUUID(),revision:0,name:'新的面试邀请',kind:'interview',subject:'[110实验室面试邀请] {{name}}',body:'{{name}} 同学你好\n\n感谢你申请加入 110 实验室 {{group}}。\n\n面试时间：{{interviewTime}}\n面试官：{{interviewerName}}\n会议链接：{{location}}\n联系方式：{{interviewerContact}}\n\n110 实验室',html:'',variables:[]});dirty=true;updateSavedState();}
  function render(template){
    previewGeneration++;clearTimeout(timer);editor?.destroy();current={id:template.id,revision:template.revision};dirty=false;request=null;main.replaceChildren();controls={};variables=[];
    const form=el('form',undefined,'rw-template-form'),meta=el('div',undefined,'rw-template-meta');main.append(form);
    const field=(key,label,type,value)=>{const wrap=el('label',undefined,'rt-field'),input=el(type==='select'?'select':'input');input.name=key;if(type!=='select')input.type=type;input.required=true;wrap.append(el('span',label),input);controls[key]=input;input.value=value||'';return wrap;};
    meta.append(field('name','模板名称','text',template.name),field('kind','用途','select'));
    controls.name.maxLength=80;controls.kind.append(...Object.entries(templateKinds).map(([k,v])=>new Option(v,k)));controls.kind.value=template.kind||'interview';
    const subjectField=field('subject','邮件主题','text',template.subject);controls.subject.maxLength=180;
    controls.subject.onfocus=()=>{lastField='subject';};for(const name of ['keyup','mouseup','blur'])controls.subject.addEventListener(name,()=>subjectSelection={start:controls.subject.selectionStart||0,end:controls.subject.selectionEnd||0});
    form.append(meta,subjectField);
    const columns=el('div',undefined,'rw-template-columns'),editing=el('section',undefined,'rw-template-editing'),preview=el('section',undefined,'rw-template-preview');columns.append(editing,preview);form.append(columns);
    const bar=el('div',undefined,'rw-variable-bar'),selector=el('select');selector.setAttribute('aria-label','选择要插入的变量');controls.variableSelector=selector;
    bar.append(el('span','插入变量'),selector,button('插入',()=>{const key=selector.value;if(!key)return;if(lastField==='subject'){const input=controls.subject,{start,end}=subjectSelection;input.value=input.value.slice(0,start)+'{{'+key+'}}'+input.value.slice(end);subjectSelection={start:start+key.length+4,end:start+key.length+4};input.focus();input.setSelectionRange(subjectSelection.start,subjectSelection.end);changed();}else editor.insertVariable(key);}));editing.append(bar);
    const body=el('div',undefined,'rw-editor-container');body.addEventListener('focusin',e=>{if(e.target.isContentEditable)lastField='body';});editing.append(body);
    editor=mailEditor(session,template,body,error,changed);
    const previewHead=el('div',undefined,'rw-section-heading');previewHead.append(el('h3','实时预览'),el('span','虚构资料 · 不发送'));controls.previewStatus=el('p','正在生成预览','rt-help');controls.previewSubject=el('h4');controls.preview=el('div');preview.append(previewHead,controls.previewStatus,controls.previewSubject,controls.preview);
    const samples=el('details',undefined,'rw-template-samples');samples.append(el('summary','预览示例资料'));const sampleFields=el('div',undefined,'rw-template-meta');
    for(const[k,label,value]of [['sampleName','候选人姓名','林同学'],['sampleGroup','应聘组别','开发组']]){sampleFields.append(field(k,label,'text',value));controls[k].maxLength=k==='sampleName'?80:60;controls[k].required=false;}
    samples.append(sampleFields);preview.append(samples);
    const config=el('details',undefined,'rw-variable-config');config.append(el('summary','自定义变量与默认值'));controls.variables=el('div');config.append(el('p','例如面试地点、QQ群。设置默认值后，发送时可直接使用。','rt-help'),controls.variables,button('添加自定义变量',()=>{if(variables.length>=20)return;let n=1;const keys=variables.map(v=>v.key.value);while(keys.includes('field'+n))n++;addVariable({key:'field'+n,label:'新的字段',defaultValue:'',required:true});changed();}));form.append(config);
    for(const v of template.variables)addVariable(v);renderVariables();
    const footer=el('footer',undefined,'rw-template-footer');controls.saved=el('span','已保存','rt-help');controls.error=el('p',undefined,'rt-form-error');controls.error.setAttribute('role','alert');controls.error.hidden=true;controls.save=el('button','保存模板','rt-button rt-primary');controls.save.type='submit';footer.append(controls.saved,controls.error,controls.save);form.append(footer);
    form.addEventListener('input',e=>{if(e.target!==controls.sampleName&&e.target!==controls.sampleGroup&&!e.target.closest('.rt-rich-editor'))changed();else if(e.target===controls.sampleName||e.target===controls.sampleGroup)queuePreview();});
    form.addEventListener('change',e=>{if(e.target!==selector&&e.target!==controls.sampleName&&e.target!==controls.sampleGroup){changed();renderVariables();}});
    form.onsubmit=save;renderSidebar();queuePreview(0);
  }
  function error(message){if(!controls.error)return;controls.error.hidden=false;controls.error.textContent=message;}
  function addVariable(value){
    const row=el('div',undefined,'rw-custom-variable'),v={};
    for(const[key,label]of [['label','字段名称'],['defaultValue','默认值'],['key','变量标识']]){const labelNode=el('label',undefined,'rt-field'),input=el('input');input.type='text';input.value=value[key];input.maxLength=key==='defaultValue'?500:key==='key'?40:60;input.required=key!=='defaultValue';labelNode.append(el('span',label),input);row.append(labelNode);v[key]=input;}
    const required=el('label',undefined,'rt-checkbox');v.required=el('input');v.required.type='checkbox';v.required.checked=value.required;required.append(v.required,el('span','发送时必填'));
    row.append(required,button('移除',()=>{variables=variables.filter(x=>x!==v);row.remove();changed();renderVariables();}));variables.push(v);controls.variables.append(row);renderVariables();
  }
  function renderVariables(){if(!controls.variableSelector)return;const old=controls.variableSelector.value;controls.variableSelector.replaceChildren(...Object.entries(variableNames).map(([k,v])=>new Option(v,k)),...variables.filter(v=>v.label.value.trim()).map(v=>new Option(v.label.value,v.key.value)));if([...controls.variableSelector.options].some(o=>o.value===old))controls.variableSelector.value=old;}
  function queuePreview(delay=800){clearTimeout(timer);if(disposed)return;controls.previewStatus&&(controls.previewStatus.textContent='正在更新预览');timer=setTimeout(()=>void preview(),delay);}
  async function preview(){
    const gen=++previewGeneration;if(!editor||disposed)return;let template;try{template=payload();}catch(e){if(e.message.includes('上传')){queuePreview();return;}controls.previewStatus.textContent=e.message;return;}
    try{const result=await session.request('templates/preview',{method:'POST',data:{template,sample:{name:controls.sampleName.value.trim()||'林同学',group:controls.sampleGroup.value.trim()||'开发组'}}});if(disposed||gen!==previewGeneration)return;
      const container=el('div');await mailPreview(session,result.payload,container);if(disposed||gen!==previewGeneration)return;controls.preview.replaceChildren(container);controls.previewSubject.textContent=result.payload.subject;controls.previewStatus.textContent='示例预览已更新';
    }catch(e){if(!disposed&&gen===previewGeneration){controls.preview.replaceChildren();controls.previewSubject.textContent='';controls.previewStatus.textContent=e.message;}}
  }
  async function save(e){
    e.preventDefault();if(busy||!e.target.reportValidity())return;let template;try{template=payload();}catch(e){error(e.message);return;}
    const fingerprint=JSON.stringify(template);if(request?.fingerprint!==fingerprint)request={fingerprint,id:crypto.randomUUID()};busy=true;controls.error.hidden=true;editor.setDisabled(true);const all=[...main.querySelectorAll('input,select,button')];for(const n of all)n.disabled=true;updateSavedState();const gen=generation;
    try{const result=await session.request('templates',{method:'POST',data:{requestId:request.id,template}});if(disposed||gen!==generation)return;const index=templates.findIndex(t=>t.id===result.id);if(index<0)templates.push(result);else templates[index]=result;dirty=false;busy=false;render(result);onStatus('模板已保存。已发出的邮件保持原样，后续发送使用最新版本。');}
    catch(e){if(!disposed){error(e.status===409?'其他管理员已更新此模板。请保留当前内容，重新打开最新版本后再编辑。':e.message);}}
    finally{busy=false;if(!disposed){editor.setDisabled(false);for(const n of all)n.disabled=false;updateSavedState();}}
  }
  return {load,dirty:()=>dirty||!!editor?.pending,busy:()=>busy,destroy(){disposed=true;generation++;previewGeneration++;clearTimeout(timer);editor?.destroy();root.replaceChildren();}};
}
