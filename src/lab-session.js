import {restoreLabSession} from './persistent-login.js';
// Shared laboratory identity, with the same embedded handoff as the workbench.
export function createLabSession({onChange=()=>{},onStatus=()=>{},apiRoot='/api/recruitment-test/'}={}){
  const embedded=location.pathname.endsWith('/embedded');
  const suffix=embedded?'embedded/':'',prefix=apiRoot+suffix,mail='/api/mail/'+suffix;
  let profile=null,flow=null,timer=null,popup=null,generation=0,poll=null;
  function clear(){generation++;profile=null;onChange(null);}
  function accept(value){if(value.subject!==profile?.subject||value.role!==profile?.role||value.recruitmentRole!==profile?.recruitmentRole)generation++;profile=value;onChange(profile);}
  function finish(){flow=null;clearTimeout(timer);clearInterval(poll);timer=null;poll=null;}
  async function call(path,{method='GET',data,form,blob=false,signal}={},isMail=false){
    const gen=generation,headers={};
    if(data!==undefined)headers['Content-Type']='application/json';
    if(method!=='GET'&&profile?.csrf)headers['X-CSRF-Token']=profile.csrf;
    const response=await fetch((isMail?mail:prefix)+path,{method,headers,credentials:'same-origin',cache:'no-store',body:form??(data===undefined?undefined:JSON.stringify(data)),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(form?65000:15000)]):AbortSignal.timeout(form?65000:15000)});
    if(response.ok&&blob){const value=await response.blob();if(gen!==generation)throw Object.assign(new Error('登录状态已改变'),{status:401});return value;}
    let value;try{value=await response.json();}catch{value={};}
    if(!response.ok){if([401,403].includes(response.status)&&gen===generation&&profile)clear();throw Object.assign(new Error(value.error||'操作未完成 请重试'),{status:response.status});}
    if(gen!==generation)throw Object.assign(new Error('登录状态已改变'),{status:401});
    return value;
  }
  async function load(){
    const gen=generation;
    try{await restoreLabSession();const value=await call('session');if(gen!==generation)return;accept(value);return value;}
    catch(e){if(gen===generation)clear();if(e.status!==401)onStatus(e.message,true);return null;}
  }
  async function redeem(ticket,expected){
    if(flow!==expected)return;
    try{await call('auth/redeem',{method:'POST',data:{state:expected.state,ticket}},true);if(flow!==expected)return;finish();onStatus('');await load();}
    catch(e){if(flow===expected){finish();onStatus(e.message,true);}}
  }
  async function login(){
    if(flow)return;
    // Open during the user gesture; asynchronous window.open is blocked by browsers.
    if(!embedded)popup=window.open('about:blank','110lab-recruitment-login','popup,width=640,height=740');
    const pending={};flow=pending;
    try{
      const result=await call('auth/start',{method:'POST',data:{}},true);
      const url=new URL(result.launchUrl);
      if(!/^[\w-]{43}$/.test(result.state||'')||url.origin!=='https://internal.110-lab.cn'||url.pathname!=='/mail/auth/launch')throw new Error('登录入口无效');
      if(flow!==pending)return;flow=result;
      if(embedded&&parent!==window){parent.postMessage({type:'110lab-mail-host-login',state:result.state,fresh:false},'*');onStatus('正在打开飞书授权');}
      else if(popup){popup.location.href=result.launchUrl;onStatus('请在新窗口完成飞书授权');}
      else{finish();throw new Error('浏览器拦截了登录窗口 请允许弹出窗口后重试');}
      timer=setTimeout(()=>{if(flow===result){finish();onStatus('授权超时 请重试',true);}},285000);
      if(!embedded)poll=setInterval(async()=>{if(flow!==result)return;try{const value=await call('session');if(flow===result){finish();onStatus('');accept(value);}}catch{}},3000);
    }catch(e){finish();try{if(popup?.location?.href==='about:blank')popup.close();}catch{}onStatus(e.message,true);}
  }
  window.addEventListener('message',event=>{
    if(!flow)return;const m=event.data;
    if(!m||m.state!==flow.state)return;
    if(embedded){
      if(event.source!==parent)return;
      if(m.type==='110lab-mail-host-opened')onStatus('请在飞书完成授权 返回后自动登录');
      if(m.type==='110lab-mail-host-result'){
        if(/^[\w-]{43}$/.test(m.ticket||''))void redeem(m.ticket,flow);
        else{finish();onStatus('连接未完成 请重试或更新 110lab 插件',true);}
      }
    }else if(event.source===popup&&event.origin==='https://internal.110-lab.cn'&&m.type==='110lab-mail-login'&&/^[\w-]{43}$/.test(m.ticket||''))void redeem(m.ticket,flow);
  });
  return {load,login,async logout(){await call('logout',{method:'POST',data:{}},true);finish();clear();onStatus('已退出');},request:(path,options)=>call(path,options),upload:(path,form,signal)=>call(path,{method:'POST',form,signal}),download:path=>call(path,{blob:true}),get profile(){return profile;},get csrf(){return profile?.csrf||'';},get embedded(){return embedded;}};
}
