const roomPalette = {
  director: { accent: '#cfed9e', dim: '#718761', inset: '#252e29' },
  library: { accent: '#a7d0ff', dim: '#6987a5', inset: '#242d38' },
  workshop: { accent: '#91d8c8', dim: '#578b85', inset: '#212e31' },
  atelier: { accent: '#c8b7ea', dim: '#8677a5', inset: '#2a2936' },
  common: { accent: '#b9c5d4', dim: '#778594', inset: '#282e36' },
};

const deskPalette = {
  plan: '#cfed9e',
  books: '#a7d0ff',
  paper: '#d9e2ec',
  terminal: '#91d8c8',
  easel: '#c8b7ea',
  notebook: '#bdc9d7',
};

const skins = [
  ['#f4c399', '#d29375'], ['#e4a77b', '#bd7657'], ['#ce8c61', '#a6654e'],
  ['#ab6850', '#894a3d'], ['#905740', '#6d3c34'], ['#f1cabc', '#c98c87'],
];
const hairs = ['#3b292b', '#673629', '#884a30', '#d59a53', '#76647b', '#c1a992'];
const clothes = [
  ['#467c83', '#95d3c8'], ['#935556', '#e7a295'], ['#617851', '#b3d189'],
  ['#675881', '#bca8df'], ['#4a6390', '#a3bbeb'], ['#9c6938', '#ecc07a'],
];
const hairstyles = [
  [[1, 0, 8, 2], [0, 2, 10, 3], [8, 5, 2, 2]],
  [[1, 0, 8, 2], [0, 2, 11, 4], [0, 6, 2, 7], [8, 6, 3, 9]],
  [[-1, 1, 4, 4], [2, 0, 6, 5], [8, 1, 4, 4], [0, 5, 2, 4], [9, 5, 3, 5]],
  [[1, 1, 8, 5], [5, -2, 5, 4], [8, 5, 2, 4]],
  [[2, 0, 6, 2], [0, 2, 10, 2], [0, 4, 1, 3]],
  [[1, 0, 10, 4], [0, 3, 11, 3], [0, 6, 2, 3], [8, 6, 4, 3], [10, 9, 3, 4]],
  [[3, -1, 6, 4], [1, 0, 8, 4], [0, 3, 10, 3], [0, 6, 2, 3], [8, 6, 2, 2]],
];

function actorProfile(key) {
  let seed = 2166136261;
  for (const letter of key) seed = Math.imul(seed ^ letter.codePointAt(0), 16777619);
  // Mix again so that consecutive keys vary across the full palette.
  seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
  seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
  seed = (seed ^ (seed >>> 16)) >>> 0;
  return {
    seed,
    skin: skins[seed % skins.length],
    hair: hairs[(seed >>> 4) % hairs.length],
    hairstyle: hairstyles[(seed >>> 8) % hairstyles.length],
    clothing: clothes[(seed >>> 12) % clothes.length],
    fit: (seed >>> 16) % 3,
    accessory: (seed >>> 19) % 5,
  };
}

function paint(canvas, scene) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  scene((x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  });
}

