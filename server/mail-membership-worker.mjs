import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {readMailConfig,bootstrapMailOwner} from './mail-auth.mjs';
import {openMailAccessStore} from './mail-access-store.mjs';
import {createMailMembershipProvider} from './mail-membership-provider.mjs';
import {openMailMembershipState,MEMBERSHIP_RECHECK_MS} from './mail-membership-state.mjs';

// A separate, single-leader worker survives HTTP rollback. Role changes are
// committed locally first; upstream revocation remains visibly pending until
// Feishu confirms it. Never report a successful native-mail revocation early.
export function startMailMembershipWorker({access,state,provider,now=Date.now,pollMs=5000}){
  let stopped=false,active=null;
  const guard=revision=>!stopped&&state.renew()&&access.membershipSnapshot().revision===revision;
  async function reconcile(){
    if(stopped||!state.claim())return;
    const previous=state.read(),snapshot=access.membershipSnapshot();
    if(previous.state==='ready'&&previous.revision===snapshot.revision&&previous.checked_at>now()-MEMBERSHIP_RECHECK_MS)return;
    if(previous.state==='error'&&previous.revision===snapshot.revision&&previous.retry_after>now())return;
    state.pending();
    try{
      for(let round=0;round<3&&!stopped;round++){
        const wanted=access.membershipSnapshot(),desired=new Set(wanted.subjects);
        if(desired.size<1||desired.size>100)throw new Error('Invalid administrator set');
        if(!guard(wanted.revision))continue;
        let actual=await provider.listMembers();
        if(!guard(wanted.revision))continue;
        let changed=false,stale=false;
        // Remove before granting; only this dedicated mailbox is managed.
        for(const member of actual){
          if(desired.has(member.subject))continue;
          if(!guard(wanted.revision)){stale=true;break;}
          await provider.removeMember(member.memberId);changed=true;
        }
        if(stale||!guard(wanted.revision))continue;
        const present=new Set(actual.map(m=>m.subject));
        for(const subject of desired){
          if(present.has(subject))continue;
          if(!guard(wanted.revision)){stale=true;break;}
          await provider.addMember(subject);changed=true;
        }
        if(stale||!guard(wanted.revision))continue;
        if(changed)actual=await provider.listMembers();
        if(!guard(wanted.revision))continue;
        const found=new Set(actual.map(m=>m.subject));
        if(found.size!==desired.size||[...desired].some(s=>!found.has(s)))throw new Error('Membership verification failed');
        state.finish(wanted.revision);return;
      }
    }catch(error){
      const code=Number.isInteger(error?.providerCode)?error.providerCode:0;
      state.finish(snapshot.revision,code);
      console.error('Mail membership synchronization failed',{code});
    }
  }
  function tick(){if(stopped)return Promise.resolve();if(active)return active;active=reconcile().catch(()=>console.error('Mail membership worker unavailable')).finally(()=>{active=null;});return active;}
  const timer=setInterval(tick,pollMs);timer.unref();void tick();
  return {tick,async stop(){stopped=true;clearInterval(timer);await active;state.release();}};
}

function isMain(){try{return !!process.argv[1]&&fileURLToPath(import.meta.url)===realpathSync(process.argv[1]);}catch{return false;}}
if(isMain()){
  if(process.env.PORTAL_MAIL_NOTIFY_ENABLED!=='true')throw new Error('Notify mailbox is not enabled');
  const directory=process.env.PORTAL_MAIL_DATA,config=readMailConfig(process.env.PORTAL_MAIL_CONFIG);
  const access=openMailAccessStore({filename:join(directory,'mail-access.sqlite'),bootstrapOwner:bootstrapMailOwner(config)});
  const state=openMailMembershipState({directory}),provider=createMailMembershipProvider({config});
  const worker=startMailMembershipWorker({access,state,provider});
  // Keep the dedicated worker alive; its polling timer is unref'ed for tests.
  const keepAlive=setInterval(()=>{},60000);
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{clearInterval(keepAlive);await worker.stop();state.close();access.close();});
  console.log('Notify mailbox membership worker started');
}
