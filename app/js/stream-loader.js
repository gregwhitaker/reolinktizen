// mpegts.js' default Chrome loader waits for another chunk before cancelling a
// buffering response. An NVR that stalls may never send that chunk. This public
// customLoader implementation always aborts the fetch and its reader immediately.
export function createStreamLoader(library, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const { BaseLoader, LoaderStatus: Status, LoaderErrors: Errors } = library;
  return class NvrStreamLoader extends BaseLoader {
    constructor(seekHandler, config) {
      super('nvr-fetch-loader');
      this.seekHandler = seekHandler;
      this.config = config;
      this._needStash = true;
      this.operation = 0;
      this.controller = null;
      this.reader = null;
    }
    static isSupported() { return Boolean(globalThis.fetch && globalThis.ReadableStream && globalThis.AbortController); }
    open(source, range) {
      this.abort();
      const operation = this.operation;
      const controller = new AbortController();
      this.controller = controller;
      this._status = Status.kConnecting;
      const target = this.seekHandler.getConfig(source.url, range);
      const headers = { ...target.headers, ...this.config.headers };
      const run = async () => {
        const response = await fetchImpl(target.url, { method: 'GET', headers, signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', mode: 'cors' });
        if (operation !== this.operation) { await response.body?.cancel(); return; }
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          this._status = Status.kError;
          this._onError?.(Errors.HTTP_STATUS_CODE_INVALID, { code: response.status, msg: 'NVR rejected the video request.' });
          return;
        }
        const reader = response.body.getReader();
        this.reader = reader;
        let received = 0;
        while (operation === this.operation) {
          const { done, value } = await reader.read();
          if (operation !== this.operation) return;
          if (done) {
            this._status = Status.kError;
            this._onError?.(Errors.EXCEPTION, { code: -1, msg: 'NVR live stream ended.' });
            return;
          }
          this._status = Status.kBuffering;
          const start = range.from + received;
          received += value.byteLength;
          const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
          this._onDataArrival?.(buffer, start, received);
        }
      };
      this.pending = run().catch(() => {
        if (controller.signal.aborted || operation !== this.operation) return;
        this._status = Status.kError;
        this._onError?.(Errors.EXCEPTION, { code: -1, msg: 'NVR stream connection failed.' });
      });
    }
    abort() {
      this.operation++;
      this.controller?.abort();
      this.controller = null;
      if (this.reader) this.reader.cancel().catch(() => {});
      this.reader = null;
      this._status = Status.kIdle;
    }
    destroy() { this.abort(); super.destroy(); }
  };
}
