import assert from 'node:assert/strict';
import test from 'node:test';
import { paintRooms } from '../renderer/room-art.mjs';

function fixture() {
  const timers = new Map();
  const document = new EventTarget();
  const motion = new EventTarget();
  let intersection;
  let mutations;
  document.defaultView = {
    matchMedia: () => motion,
    IntersectionObserver: class {
      observed = new Set();
      constructor(callback) {
        intersection = entries => callback(entries.filter(({ target }) => this.observed.has(target)));
      }
      observe(canvas) { this.observed.add(canvas); }
      disconnect() {}
    },
    MutationObserver: class {
      constructor(callback) { mutations = callback; }
      observe() {}
      disconnect() {}
    },
    setInterval(callback) {
      const id = Symbol();
      timers.set(id, callback);
      return id;
    },
    clearInterval(id) { timers.delete(id); },
  };
  const desk = (kind, key, state = 'working') => {
    let pixels = Array(40 * 40).fill(null);
    const context = {
      clearRect() { pixels = Array(40 * 40).fill(null); },
      fillRect(x, y, width, height) {
        for (let row = y; row < y + height; row++) {
          pixels.fill(this.fillStyle, row * 40 + x, row * 40 + x + width);
        }
      },
    };
    return {
      dataset: { desk: kind, actorKey: key, actorState: state }, width: 40, height: 40, isConnected: true,
      checkVisibility() { return !this.hidden; },
      getContext: () => context,
      pixels: () => pixels,
    };
  };
  const root = desks => ({
    ownerDocument: document,
    querySelectorAll: selector => selector.includes('data-desk') ? desks : [],
  });
  return {
    desk, root, document, motion, timers,
    get intersection() { return intersection; },
    get mutations() { return mutations; },
  };
}

test('actor appearance survives rerenders and differs between both agents and studios', () => {
  const { desk, root } = fixture();
  const map = desk('terminal', 'studio-a:builder');
  const list = desk('terminal', 'studio-a:builder');
  const peers = Array.from({ length: 12 }, (_, index) => desk('terminal', `studio-a:builder-${index}`));
  const otherStudio = desk('terminal', 'studio-b:builder');
  const head = canvas => canvas.pixels().slice(4 * 40, 19 * 40);
  paintRooms(root([map, list, otherStudio, ...peers]));
  assert.deepEqual(head(map), head(list));
  assert.notDeepEqual(head(map), head(otherStudio));
  const portraits = peers.map(canvas => head(canvas));
  assert.equal(new Set(portraits.map(pixels => JSON.stringify(pixels))).size, peers.length);
  assert.ok(new Set(portraits.map(pixels => pixels.map(Boolean).join(','))).size >= 5);

  const reloaded = desk('terminal', 'studio-a:builder');
  paintRooms(root([reloaded]));
  assert.deepEqual(reloaded.pixels(), map.pixels());
});

test('working agents bob slightly while the furniture and resting faces stay anchored', () => {
  const runtime = fixture();
  const { desk, document, motion, timers } = runtime;
  const active = ['terminal', 'paper', 'books', 'easel', 'plan', 'notebook'].map(kind => desk(kind, `studio:${kind}`));
  const idle = desk('terminal', 'studio:idle', 'idle');
  const waiting = desk('terminal', 'studio:waiting', 'waiting');
  const paused = desk('terminal', 'studio:paused', 'paused');
  const queued = desk('terminal', 'studio:queued', 'queued');
  const planning = desk('terminal', 'studio:terminal', 'planning');
  const review = desk('terminal', 'studio:terminal', 'review');
  const secondary = desk('terminal', 'studio:second-terminal');
  const offscreen = desk('terminal', 'studio:offscreen');
  const visible = [...active, idle, waiting, planning, review, secondary];
  const still = [paused, queued];
  const root = runtime.root([...visible, ...still, offscreen]);
  const enter = (canvases, isIntersecting = true) => canvases.map(target => ({ target, isIntersecting }));
  paintRooms(root);
  const before = visible.map(canvas => canvas.pixels());
  const stillBefore = still.map(canvas => canvas.pixels());
  const offscreenBefore = offscreen.pixels();
  runtime.intersection(enter([...visible, ...still]));
  assert.equal(timers.size, 1);
  const frames = visible.map(() => []);
  const headFrames = visible.map(() => new Set());
  for (let tick = 0; tick < 170; tick++) {
    for (const callback of timers.values()) callback();
    visible.forEach((canvas, i) => {
      const pixels = canvas.pixels();
      assert.deepEqual(pixels.slice(29 * 40), before[i].slice(29 * 40));
      const face = Array.from({length:5}, (_,row)=>pixels.slice((7+row)*40+20,(7+row)*40+30));
      headFrames[i].add(JSON.stringify(face));
      frames[i].push(JSON.stringify(pixels));
    });
  }
  frames.forEach((sequence, index) => assert.ok(new Set(sequence).size >= 3, JSON.stringify(visible[index].dataset)));
  assert.ok(headFrames[visible.indexOf(active[0])].size > 1, 'working head moves vertically');
  assert.equal(headFrames[visible.indexOf(idle)].size, 1);
  assert.notDeepEqual(frames[0].map(frame => frame === frames[0][0]), frames.at(-1).map(frame => frame === frames.at(-1)[0]));
  assert.notDeepEqual(planning.pixels().slice(0, 13 * 40), review.pixels().slice(0, 13 * 40));
  assert.equal(offscreen.pixels(), offscreenBefore);
  still.forEach((canvas, i) => assert.equal(canvas.pixels(), stillBefore[i]));

  motion.matches = true;
  motion.dispatchEvent(new Event('change'));
  assert.equal(timers.size, 0);
  visible.forEach((canvas, i) => assert.deepEqual(canvas.pixels(), before[i]));
  motion.matches = false;
  motion.dispatchEvent(new Event('change'));
  assert.equal(timers.size, 1);

  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(timers.size, 0);
  document.hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(timers.size, 1);

  visible.forEach(canvas => { canvas.hidden = true; });
  runtime.mutations([]);
  assert.equal(timers.size, 0);
  visible.forEach(canvas => { canvas.hidden = false; });
  runtime.mutations([]);
  assert.equal(timers.size, 1);

  runtime.intersection(enter(visible, false));
  assert.equal(timers.size, 0);
  const oldIntersection = runtime.intersection;
  paintRooms(root);
  oldIntersection(enter(visible));
  assert.equal(timers.size, 0);
  runtime.intersection(enter(visible));
  assert.equal(timers.size, 1);
  [...visible, offscreen].forEach(canvas => { canvas.isConnected = false; });
  runtime.mutations([]);
  assert.equal(timers.size, 0);
});
