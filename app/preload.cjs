const { contextBridge, ipcRenderer } = require("electron");

function listen(channel, listener) {
  if (typeof listener !== "function") throw new TypeError("Listener must be a function");
  const handle = (_event, data) => listener(data);
  ipcRenderer.on(channel, handle);
  return () => ipcRenderer.removeListener(channel, handle);
}

contextBridge.exposeInMainWorld("hearth", {
  async request(command, payload) {
    const response = await ipcRenderer.invoke("hearth:request", command, payload);
    if (!response.ok) throw new Error(response.error);
    return response.value;
  },
  subscribe(listener) {
    return listen("hearth:snapshot", listener);
  },
  onInbox(listener) {
    return listen("hearth:open-inbox", listener);
  },
});
