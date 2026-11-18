const margin = 28;

export function fitDialogSize(size, viewport) {
  const fit = (value, min, max) => Math.round(Math.min(max, Math.max(min, value)));
  return {
    width: fit(size.width, 360, Math.max(1, viewport.width - margin)),
    height: fit(size.height, 240, Math.max(1, viewport.height - margin)),
  };
}

export function installDialogSize(dialog, readPreference, savePreference) {
  const expand = dialog.querySelector("[data-dialog-expand]");
  const grip = dialog.querySelector("[data-dialog-resize]");
  let drag;
  let currentSize;

  function apply(size) {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    currentSize = fitDialogSize(size, viewport);
    dialog.style.setProperty("--dialog-width", currentSize.width + "px");
    dialog.style.setProperty("--dialog-height", currentSize.height + "px");
  }

  function expanded(value) {
    dialog.toggleAttribute("data-expanded", value);
    expand.setAttribute("aria-pressed", String(value));
    expand.setAttribute("aria-label", value ? "Вернуть размер окна" : "Развернуть окно");
    expand.title = value ? "Вернуть размер окна" : "Развернуть окно";
    expand.textContent = value ? "↙" : "⛶";
    grip.hidden = value || !dialog.hasAttribute("data-adjustable");
  }

  function configure(adjustable) {
    if (dialog.open && dialog.hasAttribute("data-adjustable") === adjustable) return;
    dialog.toggleAttribute("data-adjustable", adjustable);
    expand.hidden = !adjustable;
    expanded(false);
    currentSize = undefined;
    dialog.style.removeProperty("--dialog-width");
    dialog.style.removeProperty("--dialog-height");
    if (!adjustable) return;
    try {
      const saved = JSON.parse(readPreference());
      if (Number.isFinite(saved?.width) && Number.isFinite(saved?.height)) apply(saved);
    } catch { /* A fresh profile uses the default details size. */ }
  }

  expand.addEventListener("click", () => expanded(!dialog.hasAttribute("data-expanded")));
  grip.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    const { width, height } = dialog.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, width, height };
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener("pointermove", event => {
    if (drag?.id !== event.pointerId) return;
    apply({
      width: drag.width + 2 * (event.clientX - drag.x),
      height: drag.height + 2 * (event.clientY - drag.y),
    });
  });
  grip.addEventListener("lostpointercapture", () => {
    drag = undefined;
    if (currentSize) savePreference(JSON.stringify(currentSize));
  });
  grip.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const { width, height } = dialog.getBoundingClientRect();
    const step = event.shiftKey ? 80 : 24;
    apply({
      width: width + step * ((event.key === "ArrowRight") - (event.key === "ArrowLeft")),
      height: height + step * ((event.key === "ArrowDown") - (event.key === "ArrowUp")),
    });
    savePreference(JSON.stringify(currentSize));
  });

  return configure;
}
