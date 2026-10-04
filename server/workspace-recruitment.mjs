import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {lstatSync,chmodSync,existsSync} from 'node:fs';
import {z} from 'zod';
import {WorkspaceError} from './workspace-store.mjs';

export function openWorkspaceRecruitment({directory,source,now=Date.now}) {
  const path=join(directory,'recruitment-triage.sqlite');
  for(const suffix of ['','-wal','-shm'])if(existsSync(path+suffix)&&lstatSync(path+suffix).isSymbolicLink())throw new Error('Invalid triage storage');
  const db=new DatabaseSync(path);chmodSync(path,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS handled(id TEXT PRIMARY KEY,actor_subject TEXT NOT NULL,actor_name TEXT NOT NULL,note TEXT NOT NULL,at INTEGER NOT NULL) STRICT;`);
  const secure=()=>{for(const suffix of ['','-wal','-shm'])if(existsSync(path+suffix))chmodSync(path+suffix,0o600);};secure();
  const admin=actor=>{if(!['admin','super_admin'].includes(actor?.role))throw new WorkspaceError(403,'需要实验室管理员权限');};
  function snapshot(){return source?.()||{state:'disabled',items:[]};}
  return {
    list(actor){
      admin(actor);db.prepare('DELETE FROM handled WHERE at<?').run(now()-30*86400000);secure();
      let result;try{result=snapshot();}catch{return {state:'unavailable',items:[],partial:false};}
      const seen=new Set(db.prepare('SELECT id FROM handled').all().map(x=>x.id));
      const remaining=result.items.filter(x=>!seen.has(x.id));
      return {state:result.state,partial:remaining.length>200,items:remaining.slice(0,200).map(x=>({
        id:'recruitment:'+x.id,submissionId:x.id,kind:'recruitment',action:'recruitment',
        title:x.name?x.name+' · '+(x.group||'招新投递'):'招新投递 '+x.id.slice(0,8),
        group:x.group,receivedAt:x.receivedAt,deliveryStatus:x.deliveryStatus,status:'open',dueAt:null
      }))};
    },
    handle(actor,id,input){
      admin(actor);z.string().uuid().parse(id);const {note}=z.object({note:z.string().trim().min(1).max(1000)}).strict().parse(input);
      const result=snapshot();if(result.state!=='ready')throw new WorkspaceError(503,'招新来源暂不可用');
      if(!result.items.some(x=>x.id===id))throw new WorkspaceError(404,'投递不存在或已过保留期限');
      const changed=db.prepare('INSERT OR IGNORE INTO handled VALUES(?,?,?,?,?)').run(id,actor.subject,actor.name,note,now());secure();
      if(!changed.changes)throw new WorkspaceError(409,'另一位管理员已处理这份投递 请刷新');
      return {handled:true};
    },
    history(actor){admin(actor);return {events:db.prepare('SELECT id,actor_name AS actorName,note,at FROM handled WHERE at>? ORDER BY at DESC LIMIT 100').all(now()-30*86400000).map(x=>({...x,at:new Date(x.at).toISOString()}))};},
    close(){db.close();}
  };
}
