import assert from 'node:assert/strict';
import test from 'node:test';
import { paintRooms } from '../renderer/room-art.mjs';

test('working desks animate props and hands while keeping the furniture and person anchored', () => {
  const timers = new Map();
  const document = new EventTarget();
  const motion = new EventTarget();
  let intersection;
  let mutations;
  document.defaultView = {
    matchMedia: () => motion,
    IntersectionObserver: class {
      constructor(callback) { intersection = callback; }
      observe() {}
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
  const desk = (kind, working = true) => {
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
      dataset: { desk: kind }, width: 40, height: 40, isConnected: true,
      closest: () => working,
      checkVisibility() { return !this.hidden; },
      getContext: () => context,
      pixels: () => pixels,
    };
  };
  const active = ['terminal', 'paper', 'books', 'easel', 'plan', 'notebook'].map(kind => desk(kind));
  const idle = desk('terminal', false);
  const root = { ownerDocument: document, querySelectorAll: selector => selector.includes('data-desk') ? [...active, idle] : [] };
  paintRooms(root);
  const before = active.map(canvas => canvas.pixels());
  const idleBefore = idle.pixels();
  intersection(active.map(target => ({ target, isIntersecting: true })));
  assert.equal(timers.size, 1);
  for (const tick of timers.values()) tick();
  active.forEach((canvas, i) => {
    const changed = canvas.pixels().flatMap((color, index) => color === before[i][index] ? [] : [index]);
    assert.ok(changed.length > 0, canvas.dataset.desk);
    assert.ok(changed.every(index => index % 40 < 21 && index >= 13 * 40 && index < 28 * 40), canvas.dataset.desk);
  });
  assert.equal(idle.pixels(), idleBefore);

  motion.matches = true;
  motion.dispatchEvent(new Event('change'));
  assert.equal(timers.size, 0);
  active.forEach((canvas, i) => assert.deepEqual(canvas.pixels(), before[i]));
  motion.matches = false;
  motion.dispatchEvent(new Event('change'));
  assert.equal(timers.size, 1);

  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(timers.size, 0);
  document.hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(timers.size, 1);

  active.forEach(canvas => { canvas.hidden = true; });
  mutations([]);
  assert.equal(timers.size, 0);
  active.forEach(canvas => { canvas.hidden = false; });
  mutations([]);
  assert.equal(timers.size, 1);

  intersection(active.map(target => ({ target, isIntersecting: false })));
  assert.equal(timers.size, 0);
  const oldIntersection = intersection;
  paintRooms(root);
  oldIntersection(active.map(target => ({ target, isIntersecting: true })));
  assert.equal(timers.size, 0);
  intersection(active.map(target => ({ target, isIntersecting: true })));
  assert.equal(timers.size, 1);
  active.forEach(canvas => { canvas.isConnected = false; });
  mutations([]);
  assert.equal(timers.size, 0);
});
