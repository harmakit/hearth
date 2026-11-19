function createLaunchRequests({ isShuttingDown, openWindow, relaunch }) {
  let relaunchScheduled = false;

  function scheduleRelaunch() {
    if (relaunchScheduled) return;
    relaunch();
    relaunchScheduled = true;
  }

  async function open() {
    if (isShuttingDown()) {
      scheduleRelaunch();
      return;
    }
    return openWindow();
  }

  return { open, relaunch: scheduleRelaunch };
}

module.exports = { createLaunchRequests };
