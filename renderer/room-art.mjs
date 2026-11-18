const roomPalette = {
  director: { floor: '#76513c', seam: '#61432f', rug: '#744439', edge: '#a16b54' },
  library: { floor: '#674f3d', seam: '#554133', rug: '#474a63', edge: '#827f97' },
  workshop: { floor: '#705a42', seam: '#5b4a38', rug: '#466159', edge: '#76978a' },
  atelier: { floor: '#846047', seam: '#6f503e', rug: '#856548', edge: '#bba177' },
  common: { floor: '#71533e', seam: '#624432', rug: '#765843', edge: '#a7825f' },
};

const deskPalette = {
  plan: ['#a74f39', '#edc683'],
  books: ['#576585', '#e6a559'],
  paper: ['#76709b', '#f0d69b'],
  terminal: ['#3b725f', '#85dbab'],
  easel: ['#a26140', '#b4c8a6'],
  notebook: ['#826b50', '#e6b783'],
};

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

function paintDesk(canvas, working = false) {
  const kind = canvas.dataset.desk;
  const [coat, accent] = deskPalette[kind];
  paint(canvas, rect => {
    rect(7, 31, 3, 6, '#4e352a');
    rect(29, 31, 3, 6, '#4e352a');
    rect(20, 18, 11, 8, coat);
    rect(18, 20, 15, 5, coat);
    rect(23, 17, 4, 3, '#b98a6f');
    rect(20, 8, 10, 10, '#deb08e');
    rect(21, 6, 8, 2, '#483229');
    rect(20, 8, 11, 3, '#483229');
    rect(28, 11, 3, 4, '#483229');
    rect(21, 12, 1, 1, '#4f352d');
    rect(24, 12, 1, 1, '#4f352d');
    rect(4, 24, 31, 8, '#302522');
    rect(4, 24, 30, 5, '#a3714d');
    rect(4, 29, 30, 2, '#c58d5f');
    rect(27, 22, 4, 5, coat);
    rect(26, 26, 4, 2, '#deb08e');
    if (kind === 'terminal') {
      rect(5, 14, 11, 10, '#2e3833');
      rect(7, 16, 7, 5, accent);
      rect(8, 17, 4, 1, '#3b725f');
      rect(8, 19, working ? 4 : 2, 1, '#3b725f');
      rect(9, 24, 3, 3, '#4a554e');
      rect(13, 27, 8, 1, '#4a554e');
      rect(17, 22, 4, 3, coat);
      rect(working ? 15 : 17, 25, 4, 2, '#deb08e');
    } else if (kind === 'easel') {
      rect(5, 13, 11, 12, '#5a4034');
      rect(6, 13, 9, 9, '#edd4b0');
      rect(7, 17, 4, 3, accent);
      rect(12, 15, 2, working ? 4 : 3, '#b96e50');
      rect(17, 21, 4, 3, coat);
      rect(16, working ? 19 : 23, 3, 3, '#deb08e');
      rect(13, working ? 18 : 22, 5, 1, '#694735');
    } else if (kind === 'books') {
      rect(5, 22, 10, 4, '#996348');
      rect(6, 19, 8, 3, accent);
      rect(9, 23, 12, 5, '#5d4b64');
      rect(9, 22, 5, 4, '#eed7b3');
      rect(15, 22, 5, 4, '#f5e0bd');
      rect(13, 23, 1, 4, '#b99b7d');
      if (working) {
        rect(14, 20, 4, 3, '#f6e8cb');
        rect(16, 19, 3, 1, '#f6e8cb');
      }
      rect(18, working ? 20 : 26, 3, 2, '#deb08e');
    } else {
      if (kind === 'plan') rect(6, 20, 8, 2, '#80978a');
      rect(7, 23, 11, 5, accent);
      rect(8, 24, 6, 1, '#987b65');
      rect(8, 26, working ? 6 : 3, 1, '#987b65');
      rect(17, 22, 4, 3, coat);
      rect(working ? 14 : 17, 24, 4, 2, '#deb08e');
      rect(working ? 13 : 16, 26, 2, 1, '#4f352d');
    }
  });
}

const stopAnimations = new WeakMap();

function animateDesks(root, desks) {
  const document = root.ownerDocument;
  const window = document.defaultView;
  if (!desks.length || !window?.IntersectionObserver) return;

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const inViewport = new Set();
  let interval;
  let phase = 0;
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
    if (!desks.some(canvas => canvas.isConnected)) {
      stop();
      return;
    }
    if (document.hidden || motion.matches || !Array.from(inViewport).some(visible)) {
      if (interval !== undefined) {
        window.clearInterval(interval);
        interval = undefined;
        phase = 0;
        for (const canvas of desks) if (canvas.isConnected) paintDesk(canvas);
      }
    } else if (interval === undefined) {
      interval = window.setInterval(() => {
        phase = (phase + 1) % 6;
        if (phase === 5 || phase === 0) return;
        for (const canvas of inViewport) {
          if (!visible(canvas) || (phase >= 3 && canvas.dataset.desk === 'books')) continue;
          paintDesk(canvas, phase === 1 || phase === 3);
        }
      }, 680);
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
  for (const canvas of desks) intersection.observe(canvas);
}

export function paintRooms(root) {
  stopAnimations.get(root)?.();
  for (const canvas of root.querySelectorAll('canvas[data-room]')) paintRoom(canvas);
  const desks = Array.from(root.querySelectorAll('canvas[data-desk]'));
  for (const canvas of desks) paintDesk(canvas);
  animateDesks(root, desks.filter(canvas => canvas.closest('.map-pin[data-activity="good"]')));
}