function furniture(rect, room, { accent, dim, inset }) {
  const frame = (x, y, width, height) => {
    rect(x + 2, y + 2, width, height, '#12161c');
    rect(x, y, width, height, '#484f59');
    rect(x + 1, y + 1, width - 2, height - 2, '#181e26');
  };
  const shelves = (x, width) => {
    frame(x, 8, width, 27);
    for (let i = 0; i < Math.floor((width - 6) / 6); i++) {
      const height = 7 + (i * 5) % 11;
      rect(x + 4 + i * 6, 29 - height, 4, height, [dim, '#687383', '#536657', '#8b809e'][i % 4]);
      rect(x + 4 + i * 6, 30 - height, 4, 1, '#a8b4bf');
    }
    rect(x + 2, 29, width - 4, 2, '#687483');
  };
  const light = (x) => {
    rect(x, 7, 4, 24, '#161b22');
    rect(x + 1, 9, 1, 12, accent);
    rect(x + 1, 23, 1, 3, dim);
  };
  const picture = (x, body, variant) => {
    frame(x, 8, 27, 24);
    rect(x + 4, 12, 19, 16, body);
    rect(x + 7 + variant * 3, 14, 5, 5, accent);
    rect(x + 5, 23, 9 + variant * 3, 3, '#313a47');
    rect(x + 13, 21, 8, 2, '#a5a8bc');
  };
  if (room === 'library') {
    shelves(19, 62);
    shelves(119, 62);
    light(98);
  } else if (room === 'workshop') {
    frame(23, 8, 85, 26);
    for (let y = 12; y < 30; y += 4) {
      for (let x = 27; x < 104; x += 4) rect(x, y, 1, 1, '#414c59');
    }
    rect(35, 15, 3, 13, '#9daebc');
    rect(43, 17, 16, 2, dim);
    rect(69, 13, 11, 10, inset);
    rect(70, 16, 8, 2, accent);
    shelves(135, 43);
    light(119);
  } else if (room === 'atelier') {
    picture(31, '#536070', 0);
    picture(87, '#626385', 1);
    picture(143, '#4d6a67', 2);
  } else if (room === 'director') {
    frame(48, 8, 104, 26);
    rect(51, 11, 98, 20, inset);
    for (let column = 0; column < 3; column++) {
      const x = 56 + column * 30;
      rect(x, 14, 22, 2, column ? dim : accent);
      rect(x, 19, 22, 3, '#454f5b');
      rect(x, 25, 14 + column * 3, 3, '#454f5b');
    }
    light(27);
    light(169);
  } else {
    picture(37, '#4f6460', 1);
    shelves(108, 51);
    light(83);
  }
}

function paintRoom(canvas) {
  const room = canvas.dataset.room;
  const palette = roomPalette[room] ?? roomPalette.common;
  paint(canvas, rect => {
    rect(0, 0, 200, 126, '#20262e');
    for (let y = 48; y < 126; y += 13) {
      rect(0, y, 200, 1, '#2e3640');
      for (let x = 12 + (y % 2) * 10; x < 200; x += 22) rect(x, y, 1, 13, '#2b333d');
    }
    rect(0, 0, 200, 41, '#292f38');
    rect(0, 0, 200, 3, '#232832');
    for (const x of [11, 95, 189]) rect(x, 3, 1, 37, '#353d48');
    rect(0, 38, 200, 1, palette.dim);
    rect(0, 40, 200, 3, '#181d24');
    rect(17, 51, 166, 64, '#3a424e');
    rect(18, 52, 164, 62, palette.inset);
    rect(21, 55, 158, 56, '#252c35');
    for (let y = 61; y < 111; y += 8) {
      for (let x = 26; x < 179; x += 8) rect(x, y, 1, 1, '#343c47');
    }
    for (const x of [18, 174]) {
      rect(x, 52, 8, 1, palette.dim);
      rect(x, 113, 8, 1, palette.dim);
    }
    furniture(rect, room, palette);
  });
}

