// A short, continuous slowdown around chapter boundaries; never a scroll lock.
export function chapterWheelDelta(position, delta, stops, zone = 180, factor = 0.4) {
  if (!Number.isFinite(delta) || !delta) return 0;
  const direction = Math.sign(delta);
  const intervals = stops.filter(value => value > 0).map(stop =>
    direction > 0 ? [stop - zone, stop + zone / 4] : [-stop - zone / 4, -stop + zone]
  ).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  const origin = position * direction;
  let cursor = origin, remaining = Math.abs(delta);
  for (const [start, end] of merged) {
    if (cursor >= end) continue;
    const free = Math.min(remaining, Math.max(0, start - cursor));
    cursor += free; remaining -= free;
    if (remaining <= 0) break;
    const slowed = Math.min(end - cursor, remaining * factor);
    cursor += slowed; remaining = Math.max(0, remaining - slowed / factor);
    if (remaining <= 0) break;
  }
  return direction * (cursor + remaining - origin);
}

export function wheelPixels(event, viewportHeight) {
  if (!event.cancelable || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY)) return 0;
  return event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportHeight : 1);
}

function hasOwnWheelInteraction(target) {
  if (!(target instanceof Element)) return true;
  if (target.closest('input,textarea,select,button,video,audio,[contenteditable]:not([contenteditable="false"]),[role="dialog"],.uppy-Dashboard')) return true;
  for (let node = target; node && node !== document.body; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return true;
  }
  return false;
}

export function initChapters() {
  const nav = document.querySelector('.chapter-nav');
  const sections = [...document.querySelectorAll('main > section[data-chapter]')];
  if (!nav || sections.length < 2) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const desktop = matchMedia('(min-width: 1100px) and (hover: hover) and (pointer: fine)');
  const track = document.createElement('span');
  track.className = 'chapter-nav-track'; track.setAttribute('aria-hidden', 'true');
  const list = document.createElement('ol');
  const links = sections.map(section => {
    const li = document.createElement('li'), link = document.createElement('a');
    link.href = '#' + section.id;
    link.setAttribute('aria-label', section.dataset.chapter);
    const label = document.createElement('span'); label.textContent = section.dataset.chapter;
    link.append(label); li.append(link); list.append(li); return link;
  });
  nav.append(track, list); nav.hidden = false;
  document.documentElement.classList.add('chapter-navigation');
  let frame = 0, positions = [], stops = [], dirty = true, bypassUntil = 0;
  function paint() {
    frame = 0;
    if (dirty) {
      positions = sections.map(section => section.getBoundingClientRect().top + window.scrollY);
      stops = positions.slice(1).map(top => Math.max(0, top - 100));
      dirty = false;
    }
    const probe = window.scrollY + Math.min(innerHeight * 0.35, 240);
    let current = 0;
    for (let index = 1; index < positions.length; index++) if (positions[index] <= probe) current = index;
    const bottom = window.scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
    if (bottom) current = sections.length - 1;
    links.forEach((link, index) => {
      if (index === current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    const from = positions[current], to = positions[current + 1] ?? document.documentElement.scrollHeight;
    const fraction = Math.max(0, Math.min(1, (probe - from) / Math.max(1, to - from)));
    const progress = bottom ? 1 : Math.min(1, (current + fraction) / (sections.length - 1));
    nav.style.setProperty('--chapter-progress', String(progress));
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(paint); }
  function measure() { dirty = true; schedule(); }
  function wheel(event) {
    if (event.defaultPrevented || !desktop.matches || reduced.matches || performance.now() < bypassUntil) return;
    const delta = wheelPixels(event, innerHeight);
    if (!delta || hasOwnWheelInteraction(event.target)) return;
    // Keep native scrolling everywhere except these short boundary regions.
    const movement = chapterWheelDelta(window.scrollY, delta, stops);
    if (Math.abs(movement - delta) < 0.01) return;
    event.preventDefault();
    window.scrollBy({top: movement, behavior: 'instant'});
  }
  function bypass() { bypassUntil = performance.now() + 900; }
  document.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('a[href^="#"]')) bypass();
  });
  window.addEventListener('hashchange', bypass);
  window.addEventListener('scroll', schedule, {passive: true});
  window.addEventListener('resize', measure, {passive: true});
  window.addEventListener('wheel', wheel, {passive: false});
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(measure);
    sections.forEach(section => observer.observe(section));
  }
  paint();
}
