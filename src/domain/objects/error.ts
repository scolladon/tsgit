export type DomainObjectError =
  | { readonly code: 'INVALID_OBJECT_ID'; readonly value: string }
  | { readonly code: 'INVALID_OBJECT_HEADER'; readonly reason: string }
  | {
      readonly code: 'INVALID_TREE_ENTRY';
      readonly offset: number;
      readonly reason: string;
    }
  | { readonly code: 'INVALID_COMMIT'; readonly reason: string }
  | { readonly code: 'INVALID_TAG'; readonly reason: string }
  | { readonly code: 'INVALID_FILE_MODE'; readonly value: string }
  | {
      readonly code: 'INVALID_IDENTITY';
      readonly line: string;
      readonly reason: string;
    };

export class TsgitError extends Error {
  override readonly name = 'TsgitError';

  constructor(readonly data: DomainObjectError) {
    super(`${data.code}: ${extractDetail(data)}`);
  }
}

function extractDetail(data: DomainObjectError): string {
  switch (data.code) {
    case 'INVALID_OBJECT_ID':
    case 'INVALID_FILE_MODE':
      return data.value;
    case 'INVALID_OBJECT_HEADER':
    case 'INVALID_TREE_ENTRY':
    case 'INVALID_COMMIT':
    case 'INVALID_TAG':
    case 'INVALID_IDENTITY':
      return data.reason;
  }
}

export const invalidObjectId = (value: string): TsgitError =>
  new TsgitError({ code: 'INVALID_OBJECT_ID', value });

export const invalidObjectHeader = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_OBJECT_HEADER', reason });

export const invalidTreeEntry = (offset: number, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_TREE_ENTRY', offset, reason });

export const invalidCommit = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_COMMIT', reason });

export const invalidTag = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_TAG', reason });

export const invalidFileMode = (value: string): TsgitError =>
  new TsgitError({ code: 'INVALID_FILE_MODE', value });

export const invalidIdentity = (line: string, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_IDENTITY', line, reason });
