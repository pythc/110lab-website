import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createHttpServer} from '../server/http.mjs';

const asset='grunteon-intro-v2.mp4';
const expectedHash='10c872a9e09ed7fb06dfbf1619f867e62eb5695f5d2fa83df8daa2e71eef1b84';

test('Grunteon uses the approved final video and a square native vector mark',async()=>{
  const video=await readFile(new URL('../src/assets/'+asset,import.meta.url));
  assert.equal(video.length,5633353);
  assert.equal(createHash('sha256').update(video).digest('hex'),expectedHash);
  const atoms=[];
  for(let offset=0;offset<video.length;){
    const size=video.readUInt32BE(offset);
    assert.ok(size>=8);atoms.push(video.toString('ascii',offset+4,offset+8));offset+=size;
  }
  assert.ok(atoms.indexOf('moov')>=0&&atoms.indexOf('moov')<atoms.indexOf('mdat'),'fast-start metadata precedes media');
  const logo=await readFile(new URL('../src/assets/grunteon-logo.svg',import.meta.url),'utf8');
  assert.match(logo,/viewBox="0 0 160 160"/);assert.match(logo,/fill="#000"/);assert.match(logo,/fill="#fff"/);
  assert.doesNotMatch(logo,/<text\b|\brx=|<script|https?:\/\/(?!www\.w3\.org)/);
});

test('Grunteon public section has native, user-initiated playback and public-only catalog',async()=>{
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  const section=html.match(/<section class="product-section grunteon-section"[\s\S]*?<\/section>/)?.[0];
  assert.ok(section);
  assert.match(section,/Grunteon <span>JVM字节码混淆框架<\/span>/);
  assert.match(section,/<video controls playsinline preload="none" poster="\/assets\/grunteon-poster-v2.jpg"/);
  assert.match(section,/aria-label="Grunteon 功能介绍"/);
  assert.doesNotMatch(section,/autoplay|\bloop\b|mailto:|libfile_|file_000|whzy3185\/grunteon|\.jar\b/);
  assert.doesNotMatch(section,/观看一分钟介绍|一分钟了解 Grunteon|核心未开源|class="product-actions"/);
  assert.match(section,/面向 JVM 字节码的混淆框架<br class="desktop-break">让核心代码得到保护/);
  assert.doesNotMatch(section,/<details|<summary|<figcaption|直接打开视频|项目简介/);
  const description=section.match(/<p class="grunteon-description">([\s\S]*?)<\/p>/)?.[1];
  assert.ok(description,'complete project introduction is visible beside the title');
  assert.match(description,/层级分析/);assert.match(description,/同步屏障/);assert.match(description,/失败回退/);
  assert.ok(section.indexOf(description)<section.indexOf('<video'));
  assert.match(html,/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  const catalog=JSON.parse(await readFile(new URL('../src/projects.json',import.meta.url),'utf8'));
  const project=catalog.projects.find(p=>p.id==='grunteon');
  assert.equal(project.title,'Grunteon JVM字节码混淆框架');
  assert.equal(project.url,'https://110-lab.cn/#grunteon');
});

test('Grunteon media serves correct MIME, ranges and cache validators',async()=>{
  const server=await createHttpServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/assets/`;
  try{
    const head=await fetch(base+asset,{method:'HEAD'});
    assert.equal(head.status,200);assert.equal(head.headers.get('content-type'),'video/mp4');
    assert.equal(head.headers.get('accept-ranges'),'bytes');assert.equal(Number(head.headers.get('content-length')),5633353);
    assert.equal((await head.arrayBuffer()).byteLength,0);
    const file=await readFile(new URL('../src/assets/'+asset,import.meta.url));
    for(const [range,start,end] of [['bytes=0-63',0,63],['bytes=-64',file.length-64,file.length-1],['bytes=4096-4159',4096,4159]]){
      const response=await fetch(base+asset,{headers:{Range:range}});
      assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/${file.length}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),file.subarray(start,end+1));
    }
    assert.equal((await fetch(base+asset,{headers:{Range:`bytes=${file.length}-`}})).status,416);
    assert.equal((await fetch(base+asset,{headers:{'If-None-Match':head.headers.get('etag')}})).status,304);
    for(const [name,mime] of [['grunteon-logo.svg','image/svg+xml'],['grunteon-poster-v2.jpg','image/jpeg']]){
      const response=await fetch(base+name);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),mime);await response.arrayBuffer();
    }
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
