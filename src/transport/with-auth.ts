import type { HttpRequest, HttpTransport } from '../ports/http-transport.js';
import type { AuthConfig } from './types.js';

const TEXT_ENCODER = new TextEncoder();

const base64Utf8 = (s: string): string => {
  const bytes = TEXT_ENCODER.encode(s);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    bin += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(bin);
};

const hasAuthHeader = (headers: Readonly<Record<string, string>>): boolean =>
  Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');

const validateBearer = (token: string): void => {
  if (token === '') throw new TypeError('withAuth: token is empty');
};

const validateBasic = (username: string): void => {
  if (username.includes(':')) {
    throw new TypeError('withAuth: basic username must not contain ":"');
  }
};

const validateConfig = (config: AuthConfig): void => {
  if (config.type === 'bearer') validateBearer(config.token);
  if (config.type === 'basic') validateBasic(config.username);
};

const headerForBearer = (token: string): string => `Bearer ${token}`;
const headerForBasic = (username: string, password: string): string =>
  `Basic ${base64Utf8(`${username}:${password}`)}`;

const resolveHeader = async (config: AuthConfig, req: HttpRequest): Promise<string> => {
  if (config.type === 'bearer') return headerForBearer(config.token);
  if (config.type === 'basic') return headerForBasic(config.username, config.password);
  const value = await config.header(req);
  if (value === '' || value === null || value === undefined) {
    throw new TypeError('withAuth: custom returned empty value');
  }
  return value;
};

const addAuthorization = (req: HttpRequest, value: string): HttpRequest => ({
  ...req,
  headers: { ...req.headers, authorization: value },
});

export const withAuth = (config: AuthConfig) => {
  validateConfig(config);
  return (inner: HttpTransport): HttpTransport => ({
    request: async (req) => {
      if (hasAuthHeader(req.headers)) return inner.request(req);
      const value = await resolveHeader(config, req);
      return inner.request(addAuthorization(req, value));
    },
  });
};
