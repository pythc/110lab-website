import {createProjectSyncClient,ProjectSyncError} from './project-sync-client.mjs';
export function projectSyncWorker({store,mail,client=createProjectSyncClient(),enabled=false,intervalMs=2000}) {
  let busy=false,closing=false,active,lastCatalog=0,lastReconcile=0;
  async function tick() {
    if(!enabled||busy||closing)return;
    busy=true;let job;
    try {
      if(store.reconcileProjects&&Date.now()-lastReconcile>30000){
        let feed;
        if(client.catalog&&Date.now()-lastCatalog>30000){
          try{feed=await client.catalog();}
          catch(e){console.error('Project catalog refresh failed',e.code||e.name);}
          lastCatalog=Date.now();
        }
        store.reconcileProjects(feed);lastReconcile=Date.now();
      }
      job=store.requirementsSync.claim();if(!job)return;
      // Imported classifications carry no owner or approval; existing projects
      // continue to recheck the owner's live directory membership.
      if(job.ownerSubject){
        mail.profile(job.ownerSubject);
        const directory=await mail.projectMembers(job.ownerSubject);
        if(directory.unavailable)throw new ProjectSyncError('DIRECTORY_UNAVAILABLE');
        if(!directory.members.some(m=>m.subject===job.ownerSubject))throw new ProjectSyncError('OWNER_NOT_ACTIVE',{permanent:true});
      }
      const result=await client.ensure(job);
      store.requirementsSync.finish(job,result);
    }catch(e){
      if(job)store.requirementsSync.fail(job,{code:e instanceof ProjectSyncError?e.code:'SYNC_UNCONFIRMED',permanent:e instanceof ProjectSyncError&&e.permanent});
      else console.error('Project reconciliation failed',e.code||e.name);
    }finally{busy=false;}
  }
  const run=()=>{if(busy||closing)return active||Promise.resolve();active=tick();return active;};
  const timer=enabled?setInterval(()=>{run().catch(()=>{});},intervalMs):null;
  timer?.unref();
  return {run,async close(){closing=true;clearInterval(timer);await active;}};
}
