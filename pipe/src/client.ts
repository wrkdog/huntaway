/** Bounded local JSON client. It has no dependency on the pipe server. */
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One bounded client call. A redirect is an error so the token never travels to its destination. */
export async function requestJson(base: string, token: string, method: string, path: string, data?: unknown, signal?: AbortSignal): Promise<unknown> {
  const target = new URL(path, `${base.replace(/\/$/, '')}/`);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('PIPE_URL must use local HTTP on 127.0.0.1');
  const response = await fetch(target, { method, redirect: 'manual', signal, headers: { authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'content-type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  if (response.status >= 300 && response.status < 400) throw new Error('redirect refused');
  const text = await response.text();
  if (Buffer.byteLength(text) > RESPONSE_LIMIT) throw new Error('response exceeds 8 MiB');
  const value: unknown = JSON.parse(text);
  if (!response.ok) throw new Error(object(value) && object(value.error) ? String(value.error.message) : `HTTP ${response.status}`);
  return value;
}

/** Retry only transport failures. A service HTTP answer, including an error, is final. */
export async function requestJsonReconnecting(base: string, token: string, path: string, unreachableMs: number, deadline = Infinity): Promise<unknown> {
  const target = new URL(path, `${base.replace(/\/$/, '')}/`);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('PIPE_URL must use local HTTP on 127.0.0.1');
  const expires = Math.min(performance.now() + unreachableMs, deadline);
  let delay = 250;
  let first = true;
  for (;;) {
    const remaining = expires - performance.now();
    if (remaining <= 0 && !first) throw new Error('pipe is unreachable; call again when the service returns');
    first = false;
    // A zero budget still gets one request. Give that request a short deadline so a
    // connected service that never answers cannot hold the client indefinitely.
    // A referenced timer, unlike AbortSignal.timeout on Node 22, keeps a waiting client alive until it fires.
    const controller = new AbortController(), signal = controller.signal;
    const timer = setTimeout(() => controller.abort(new DOMException('the request timed out', 'TimeoutError')),
      Math.max(1, Math.ceil(remaining > 0 ? Math.min(30_000, remaining) : 1000)));
    let onAbort: () => void = () => {};
    const timeout = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([requestJson(base, token, 'GET', path, undefined, signal), timeout]); }
    catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) throw error;
      const left = expires - performance.now();
      if (left <= 0) throw new Error('pipe is unreachable; call again when the service returns');
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, left)));
      delay = Math.min(delay * 2, 5000);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}
