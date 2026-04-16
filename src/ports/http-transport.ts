export interface HttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  /** Optional abort signal for request cancellation. */
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly statusCode: number;
  /** Response headers. All keys MUST be lowercased by the adapter. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array>;
}

export interface HttpTransport {
  /** Send an HTTP request and return the response. */
  readonly request: (req: HttpRequest) => Promise<HttpResponse>;
}
