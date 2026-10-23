/* Classic worker: Samsung's generated socket runtime uses importScripts. */
let controller = null;
self.onmessage = async event => {
  if (event.data?.type === 'cancel') { controller?.abort(); return; }
  if (event.data?.type !== 'scan' || controller) return;
  controller = new AbortController();
  let module;
  try {
    importScripts('../vendor/discovery/tizen-discovery.js');
    const { scanTvSockets } = await import('./discovery-tv-scan.js');
    module = await self.createTizenDiscovery({
      locateFile: file => new URL(`../vendor/discovery/${file}`, self.location.href).href,
      print: () => {}, printErr: () => {}
    });
    const devices = await scanTvSockets(module, { id: event.data.id, signal: controller.signal });
    self.postMessage({ type: 'result', devices });
  } catch (_) {
    self.postMessage(controller.signal.aborted ? { type: 'cancelled' } : {
      type: 'error', message: 'Could not search this TV’s network. Check its connection, or enter the NVR IP address.'
    });
  } finally {
    try { module?._discovery_close(); } catch (_) {}
    self.close();
  }
};
