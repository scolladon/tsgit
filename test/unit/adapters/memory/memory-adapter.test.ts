import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { MemoryCommandRunner } from '../../../../src/adapters/memory/memory-command-runner.js';
import { MemoryHookRunner } from '../../../../src/adapters/memory/memory-hook-runner.js';

describe('createMemoryContext', () => {
  describe('Given a command runner option', () => {
    describe('When reading ctx.command', () => {
      it('Then it equals the supplied runner', () => {
        // Arrange
        const command = new MemoryCommandRunner();

        // Act
        const sut = createMemoryContext({ command });

        // Assert
        expect(sut.command).toBe(command);
      });
    });
    describe('When no command runner is supplied', () => {
      it('Then ctx.command is undefined', () => {
        // Arrange / Act
        const sut = createMemoryContext();

        // Assert
        expect(sut.command).toBeUndefined();
      });
    });
  });

  describe('Given default options', () => {
    describe('When reading config', () => {
      it('Then workDir is /repo and gitDir is /repo/.git', () => {
        // Arrange / Act
        const sut = createMemoryContext();

        // Assert
        expect(sut.layout.workDir).toBe('/repo');
        expect(sut.layout.gitDir).toBe('/repo/.git');
        expect(sut.layout.bare).toBe(false);
      });
    });
    describe('When reading layout.homeDir', () => {
      it('Then it is undefined', () => {
        // Arrange / Act
        const sut = createMemoryContext();

        // Assert
        expect(sut.layout.homeDir).toBeUndefined();
      });
    });
  });

  describe('Given homeDir option', () => {
    describe('When reading layout.homeDir', () => {
      it('Then it equals the option', () => {
        // Arrange / Act
        const sut = createMemoryContext({ homeDir: '/home/me' });

        // Assert
        expect(sut.layout.homeDir).toBe('/home/me');
      });
    });
    describe('When reading layout.bare', () => {
      it('Then it stays false', () => {
        // Arrange / Act — the homeDir branch builds the layout independently; bare must remain false.
        const sut = createMemoryContext({ homeDir: '/home/me' });

        // Assert
        expect(sut.layout.bare).toBe(false);
      });
    });
  });

  describe('Given default options', () => {
    describe('When reading hash algorithm', () => {
      it('Then is sha1', () => {
        // Arrange / Act
        const sut = createMemoryContext();

        // Assert
        expect(sut.hash.algorithm).toBe('sha1');
      });
    });
  });

  describe('Given algorithm option sha256', () => {
    describe('When reading hash algorithm', () => {
      it('Then is sha256', () => {
        // Arrange / Act
        const sut = createMemoryContext({ algorithm: 'sha256' });

        // Assert
        expect(sut.hash.algorithm).toBe('sha256');
        expect(sut.hash.digestLength).toBe(32);
      });
    });
  });

  describe('Given pre-seeded files', () => {
    describe('When reading via fs', () => {
      it('Then returns seeded bytes', async () => {
        // Arrange
        const seeded = new Uint8Array([1, 2, 3]);
        const sut = createMemoryContext({ files: { '/repo/pre.bin': seeded } });

        // Act
        const result = await sut.fs.read('/repo/pre.bin');

        // Assert
        expect(result).toEqual(seeded);
      });
    });
  });

  describe('Given two contexts', () => {
    describe('When mutating one', () => {
      it('Then other is unaffected', async () => {
        // Arrange
        const sutA = createMemoryContext();
        const sutB = createMemoryContext();

        // Act
        await sutA.fs.write('/repo/only-a.bin', new Uint8Array([42]));

        // Assert
        expect(await sutA.fs.exists('/repo/only-a.bin')).toBe(true);
        expect(await sutB.fs.exists('/repo/only-a.bin')).toBe(false);
      });
    });
  });

  describe('Given context', () => {
    describe('When it is frozen', () => {
      it('Then mutating fs property throws', () => {
        // Arrange
        const sut = createMemoryContext();

        // Act / Assert
        expect(() => {
          (sut as { fs: unknown }).fs = null;
        }).toThrow();
      });
    });
  });

  describe('Given signal option', () => {
    describe('When reading context signal', () => {
      it('Then matches input', () => {
        // Arrange
        const controller = new AbortController();

        // Act
        const sut = createMemoryContext({ signal: controller.signal });

        // Assert
        expect(sut.signal).toBe(controller.signal);
      });
    });
  });

  describe('Given default options', () => {
    describe('When reading progress reporter', () => {
      it('Then start/update/end are no-op functions', () => {
        // Arrange / Act
        const sut = createMemoryContext();

        // Assert
        expect(typeof sut.progress.start).toBe('function');
        expect(typeof sut.progress.update).toBe('function');
        expect(typeof sut.progress.end).toBe('function');
        expect(() => sut.progress.start('test', 1)).not.toThrow();
        expect(() => sut.progress.update('test', 0, 1)).not.toThrow();
        expect(() => sut.progress.end('test')).not.toThrow();
      });
    });
  });

  describe('Given a home override', () => {
    describe('When reading fs.homedir', () => {
      it('Then it equals the supplied home, not the default', () => {
        // Arrange / Act
        const sut = createMemoryContext({ home: '/custom/home' });

        // Assert — dropping the `home` spread would fall back to the default home.
        expect(sut.fs.homedir()).toBe('/custom/home');
      });
    });
  });

  describe('Given a hooks runner option', () => {
    describe('When reading ctx.hooks', () => {
      it('Then it equals the supplied runner', () => {
        // Arrange
        const hooks = new MemoryHookRunner();

        // Act
        const sut = createMemoryContext({ hooks });

        // Assert — dropping the `hooks` spread would leave ctx.hooks undefined.
        expect(sut.hooks).toBe(hooks);
      });
    });
  });

  describe('Given default options', () => {
    describe('When reading hashConfig', () => {
      it('Then it is the sha1 config (20-byte digest, 40-char hex)', () => {
        // Arrange / Act
        const sut = createMemoryContext();

        // Assert — forcing the sha256 arm would give a 32-byte digest.
        expect(sut.hashConfig.digestLength).toBe(20);
        expect(sut.hashConfig.hexLength).toBe(40);
      });
    });
  });

  describe('Given algorithm option sha256', () => {
    describe('When reading hashConfig', () => {
      it('Then it is the sha256 config (32-byte digest, 64-char hex)', () => {
        // Arrange / Act
        const sut = createMemoryContext({ algorithm: 'sha256' });

        // Assert — forcing the sha1 arm would give a 20-byte digest.
        expect(sut.hashConfig.digestLength).toBe(32);
        expect(sut.hashConfig.hexLength).toBe(64);
      });
    });
  });

  describe('Given a deltaCacheMaxEntries cap', () => {
    describe('When more entries than the cap are inserted', () => {
      it('Then the cache evicts down to the cap', () => {
        // Arrange — a cap of 2 with generous byte room isolates the entry-count limit.
        const sut = createMemoryContext({ deltaCacheMaxEntries: 2, deltaCacheMaxBytes: 1_000_000 });

        // Act
        sut.deltaCache.set('a', new Uint8Array([1]), 1);
        sut.deltaCache.set('b', new Uint8Array([2]), 1);
        sut.deltaCache.set('c', new Uint8Array([3]), 1);

        // Assert — coalescing the cap to the 65_536 default would keep all three.
        expect(sut.deltaCache.entryCount).toBe(2);
        expect(sut.deltaCache.get('a')).toBeUndefined();
        expect(sut.deltaCache.get('c')).toEqual(new Uint8Array([3]));
      });
    });
  });
});
