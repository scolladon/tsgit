// AGENT identifier sent in upload-pack/receive-pack negotiation.
// Hardcoded to major.minor (no patch) to reduce fingerprinting; bump on minor
// release. See docs/design/transport.md §7.
export const AGENT = 'agent=tsgit/0.0';

export const CLIENT_CAPABILITIES_FETCH: ReadonlyArray<string> = [
  'multi_ack_detailed',
  'side-band-64k',
  'ofs-delta',
  'thin-pack',
  'no-progress',
  'include-tag',
  'filter',
  AGENT,
];

export const CLIENT_CAPABILITIES_PUSH: ReadonlyArray<string> = [
  'report-status',
  'side-band-64k',
  'ofs-delta',
  'atomic',
  'delete-refs',
  AGENT,
];

// Bare push-cert capability token. Advertised by the client only when a push
// is being signed, so it is kept out of the default CLIENT_CAPABILITIES_PUSH
// set and added conditionally by the caller building the wants list.
export const PUSH_CERT = 'push-cert';

const keyOf = (token: string): string => {
  const eq = token.indexOf('=');
  return eq < 0 ? token : token.slice(0, eq);
};

const dedupeByKey = (tokens: ReadonlyArray<string>): ReadonlyArray<string> => {
  const map = new Map<string, string>();
  for (const t of tokens) map.set(keyOf(t), t);
  return Array.from(map.values());
};

export const parseCapabilities = (tail: string): ReadonlyArray<string> => {
  const tokens = tail.split(' ').filter((s) => s.length > 0);
  return dedupeByKey(tokens);
};

export const formatCapabilities = (caps: ReadonlyArray<string>): string => caps.join(' ');

export const negotiateCapabilities = (
  serverCaps: ReadonlyArray<string>,
  clientCaps: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const serverByKey = new Map<string, string>();
  for (const t of serverCaps) serverByKey.set(keyOf(t), t);
  const out: string[] = [];
  for (const c of clientCaps) {
    const k = keyOf(c);
    const serverValue = serverByKey.get(k);
    if (serverValue !== undefined) out.push(serverValue);
  }
  return out;
};
