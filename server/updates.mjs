import {commandJournal} from './durable-command.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,lstatSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

const publicLink=z.string().max(1000).refine(value=>{
  if(/[\s\u0000-\u001f]/u.test(value))return false;
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}
},'Use an HTTPS URL without credentials');
const span=z.object({text:z.string().min(1).max(2000),bold:z.boolean().optional(),href:publicLink.optional()}).strict();
const inline=z.array(span).min(1).max(30);
const block=z.discriminatedUnion('type',[
  z.object({type:z.literal('paragraph'),content:inline}).strict(),
  z.object({type:z.literal('heading'),content:inline}).strict(),
  z.object({type:z.literal('list'),items:z.array(inline).min(1).max(20)}).strict()
]);
const input=z.object({title:z.string().trim().min(1).max(120),summary:z.string().trim().max(280).default(''),body:z.array(block).max(30).default([]),link:publicLink.nullable().default(null)}).strict().refine(value=>JSON.stringify(value).length<=16000,'Content is too long');
const revision=z.number().int().positive();
export class UpdateError extends Error {constructor(code,message){super(message);this.code=code;}}

/** Private drafts and public snapshots stay separate, including during edits. */
export function openUpdatesStore(filename=':memory:'){
  if(filename!==':memory:'){
    const parent=dirname(resolve(filename));mkdirSync(parent,{recursive:true,mode:0o700});
    if(lstatSync(parent).isSymbolicLink())throw new Error('Unsafe updates directory');chmodSync(parent,0o700);
    try{if(lstatSync(filename).isSymbolicLink())throw new Error('Unsafe updates database');}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const db=new DatabaseSync(filename);
  if(filename!==':memory:')chmodSync(filename,0o600);
  db.exec('PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS public_updates (id TEXT PRIMARY KEY, draft TEXT NOT NULL, published TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT);');
  const row=id=>{const r=db.prepare('SELECT * FROM public_updates WHERE id=?').get(z.string().uuid().parse(id));if(!r)throw new UpdateError('NOT_FOUND','Update not found');return r;};
  const present=r=>({id:r.id,draft:JSON.parse(r.draft),published:r.published?JSON.parse(r.published):null,revision:r.revision,createdAt:r.created_at,updatedAt:r.updated_at,publishedAt:r.published_at});
  const change=(id,expectedRevision,sql,...values)=>{
    revision.parse(expectedRevision);
    const result=db.prepare(sql).run(...values,id,expectedRevision);
    if(result.changes!==1)throw new UpdateError('CONFLICT','Content changed; reload before saving');
    return present(row(id));
  };
  return {
    durable:commandJournal(db),
    create(value){
      const draft=input.parse(value),id=randomUUID(),now=new Date().toISOString();
      db.prepare('INSERT INTO public_updates (id,draft,revision,created_at,updated_at) VALUES (?,?,1,?,?)').run(id,JSON.stringify(draft),now,now);
      return present(row(id));
    },
    get:id=>present(row(id)),
    listDrafts:()=>db.prepare('SELECT * FROM public_updates ORDER BY updated_at DESC,id').all().map(present),
    edit(id,expectedRevision,value){
      const draft=input.parse(value);row(id);
      return change(id,expectedRevision,'UPDATE public_updates SET draft=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',JSON.stringify(draft),new Date().toISOString());
    },
    publish(id,expectedRevision,{publicConfirmed=false}={}){
      if(publicConfirmed!==true)throw new UpdateError('PUBLIC_CONFIRMATION_REQUIRED','Confirm that this content is suitable for public display');
      const r=row(id),now=new Date().toISOString();
      const published={id,...input.parse(JSON.parse(r.draft)),publishedAt:now,updatedAt:now};
      return change(id,expectedRevision,'UPDATE public_updates SET published=?,published_at=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?',JSON.stringify(published),now,now);
    },
    withdraw(id,expectedRevision){
      row(id);
      return change(id,expectedRevision,'UPDATE public_updates SET published=NULL,published_at=NULL,updated_at=?,revision=revision+1 WHERE id=? AND revision=?',new Date().toISOString());
    },
    listPublished:()=>db.prepare('SELECT published FROM public_updates WHERE published IS NOT NULL ORDER BY published_at DESC,id LIMIT 50').all().map(r=>JSON.parse(r.published)),
    close:()=>db.close()
  };
}

export {input as updateContentSchema};