function portrait(rect, actor) {
  const { skin: [skin, shadow], hair, hairstyle, clothing: [coat, trim], fit, accessory } = actor;
  rect(20 - fit, 19, 11 + fit * 2, 7, coat);
  rect(18 - fit, 22, 15 + fit * 2, 4, coat);
  rect(23, 17, 4, 3, shadow);
  rect(24, 20, 2, 1, trim);
  if (fit === 1) rect(24, 21, 2, 3, trim);
  if (fit === 2) rect(27, 22, 4, 2, trim);

  rect(21, 8, 9, 10, shadow);
  rect(20, 10, 9, 7, skin);
  rect(21, 9, 7, 8, skin);
  for (const [x, y, width, height] of hairstyle) rect(20 + x, 6 + y, width, height, hair);
  rect(21, 12, 1, 1, '#3a2930');
  rect(25, 12, 1, 1, '#3a2930');
  rect(22, 15, 2, 1, shadow);

  if (accessory === 1) {
    rect(20, 11, 8, 1, '#3a2930');
    rect(20, 13, 3, 1, '#3a2930');
    rect(24, 13, 3, 1, '#3a2930');
    rect(27, 12, 2, 1, '#3a2930');
  } else if (accessory === 2) {
    rect(28, 14, 2, 2, '#f0c671');
  } else if (accessory === 3) {
    rect(21, 16, 6, 2, hair);
    rect(22, 14, 4, 1, hair);
  } else if (accessory === 4) {
    rect(20, 8, 10, 2, trim);
    rect(27, 7, 2, 1, trim);
  }
}

function deskProps(rect, kind, frame, accent) {
  if (kind === 'terminal') {
    rect(4, 13, 12, 11, '#68798a');
    rect(5, 14, 10, 9, '#17232e');
    rect(7, 16, 5, 1, accent);
    rect(7, 18, 3 + frame % 3, 1, accent);
    rect(8 + frame, 20, 1, 1, '#e1f0fa');
    rect(9, 24, 3, 2, '#728495');
    rect(13, 26, 10, 2, '#222831');
    rect(14, 26, 8, 1, '#a7b6c3');
  } else if (kind === 'easel') {
    rect(5, 12, 11, 13, '#3c4451');
    rect(6, 12, 9, 10, '#dae2ee');
    rect(7, 17, 4, 3, accent);
    rect(12, 14, 2, 3 + frame, '#6579a5');
    rect(8, 24, 6, 2, '#788795');
  } else if (kind === 'books') {
    rect(5, 22, 9, 4, '#596d84');
    rect(6, 19, 8, 3, accent);
    rect(9, 23, 12, 5, '#444d66');
    rect(9, 22, 5, 4, '#d7e0ec');
    rect(15, 22, 5, 4, '#ecf0f3');
    rect(14, 23, 1, 4, '#8190a4');
    if (frame) rect(14, 22 - frame, 5 - frame, frame, '#f3f7fc');
  } else {
    if (kind === 'plan') rect(6, 20, 8, 2, '#80988d');
    rect(7, 23, 13, 5, accent);
    rect(8, 24, 6, 1, '#617384');
    rect(8, 26, 3 + frame, 1, '#617384');
  }
}

function thought(rect, actor, action, frame) {
  const paper = frame === 2 ? '#e3f1cb' : '#cbd6e2';
  rect(7, 3, 8, 1, '#3e4755');
  rect(5, 4, 12, 8, '#3e4755');
  rect(7, 4, 8, 8, paper);
  rect(6, 5, 10, 6, paper);
  rect(15, 12, 2, 1, paper);
  rect(18, 14, 1, 1, paper);
  if (action === 'review') {
    rect(9, 8, 2, 1, '#4e6855');
    rect(10, 9, 1, 1, '#4e6855');
    rect(11, 8, 1, 1, '#4e6855');
    rect(12, 7, 1, 1, '#4e6855');
    rect(13, 6, 1, 1, '#4e6855');
  } else if (actor.seed % 2) {
    rect(10, 5, 2, 1, '#55697c');
    rect(9, 6, 4, 2, frame === 1 ? '#8ea85d' : '#627d47');
    rect(10, 8, 2, 1, '#55697c');
    rect(10, 10, 2, 1, '#55697c');
    if (frame === 2) rect(14, 6, 1, 1, '#6b8551');
  } else {
    for (let i = 0; i <= frame; i++) rect(8 + i * 3, 8, 1, 1, '#55697c');
  }
}

const handPositions = {
  terminal: [[18, 25], [14, 26], [17, 24], [19, 26]],
  books: [[18, 26], [18, 22], [15, 20], [16, 24]],
  easel: [[17, 23], [16, 19], [16, 16], [16, 21]],
  writing: [[18, 25], [14, 24], [16, 25], [17, 26]],
};

