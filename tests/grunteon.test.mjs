import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createHttpServer} from '../server/http.mjs';

const asset='grunteon-ticking-away-60s.mp4';
const expectedHash='007c4c35a35cedb81f5aeb816dc36d59eb7933b9a2543027e5e79b14d3bf7f0a';

test('Grunteon uses the approved final video and a square native vector mark',async()=>{
  const video=await readFile(new URL('../src/assets/'+asset,import.meta.url));
  assert.equal(video.length,9458009);
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
  assert.match(section,/Grunteon <span>- JVM字节码混淆框架<\/span>/);
  assert.match(section,/<video controls playsinline preload="none" poster="\/assets\/grunteon-poster.jpg"/);
  assert.match(section,/aria-describedby="grunteon-film-caption"/);
  assert.doesNotMatch(section,/autoplay|\bloop\b|mailto:|libfile_|file_000|whzy3185\/grunteon|\.jar\b/);
  assert.doesNotMatch(section,/观看一分钟介绍|一分钟了解 Grunteon|核心未开源|class="product-actions"/);
  assert.match(section,/面向 JVM 字节码的混淆框架<br class="desktop-break">让核心代码得到保护/);
  const details=section.match(/<details class="grunteon-details">[\s\S]*?<\/details>/)?.[0];
  assert.ok(details,'project introduction starts collapsed with no open attribute');
  assert.match(details,/<summary>项目简介<\/summary>/);
  const paragraphs=[...details.matchAll(/<p>([\s\S]*?)<\/p>/g)];
  assert.equal(paragraphs.length,1);
  const characterCount=[...paragraphs[0][1].replace(/\s/g,'')].length;
  assert.ok(characterCount>=230&&characterCount<=290,'one approximately 250-character capability paragraph');
  assert.match(paragraphs[0][1],/层级分析/);assert.match(paragraphs[0][1],/同步屏障/);
  assert.match(paragraphs[0][1],/失败回退/);
  assert.doesNotMatch(section.replace(/<[^>]+>/g,''),/Ticking[\s-]*Away/i);
  assert.doesNotMatch(section,/aria-label="[^"]*Ticking/i);
  assert.doesNotMatch(details,/项目与视频说明|视频时长|浏览器|播放器/);
  assert.match(section,/<a href="\/assets\/grunteon-ticking-away-60s.mp4">直接打开视频<\/a>/);
  assert.match(html,/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  const catalog=JSON.parse(await readFile(new URL('../src/projects.json',import.meta.url),'utf8'));
  const project=catalog.projects.find(p=>p.id==='grunteon');
  assert.equal(project.title,'Grunteon - JVM字节码混淆框架');
  assert.equal(project.url,'https://110-lab.cn/#grunteon');
});

test('Grunteon media serves correct MIME, ranges and cache validators',async()=>{
  const server=await createHttpServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/assets/`;
  try{
    const head=await fetch(base+asset,{method:'HEAD'});
    assert.equal(head.status,200);assert.equal(head.headers.get('content-type'),'video/mp4');
    assert.equal(head.headers.get('accept-ranges'),'bytes');assert.equal(Number(head.headers.get('content-length')),9458009);
    assert.equal((await head.arrayBuffer()).byteLength,0);
    const file=await readFile(new URL('../src/assets/'+asset,import.meta.url));
    for(const [range,start,end] of [['bytes=0-63',0,63],['bytes=-64',file.length-64,file.length-1],['bytes=4096-4159',4096,4159]]){
      const response=await fetch(base+asset,{headers:{Range:range}});
      assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/${file.length}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),file.subarray(start,end+1));
    }
    assert.equal((await fetch(base+asset,{headers:{Range:`bytes=${file.length}-`}})).status,416);
    assert.equal((await fetch(base+asset,{headers:{'If-None-Match':head.headers.get('etag')}})).status,304);
    for(const [name,mime] of [['grunteon-logo.svg','image/svg+xml'],['grunteon-poster.jpg','image/jpeg']]){
      const response=await fetch(base+name);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),mime);await response.arrayBuffer();
    }
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
