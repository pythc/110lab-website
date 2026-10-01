import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {openRecruitmentStore} from './recruitment-store.mjs';
import {composeApplication,createSmtpSender,classifyDeliveryError} from './recruitment-mail.mjs';

const retryDelays=[60000,5*60000,15*60000,3600000,3*3600000,6*3600000,12*3600000];
export async function runDeliveryOnce(store,sender,{deadlineMs=180000,delays=retryDelays}={}){
  store.recoverInterrupted();
  const row=store.claim();if(!row)return null;
  let timer,result;
  try{
    const message=await composeApplication(row,store.root,sender.from);
    await Promise.race([sender.send(message),new Promise((_,reject)=>{timer=setTimeout(()=>{if(sender.abort)sender.abort();else sender.close();reject(Object.assign(new Error('Send deadline exceeded'),{code:'SEND_TIMEOUT',command:'DATA'}));},deadlineMs);})]);
    result={status:'SENT'};
  }catch(error){
    result=classifyDeliveryError(error);
    const inRound=row.round_attempts;
    if(result.status==='RETRYING'){
      if(inRound>=8)result={status:'FAILED',code:result.code};
      else result.retryDelay=delays[Math.max(0,Math.min(delays.length-1,inRound-1))];
    }
  }finally{clearTimeout(timer);}
  store.finish(row.id,row.lease_token,result);
  return {id:row.id,...result};
}

export function startRecruitmentWorker(store,sender,{pollMs=5000,...options}={}){
  let stopped=false,busy=false,active;
  const tick=async()=>{if(stopped||busy)return;busy=true;try{active=runDeliveryOnce(store,sender,options);await active;}catch(error){console.error('Recruitment worker failed',error.code||error.name);}finally{busy=false;}};
  store.recoverInterrupted();store.cleanup();store.heartbeat();
  const heartbeat=setInterval(()=>{if(!stopped)store.heartbeat();},5000);
  const polling=setInterval(tick,pollMs);
  const cleaning=setInterval(()=>{try{store.recoverInterrupted();store.cleanup();}catch{console.error('Recruitment cleanup failed');}},15*60000);
  tick();
  return {async stop(){stopped=true;clearInterval(heartbeat);clearInterval(polling);clearInterval(cleaning);sender.close();await active?.catch(()=>{});}};
}

function isMain(){try{return !!process.argv[1]&&fileURLToPath(import.meta.url)===realpathSync(process.argv[1]);}catch{return false;}}
if(isMain()){
  const directory=process.env.PORTAL_RECRUITMENT_DATA,configPath=process.env.PORTAL_RECRUITMENT_SMTP_CONFIG;
  if(process.env.PORTAL_RECRUITMENT_ENABLED!=='true'||!directory||!configPath)throw new Error('Recruitment worker is not configured');
  const info=lstatSync(configPath);
  if(!info.isFile()||info.isSymbolicLink()||info.mode&0o077)throw new Error('SMTP config must be a private regular file with mode 0600');
  const config=JSON.parse(readFileSync(configPath,'utf8'));
  const store=openRecruitmentStore(directory),sender=createSmtpSender(config),worker=startRecruitmentWorker(store,sender);
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await worker.stop();store.close();process.exit(0);});
  console.log('Recruitment mail worker started');
}