function paintDesk(canvas, actor, action, frame, lift) {
  const kind = canvas.dataset.desk;
  const accent = deskPalette[kind] ?? deskPalette.notebook;
  const [coat, trim] = actor.clothing;
  const [skin, shadow] = actor.skin;
  const workFrame = action === 'working' ? frame : 0;
  paint(canvas, rect => {
    rect(3, 36, 34, 2, '#151a20');
    rect(6, 31, 3, 6, '#5e6a77');
    rect(29, 31, 3, 6, '#5e6a77');
    rect(9, 32, 20, 2, '#272e36');
    portrait((x, y, w, h, color) => rect(x, y - lift, w, h, color), actor);
    rect(3, 24, 33, 8, '#21272f');
    rect(4, 24, 31, 5, '#535f6b');
    rect(4, 28, 31, 1, '#8491a1');
    rect(5, 30, 10, 1, accent);
    rect(27, 30, 6, 1, '#535f6b');
    deskProps(rect, kind, workFrame, accent);

    const [leftX, leftY] = (handPositions[kind] ?? handPositions.writing)[workFrame];
    rect(18, 22, 4, 3, coat);
    rect(27, 22, 4, 4, coat);
    if (workFrame && leftX < 18) {
      rect(leftX + 2, Math.min(leftY, 24), 2, Math.abs(leftY - 24) + 2, coat);
      rect(leftX + 3, 23, 19 - leftX, 2, coat);
    }
    rect(leftX, leftY, 3, 2, skin);
    if (kind === 'terminal' && workFrame) {
      rect(21, 23, 6, 2, coat);
      rect(workFrame === 2 ? 20 : 22, workFrame === 2 ? 26 : 25, 3, 2, skin);
    } else if (kind === 'easel' || !handPositions[kind]) {
      const toolY = kind === 'easel' ? leftY - 1 : leftY + 1;
      rect(leftX - 3, toolY, 4, 1, '#293542');
    }

    if (action === 'planning' || action === 'review') {
      thought(rect, actor, action, frame);
      rect(27, 18 + frame % 2, 3, 5, coat);
      rect(26, 16 + frame % 2, 3, 2, skin);
    } else if (action === 'break') {
      if (actor.seed % 2) {
        const cupX = [33, 34, 30][frame];
        const cupY = [23, 18, 15][frame];
        if (frame) {
          rect(cupX, cupY + 2, 2, 25 - cupY, coat);
          rect(cupX - 2, cupY + 1, 3, 2, skin);
        } else {
          rect(29, 25, 3, 2, skin);
        }
        rect(cupX, cupY, 3, 3, trim);
        rect(cupX + 3, cupY, 1, 2, trim);
        if (frame === 1) rect(cupX, cupY - 2, 2, 1, '#eedcc2');
      } else if (frame) {
        rect(30, 17 - frame * 2, 3, 7 + frame * 2, coat);
        rect(31, 15 - frame * 2, 3, 3, skin);
        rect(29, 15 - frame * 2, 2, 1, shadow);
      } else {
        rect(27, 25, 3, 2, skin);
      }
    } else if (kind !== 'terminal' || !workFrame) {
      rect(27, 25, 3, 2, skin);
    }
  });
}

function actionFor({ desk, actorState }) {
  if (actorState === 'working') return desk === 'plan' ? 'planning' : 'working';
  if (actorState === 'planning' || actorState === 'review') return actorState;
  return actorState === 'idle' || actorState === 'waiting' ? 'break' : 'still';
}

const actionFrames = {
  terminal: [0, 1, 2, 3, 1, 3, 2, 1, 0, 0],
  books: [0, 0, 0, 1, 2, 3, 0, 0, 0],
  easel: [0, 1, 2, 3, 2, 1, 0, 0],
  writing: [0, 1, 2, 3, 1, 2, 3, 0, 0],
  planning: [0, 0, 1, 1, 2, 2, 1, 0],
  review: [0, 0, 1, 1, 2, 2, 1, 0],
};

