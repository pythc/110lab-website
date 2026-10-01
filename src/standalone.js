import {initMotion} from './motion.js';
import {initPublicUpdates} from './updates.js';
initMotion();
initPublicUpdates();
const nav=document.querySelector('.glass-nav');
const update=()=>{if(nav)nav.dataset.elevation=window.scrollY>20?'scrolled':'base';};
window.addEventListener('scroll',update,{passive:true});update();
