/// <reference lib="dom" />
import { describe, expect, it } from 'vitest';
import { BrowserFileSystem } from '../../../../src/adapters/browser/browser-file-system.js';

describe('BrowserFileSystem', () => {
  describe('Given a browser file system', () => {
    describe('When checking for the atomicRename capability', () => {
      it('Then the adapter does not expose atomicRename (structurally absent, not merely undefined)', () => {
        // Arrange
        const sut = new BrowserFileSystem({} as unknown as FileSystemDirectoryHandle);

        // Act
        const result = 'atomicRename' in sut;

        // Assert — OPFS has no atomic rename; the member must be omitted
        // entirely rather than present as a throwing stub, so callers can
        // branch on its absence before attempting the operation.
        expect(result).toBe(false);
      });
    });
  });
});
