// One quiet encounter per tab session, entirely local to the public homepage.
const visits=new WeakMap();
const visitKey='110lab:naidan-visit:v1';

export function initNaidan({document:doc=globalThis.document,window:win=globalThis.window,random=Math.random}={}){
  if(!doc||!win)return ()=>{};
  if(visits.has(doc))return visits.get(doc);
  const noop=()=>{};
  visits.set(doc,noop);
  const nook=doc.querySelector('[data-naidan-nook]');
  const pet=nook?.querySelector('[data-naidan]');
  if(!pet||!win.IntersectionObserver)return noop;
  try{
    if(win.sessionStorage.getItem(visitKey))return noop;
    win.sessionStorage.setItem(visitKey,'visited');
  }catch{/* Storage may be blocked. The document guard still prevents rerolls. */}
  if(random()>=.35)return noop;

  const greet=pet.querySelector('[data-naidan-greet]');
  const close=pet.querySelector('[data-naidan-close]');
  const image=pet.querySelector('img');
  const message=pet.querySelector('[data-naidan-message]');
  const heading=doc.querySelector('#lab-title');
  const delay=8000+Math.floor(random()*8001);
  let revealTimer,hideTimer,inView=false,hovered=false,stage='waiting';
  const clearTimers=()=>{win.clearTimeout(revealTimer);win.clearTimeout(hideTimer);revealTimer=hideTimer=undefined;};
  const hasFocus=()=>pet.contains(doc.activeElement);
  const finish=()=>{
    if(stage==='done')return;
    stage='done';clearTimers();observer.disconnect();
    // Never leave keyboard focus stranded in a hidden control.
    if(hasFocus())heading?.focus({preventScroll:true});
    pet.hidden=true;
    doc.removeEventListener('visibilitychange',visibilityChanged);
    win.removeEventListener('pagehide',finish);
    greet.removeEventListener('click',greetNaidan);
    close.removeEventListener('click',finish);
    image.removeEventListener('error',finish);
    pet.removeEventListener('keydown',keydown);
    pet.removeEventListener('pointerenter',pointerEnter);
    pet.removeEventListener('pointerleave',pointerLeave);
    pet.removeEventListener('focusin',pauseHide);
    pet.removeEventListener('focusout',focusOut);
  };
  const armHide=()=>{
    win.clearTimeout(hideTimer);
    if(stage==='visible'&&!hovered&&!hasFocus())hideTimer=win.setTimeout(finish,10000);
  };
  const show=()=>{
    revealTimer=undefined;
    if(stage!=='waiting'||!inView||doc.visibilityState==='hidden')return;
    stage='visible';
    image.src='/assets/naidan-peek.png';
    pet.hidden=false;
    armHide();
  };
  const schedule=()=>{
    if(stage==='waiting'&&inView&&doc.visibilityState!=='hidden'&&revealTimer===undefined)revealTimer=win.setTimeout(show,delay);
  };
  function visibilityChanged(){
    if(doc.visibilityState==='hidden'){
      clearTimers();
      if(stage==='visible')finish();
    }else schedule();
  }
  function greetNaidan(){
    if(stage!=='visible')return;
    message.textContent='被你发现啦！';
    pet.classList.add('is-found');
    armHide();
  }
  function keydown(event){if(event.key==='Escape'){event.preventDefault();finish();}}
  function pauseHide(){win.clearTimeout(hideTimer);hideTimer=undefined;}
  function pointerEnter(){hovered=true;pauseHide();}
  function pointerLeave(){hovered=false;armHide();}
  function focusOut(event){if(stage==='visible'&&!pet.contains(event.relatedTarget)){
    // focusout fires before activeElement updates in some browsers.
    win.clearTimeout(hideTimer);
    if(!hovered)hideTimer=win.setTimeout(finish,10000);
  }}
  const observer=new win.IntersectionObserver(entries=>{
    inView=entries.some(entry=>entry.target===nook&&entry.isIntersecting&&entry.intersectionRatio>=1);
    if(!inView){win.clearTimeout(revealTimer);revealTimer=undefined;}
    else schedule();
  },{threshold:1});
  greet.addEventListener('click',greetNaidan);
  close.addEventListener('click',finish);
  image.addEventListener('error',finish);
  pet.addEventListener('keydown',keydown);
  pet.addEventListener('pointerenter',pointerEnter);
  pet.addEventListener('pointerleave',pointerLeave);
  pet.addEventListener('focusin',pauseHide);
  pet.addEventListener('focusout',focusOut);
  doc.addEventListener('visibilitychange',visibilityChanged);
  win.addEventListener('pagehide',finish);
  observer.observe(nook);
  visits.set(doc,finish);
  return finish;
}
