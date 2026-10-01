import {readFile} from 'node:fs/promises';
import {openUpdatesStore} from '../server/updates.mjs';

// Local operator CLI; it does not grant a browser or MCP caller admin rights.
const filename=process.env.PORTAL_UPDATES_DATABASE;
if(!filename||filename===':memory:')throw new Error('Set PORTAL_UPDATES_DATABASE to a dedicated updates SQLite file');
const [command,id,expectedRevision,flag]=process.argv.slice(2);
const store=openUpdatesStore(filename);
try{
  let result;
  if(command==='create')result=store.create(JSON.parse(await readFile(id,'utf8')));
  else if(command==='edit')result=store.edit(id,Number(expectedRevision),JSON.parse(await readFile(flag,'utf8')));
  else if(command==='publish')result=store.publish(id,Number(expectedRevision),{publicConfirmed:flag==='--confirm-public'});
  else if(command==='withdraw')result=store.withdraw(id,Number(expectedRevision));
  else if(command==='get')result=store.get(id);
  else if(command==='list')result=store.listDrafts();
  else throw new Error('Use create FILE, edit ID REVISION FILE, publish ID REVISION --confirm-public, withdraw ID REVISION, get ID, or list');
  console.log(JSON.stringify(result,null,2));
}finally{store.close();}
