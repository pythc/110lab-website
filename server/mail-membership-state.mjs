import {DatabaseSync} from 'node:sqlite';
import {lstatSync,openSync,closeSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const MEMBERSHIP_RECHECK_MS=15*60000;
const LEASE_MS=60000;
export function openMailMembershipState({directory,now=Date.now}){
  const dir=lstatSync(directory);
  if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077))throw new Error('Membership directory must be private');
  const path=join(directory,'mail-membership.sqlite');
  try{closeSync(openSync(path,'wx',0o600));}catch(e){if(e.code!=='EEXIST')throw e;}
  const file=lstatSync(path);
  if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o077))throw new Error('Membership database must be private');
  const tighten=()=>{for(const suffix of ['-wal','-shm']){try{const side=lstatSync(path+suffix);if(!side.isFile()||side.isSymbolicLink())throw new Error('Invalid membership sidecar');chmodSync(path+suffix,0o600);}catch(e){if(e.code!=='ENOENT')throw e;}}};
  tighten();
  const db=new DatabaseSync(path);let closed=false;
  try{
    db.enableDefensive(true);
    db.exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS membership(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,checked_at INTEGER NOT NULL DEFAULT 0,heartbeat INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','error')),error_code INTEGER,failures INTEGER NOT NULL DEFAULT 0,retry_after INTEGER NOT NULL DEFAULT 0) STRICT;
      INSERT OR IGNORE INTO membership(id) VALUES(1);`);
    chmodSync(path,0o600);tighten();
  }catch(error){db.close();throw error;}
  const read=()=>db.prepare('SELECT * FROM membership WHERE id=1').get();
  const owner=randomUUID();
  return {
    read,
    claim(){return db.prepare('UPDATE membership SET owner=?,lease_until=?,heartbeat=? WHERE id=1 AND (owner IS NULL OR lease_until<=? OR owner=?)').run(owner,now()+LEASE_MS,now(),now(),owner).changes===1;},
    renew(){return db.prepare('UPDATE membership SET lease_until=?,heartbeat=? WHERE id=1 AND owner=? AND lease_until>?').run(now()+LEASE_MS,now(),owner,now()).changes===1;},
    pending(){db.prepare("UPDATE membership SET state='pending',error_code=NULL WHERE id=1 AND owner=? AND lease_until>?").run(owner,now());},
    finish(revision,errorCode=null){
      const previous=read(),failures=errorCode===null?0:Math.min(previous.revision===revision?previous.failures+1:1,6);
      const retryAfter=failures?now()+Math.min(15000*2**(failures-1),300000):0;
      db.prepare('UPDATE membership SET revision=?,checked_at=?,state=?,error_code=?,heartbeat=?,failures=?,retry_after=? WHERE id=1 AND owner=? AND lease_until>?').run(revision,now(),errorCode===null?'ready':'error',errorCode,now(),failures,retryAfter,owner,now());tighten();
    },
    status(revision){const row=read();return {state:!row.owner||row.lease_until<=now()||row.heartbeat<now()-LEASE_MS||row.revision!==revision||row.checked_at<now()-MEMBERSHIP_RECHECK_MS-LEASE_MS?'pending':row.state,checkedAt:row.checked_at?new Date(row.checked_at).toISOString():null};},
    release(){db.prepare('UPDATE membership SET owner=NULL,lease_until=0 WHERE id=1 AND owner=?').run(owner);},
    close(){if(!closed){tighten();db.close();closed=true;}}
  };
}
