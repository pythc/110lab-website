import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chapterWheelDelta,wheelPixels} from '../src/chapters.js';

test('chapter boundaries slow continuous wheel travel without locking or skipping content',()=>{
  assert.equal(chapterWheelDelta(0,100,[1000,2000]),100,'ordinary page area stays native');
  const near=chapterWheelDelta(900,100,[1000,2000]);
  assert.ok(near>0&&near<100,'every wheel still advances');
  let y=800;
  for(let i=0;i<12;i++) y+=chapterWheelDelta(y,100,[1000,2000]);
  assert.ok(y>1400,'repeated scroll always leaves the chapter');
  assert.ok(chapterWheelDelta(1050,-100,[1000,2000])<0,'reverse direction never waits for a timer');
  const large=chapterWheelDelta(0,1500,[1000,2000]);
  assert.ok(large>1000&&large<1500,'a fling includes the cost of crossing a boundary');
});

test('scroll slowdown is independent of event splitting and overlapping short chapters',()=>{
  const stops=[1000,1100,2000];
  for(const [start,delta] of [[700,800],[1500,-900]]){
    const once=start+chapterWheelDelta(start,delta,stops);
    let divided=start;
    for(let i=0;i<10;i++) divided+=chapterWheelDelta(divided,delta/10,stops);
    assert.ok(Math.abs(once-divided)<.001,'touchpad event cadence does not change resistance');
    assert.ok(Math.abs(once-start)>=Math.abs(delta)*.4-.001,'overlapping chapters do not compound damping');
  }
  assert.equal(chapterWheelDelta(100,NaN,[1000]),0);
});

test('wheel normalization preserves zoom, horizontal gestures, modifiers and uncancelable events',()=>{
  const e={cancelable:true,deltaX:0,deltaY:3,deltaMode:0};
  assert.equal(wheelPixels(e,720),3);
  assert.equal(wheelPixels({...e,deltaMode:1},720),48);
  assert.equal(wheelPixels({...e,deltaMode:2},720),2160);
  for(const field of ['ctrlKey','metaKey','altKey','shiftKey']) assert.equal(wheelPixels({...e,[field]:true},720),0);
  assert.equal(wheelPixels({...e,cancelable:false},720),0);
  assert.equal(wheelPixels({...e,deltaX:20},720),0);
});

test('public sections supply named navigation targets; controls and reduced motion keep native scrolling',async()=>{
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  for(const label of ['首页','认识 110','智评学堂','Grunteon','实验室动态','加入我们']) assert.ok(html.includes(`data-chapter="${label}"`));
  assert.match(html,/aria-label="页面章节"/);
  const source=await readFile(new URL('../src/chapters.js',import.meta.url),'utf8');
  assert.match(source,/reduced.matches/);assert.match(source,/!desktop.matches/);
  assert.match(source,/input,textarea,select,button,video,audio/);
  assert.doesNotMatch(source,/addEventListener\(['"](?:touchmove|keydown)/);
});
