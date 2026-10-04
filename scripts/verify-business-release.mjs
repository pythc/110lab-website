// Same OAuth and browser confirmation integration tests against the exact bundle,
// outside node_modules. Source-only dependencies of the test runner stay local.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Worker} from 'node:worker_threads';
const root=mkdtempSync(join(tmpdir(),'110lab-business-release-'));
try{
 const manifest=JSON.parse(readFileSync('release.json'));
 for(const path of Object.keys(manifest.files)){mkdirSync(dirname(join(root,path)),{recursive:true});copyFileSync(path,join(root,path));}
 const result=spawnSync(process.execPath,['--test','--test-timeout=30000','tests/business-http.test.mjs'],{stdio:'inherit',env:{...process.env,BUSINESS_RELEASE_ROOT:root}});assert.equal(result.status,0);
 const worker=new Worker(join(root,'server/attachment-text-worker-runtime.mjs'),{execArgv:[],workerData:{buffer:Buffer.from('Isolated fictional attachment'),mime:'text/plain'}});
 const extracted=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});await worker.terminate();
 assert.equal(extracted.status,'EXTRACTED');assert.equal(extracted.segments[0].text,'Isolated fictional attachment');
 console.log(JSON.stringify({isolatedBusinessBundle:true,oauth:true,humanConfirmation:true,privateAttachmentWorker:true,externalCalls:false}));
}finally{rmSync(root,{recursive:true,force:true});}
