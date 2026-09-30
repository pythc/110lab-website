import test from 'node:test';
import assert from 'node:assert/strict';
import {open,stat} from 'node:fs/promises';
import {createHttpServer} from '../server/http.mjs';
import {createHash} from 'node:crypto';

test('Android download returns the verified public APK as an attachment',async()=>{
  const server=await createHttpServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/assets/zhiping-public-0.2.2.apk`;
  try{
    const head=await fetch(url,{method:'HEAD'});
    assert.equal(head.status,200);
    assert.equal(head.headers.get('content-type'),'application/vnd.android.package-archive');
    assert.equal(Number(head.headers.get('content-length')),7737057);
    assert.match(head.headers.get('content-disposition'),/^attachment; filename="zhiping-android-public-0\.2\.2\.apk"/);
    assert.equal(decodeURIComponent(head.headers.get('content-disposition').split("filename*=UTF-8''")[1]),'智评学堂-安卓版-0.2.2.apk');
    assert.equal((await head.arrayBuffer()).byteLength,0);
    const response=await fetch(url);assert.equal(response.status,200);
    assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),'4c553d94f356047f09af41dab0db425b88a499cf78da6462cbd60eef8eed3c56');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('video streams support playback seeking and reject invalid ranges',async()=>{
  const server=await createHttpServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const file=new URL('../src/assets/zhiping-promo.mp4',import.meta.url);
  const size=(await stat(file)).size;
  const handle=await open(file);
  try{
    const head=await fetch(base+'/assets/zhiping-promo.mp4',{method:'HEAD',headers:{Range:'bytes=0-15'}});
    assert.equal(head.status,200);assert.equal(head.headers.get('content-type'),'video/mp4');
    assert.equal(Number(head.headers.get('content-length')),size);assert.equal(head.headers.get('accept-ranges'),'bytes');
    assert.equal((await head.arrayBuffer()).byteLength,0);
    for(const [range,start,end] of [['bytes=0-31',0,31],['bytes=-16',size-16,size-1],[`bytes=${size-8}-`,size-8,size-1],[`bytes=${size-8}-${size+10}`,size-8,size-1]]){
      const response=await fetch(base+'/assets/zhiping-promo.mp4',{headers:{Range:range}});
      assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/${size}`);
      const expected=Buffer.alloc(end-start+1);await handle.read(expected,0,expected.length,start);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);
    }
    for(const Range of [`bytes=${size}-`,'bytes=9-3','bytes=-0','bytes=nope','bytes=0-3,8-10','bytes=999999999999999999999-']){
      const response=await fetch(base+'/assets/zhiping-promo.mp4',{headers:{Range}});
      assert.equal(response.status,416);assert.equal(response.headers.get('content-range'),`bytes */${size}`);assert.equal((await response.arrayBuffer()).byteLength,0);
    }
    const resumed=await fetch(base+'/assets/zhiping-promo.mp4',{headers:{Range:'bytes=0-3','If-Range':head.headers.get('etag')}});
    assert.equal(resumed.status,206);await resumed.arrayBuffer();
    const stale=await fetch(base+'/assets/zhiping-promo.mp4',{headers:{Range:'bytes=0-3','If-Range':'"outdated"'}});
    assert.equal(stale.status,200);assert.equal(Number(stale.headers.get('content-length')),size);await stale.body.cancel();
    const poster=await fetch(base+'/assets/zhiping-poster.jpg');assert.equal(poster.status,200);assert.equal(poster.headers.get('content-type'),'image/jpeg');await poster.arrayBuffer();
    assert.equal((await fetch(base+'/assets/not-a-file.mp4')).status,404);
    assert.equal((await fetch(base+'/assets/toString')).status,404);
    assert.equal((await fetch(base+'/assets/%2e%2e%2fpackage.json')).status,404);
    assert.equal((await fetch(base+'/healthz')).status,200);
  }finally{await handle.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
