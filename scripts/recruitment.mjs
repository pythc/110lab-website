import {openRecruitmentStore} from '../server/recruitment-store.mjs';
const [command,id,revision,confirmation]=process.argv.slice(2);
if(!process.env.PORTAL_RECRUITMENT_DATA)throw new Error('Set the private PORTAL_RECRUITMENT_DATA directory');
const store=openRecruitmentStore(process.env.PORTAL_RECRUITMENT_DATA);
try{
  let result;
  if(command==='inspect')result=store.inspect(id);
  else if(command==='retry')result=store.operatorRetry(id,Number(revision),{confirmUnknown:confirmation==='--confirmed-not-sent'});
  else if(command==='cleanup')result=store.cleanup();
  else if(command==='cleanup-loop'){
    const clean=()=>{try{store.recoverInterrupted();console.log(JSON.stringify(store.cleanup()));}catch{console.error('Recruitment retention task failed');}};
    clean();
    const interval=setInterval(clean,15*60000);
    const stopped=new Promise(resolve=>{for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{clearInterval(interval);resolve();});});
    console.log('Recruitment retention task started');
    await stopped;
    result={stopped:true};
  }else throw new Error('Usage: recruitment.mjs inspect ID | retry ID REVISION [--confirmed-not-sent] | cleanup | cleanup-loop');
  console.log(JSON.stringify(result,null,2));
}finally{store.close();}
