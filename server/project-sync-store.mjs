import {randomUUID} from 'node:crypto';

// The project and its outbox entry commit in the same workspace transaction.
// V2 uses a separate outbox so a still-running V1 worker cannot acknowledge
// a snapshot it never uploaded. Old releases ignore this additive table; rollback never removes queued work.
export function projectSyncStore(db, {enabled=false, now=Date.now}={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS requirement_project_sync_v2(
    project_id TEXT PRIMARY KEY REFERENCES projects(id),
    name TEXT NOT NULL, summary TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','syncing','retrying','synced','blocked')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0,
    lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    remote_id TEXT, remote_url TEXT, error_code TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT;`);
  const columns=new Set(db.prepare('PRAGMA table_info(requirement_project_sync_v2)').all().map(c=>c.name));
  if(!columns.has('payload_json'))db.exec('ALTER TABLE requirement_project_sync_v2 ADD COLUMN payload_json TEXT');
  if(!columns.has('generation'))db.exec('ALTER TABLE requirement_project_sync_v2 ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
  const value=row=>row?{
    state:row.state, projectName:row.name, projectId:row.remote_id||null,
    url:row.remote_url||null, attempts:row.attempts, errorCode:row.error_code||null,
    retryAt:row.state==='retrying'?new Date(row.next_attempt).toISOString():null,
    updatedAt:new Date(row.updated_at).toISOString(),
  }:null;
  return {
    enqueue(id,name,summary,snapshot) {
      if(!enabled)return;
      const payload=snapshot?JSON.stringify(snapshot):null;
      db.prepare(`INSERT INTO requirement_project_sync_v2
        (project_id,name,summary,payload_json,generation,state,created_at,updated_at)
        VALUES(?,?,?,?,1,'queued',?,?)
        ON CONFLICT(project_id) DO UPDATE SET name=excluded.name,summary=excluded.summary,
        payload_json=excluded.payload_json,generation=requirement_project_sync_v2.generation+1,
        state='queued',lease=NULL,lease_until=0,next_attempt=0,error_code=NULL,updated_at=excluded.updated_at
        WHERE requirement_project_sync_v2.name<>excluded.name OR requirement_project_sync_v2.summary<>excluded.summary
        OR requirement_project_sync_v2.payload_json IS NOT excluded.payload_json`)
        .run(id,name,summary,payload,now(),now());
    },
    get(id){return value(db.prepare('SELECT * FROM requirement_project_sync_v2 WHERE project_id=?').get(id));},
    claim() {
      db.exec('SAVEPOINT project_sync_claim');
      try {
        const time=now();
        db.prepare(`UPDATE requirement_project_sync_v2 SET state='retrying',lease=NULL,
          lease_until=0,next_attempt=?,error_code='WORKER_RESTARTED',updated_at=?
          WHERE state='syncing' AND lease_until<=?`).run(time,time,time);
        if(db.prepare("SELECT 1 FROM requirement_project_sync_v2 WHERE state='syncing' LIMIT 1").get()) {
          db.exec('RELEASE project_sync_claim');return null;
        }
        const row=db.prepare(`SELECT s.*,p.owner_subject FROM requirement_project_sync_v2 s
          JOIN projects p ON p.id=s.project_id WHERE s.state IN ('queued','retrying')
          AND s.next_attempt<=? ORDER BY s.created_at,s.project_id LIMIT 1`).get(time);
        if(!row){db.exec('RELEASE project_sync_claim');return null;}
        const lease=randomUUID();
        db.prepare(`UPDATE requirement_project_sync_v2 SET state='syncing',lease=?,lease_until=?,
          attempts=attempts+1,updated_at=? WHERE project_id=?`).run(lease,time+120000,time,row.project_id);
        db.exec('RELEASE project_sync_claim');
        return {id:row.project_id,name:row.name,summary:row.summary,ownerSubject:row.owner_subject,
          attempts:row.attempts+1,lease,previousUrl:row.remote_url,revision:row.payload_json?row.generation:undefined,snapshot:row.payload_json?JSON.parse(row.payload_json):undefined};
      } catch(e){db.exec('ROLLBACK TO project_sync_claim; RELEASE project_sync_claim');throw e;}
    },
    finish(job,{projectId,url}) {
      db.exec('SAVEPOINT project_sync_finish');
      try {
        const done=db.prepare(`UPDATE requirement_project_sync_v2 SET state='synced',remote_id=?,
          remote_url=?,lease=NULL,lease_until=0,error_code=NULL,updated_at=?
          WHERE project_id=? AND state='syncing' AND lease=? AND lease_until>?`)
          .run(projectId,url,now(),job.id,job.lease,now());
        if(done.changes) {
          // A user-supplied link is retained. Compare against the current row,
          // rather than an old snapshot, to avoid overwriting an edit in flight.
          db.prepare(`UPDATE projects SET links_json=json_set(links_json,'$.requirements',?),
            revision=revision+1,updated_at=? WHERE id=?
            AND (coalesce(json_extract(links_json,'$.requirements'),'')=''
              OR json_extract(links_json,'$.requirements')=?)
            AND coalesce(json_extract(links_json,'$.requirements'),'')<>?`)
            .run(url,new Date(now()).toISOString(),job.id,job.previousUrl||null,url);
        }
        db.exec('RELEASE project_sync_finish');return !!done.changes;
      } catch(e){db.exec('ROLLBACK TO project_sync_finish; RELEASE project_sync_finish');throw e;}
    },
    fail(job,{code='TEMPORARILY_UNAVAILABLE',permanent=false}={}) {
      const delay=Math.min(300000,10000*2**Math.min(job.attempts-1,5));
      return db.prepare(`UPDATE requirement_project_sync_v2 SET state=?,next_attempt=?,
        lease=NULL,lease_until=0,error_code=?,updated_at=?
        WHERE project_id=? AND state='syncing' AND lease=? AND lease_until>?`)
        .run(permanent?'blocked':'retrying',now()+delay,code,now(),job.id,job.lease,now()).changes>0;
    },
    retry(id) {
      return db.prepare(`UPDATE requirement_project_sync_v2 SET state='queued',next_attempt=0,
        error_code=NULL,updated_at=? WHERE project_id=? AND state IN ('blocked','retrying')`)
        .run(now(),id).changes>0;
    },
  };
}
