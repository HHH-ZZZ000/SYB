export class HttpError extends Error {
  constructor(status) {
    super(`请求失败（${status}）`);
    this.status = status;
  }
}
export class ApiClient {
  constructor() {
    this.requests = new Set();
  }
  async fetchJson(path, options = {}, cancelOnHide = true) {
    const controller = new AbortController();
    if (cancelOnHide) this.requests.add(controller);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    // Local model loading gets a bounded allowance; other API deadlines stay unchanged.
    const timer = setTimeout(abort, path === "/api/vision/infer" ? 15000 : 4000);
    try {
      const response = await fetch(path, {
        ...options,
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        const error = new HttpError(response.status);
        // A decoder/hash failure is evidence, unlike a generic HTTP 400. Keep
        // only the existing vision endpoint's allowlisted machine error code.
        if (path === "/api/vision/infer" && response.status === 400) {
          try { if ((await response.json()).error === "image_invalid") error.code = "image_invalid"; }
          catch { /* Non-JSON errors remain ordinary interface failures. */ }
        }
        throw error;
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  abort() {
    this.requests.forEach((controller) => controller.abort());
  }
  status(device) {
    return this.fetchJson(`/api/status?device=${encodeURIComponent(device)}`);
  }
  devices() {
    return this.fetchJson("/api/devices");
  }
  history(device, afterId) {
    return this.fetchJson(
      `/api/history?device=${encodeURIComponent(device)}&limit=2000${afterId == null ? "" : `&after_id=${afterId}`}`,
    );
  }
  queryHistory(filters, signal) {
    return this.fetchJson(`/api/records?${new URLSearchParams(filters)}`, { signal });
  }
}