function actorFrame(actor, kind, action, elapsed) {
  const speed = (actor.seed >>> 24) % 4;
  if (action === 'break') {
    const pause = 7300 + speed * 1300;
    const step = (elapsed + actor.seed % pause) % pause;
    return step < 300 || (step >= 750 && step < 1050) ? 1 : (step < 750 ? 2 : 0);
  }
  const frames = action === 'working' ? (actionFrames[kind] ?? actionFrames.writing) : actionFrames[action];
  const duration = (kind === 'terminal' && action === 'working' ? 100 : 230) + speed * 28;
  return frames[(Math.floor(elapsed / duration) + actor.seed % frames.length) % frames.length];
}

const stopAnimations = new WeakMap();

function animateDesks(root, desks) {
  const document = root.ownerDocument;
  const window = document.defaultView;
  if (!desks.length || !window?.IntersectionObserver) return;

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const inViewport = new Set();
  let interval;
  let elapsed = 0;
  let stopped = false;
  const visible = canvas => canvas.isConnected &&
    (canvas.checkVisibility?.({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true }) ?? true);

  const stop = () => {
    stopped = true;
    window.clearInterval(interval);
    interval = undefined;
    intersection.disconnect();
    mutations.disconnect();
    document.removeEventListener('visibilitychange', update);
    motion.removeEventListener('change', update);
    stopAnimations.delete(root);
  };

  const update = () => {
    if (stopped) return;
    if (!desks.some(({ canvas }) => canvas.isConnected)) {
      stop();
      return;
    }
    if (document.hidden || motion.matches || !Array.from(inViewport).some(visible)) {
      if (interval !== undefined) {
        window.clearInterval(interval);
        interval = undefined;
        elapsed = 0;
      }
      for (const desk of desks) drawFrame(desk, 0);
    } else if (interval === undefined) {
      interval = window.setInterval(() => {
        elapsed += 100;
        for (const desk of desks) {
          const { canvas, actor, action } = desk;
          if (inViewport.has(canvas) && visible(canvas)) {
            const lift = action !== 'break' && (elapsed + actor.seed % 1600) % 1600 < 700 ? 1 : 0;
            drawFrame(desk, actorFrame(actor, canvas.dataset.desk, action, elapsed), lift);
          }
        }
      }, 100);
    }
  };

  const intersection = new window.IntersectionObserver(entries => {
    for (const { target, isIntersecting } of entries) {
      if (isIntersecting) inViewport.add(target);
      else inViewport.delete(target);
    }
    update();
  });
  const mutations = new window.MutationObserver(update);
  stopAnimations.set(root, stop);
  document.addEventListener('visibilitychange', update);
  motion.addEventListener('change', update);
  mutations.observe(document, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['hidden', 'class', 'style'],
  });
  for (const { canvas } of desks) intersection.observe(canvas);
}

function drawFrame(desk, frame, lift = 0) {
  if ((desk.frame === frame && desk.lift === lift) || !desk.canvas.isConnected) return;
  paintDesk(desk.canvas, desk.actor, desk.action, frame, lift);
  desk.frame = frame;
  desk.lift = lift;
}

export function paintRooms(root) {
  stopAnimations.get(root)?.();
  for (const canvas of root.querySelectorAll('canvas[data-room]')) paintRoom(canvas);
  const desks = Array.from(root.querySelectorAll('canvas[data-desk]'), canvas => ({
    canvas,
    actor: actorProfile(canvas.dataset.actorKey ?? canvas.dataset.desk),
    action: actionFor(canvas.dataset),
  }));
  for (const desk of desks) drawFrame(desk, 0);
  animateDesks(root, desks.filter(({ action }) => action !== 'still'));
}
