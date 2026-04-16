/// <reference lib="dom" />
import { networkError } from '../../domain/index.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../ports/http-transport.js';

export class BrowserHttpTransport implements HttpTransport {
  async request(req: HttpRequest): Promise<HttpResponse> {
    try {
      const init: RequestInit = {
        method: req.method,
        headers: { ...req.headers },
      };
      if (req.body !== undefined) init.body = req.body as BodyInit;
      if (req.signal !== undefined) init.signal = req.signal;
      const res = await fetch(req.url, init);
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const body: ReadableStream<Uint8Array> = (res.body ??
        new ReadableStream<Uint8Array>()) as ReadableStream<Uint8Array>;
      return {
        statusCode: res.status,
        headers,
        body,
      };
    } catch (err) {
      throw networkError(err instanceof Error ? err.message : String(err));
    }
  }
}
