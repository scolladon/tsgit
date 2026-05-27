import fc from 'fast-check';

import type { WriteScope } from '../../../../src/ports/write-scope.js';

export const arbWriteScope = (): fc.Arbitrary<WriteScope> =>
  fc.constantFrom<WriteScope>('index', 'refs', 'objects');

export const arbScopeHistory = (): fc.Arbitrary<readonly WriteScope[]> =>
  fc.array(arbWriteScope(), { maxLength: 64 });
