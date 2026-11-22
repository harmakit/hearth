export function fitInspectorWidth(width, available) {
  const min = Math.min(260, available / 2);
  const max = Math.max(min, available - 260);
  return Math.min(max, Math.max(min, width));
}

export function installInspectorResize(layout, handle, readPreference, savePreference) {
  const available = () => Math.max(1, layout.clientWidth - handle.offsetWidth);
  const saved = readPreference();
  let preferred = saved && Number.isFinite(Number(saved)) ? Number(saved) / 100 : 0.48;
  let drag;
  const current = () => fitInspectorWidth(available() * preferred, available());

  function renderWidth() {
    if (!handle.offsetWidth) return;
    const width = current();
    layout.style.setProperty('--owner-width', width + 'px');
    for (const [key, value] of Object.entries({ min: fitInspectorWidth(0, available()),
      max: fitInspectorWidth(available(), available()), now: width })) {
      handle.setAttribute('aria-value' + key, String(Math.round(value)));
    }
  }

  function resize(width) {
    preferred = fitInspectorWidth(width, available()) / available();
    renderWidth();
    savePreference(String(preferred * 100));
  }

  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, width: current() };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (drag?.id === event.pointerId) resize(drag.width + drag.x - event.clientX);
  });
  handle.addEventListener('lostpointercapture', () => { drag = undefined; });
  handle.addEventListener('keydown', event => {
    const step = event.shiftKey ? 64 : 16;
    const widths = { ArrowLeft: current() + step, ArrowRight: current() - step, Home: 0, End: available() };
    if (!Object.hasOwn(widths, event.key)) return;
    event.preventDefault();
    resize(widths[event.key]);
  });
  const observer = new ResizeObserver(renderWidth);
  observer.observe(layout);
  observer.observe(handle);
}
