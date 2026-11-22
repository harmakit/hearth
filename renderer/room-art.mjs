const roomPalette = {
  director: { floor: '#76513c', seam: '#61432f', rug: '#744439', edge: '#a16b54' },
  library: { floor: '#674f3d', seam: '#554133', rug: '#474a63', edge: '#827f97' },
  workshop: { floor: '#705a42', seam: '#5b4a38', rug: '#466159', edge: '#76978a' },
  atelier: { floor: '#846047', seam: '#6f503e', rug: '#856548', edge: '#bba177' },
  common: { floor: '#71533e', seam: '#624432', rug: '#765843', edge: '#a7825f' },
};

const deskPalette = {
  plan: '#edc683',
  books: '#e6a559',
  paper: '#f0d69b',
  terminal: '#85dbab',
  easel: '#b4c8a6',
  notebook: '#e6b783',
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

function furniture(rect, room) {
  const cabinet = (x, width, shades) => {
    rect(x + 2, 14, width, 30, '#3f2d25');
    rect(x, 11, width, 29, '#8a573e');
    rect(x + 3, 14, width - 6, 21, '#503426');
    shades.forEach((color, i) => rect(x + 6 + i * 6, 19 - (i % 2) * 3, 4, 14 + (i % 2) * 3, color));
    rect(x, 34, width, 3, '#b48355');
  };
  const plant = (x, y) => {
    rect(x + 2, y + 12, 10, 8, '#9e6749');
    rect(x + 1, y + 10, 12, 3, '#bc825b');
    rect(x + 6, y + 3, 3, 9, '#405b44');
    rect(x + 2, y + 3, 5, 5, '#6b8b52');
    rect(x + 8, y, 6, 5, '#85a267');
  };
  const picture = (x, body) => {
    rect(x, 6, 30, 19, '#39291f');
    rect(x + 2, 8, 26, 15, '#bc926b');
    rect(x + 4, 10, 22, 11, body);
    rect(x + 6, 16, 17, 3, '#856d54');
    rect(x + 15, 11, 5, 4, '#e3bc81');
  };
  if (room === 'library') {
    cabinet(16, 54, ['#ac6652', '#806e51', '#6b8069', '#a58456', '#747894', '#93624c', '#9c815e']);
    cabinet(129, 52, ['#6c8290', '#a67555', '#8a6a8b', '#9b9b6f', '#a86850', '#b29261', '#718368']);
  } else if (room === 'workshop') {
    rect(12, 13, 55, 23, '#3b302b');
    rect(14, 15, 51, 19, '#a18b68');
    rect(19, 18, 3, 13, '#53645c');
    rect(25, 19, 10, 3, '#727d76');
    rect(41, 17, 3, 14, '#86533d');
    rect(50, 19, 9, 8, '#53645c');
    cabinet(142, 35, ['#b08657', '#82988d', '#536554', '#ad774f']);
  } else if (room === 'atelier') {
    picture(18, '#5c6b65');
    picture(68, '#9a6460');
    picture(141, '#57617b');
  } else {
    picture(30, room === 'director' ? '#6b795e' : '#7c656b');
    cabinet(139, 42, ['#ac6652', '#806e51', '#6b8069', '#a58456', '#747894']);
  }
  plant(room === 'library' ? 93 : 177, 30);
}

function paintRoom(canvas) {
  const room = canvas.dataset.room;
  const palette = roomPalette[room];
  paint(canvas, rect => {
    rect(0, 0, 200, 126, palette.floor);
    for (let y = 39; y < 126; y += 11) {
      rect(0, y, 200, 1, palette.seam);
      for (let x = y % 3 * 10; x < 200; x += 35) rect(x, y, 1, 10, palette.seam);
    }
    rect(0, 0, 200, 35, '#584131');
    rect(0, 0, 200, 5, '#3b2b23');
    rect(0, 32, 200, 3, '#3d2c21');
    rect(0, 35, 200, 2, '#9a6f51');
    rect(17, 52, 166, 66, '#3a3027');
    rect(20, 53, 160, 62, palette.edge);
    rect(24, 57, 152, 54, palette.rug);
    for (let x = 27; x < 175; x += 6) {
      rect(x, 54, 2, 1, '#d7a67a');
      rect(x, 113, 2, 1, '#d7a67a');
    }
    furniture(rect, room);
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
    rect(4, 13, 12, 11, '#26342e');
    rect(6, 15, 8, 7, '#415d50');
    rect(7, 16, 5, 1, accent);
    rect(7, 18, 3 + frame % 3, 1, accent);
    rect(8 + frame, 20, 1, 1, '#d9ebc2');
    rect(9, 24, 3, 2, '#4a554e');
    rect(13, 26, 10, 2, '#403839');
    rect(14, 26, 8, 1, '#b39b88');
  } else if (kind === 'easel') {
    rect(5, 12, 11, 13, '#594034');
    rect(6, 12, 9, 10, '#edd4b0');
    rect(7, 17, 4, 3, accent);
    rect(12, 14, 2, 3 + frame, '#b96e50');
    rect(8, 24, 6, 2, '#866146');
  } else if (kind === 'books') {
    rect(5, 22, 9, 4, '#996348');
    rect(6, 19, 8, 3, accent);
    rect(9, 23, 12, 5, '#5d4b64');
    rect(9, 22, 5, 4, '#eed7b3');
    rect(15, 22, 5, 4, '#f5e0bd');
    rect(14, 23, 1, 4, '#b99b7d');
    if (frame) rect(14, 22 - frame, 5 - frame, frame, '#fff1d5');
  } else {
    if (kind === 'plan') rect(6, 20, 8, 2, '#80978a');
    rect(7, 23, 13, 5, accent);
    rect(8, 24, 6, 1, '#987b65');
    rect(8, 26, 3 + frame, 1, '#987b65');
  }
}

function thought(rect, actor, action, frame) {
  const paper = frame === 2 ? '#fff1bb' : '#e6cfab';
  rect(7, 3, 8, 1, '#5c4736');
  rect(5, 4, 12, 8, '#5c4736');
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
    rect(10, 5, 2, 1, '#8a5b31');
    rect(9, 6, 4, 2, frame === 1 ? '#e69e45' : '#b77637');
    rect(10, 8, 2, 1, '#8a5b31');
    rect(10, 10, 2, 1, '#8a5b31');
    if (frame === 2) rect(14, 6, 1, 1, '#a27549');
  } else {
    for (let i = 0; i <= frame; i++) rect(8 + i * 3, 8, 1, 1, '#8a5b31');
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
    rect(7, 31, 3, 6, '#4e352a');
    rect(29, 31, 3, 6, '#4e352a');
    portrait((x, y, w, h, color) => rect(x, y - lift, w, h, color), actor);
    rect(4, 24, 31, 8, '#302522');
    rect(4, 24, 30, 5, '#a3714d');
    rect(4, 29, 30, 2, '#c58d5f');
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
      rect(leftX - 3, toolY, 4, 1, '#543b35');
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
