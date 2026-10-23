// Some firmware accepts a token HTTP request but never sends video. Try the
// other sign-in method after one quiet second without discarding the original
// connection. The first valid FLV header wins; only that stream reaches MSE.
export function openStartupStream(url, options, { fetchImpl, alternate, onSelect, delay = 1000, timeout = 8000 }) {
  const signal = options.signal;
  const cancelled = () => new DOMException('Video cancelled.', 'AbortError');
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const candidates = new Set();
    let settled = false, alternateStarted = false, pending = 0;
    let hedgeTimer, deadline;
    const clearTimers = () => { clearTimeout(hedgeTimer); clearTimeout(deadline); };
    const release = () => { clearTimers(); signal?.removeEventListener('abort', abort); };
    const cancel = candidate => {
      candidate.controller.abort();
      try { (candidate.reader ? candidate.reader.cancel() : candidate.response?.body?.cancel())?.catch(() => {}); }
      catch (_) { /* The fetch may already have closed its body. */ }
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      release();
      for (const candidate of candidates) cancel(candidate);
      reject(error);
    };
    function abort() {
      if (!settled) fail(cancelled());
      else { release(); for (const candidate of candidates) cancel(candidate); }
    }
    signal?.addEventListener('abort', abort, { once: true });

    async function start(useAlternate) {
      if (settled || (useAlternate && alternateStarted)) return;
      if (useAlternate) { alternateStarted = true; clearTimeout(hedgeTimer); }
      const candidate = { controller: new AbortController(), reader: null, response: null };
      candidates.add(candidate);
      pending++;
      try {
        const target = useAlternate ? await alternate() : url;
        if (settled) return;
        const response = candidate.response = await fetchImpl(target, { ...options, signal: candidate.controller.signal });
        if (settled) { cancel(candidate); return; }
        if (!response.ok || !response.body) throw new Error('NVR rejected the video request.');
        const reader = candidate.reader = response.body.getReader();
        const chunks = [], header = new Uint8Array(9);
        let length = 0;
        while (length < header.length) {
          const { done, value } = await reader.read();
          if (settled) { cancel(candidate); return; }
          if (done) throw new Error('NVR video ended before its header.');
          if (!value.byteLength) continue;
          chunks.push(value);
          const count = Math.min(value.byteLength, header.length - length);
          header.set(value.subarray(0, count), length);
          length += count;
        }
        if (header[0] !== 0x46 || header[1] !== 0x4c || header[2] !== 0x56 || header[3] !== 1 ||
            new DataView(header.buffer).getUint32(5) < 9) throw new Error('NVR did not return a video stream.');
        settled = true;
        clearTimers();
        for (const other of candidates) if (other !== candidate) cancel(other);
        onSelect?.(useAlternate);
        let index = 0;
        const body = new ReadableStream({
          async pull(controller) {
            try {
              if (index < chunks.length) { controller.enqueue(chunks[index]); chunks[index++] = null; return; }
              const { done, value } = await reader.read();
              if (done) { release(); controller.close(); }
              else controller.enqueue(value);
            } catch (error) { release(); cancel(candidate); controller.error(error); }
          },
          cancel() { release(); cancel(candidate); }
        }, { highWaterMark: 0 });
        resolve(new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }));
      } catch (_) {
        cancel(candidate);
        pending--;
        if (settled) return;
        if (!alternateStarted) start(true);
        else if (pending === 0) fail(new Error('Unable to open an NVR video stream.'));
      }
    }
    hedgeTimer = setTimeout(() => start(true), delay);
    deadline = setTimeout(() => fail(new Error('NVR video startup timed out.')), timeout);
    start(false);
  });
}
