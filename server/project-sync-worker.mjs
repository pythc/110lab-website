import {createProjectSyncClient,ProjectSyncError} from './project-sync-client.mjs';
export function projectSyncWorker({store,mail,client=createProjectSyncClient(),enabled=false,intervalMs=2000}) {
  let busy=false,closing=false,active;
  async function tick() {
    if(!enabled||busy||closing)return;
    busy=true;let job;
    try {
      job=store.requirementsSync.claim();if(!job)return;
      // Recheck the actual directory. Its outage fallback cannot prove that an
      // owner is still a member, and must not authorize a background write.
      mail.profile(job.ownerSubject);
      const directory=await mail.projectMembers(job.ownerSubject);
      if(directory.unavailable)throw new ProjectSyncError('DIRECTORY_UNAVAILABLE');
      if(!directory.members.some(m=>m.subject===job.ownerSubject))throw new ProjectSyncError('OWNER_NOT_ACTIVE',{permanent:true});
      const result=await client.ensure(job);
      store.requirementsSync.finish(job,result);
    }catch(e){if(job)store.requirementsSync.fail(job,{code:e instanceof ProjectSyncError?e.code:'SYNC_UNCONFIRMED',permanent:e instanceof ProjectSyncError&&e.permanent});}
    finally{busy=false;}
  }
  const run=()=>{if(busy||closing)return active||Promise.resolve();active=tick();return active;};
  const timer=enabled?setInterval(()=>{run().catch(()=>{});},intervalMs):null;
  timer?.unref();
  return {run,async close(){closing=true;clearInterval(timer);await active;}};
}
