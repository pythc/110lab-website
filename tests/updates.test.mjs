import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openUpdatesStore} from '../server/updates.mjs';
import {createHttpServer} from '../server/http.mjs';

const content=title=>({title,summary:'Only confirmed public content',body:[{type:'paragraph',content:[{text:'<img src=x onerror=alert(1)>',bold:true}]}]});
test('drafts, live snapshots, edits, confirmation, conflicts and withdrawal stay separate',()=>{
  const store=openUpdatesStore();
  try{
    const a=store.create(content('First draft'));assert.deepEqual(store.listPublished(),[]);
    assert.throws(()=>store.publish(a.id,a.revision),{code:'PUBLIC_CONFIRMATION_REQUIRED'});
    const live=store.publish(a.id,a.revision,{publicConfirmed:true});assert.equal(store.listPublished()[0].title,'First draft');
    const edited=store.edit(a.id,live.revision,content('Unpublished edit'));
    assert.equal(store.listPublished()[0].title,'First draft');
    assert.throws(()=>store.publish(a.id,live.revision,{publicConfirmed:true}),{code:'CONFLICT'});
    const updated=store.publish(a.id,edited.revision,{publicConfirmed:true});assert.equal(store.listPublished()[0].title,'Unpublished edit');
    const withdrawn=store.withdraw(a.id,updated.revision);assert.deepEqual(store.listPublished(),[]);assert.equal(withdrawn.draft.title,'Unpublished edit');
    assert.throws(()=>store.create({...content('Unsafe URL'),link:'javascript:alert(1)'}));
    assert.throws(()=>store.create({...content('Embedded credentials'),link:'https://user:secret@example.com'}));
    assert.throws(()=>store.create({...content('Unexpected data'),internalTasks:[]}));
    assert.throws(()=>store.create({title:'Unsafe mark',body:[{type:'paragraph',content:[{text:'x',href:'data:text/html,x'}]}]}));
    assert.equal(updated.published.body[0].content[0].text,'<img src=x onerror=alert(1)>');
  }finally{store.close();}
});
test('persistent content and public cache reflect publish and withdraw; anonymous writes remain closed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'110lab-updates-')),path=join(dir,'updates.sqlite');
  const writer=openUpdatesStore(path),reader=openUpdatesStore(path),http=await createHttpServer({updatesStore:reader});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${http.address().port}`;
  try{
    const a=writer.create(content('Persistent draft'));
    const empty=await fetch(base+'/api/updates');const initialETag=empty.headers.get('etag');assert.deepEqual(await empty.json(),{updates:[]});
    assert.equal((await fetch(base+'/api/updates',{headers:{'If-None-Match':initialETag}})).status,304);
    const live=writer.publish(a.id,a.revision,{publicConfirmed:true});
    const publicResponse=await fetch(base+'/api/updates',{headers:{'If-None-Match':initialETag}});assert.equal(publicResponse.status,200);
    const publishedETag=publicResponse.headers.get('etag');const data=await publicResponse.json();assert.equal(data.updates[0].title,'Persistent draft');assert.equal(data.updates[0].draft,undefined);
    assert.equal((await fetch(base+'/api/updates',{method:'POST',body:'{}'})).status,405);
    assert.equal((await fetch(base+'/api/admin/updates',{method:'POST',body:'{}'})).status,404);
    writer.withdraw(a.id,live.revision);
    const withdrawn=await fetch(base+'/api/updates',{headers:{'If-None-Match':publishedETag}});assert.equal(withdrawn.status,200);assert.deepEqual(await withdrawn.json(),{updates:[]});
    assert.equal((await fetch(base+'/api/updates',{method:'HEAD'})).status,200);
  }finally{http.closeAllConnections();await new Promise(resolve=>http.close(resolve));reader.close();writer.close();await rm(dir,{recursive:true,force:true});}
});
