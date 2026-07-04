import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../../src/domain/error.js';
import type { PktLine } from '../../../../../src/domain/protocol/pkt-line.js';
import {
  parseV2Capabilities,
  supportsV2Fetch,
} from '../../../../../src/domain/protocol/v2/capabilities.js';

async function* streamOf(lines: ReadonlyArray<string>): AsyncIterable<PktLine> {
  const encoder = new TextEncoder();
  for (const line of lines) {
    yield { kind: 'data', payload: encoder.encode(line) };
  }
  yield { kind: 'flush' };
}

const FULL_ADVERTISEMENT = [
  'version 2\n',
  'agent=git/2.55.0-Darwin\n',
  'ls-refs=unborn\n',
  'fetch=shallow wait-for-done\n',
  'server-option\n',
  'object-format=sha1\n',
];

describe('parseV2Capabilities', () => {
  describe('Given a version-2 capability advertisement', () => {
    describe('When parsed', () => {
      it('Then version is 2, commands include ls-refs and fetch, objectFormat is sha1', async () => {
        // Arrange
        const sut = parseV2Capabilities;

        // Act
        const caps = await sut(streamOf(FULL_ADVERTISEMENT));

        // Assert
        expect(caps.version).toBe(2);
        expect(caps.agent).toBe('git/2.55.0-Darwin');
        expect(caps.commands.has('ls-refs')).toBe(true);
        expect(caps.commands.has('fetch')).toBe(true);
        expect(caps.objectFormat).toBe('sha1');
        expect(supportsV2Fetch(caps)).toBe(true);
      });
    });
  });

  describe('Given a version-2 advertisement missing the fetch command', () => {
    describe('When supportsV2Fetch is checked', () => {
      it('Then it returns false', async () => {
        // Arrange
        const advertisement = ['version 2\n', 'ls-refs=unborn\n', 'object-format=sha1\n'];

        // Act
        const caps = await parseV2Capabilities(streamOf(advertisement));

        // Assert
        expect(supportsV2Fetch(caps)).toBe(false);
      });
    });
  });

  describe('Given a first line that is not "version 2"', () => {
    describe('When parsed', () => {
      it('Then it throws V2_COMMAND_UNSUPPORTED carrying the offending line', async () => {
        // Arrange
        const advertisement = ['0000000000000000000000000000000000000000 HEAD\n'];

        // Act
        let sut: unknown;
        try {
          await parseV2Capabilities(streamOf(advertisement));
        } catch (e) {
          sut = e;
        }

        // Assert
        expect(sut).toBeInstanceOf(TsgitError);
        expect((sut as TsgitError).data).toEqual({
          code: 'V2_COMMAND_UNSUPPORTED',
          command: '0000000000000000000000000000000000000000 HEAD',
        });
      });
    });
  });

  describe('Given an empty advertisement stream', () => {
    describe('When parsed', () => {
      it('Then it throws V2_COMMAND_UNSUPPORTED', async () => {
        // Arrange
        async function* empty(): AsyncIterable<PktLine> {
          yield { kind: 'flush' };
        }

        // Act
        let sut: unknown;
        try {
          await parseV2Capabilities(empty());
        } catch (e) {
          sut = e;
        }

        // Assert
        expect(sut).toBeInstanceOf(TsgitError);
        expect((sut as TsgitError).data).toEqual({ code: 'V2_COMMAND_UNSUPPORTED', command: '' });
      });
    });
  });

  describe('Given a version-2 advertisement whose object-format is sha256', () => {
    describe('When parsed', () => {
      it('Then it throws V2_COMMAND_UNSUPPORTED carrying the offending object-format', async () => {
        // Arrange
        const advertisement = ['version 2\n', 'ls-refs\n', 'fetch\n', 'object-format=sha256\n'];

        // Act
        let sut: unknown;
        try {
          await parseV2Capabilities(streamOf(advertisement));
        } catch (e) {
          sut = e;
        }

        // Assert
        expect(sut).toBeInstanceOf(TsgitError);
        expect((sut as TsgitError).data).toEqual({
          code: 'V2_COMMAND_UNSUPPORTED',
          command: 'object-format=sha256',
        });
      });
    });
  });

  describe('Given a version-2 advertisement with no optional capability lines', () => {
    describe('When parsed', () => {
      it('Then agent is absent and objectFormat defaults to sha1', async () => {
        // Arrange
        const advertisement = ['version 2\n'];

        // Act
        const caps = await parseV2Capabilities(streamOf(advertisement));

        // Assert
        expect(Object.hasOwn(caps, 'agent')).toBe(false);
        expect(caps.objectFormat).toBe('sha1');
        expect(caps.commands.size).toBe(0);
      });
    });
  });

  describe('Given a version line with no trailing newline', () => {
    describe('When parsed', () => {
      it('Then it is still recognised as version 2', async () => {
        // Arrange
        async function* stream(): AsyncIterable<PktLine> {
          yield { kind: 'data', payload: new TextEncoder().encode('version 2') };
          yield { kind: 'flush' };
        }

        // Act
        const caps = await parseV2Capabilities(stream());

        // Assert
        expect(caps.version).toBe(2);
      });
    });
  });

  describe('Given a bare "object-format" capability with no value', () => {
    describe('When parsed', () => {
      it('Then it throws V2_COMMAND_UNSUPPORTED', async () => {
        // Arrange
        const advertisement = ['version 2\n', 'object-format\n'];

        // Act
        let sut: unknown;
        try {
          await parseV2Capabilities(streamOf(advertisement));
        } catch (e) {
          sut = e;
        }

        // Assert
        expect(sut).toBeInstanceOf(TsgitError);
        expect((sut as TsgitError).data).toEqual({
          code: 'V2_COMMAND_UNSUPPORTED',
          command: 'object-format',
        });
      });
    });
  });
});
