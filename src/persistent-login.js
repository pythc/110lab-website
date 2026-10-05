// Try the existing device grant once per page. Never open an authorization
// window automatically; a missing/revoked grant leaves the normal login button.
let attempt;
export function restoreLabSession(){
  if(!location.pathname.endsWith('/embedded')||window.parent===window)return Promise.resolve(false);
  return attempt||=(async()=>{
    let receive,timer;
    const request=async(path,data)=>{
      const response=await fetch('/api/mail/embedded/'+path,{method:data?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(15000)});
      return {response,value:await response.json()};
    };
    try{
      const config=await request('config');if(!config.response.ok||!config.value.loginAvailable||config.value.restorePolicy!==1)return false;
      const current=await request('session');if(current.response.ok)return true;if(current.response.status!==401)return false;
      const {response,value}=await request('auth/start',{});if(!response.ok||!/^[\w-]{43}$/.test(value.state||''))return false;
      const ticket=await new Promise(resolve=>{
        receive=event=>{const data=event.data;if(event.source!==window.parent||data?.type!=='110lab-mail-host-result'||data.state!==value.state)return;resolve(/^[\w-]{43}$/.test(data.ticket||'')?data.ticket:null);};
        window.addEventListener('message',receive);
        timer=setTimeout(()=>resolve(null),25000);
        window.parent.postMessage({type:'110lab-mail-host-login',state:value.state,fresh:false,silent:true},'*');
      });
      if(!ticket)return false;
      return (await request('auth/redeem',{state:value.state,ticket})).response.ok;
    }catch{return false;}
    finally{clearTimeout(timer);if(receive)window.removeEventListener('message',receive);}
  })();
}
