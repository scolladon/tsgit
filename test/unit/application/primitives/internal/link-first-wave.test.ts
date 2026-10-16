import { describe, expect, it, vi } from 'vitest';
import {
  runLinkFirstWave,
  type WaveWrite,
} from '../../../../../src/application/primitives/internal/link-first-wave.js';
import type { LeadingPathScanner } from '../../../../../src/application/primitives/internal/symlinked-leading-path.js';
import type { FilePath } from '../../../../../src/domain/objects/index.js';
import { buildSeededContext } from '../fixtures.js';

interface WriteSpec {
  readonly path: string;
  readonly isLink?: boolean;
  readonly needsDirectories?: boolean;
  readonly refusal?: Error;
}

const recordingScanner = (events: string[]): LeadingPathScanner => ({
  hasSymlinkedLeadingPath: vi.fn(async () => false),
  symlinkedLeadingComponent: vi.fn(async () => undefined),
  unlinkSymlinkedLeadingComponent: vi.fn(async () => undefined),
  invalidate: vi.fn(),
  ensureLeadingDirectories: vi.fn(async (path: FilePath) => {
    events.push(`ensure ${path}`);
  }),
  invalidateAll: vi.fn(() => {
    events.push('invalidate');
  }),
});

const recordingWrite = (events: string[], spec: WriteSpec): WaveWrite => ({
  path: spec.path as FilePath,
  isLink: spec.isLink ?? false,
  needsDirectories: spec.needsDirectories ?? true,
  validate: () => {
    events.push(`validate ${spec.path}`);
    if (spec.refusal !== undefined) throw spec.refusal;
  },
  run: async () => {
    events.push(`run ${spec.path}`);
  },
});

describe('runLinkFirstWave', () => {
  describe('Given a wave listing a regular write before a link that sorts ahead of it', () => {
    describe('When the wave runs', () => {
      it('Then the link is written and every verdict dropped before the regular write is validated, prepared and pooled', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const events: string[] = [];
        const batch = [
          recordingWrite(events, { path: 'b/file' }),
          recordingWrite(events, { path: 'a', isLink: true }),
        ];
        const sut = runLinkFirstWave;

        // Act
        await sut(ctx, [batch], recordingScanner(events));

        // Assert
        expect(events).toEqual([
          'run a',
          'invalidate',
          'validate b/file',
          'ensure b/file',
          'run b/file',
        ]);
      });
    });
  });

  describe('Given a link wave holding a regular write that needs no directory', () => {
    describe('When the wave runs', () => {
      it('Then that write is neither validated nor prepared, only pooled', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const events: string[] = [];
        const batch = [
          recordingWrite(events, { path: 'a', isLink: true }),
          recordingWrite(events, { path: 'b/skipped', needsDirectories: false }),
        ];
        const sut = runLinkFirstWave;

        // Act
        await sut(ctx, [batch], recordingScanner(events));

        // Assert
        expect(events).toEqual(['run a', 'invalidate', 'run b/skipped']);
      });
    });
  });

  describe('Given a link wave holding a regular write its validation refuses', () => {
    describe('When the wave runs', () => {
      it('Then the refusal propagates before any directory is made or write pooled', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const events: string[] = [];
        const refusal = new Error('refused path');
        const batch = [
          recordingWrite(events, { path: 'a', isLink: true }),
          recordingWrite(events, { path: 'b/refused', refusal }),
        ];
        const sut = runLinkFirstWave;
        let caught: unknown;

        // Act
        try {
          await sut(ctx, [batch], recordingScanner(events));
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBe(refusal);
        expect(events).toEqual(['run a', 'invalidate', 'validate b/refused']);
      });
    });
  });
});
