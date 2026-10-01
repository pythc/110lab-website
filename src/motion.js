const HERO_PROPS = [
  '--hero-progress',
  '--hero-copy-opacity',
  '--hero-copy-y',
  '--hero-art-x',
  '--hero-art-y',
  '--hero-art-scale',
  '--hero-art-rotate',
  '--hero-caption-opacity',
  '--hero-caption-y'
];

const LINE_PROPS = ['--line-0-opacity', '--line-1-opacity', '--line-2-opacity'];

const LINE_WINDOWS = [
  [0.06, 0.36],
  [0.34, 0.64],
  [0.62, 0.92]
];

const PASSIVE = { passive: true };

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function segment(progress, start, end) {
  if (end <= start) return progress >= end ? 1 : 0;
  return clamp((progress - start) / (end - start), 0, 1);
}

function smooth(amount) {
  return amount * amount * (3 - 2 * amount);
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

function unitless(value) {
  const rounded = Math.round(clamp(value, -1, 2) * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function withUnit(value, unit) {
  const rounded = Math.round(value * 10) / 10;
  return `${Object.is(rounded, -0) ? 0 : rounded}${unit}`;
}

function px(value) {
  return withUnit(value, 'px');
}

function deg(value) {
  return withUnit(value, 'deg');
}

function paint(node, name, value) {
  if (!node || !node.style) return;
  if (node.style.getPropertyValue(name) === value) return;
  node.style.setProperty(name, value);
}

function scrubProgress(section, stickySelector, viewH) {
  const rect = section.getBoundingClientRect();
  const view = viewH || 1;
  if (rect.bottom <= 0) return 1;
  if (rect.top >= view) return 0;
  const sticky = stickySelector ? section.querySelector(stickySelector) : null;
  const span = sticky ? sticky.getBoundingClientRect().height : view;
  const travel = rect.height - (span || view);
  if (!(travel > 1)) return 0;
  return clamp(-rect.top / travel, 0, 1);
}

function mediaQuery(query) {
  if (typeof window.matchMedia !== 'function') {
    return {
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {}
    };
  }
  return window.matchMedia(query);
}

function listenMedia(query, listener) {
  if (query.addEventListener) query.addEventListener('change', listener);
  else if (query.addListener) query.addListener(listener);
}

function unlistenMedia(query, listener) {
  if (query.removeEventListener) query.removeEventListener('change', listener);
  else if (query.removeListener) query.removeListener(listener);
}

export function initMotion() {
  if (typeof document === 'undefined' || !document.documentElement || typeof window === 'undefined') {
    return {
      setPaused() {},
      destroy() {},
      refresh() {}
    };
  }

  const root = document.documentElement;
  const reducedQuery = mediaQuery('(prefers-reduced-motion: reduce)');
  const compactQuery = mediaQuery('(max-width: 1023px), (orientation: portrait) and (max-width: 1180px)');
  const heroStamp = new WeakMap();
  const lineStamp = new WeakMap();

  let hero = null;
  let manifesto = null;
  let paused = false;
  let destroyed = false;
  let frame = 0;
  let cleared = false;
  let observer = null;

  function motionOn() {
    return !destroyed && !paused && !reducedQuery.matches;
  }

  function currentHero() {
    if (!hero || !hero.isConnected) hero = document.querySelector('.hero-story');
    return hero;
  }

  function currentManifesto() {
    if (!manifesto || !manifesto.isConnected) manifesto = document.querySelector('.manifesto-story');
    return manifesto;
  }

  function clearHero(section) {
    if (!section) return;
    section.querySelectorAll('.hero-copy,.hero-caption').forEach(node=>{node.inert=false;});
    heroStamp.delete(section);
    const targets = [
      section,
      section.querySelector('.hero-copy'),
      section.querySelector('.hero-art-wrap'),
      section.querySelector('.hero-caption')
    ];
    for (const target of targets) {
      if (!target) continue;
      for (const name of HERO_PROPS) target.style.removeProperty(name);
    }
  }

  function clearManifesto(section) {
    if (!section) return;
    lineStamp.delete(section);
    const targets = [section, ...section.querySelectorAll('[data-line], [data-chapter]')];
    for (const target of targets) {
      for (const name of LINE_PROPS) target.style.removeProperty(name);
    }
  }

  function clearVars() {
    clearHero(currentHero());
    clearManifesto(currentManifesto());
    cleared = true;
  }

  function writeHero(section, progress, compact, viewW, viewH) {
    const stamp = `${progress.toFixed(3)}|${compact ? 1 : 0}|${viewW}|${viewH}`;
    if (heroStamp.get(section) === stamp) return;
    heroStamp.set(section, stamp);

    const travel = smooth(progress);
    const values = {
      '--hero-progress': unitless(progress),
      '--hero-copy-opacity': '1',
      '--hero-copy-y': px(-8 * travel),
      '--hero-art-x': '0px',
      '--hero-art-y': px((compact ? -10 : -16) * travel),
      '--hero-art-scale': unitless(lerp(1, 1.06, travel)),
      '--hero-art-rotate': deg(compact ? 0 : -1.5 * travel),
      '--hero-caption-opacity': '0',
      '--hero-caption-y': '0px'
    };

    const copy=section.querySelector('.hero-copy');
    const captionNode=section.querySelector('.hero-caption');
    if(copy)copy.inert=false;
    if(captionNode)captionNode.inert=true;
    for (const name of HERO_PROPS) paint(section,name,values[name]);
  }

  function writeLines(section, progress) {
    const stamp = progress.toFixed(3);
    if (lineStamp.get(section) === stamp) return;
    lineStamp.set(section, stamp);
    const values = LINE_WINDOWS.map(([start, end]) => unitless(clamp(
      lerp(0.18, 1, smooth(segment(progress, start, end))),
      0.18,
      1
    )));
    for (let index = 0; index < LINE_PROPS.length; index += 1) {
      paint(section, LINE_PROPS[index], values[index]);
    }
    section.querySelectorAll('[data-line], [data-chapter]').forEach(node => {
      const index = Number(node.getAttribute('data-line') ?? node.getAttribute('data-chapter'));
      if (index >= 0 && index <= 2) paint(node, LINE_PROPS[index], values[index]);
    });
  }

  function update() {
    if (destroyed) return;
    if (!motionOn()) {
      if (!cleared) clearVars();
      return;
    }
    cleared = false;
    const viewW = Math.round(window.innerWidth || root.clientWidth || 0);
    const viewH = Math.round(window.innerHeight || root.clientHeight || 0);
    const compact = compactQuery.matches;
    const heroSection = currentHero();
    if (heroSection) writeHero(heroSection, scrubProgress(heroSection, '.hero-sticky', viewH), compact, viewW, viewH);
    const manifestoSection = currentManifesto();
    if (manifestoSection) writeLines(manifestoSection, scrubProgress(manifestoSection, '.manifesto-sticky', viewH));
  }

  function schedule() {
    if (destroyed || frame || document.visibilityState === 'hidden') return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      if (destroyed || document.visibilityState === 'hidden') return;
      update();
    });
  }

  function onIntersect(entries) {
    if (destroyed || !motionOn() || !observer) return;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }

  function ensureObserver() {
    if (observer) return observer;
    if (typeof IntersectionObserver !== 'function') return null;
    observer = new IntersectionObserver(onIntersect, {
      root: null,
      rootMargin: '0px 0px -6% 0px',
      threshold: 0.14
    });
    return observer;
  }

  function inView(node, viewH) {
    const rect = node.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < viewH * 0.98;
  }

  function bindReveals() {
    observer?.disconnect();
    const nodes = document.querySelectorAll('.reveal, .system-feature');
    if (!motionOn() || !ensureObserver()) {
      observer?.disconnect();
      root.removeAttribute('data-reveal-ready');
      nodes.forEach(node => node.classList.add('is-visible'));
      return;
    }
    const viewH = window.innerHeight || root.clientHeight || 0;
    nodes.forEach(node => {
      if (!node.classList.contains('reveal') && !node.classList.contains('system-feature')) return;
      if (node.classList.contains('is-visible') || inView(node, viewH)) {
        node.classList.add('is-visible');
        observer.unobserve(node);
        return;
      }
      observer.observe(node);
    });
    root.setAttribute('data-reveal-ready', 'true');
  }

  function applyMode() {
    if (destroyed) return;
    root.classList.toggle('motion-enabled', motionOn());
    root.classList.toggle('motion-paused', paused);
    bindReveals();
    update();
  }

  function onVisibility() {
    if (destroyed) return;
    if (document.visibilityState === 'hidden') {
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      return;
    }
    update();
  }

  function onPageShow() {
    applyMode();
  }

  function onMedia() {
    applyMode();
  }

  window.addEventListener('scroll', schedule, PASSIVE);
  window.addEventListener('resize', schedule, PASSIVE);
  window.addEventListener('hashchange', schedule);
  window.addEventListener('pageshow', onPageShow);
  document.addEventListener('visibilitychange', onVisibility);
  listenMedia(reducedQuery, onMedia);
  listenMedia(compactQuery, onMedia);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', schedule, PASSIVE);
  if (document.readyState !== 'complete') window.addEventListener('load', schedule);

  applyMode();

  return {
    setPaused(value) {
      if (destroyed) return;
      paused = Boolean(value);
      applyMode();
    },
    refresh() {
      if (destroyed) return;
      if (hero) heroStamp.delete(hero);
      if (manifesto) lineStamp.delete(manifesto);
      hero = null;
      manifesto = null;
      bindReveals();
      update();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      window.removeEventListener('scroll', schedule, PASSIVE);
      window.removeEventListener('resize', schedule, PASSIVE);
      window.removeEventListener('hashchange', schedule);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('load', schedule);
      document.removeEventListener('visibilitychange', onVisibility);
      unlistenMedia(reducedQuery, onMedia);
      unlistenMedia(compactQuery, onMedia);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', schedule, PASSIVE);
      observer?.disconnect();
      observer = null;
      root.classList.remove('motion-enabled', 'motion-paused');
      root.removeAttribute('data-reveal-ready');
      document.querySelectorAll('.reveal, .system-feature').forEach(node => node.classList.add('is-visible'));
      clearVars();
    }
  };
}
