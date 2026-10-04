import {createHash} from 'node:crypto';
import {z} from 'zod';

export function stableJSON(value) {
  if (Array.isArray(value)) return '['+value.map(stableJSON).join(',')+']';
  if (value && typeof value === 'object') return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+stableJSON(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(stableJSON(value)).digest('hex');

// A SAVEPOINT composes with existing store transactions. The result and the
// business mutation commit together, including across process restarts.
export function commandJournal(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS business_commands(subject TEXT NOT NULL,request_id TEXT NOT NULL,operation TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(subject,request_id));`);
  const execute = (actor, requestId, operation, input, fn, {replayOnly=false}={}) => {
    z.uuid().parse(requestId);
    if (!actor?.subject) throw new Error('Missing trusted identity');
    const fingerprint=digest({operation,input});
    db.exec('SAVEPOINT business_command');
    try {
      const old=db.prepare('SELECT * FROM business_commands WHERE subject=? AND request_id=?').get(actor.subject,requestId);
      if (old) {
        if (old.fingerprint!==fingerprint) throw Object.assign(new Error('同一请求编号不能用于不同内容'),{code:'REQUEST_CONFLICT',status:409});
        db.exec('RELEASE business_command');return JSON.parse(old.result);
      }
      if(replayOnly)throw Object.assign(new Error('预览已过期且没有已提交结果 请重新生成'),{code:'PREVIEW_STALE',status:409});
      const result=fn();
      if (result?.then) throw new Error('Durable commands must be synchronous');
      db.prepare('INSERT INTO business_commands VALUES(?,?,?,?,?,?)').run(actor.subject,requestId,operation,fingerprint,JSON.stringify(result),new Date().toISOString());
      db.exec('RELEASE business_command');return result;
    } catch (e) { db.exec('ROLLBACK TO business_command; RELEASE business_command');throw e; }
  };
  return execute;
}
