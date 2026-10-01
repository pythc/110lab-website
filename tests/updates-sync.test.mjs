import test from 'node:test';
import assert from 'node:assert/strict';
import {createUpdatesSync} from '../src/updates-sync.js';

function clock(){
  let now=0,id=0;const timers=new Map();
  return {
    setTimer(fn,ms){const key=++id;timers.set(key,{at:now+ms,fn});return key;},
    clearTimer(key){timers.delete(key);},
    tick(ms){const end=now+ms;for(;;){const next=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn();}now=end;},
    get now(){return now;},
  };
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}

test('already-open page observes publish, draft isolation, and withdraw within one visible interval',async()=>{
  const time=clock(),requests=[],shown=[];let publicData=[];
  const sync=createUpdatesSync({...time,isVisible:()=>true,request:async()=>{requests.push(time.now);return structuredClone(publicData);},onData:data=>shown.push(data),onFailure:()=>assert.fail('unexpected failure')});
  sync.start();sync.start();await flush();assert.deepEqual(shown.at(-1),[]);
  // Private draft editing never changes the response; only publishing does.
  time.tick(59999);await flush();assert.equal(requests.length,1);
  publicData=[{title:'Published snapshot'}];time.tick(1);await flush();assert.deepEqual(shown.at(-1),publicData);
  publicData=[];time.tick(60000);await flush();assert.deepEqual(shown.at(-1),[]);
  assert.deepEqual(requests,[0,60000,120000]);sync.stop();time.tick(120000);await flush();assert.equal(requests.length,3);
});

test('hidden pages stop requests; foreground refresh discards an obsolete response and deduplicates concurrent triggers',async()=>{
  const time=clock(),pending=[],shown=[];let visible=true,resumes=0;
  const sync=createUpdatesSync({...time,isVisible:()=>visible,request:signal=>{const item=deferred();pending.push({...item,signal});return item.promise;},onData:data=>shown.push(data),onFailure:()=>assert.fail('unexpected failure'),onResume:()=>resumes++});
  sync.start();sync.refresh();await flush();assert.equal(pending.length,1);
  visible=false;sync.visibilityChanged();assert.equal(pending[0].signal.aborted,true);
  time.tick(300000);await flush();assert.equal(pending.length,1);
  visible=true;sync.visibilityChanged();sync.refresh();await flush();assert.equal(pending.length,2);assert.equal(resumes,1);
  pending[0].resolve(['withdrawn old content']);await flush();assert.deepEqual(shown,[]);
  pending[1].resolve([]);await flush();assert.deepEqual(shown,[[]]);sync.stop();
});

test('failure clears stale content; body timeout has a deadline even if abort is ignored; retry is bounded',async()=>{
  const time=clock(),shown=[],calls=[];let mode='good';const stalled=deferred();
  const sync=createUpdatesSync({...time,isVisible:()=>true,request:signal=>{calls.push({at:time.now,signal});if(mode==='good')return Promise.resolve(['published']);if(mode==='fail')return Promise.reject(new Error('503'));return stalled.promise;},onData:data=>shown.push(data),onFailure:()=>shown.push([])});
  sync.start();await flush();assert.deepEqual(shown.at(-1),['published']);
  mode='fail';time.tick(60000);await flush();assert.deepEqual(shown.at(-1),[]);
  mode='stall';time.tick(60000);await flush();sync.refresh();assert.equal(calls.length,3);
  time.tick(9999);assert.equal(calls[2].signal.aborted,false);
  time.tick(1);assert.equal(calls[2].signal.aborted,true);assert.deepEqual(shown.at(-1),[]);
  stalled.resolve(['late withdrawn content']);await flush();assert.deepEqual(shown.at(-1),[]);
  mode='good';time.tick(50000);await flush();assert.equal(calls.length,4);assert.equal(calls[3].at,180000);assert.deepEqual(shown.at(-1),['published']);sync.stop();
});

test('suspending before request dispatch prevents the request; initial hidden page stays idle',async()=>{
  const time=clock();let visible=false,calls=0;
  const sync=createUpdatesSync({...time,isVisible:()=>visible,request:async()=>{calls++;return [];},onData:()=>{},onFailure:()=>assert.fail('unexpected failure')});
  sync.start();time.tick(600000);await flush();assert.equal(calls,0);
  visible=true;sync.visibilityChanged();sync.stop();await flush();assert.equal(calls,0);
  sync.start();await flush();assert.equal(calls,1);sync.stop();
});
