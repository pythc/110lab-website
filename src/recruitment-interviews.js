import {saveResumeFile} from './resume-download.js';
import {createResumePreviewController} from './resume-preview.js';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const date=s=>s?new Date(s).toLocaleString('zh-CN',{hour12:false}):'待填写';
const local=s=>{const d=new Date(s);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
export function createInterviewWorkspace({session,root,route='assignments',assignment=null,onStatus=()=>{}}){
  let generation=0,dirty=false,submitting=false,disposed=false,downloading=false,selected=assignment,items=[],filter='active';
  const preview=createResumePreviewController();
  const button=(label,fn,cls='rt-button')=>{const b=el('button',label,cls);b.type='button';b.onclick=fn;return b;};
  async function download(c){if(downloading)return;downloading=true;try{onStatus('正在下载简历');const blob=await session.download(route+'/'+c.assignment.id+'/resume');if(disposed)return;await saveResumeFile(blob,c.resume.filename,{embedded:session.embedded,current:()=>!disposed,onStatus});if(!disposed)onStatus('已发起简历下载，请查看客户端保存窗口或下载列表');}catch(e){if(!disposed)onStatus(e.message,true);}finally{downloading=false;}}
  async function load(force=false){
    if(disposed||submitting||dirty&&!force)return;
    const gen=++generation;root.setAttribute('aria-busy','true');
    try{const data=assignment?{items:[await session.request(route+'/'+assignment)]}:await session.request(route);if(gen!==generation||disposed)return;
      items=data.items.sort((a,b)=>Number(!!a.assignment.feedback)-Number(!!b.assignment.feedback)||Date.parse(a.interview?.at||a.assignment.proposal?.at||'2100-01-01')-Date.parse(b.interview?.at||b.assignment.proposal?.at||'2100-01-01'));
      dirty=false;renderWorkspace();
    }catch(e){if(gen===generation)onStatus(e.message,true);}finally{if(gen===generation)root.removeAttribute('aria-busy');}
  }
  function renderWorkspace(){
    preview.sync(items.find(c=>c.assignment.id===selected));
    root.replaceChildren();
    if(selected){const c=items.find(c=>c.assignment.id===selected);if(c){if(!assignment)root.append(button('返回我的面试',()=>{if(submitting)return;if(dirty&&!confirm('填写内容尚未提交，确定返回列表？'))return;dirty=false;selected=null;renderWorkspace();},'rt-button rw-interview-back'));root.append(render(c));return;}selected=null;}
    const tabs=el('div',undefined,'rw-detail-tabs');for(const[key,label]of [['active','待处理与已安排'],['finished','已完成']]){const b=button(label,()=>{filter=key;renderWorkspace();});b.setAttribute('aria-pressed',String(filter===key));tabs.append(b);}root.append(tabs);
    const visible=items.filter(c=>(c.stage==='interview'&&!c.archived&&!c.assignment.feedback)===(filter==='active'));
    if(!visible.length){const empty=el('div',undefined,'rw-empty');empty.append(el('h2',filter==='active'?'暂无待处理的面试':'暂无已完成的面试'),el('p','分配给你的候选人和安排会显示在这里'));root.append(empty);return;}
    const list=el('div',undefined,'rw-interview-list');for(const c of visible){const a=c.assignment,row=el('article',undefined,'rw-interview-row'),identity=el('div'),action=a.status==='approved'?'查看并填写评价':a.status==='submitted'?'查看待审核安排':'填写面试安排';
      identity.append(el('strong',c.name),el('p',c.group,'rt-help'));row.append(identity,el('span',a.feedback?'评价已提交':({requested:'待填写安排',submitted:'等待管理员审核',changes_requested:'待修改安排',approved:'已确认面试'}[a.status]),'rt-pill'),el('time',date(c.interview?.at||a.proposal?.at)),button(filter==='finished'?'查看记录':action,()=>{selected=a.id;renderWorkspace();},'rt-button'));list.append(row);
    }root.append(list);
  }
  function render(c){
    const a=c.assignment,p=a.proposal||c.interview||{},card=el('article',undefined,'rw-interview-card');
    const header=el('header'),name=el('div');name.append(el('p',c.group,'rw-eyebrow'),el('h2',c.name));
    const label=c.archived?'已归档':a.feedback?'评价已提交':c.stage!=='interview'?'流程已结束':({requested:'待填写安排',submitted:'等待管理员审核',changes_requested:'待修改安排',approved:'已确认面试'}[a.status]);
    header.append(name,el('span',label,'rt-pill'));card.append(header);
    if(c.summary)card.append(el('p',c.summary,'rw-summary'));
    if(c.resume){const actions=el('div',undefined,'rt-inline-actions');actions.append(button('预览简历',()=>preview.show(c,{load:()=>session.download(route+'/'+c.assignment.id+'/resume'),current:()=>!disposed&&selected===c.assignment.id})));if(!session.embedded)actions.append(button('下载简历',()=>void download(c)));card.append(actions);}
    if(a.reviewNote)card.append(el('p','管理员说明：'+a.reviewNote,'rw-callout'));
    if(a.status==='approved'||c.stage!=='interview'||c.archived){
      const info=el('dl',undefined,'rw-facts');
      for(const[label,value]of [['面试时间',date(c.interview?.at||p.at)],['时长',(c.interview?.durationMinutes||p.durationMinutes||30)+' 分钟'],['面试官',a.name],['联系邮箱',c.interview?.email||p.email||a.email||'—']])info.append(el('dt',label),el('dd',value));
      const url=c.interview?.location||p.location;if(/^https:\/\//.test(url||'')){const link=el('a','打开会议链接','rt-button');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.onclick=e=>{if(session.embedded&&parent!==window){e.preventDefault();parent.postMessage({type:'110lab-workspace-open-link',url},'*');}};const cell=el('dd');cell.append(link);info.append(el('dt','会议'),cell);}
      card.append(info);
      if(a.feedback){const feedback=el('section',undefined,'rw-callout');feedback.append(el('h3','已提交的评价'),el('p',a.feedback.score+' 分 · '+({recommend:'建议录取',consider:'建议进一步讨论',decline:'建议不录取'}[a.feedback.recommendation])),el('p',a.feedback.note),el('small',date(a.feedback.at)+' · '+a.feedback.by));card.append(feedback);}
      else if(c.stage==='interview'&&!c.archived){
        if(Date.parse(c.interview?.at)>Date.now())card.append(el('p','面试开始后可在这里提交评价。需要改期时，请联系管理员发起改期。','rt-help'));
        else card.append(form(c,'feedback'));
      }
    }else card.append(form(c,'arrangement'));
    return card;
  }
  function form(c,kind){
    const a=c.assignment,p=a.proposal||{},f=el('form',undefined,'rw-interview-form'),fields=[];
    f.append(el('h3',kind==='feedback'?'填写面试评价':'填写面试安排'));
    const add=(key,title,type,value='')=>{const label=el('label',undefined,'rt-field'),input=el(type==='textarea'?'textarea':type==='select'?'select':'input');input.name=key;if(input.tagName==='INPUT')input.type=type;input.required=true;input.value=value;input.maxLength=type==='textarea'?4000:500;label.append(el('span',title),input);f.append(label);fields.push(input);return input;};
    if(kind==='feedback'){
      const score=add('score','综合评分（0–100）','number');score.min=0;score.max=100;
      const recommendation=add('recommendation','面试建议','select');recommendation.append(new Option('请选择',''),new Option('建议录取','recommend'),new Option('建议进一步讨论','consider'),new Option('建议不录取','decline'));
      add('note','评价依据与建议','textarea');f.append(el('p','评价仅 HR、管理员和本次面试官可见，录取由 HR 或管理员决定。','rt-help'));
    }else{
      add('at','面试时间','datetime-local',p.at?local(p.at):'');const duration=add('durationMinutes','面试时长（分钟）','number',p.durationMinutes||30);duration.min=5;duration.max=240;duration.step=1;add('location','会议链接（HTTPS）','url',p.location||'');add('email','候选人回复邮箱','email',p.email||a.email||'');add('contact','对外联系方式','text',p.contact||a.email||'');
      f.append(el('p','计划结束后未提交面评，将通过飞书提醒一次。时间按 '+Intl.DateTimeFormat().resolvedOptions().timeZone+' 填写。管理员审核后才会通知候选人。','rt-help'));
    }
    const error=el('p',undefined,'rt-form-error');error.setAttribute('role','alert');error.hidden=true;
    const submit=el('button',kind==='feedback'?'提交评价':a.status==='submitted'?'更新待审核安排':'提交安排','rt-button rt-primary');submit.type='submit';f.append(error,submit);
    let request=null;f.oninput=()=>{dirty=true;};
    f.onsubmit=async e=>{e.preventDefault();if(submitting||!f.reportValidity())return;const data=new FormData(f),payload={revision:a.revision};
      if(kind==='feedback')Object.assign(payload,{score:Number(data.get('score')),recommendation:data.get('recommendation'),note:data.get('note')});
      else Object.assign(payload,{at:new Date(data.get('at')).toISOString(),durationMinutes:Number(data.get('durationMinutes')),location:data.get('location'),email:data.get('email'),contact:data.get('contact')});
      const fingerprint=JSON.stringify(payload);if(request?.fingerprint!==fingerprint)request={fingerprint,id:crypto.randomUUID()};
      submitting=true;submit.disabled=true;for(const n of fields)n.disabled=true;error.hidden=true;
      try{await session.request(route+'/'+a.id+(kind==='feedback'?'/feedback':''),{method:'POST',data:{...payload,requestId:request.id}});dirty=false;submitting=false;await load(true);onStatus(kind==='feedback'?'评价已提交，等待管理员决定':'安排已提交，等待管理员审核');}
      catch(e){error.textContent=e.status===409?e.message+'。请先复制当前填写内容，再刷新查看最新状态。':e.message;error.hidden=false;}
      finally{submitting=false;submit.disabled=false;for(const n of fields)n.disabled=false;}
    };
    return f;
  }
  return {load,dirty:()=>dirty,busy:()=>submitting,destroy(){disposed=true;generation++;preview.destroy();root.replaceChildren();}};
}
