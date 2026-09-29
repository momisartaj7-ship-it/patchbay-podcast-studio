// Uploads a recording to the server in small pieces.
//
// Why pieces: on long-distance or mobile connections a single huge upload is
// likely to fail somewhere in the middle. Sent in ~8 MB pieces, a failed piece
// is just retried (with a growing pause) and the upload carries on from where
// it was instead of starting over.
(function (root) {
  const CHUNK_SIZE = 8 * 1024 * 1024;
  const CHUNK_RETRIES = 6;
  const COMPLETE_RETRIES = 4;
  const CHUNK_TIMEOUT_MS = 120000;
  const FATAL_STATUSES = [400, 404, 409, 413]; // retrying these will never help

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function request(fetchImpl, url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function withRetry(makeRequest, retries, onRetry) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await makeRequest();
        if (res.ok) return res;
        if (FATAL_STATUSES.includes(res.status)) {
          const err = new Error(`Server rejected the upload (HTTP ${res.status})`);
          err.fatal = true;
          throw err;
        }
        lastError = new Error(`HTTP ${res.status}`);
      } catch (err) {
        if (err.fatal) throw err;
        lastError = err;
      }
      if (attempt < retries) {
        if (onRetry) onRetry(attempt + 1, lastError);
        await sleep(Math.min(1000 * 2 ** attempt, 15000));
      }
    }
    throw lastError;
  }

  /**
   * @param {Blob} blob
   * @param {object} meta  sent with the final "complete" call (room, sessionId, participantId, startedAt, ext, ...)
   * @param {object} [opts] onProgress(percent), onRetry(attempt, error), baseUrl, fetchImpl, chunkSize
   */
  async function uploadRecording(blob, meta, opts = {}) {
    const fetchImpl = opts.fetchImpl || root.fetch.bind(root);
    const baseUrl = opts.baseUrl || '';
    const chunkSize = opts.chunkSize || CHUNK_SIZE;
    const uploadId = (root.crypto && root.crypto.randomUUID
      ? root.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^a-zA-Z0-9-]/g, '');

    const totalChunks = Math.ceil(blob.size / chunkSize);
    for (let i = 0; i < totalChunks; i++) {
      const piece = blob.slice(i * chunkSize, Math.min((i + 1) * chunkSize, blob.size));
      await withRetry(
        () => request(
          fetchImpl,
          `${baseUrl}/upload-chunk?uploadId=${encodeURIComponent(uploadId)}&index=${i}`,
          { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: piece },
          CHUNK_TIMEOUT_MS
        ),
        CHUNK_RETRIES,
        opts.onRetry
      );
      if (opts.onProgress) opts.onProgress(Math.round(((i + 1) / totalChunks) * 100));
    }

    // Finalizing can take a little while (the server hands the file to storage).
    await withRetry(
      () => request(
        fetchImpl,
        `${baseUrl}/upload-complete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...meta, uploadId, totalChunks }),
        },
        10 * 60 * 1000
      ),
      COMPLETE_RETRIES,
      opts.onRetry
    );
  }

  const api = { uploadRecording };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // for tests
  root.PatchbayUploader = api;
})(typeof window !== 'undefined' ? window : globalThis);
