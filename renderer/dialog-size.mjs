const margin = 28;

export function fitDialogSize(size, viewport) {
  const fit = (value, min, max) => Math.round(Math.min(max, Math.max(min, value)));
  return {
    width: fit(size.width, 360, Math.max(1, viewport.width - margin)),
    height: fit(size.height, 240, Math.max(1, viewport.height - margin)),
  };
}

export function installDialogSize(dialog, readPreference, savePreference) {
  const handles = dialog.querySelectorAll("[data-dialog-width], [data-dialog-resize]");
  let drag;
  let currentSize;

  function apply(size) {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const fitted = fitDialogSize({ ...size, height: size.height ?? 240 }, viewport);
    currentSize = { width: fitted.width, ...(size.height == null ? {} : {height: fitted.height}) };
    dialog.style.setProperty("--dialog-width", currentSize.width + "px");
    if (currentSize.height != null) dialog.style.setProperty("--dialog-height", currentSize.height + "px");
  }

  function configure(adjustable) {
    if (dialog.open && dialog.hasAttribute("data-adjustable") === adjustable) return;
    dialog.toggleAttribute("data-adjustable", adjustable);
    for (const handle of handles) handle.hidden = !adjustable;
    currentSize = undefined;
    dialog.style.removeProperty("--dialog-width");
    dialog.style.removeProperty("--dialog-height");
    if (!adjustable) return;
    try {
      const saved = JSON.parse(readPreference());
      if (Number.isFinite(saved?.width)) apply({width:saved.width, height:Number.isFinite(saved.height) ? saved.height : undefined});
    } catch { /* A fresh profile uses the default details size. */ }
  }

  for (const handle of handles) {
    const corner = handle.hasAttribute("data-dialog-resize");
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.focus({preventScroll:true});
      const { width, height } = dialog.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, width, height };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", event => {
      if (drag?.id !== event.pointerId) return;
      apply({
        width: drag.width + 2 * (event.clientX - drag.x),
        height: corner ? drag.height + 2 * (event.clientY - drag.y) : currentSize?.height,
      });
    });
    handle.addEventListener("lostpointercapture", () => {
      drag = undefined;
      if (currentSize) savePreference(JSON.stringify(currentSize));
    });
    handle.addEventListener("keydown", event => {
      const horizontal = ["ArrowLeft", "ArrowRight"].includes(event.key);
      if (!horizontal && !(corner && ["ArrowUp", "ArrowDown"].includes(event.key))) return;
      event.preventDefault();
      const { width, height } = dialog.getBoundingClientRect();
      const step = event.shiftKey ? 80 : 24;
      apply({
        width: width + step * ((event.key === "ArrowRight") - (event.key === "ArrowLeft")),
        height: horizontal ? currentSize?.height : height + step * ((event.key === "ArrowDown") - (event.key === "ArrowUp")),
      });
      savePreference(JSON.stringify(currentSize));
    });
  }

  return configure;
}
