import { networkError } from '../../domain/index.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../ports/http-transport.js';

export interface MockSetup {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly response: {
    readonly statusCode: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  };
}

interface StoredMock {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export class MemoryHttpTransport implements HttpTransport {
  private readonly mocks = new Map<string, StoredMock>();

  request = async (req: HttpRequest): Promise<HttpResponse> => {
    const key = buildKey(req.method, req.url);
    const mock = this.mocks.get(key);
    if (mock === undefined) {
      throw networkError(`no mock for ${req.url}`);
    }
    const bodyBytes = mock.body.slice();
    return {
      statusCode: mock.statusCode,
      headers: mock.headers,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bodyBytes);
          controller.close();
        },
      }),
    };
  };

  addMockResponse(mock: MockSetup): void {
    const lowercasedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(mock.response.headers)) {
      lowercasedHeaders[key.toLowerCase()] = value;
    }
    this.mocks.set(buildKey(mock.method, mock.url), {
      statusCode: mock.response.statusCode,
      headers: lowercasedHeaders,
      body: mock.response.body.slice(),
    });
  }

  clearMocks(): void {
    this.mocks.clear();
  }
}

function buildKey(method: 'GET' | 'POST', url: string): string {
  return `${method}:${url}`;
}
