import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

export type PaidResponse = Pick<Response, 'status' | 'headers' | 'json'>;
export type PaidRequest = (url: string | URL, init: RequestInit & { signal: AbortSignal }) => Promise<PaidResponse>;

type Failure = { cause: { code?: string; message?: string; errors?: { code?: string }[] } };
type Reply = { kind: 'headers'; status: number; requestId: string | null } |
  { kind: 'body'; body: unknown } | { kind: 'failure'; error: Failure };
const failed = (): Error => new Error('The API connection failed');

/**
 * Native fetch can leave a proxy CONNECT attempt alive after aborting the request.
 * Give each call its own worker: terminating it closes its entire connection pool,
 * including DNS, TLS and proxy handshakes, without waiting for fetch to cooperate.
 * Auth and bodies pass only through memory; worker output/errors are never printed.
 */
export const paidRequest: PaidRequest = (url, init) => {
  if (init.signal.aborted) return Promise.reject(failed());
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./paid-fetch.ts', import.meta.url), {
      workerData: { huntawayPaidRequest: true, url: String(url), init: { ...init, signal: undefined } },
      stdout: true, stderr: true,
    });
    let resolveBody!: (body: unknown) => void;
    let rejectBody!: (error: unknown) => void;
    const body = new Promise<unknown>((yes, no) => { resolveBody = yes; rejectBody = no; });
    // A count's non-200 headers may cause the caller to skip reading the body.
    void body.catch(() => {});
    let done = false;
    const finish = (error?: unknown): void => {
      if (done) return;
      done = true;
      init.signal.removeEventListener('abort', abort);
      if (error) { reject(error); rejectBody(error); }
      void worker.terminate();
    };
    const abort = (): void => finish(failed());
    init.signal.addEventListener('abort', abort, { once: true });
    worker.on('message', (reply: Reply) => {
      if (done) return;
      if (reply.kind === 'headers') {
        const headers = new Headers();
        if (reply.requestId !== null) headers.set('request-id', reply.requestId);
        resolve({ status: reply.status, headers, json: () => body });
      } else if (reply.kind === 'body') {
        resolveBody(reply.body);
        finish();
      } else finish(reply.error);
    });
    worker.on('error', () => finish(failed()));
    worker.on('exit', () => finish(failed()));
    // Catch an abort between the initial check and installing the listener.
    if (init.signal.aborted) abort();
  });
};

if (!isMainThread && workerData?.huntawayPaidRequest === true) {
  try {
    const response = await fetch(workerData.url, workerData.init);
    parentPort!.postMessage({ kind: 'headers', status: response.status,
      requestId: response.headers.get('request-id') ?? response.headers.get('x-request-id') });
    parentPort!.postMessage({ kind: 'body', body: await response.json() });
  } catch (error) {
    // Preserve only the network classification, never a URL, provider message or key.
    const cause = (error as { cause?: { code?: unknown; message?: unknown; errors?: { code?: unknown }[] } }).cause;
    const code = (value: unknown): { code?: string } => typeof value === 'string' ? { code: value } : {};
    parentPort!.postMessage({ kind: 'failure', error: { cause: {
      ...code(cause?.code),
      ...(typeof cause?.message === 'string' && /redirect/iu.test(cause.message) ? { message: 'redirect' } : {}),
      ...(Array.isArray(cause?.errors) ? { errors: cause.errors.map(e => code(e?.code)) } : {}),
    } } });
  }
}
