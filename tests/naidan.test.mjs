import test from 'node:test';
import assert from 'node:assert/strict';
import {initNaidan} from '../src/naidan.js';

// Only the DOM and timing APIs used by the encounter are faked. Each fixture has
// its own document, so the production WeakMap can exercise real visit guarding.
class EventTarget {
  listeners=new Map();
  addEventListener(type,listener){
    if(!this.listeners.has(type))this.listeners.set(type,new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type,listener){this.listeners.get(type)?.delete(listener);}
  emit(type,properties={}){
    const event={type,target:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...properties};
    const bubbles=['click','keydown','focusin','focusout'].includes(type);
    for(let target=this;target;target=bubbles?target.parent:null){
      event.currentTarget=target;
      for(const listener of [...(target.listeners.get(type)||[])])listener(event);
    }
    return event;
  }
  get listenerCount(){return [...this.listeners.values()].reduce((sum,listeners)=>sum+listeners.size,0);}
}

class Element extends EventTarget {
  selectors=new Map();
  classList=new Set();
  textContent='';
  hidden=false;
  focusCalls=[];
  constructor(document,parent=null){super();this.document=document;this.parent=parent;}
  querySelector(selector){return this.selectors.get(selector)||null;}
  contains(element){
    for(let node=element;node;node=node.parent)if(node===this)return true;
    return false;
  }
  focus(options){
    this.focusCalls.push(options);
    const previous=this.document.activeElement;
    if(previous===this)return;
    // Model focusout before activeElement changes, as browsers may do.
    previous?.emit('focusout',{relatedTarget:this});
    this.document.activeElement=this;
    this.emit('focusin',{relatedTarget:previous});
  }
}

class Clock {
  now=0;
  nextId=0;
  timers=new Map();
  setTimeout(callback,delay){const id=++this.nextId;this.timers.set(id,{at:this.now+delay,callback});return id;}
  clearTimeout(id){this.timers.delete(id);}
  tick(milliseconds){
    const end=this.now+milliseconds;
    let iterations=0;
    while(true){
      const next=[...this.timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      if(!next)break;
      assert.ok(++iterations<1000,'timer loop must terminate');
      const [id,timer]=next;this.now=timer.at;this.timers.delete(id);timer.callback();
    }
    this.now=end;
  }
}

function fixture({chance=.1,delay=0,storage=new Map(),blockedStorage,observer=true,markup=true,visibility='visible'}={}){
  const clock=new Clock();
  const doc=new EventTarget();
  doc.visibilityState=visibility;
  const outside=new Element(doc);
  const heading=new Element(doc);
  const nook=new Element(doc);
  const pet=new Element(doc,nook);pet.hidden=true;
  const greet=new Element(doc,pet);
  const close=new Element(doc,pet);
  const image=new Element(doc,greet);
  const message=new Element(doc,pet);
  doc.activeElement=outside;
  doc.querySelector=selector=>({'[data-naidan-nook]':markup?nook:null,'#lab-title':heading}[selector]||null);
  nook.selectors.set('[data-naidan]',pet);
  for(const [selector,element] of [['[data-naidan-greet]',greet],['[data-naidan-close]',close],['img',image],['[data-naidan-message]',message]])pet.selectors.set(selector,element);
  const win=new EventTarget();
  win.setTimeout=clock.setTimeout.bind(clock);win.clearTimeout=clock.clearTimeout.bind(clock);
  win.sessionStorage={
    getItem(key){if(blockedStorage==='get')throw new Error('Storage blocked');return storage.get(key)||null;},
    setItem(key,value){if(blockedStorage==='set')throw new Error('Storage blocked');storage.set(key,value);}
  };
  const observers=[];
  if(observer)win.IntersectionObserver=class {
    disconnected=false;
    constructor(callback,options){this.callback=callback;this.options=options;observers.push(this);}
    observe(target){this.target=target;}
    disconnect(){this.disconnected=true;}
    deliver(ratio){if(!this.disconnected)this.callback([{target:this.target,isIntersecting:ratio>0,intersectionRatio:ratio}]);}
  };
  let randomCalls=0;
  const random=()=>{assert.ok(randomCalls<2,'a document must not reroll');return [chance,delay][randomCalls++];};
  const targets=[doc,win,nook,pet,greet,close,image,message,heading,outside];
  return {
    doc,win,clock,storage,observers,pet,greet,close,image,message,heading,outside,
    init:()=>initNaidan({document:doc,window:win,random}),
    intersect:ratio=>observers[0].deliver(ratio),
    visibility(state){doc.visibilityState=state;doc.emit('visibilitychange');},
    get randomCalls(){return randomCalls;},
    get listenerCount(){return targets.reduce((sum,target)=>sum+target.listenerCount,0);}
  };
}

function reveal(f){f.init();f.intersect(1);f.clock.tick(8000);assert.equal(f.pet.hidden,false);}
function assertFinished(f){
  assert.equal(f.pet.hidden,true);
  assert.equal(f.clock.timers.size,0,'all timers are cancelled');
  assert.equal(f.listenerCount,0,'all installed listeners are removed');
  assert.equal(f.observers[0].disconnected,true);
}

test('the 35% chance includes values below the boundary and excludes the boundary',()=>{
  for(const [chance,eligible] of [[0,true],[.349999999,true],[.35,false],[.999999999,false]]){
    const f=fixture({chance});const dispose=f.init();
    assert.equal(f.observers.length,eligible?1:0,`chance ${chance}`);
    assert.equal(f.randomCalls,eligible?2:1);
    assert.equal(f.pet.hidden,true);
    assert.equal(f.clock.timers.size,0,'visibility is required before scheduling');
    assert.equal(f.storage.size,1,'even an unsuccessful roll consumes the session visit');
    dispose();
  }
});

test('one tab session gets one roll, including misses, reloads, and later initialization',()=>{
  for(const chance of [0,.9]){
    const storage=new Map();
    const first=fixture({chance,storage});const dispose=first.init();
    assert.equal(first.init(),dispose);
    dispose();
    const nextDocument=fixture({storage});nextDocument.init();
    assert.equal(nextDocument.randomCalls,0);
    assert.equal(nextDocument.observers.length,0);
    assert.equal(nextDocument.listenerCount,0);
    assert.equal(nextDocument.pet.hidden,true);
  }
});

test('repeat initialization returns the same teardown without duplicating listeners or timers',()=>{
  const f=fixture();const dispose=f.init();const listeners=f.listenerCount;
  assert.ok(listeners>0);
  f.intersect(1);
  for(let index=0;index<5;index++)assert.equal(f.init(),dispose);
  assert.equal(f.observers.length,1);assert.equal(f.randomCalls,2);
  assert.equal(f.listenerCount,listeners);assert.equal(f.clock.timers.size,1);
  f.clock.tick(8000);assert.equal(f.pet.hidden,false);
  assert.equal(f.init(),dispose);assert.equal(f.clock.timers.size,1);
  dispose();dispose();assertFinished(f);
  assert.equal(f.init(),dispose);assertFinished(f);
});

test('reveal delay covers the inclusive 8-second and 16-second limits',()=>{
  for(const [delay,milliseconds] of [[0,8000],[1-Number.EPSILON,16000]]){
    const f=fixture({delay});f.init();f.intersect(1);
    assert.equal(f.image.src,undefined,'do not fetch the image before the encounter');
    f.clock.tick(milliseconds-1);assert.equal(f.pet.hidden,true);
    f.clock.tick(1);assert.equal(f.pet.hidden,false);
    assert.equal(f.image.src,'/assets/naidan-peek.png');
    f.clock.tick(9999);assert.equal(f.pet.hidden,false);
    f.clock.tick(1);assertFinished(f);
  }
});

test('leaving the nook resets the complete dwell interval without rerolling its delay',()=>{
  const f=fixture();f.init();f.intersect(1);f.clock.tick(7999);
  f.intersect(0);assert.equal(f.clock.timers.size,0);
  f.clock.tick(20000);assert.equal(f.pet.hidden,true);
  f.intersect(1);f.clock.tick(4000);f.intersect(1);
  assert.equal(f.clock.timers.size,1,'duplicate entries do not restart or duplicate the timer');
  f.clock.tick(3999);assert.equal(f.pet.hidden,true);
  f.clock.tick(1);assert.equal(f.pet.hidden,false);
  assert.equal(f.randomCalls,2);f.init()();assertFinished(f);
});

test('the nook must remain fully visible for the entire dwell interval',()=>{
  const f=fixture();f.init();
  assert.equal(f.observers[0].options.threshold,1);
  for(const ratio of [.1,.999]){
    f.intersect(ratio);assert.equal(f.clock.timers.size,0,'partial intersection does not start the dwell');
  }
  f.intersect(1);f.clock.tick(7999);f.intersect(.5);
  assert.equal(f.clock.timers.size,0,'partial visibility resets an active dwell');
  f.intersect(1);f.clock.tick(7999);assert.equal(f.pet.hidden,true);
  f.clock.tick(1);assert.equal(f.pet.hidden,false);f.init()();
});

test('hidden documents do not accumulate dwell time and resume with a full delay',()=>{
  for(const visibility of ['visible','hidden']){
    const f=fixture({visibility});f.init();f.intersect(1);
    if(visibility==='visible')f.clock.tick(7999);
    f.visibility('hidden');assert.equal(f.clock.timers.size,0);
    f.clock.tick(60000);assert.equal(f.pet.hidden,true);
    f.visibility('visible');f.clock.tick(7999);assert.equal(f.pet.hidden,true);
    f.clock.tick(1);assert.equal(f.pet.hidden,false);f.init()();assertFinished(f);
  }
});

test('automatic dismissal ends the encounter permanently and leaves external focus unchanged',()=>{
  const f=fixture();reveal(f);f.clock.tick(10000);assertFinished(f);
  f.intersect(0);f.intersect(1);f.visibility('hidden');f.visibility('visible');
  f.init();f.clock.tick(100000);assertFinished(f);
  assert.equal(f.doc.activeElement,f.outside);assert.equal(f.heading.focusCalls.length,0);
});

test('pointer hover pauses dismissal and leaving starts a fresh ten-second interval',()=>{
  const f=fixture();reveal(f);f.clock.tick(9999);
  f.pet.emit('pointerenter');assert.equal(f.clock.timers.size,0);
  f.clock.tick(60000);assert.equal(f.pet.hidden,false);
  f.greet.emit('click');f.greet.emit('click');assert.equal(f.clock.timers.size,0,'greeting does not override hover pause');
  f.pet.emit('pointerleave');f.clock.tick(9999);assert.equal(f.pet.hidden,false);
  f.clock.tick(1);assertFinished(f);
});

test('repeated greetings update one message and renew only one dismissal timer',()=>{
  const f=fixture();reveal(f);
  for(let index=0;index<3;index++){
    f.clock.tick(9999);f.greet.emit('click');
    assert.equal(f.message.textContent,'被你发现啦！');
    assert.equal(f.pet.classList.has('is-found'),true);assert.equal(f.pet.classList.size,1);
    assert.equal(f.clock.timers.size,1);assert.equal(f.pet.hidden,false);
  }
  f.clock.tick(9999);assert.equal(f.pet.hidden,false);f.clock.tick(1);assertFinished(f);
});

test('focus within the encounter pauses dismissal, including movement between its controls',()=>{
  const f=fixture();reveal(f);f.clock.tick(9999);f.greet.focus();
  assert.equal(f.clock.timers.size,0);f.clock.tick(60000);assert.equal(f.pet.hidden,false);
  f.greet.emit('click');assert.equal(f.clock.timers.size,0,'greeting does not override focus pause');
  f.close.focus();assert.equal(f.clock.timers.size,0);f.clock.tick(60000);assert.equal(f.pet.hidden,false);
  f.outside.focus();assert.equal(f.clock.timers.size,1);
  f.clock.tick(9999);assert.equal(f.pet.hidden,false);f.clock.tick(1);assertFinished(f);
  assert.equal(f.doc.activeElement,f.outside);
});

test('overlapping hover and focus pauses end only when both leave',()=>{
  const f=fixture();reveal(f);f.pet.emit('pointerenter');f.greet.focus();
  f.pet.emit('pointerleave');assert.equal(f.clock.timers.size,0,'focus still pauses after the pointer leaves');
  f.pet.emit('pointerenter');f.outside.focus();assert.equal(f.clock.timers.size,0,'hover still pauses after focus leaves');
  f.clock.tick(60000);assert.equal(f.pet.hidden,false);
  f.pet.emit('pointerleave');f.clock.tick(10000);assertFinished(f);
});

test('Escape and close dismiss once and restore focused controls to the heading without scrolling',()=>{
  for(const method of ['escape','close']){
    const f=fixture();reveal(f);f.greet.focus();
    if(method==='escape'){
      const ignored=f.greet.emit('keydown',{key:'Enter'});assert.equal(ignored.defaultPrevented,false);assert.equal(f.pet.hidden,false);
      const escape=f.greet.emit('keydown',{key:'Escape'});assert.equal(escape.defaultPrevented,true);
    }else f.close.emit('click');
    assertFinished(f);assert.equal(f.doc.activeElement,f.heading);
    assert.deepEqual(f.heading.focusCalls,[{preventScroll:true}]);
    f.close.emit('click');f.pet.emit('keydown',{key:'Escape'});f.init()();
    assertFinished(f);assert.equal(f.heading.focusCalls.length,1);
  }
});

test('hiding the page dismisses a visible encounter even when interaction paused its timer',()=>{
  const f=fixture();reveal(f);f.pet.emit('pointerenter');f.greet.focus();f.visibility('hidden');
  assertFinished(f);assert.equal(f.doc.activeElement,f.heading);
  f.visibility('visible');f.intersect(1);f.clock.tick(60000);assertFinished(f);
});

test('pagehide and explicit teardown clean up both waiting and visible encounters',()=>{
  for(const visible of [false,true])for(const method of ['pagehide','dispose']){
    const f=fixture();const dispose=f.init();f.intersect(1);f.clock.tick(visible?8000:7999);
    if(visible)f.close.focus();
    if(method==='pagehide')f.win.emit('pagehide');else dispose();
    assertFinished(f);dispose();f.clock.tick(60000);assertFinished(f);
    assert.equal(f.doc.activeElement,visible?f.heading:f.outside);
  }
});

test('blocked storage still allows a safe encounter and prevents rerolls in the same document',()=>{
  for(const blockedStorage of ['get','set']){
    const f=fixture({blockedStorage});const dispose=f.init();assert.equal(f.init(),dispose);
    assert.equal(f.randomCalls,2);assert.equal(f.observers.length,1);
    f.intersect(1);f.clock.tick(8000);assert.equal(f.pet.hidden,false);
    dispose();assertFinished(f);assert.equal(f.init(),dispose);assert.equal(f.randomCalls,2);
  }
});

test('unsupported observers, absent markup, and absent browser globals fail closed',()=>{
  for(const options of [{observer:false},{markup:false}]){
    const f=fixture(options);const dispose=f.init();assert.equal(typeof dispose,'function');
    assert.equal(f.init(),dispose);dispose();
    assert.equal(f.randomCalls,0);assert.equal(f.storage.size,0);assert.equal(f.observers.length,0);
    assert.equal(f.listenerCount,0);assert.equal(f.clock.timers.size,0);assert.equal(f.pet.hidden,true);
  }
  assert.doesNotThrow(()=>initNaidan({document:null,window:{}})());
  assert.doesNotThrow(()=>initNaidan({document:{},window:null})());
});

test('an image failure cancels the encounter and cleans up all pending work',()=>{
  for(const visible of [false,true]){
    const f=fixture();f.init();f.intersect(1);f.clock.tick(visible?8000:7999);
    if(visible)f.greet.focus();
    f.image.emit('error');assertFinished(f);
    assert.equal(f.doc.activeElement,visible?f.heading:f.outside);
    f.image.emit('error');f.init();f.clock.tick(60000);assertFinished(f);
  }
});
