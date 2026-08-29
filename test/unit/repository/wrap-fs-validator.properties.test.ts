/**
 * Property tests (lens 2) for the containment predicate that matters for
 * "the adapter is the single read-containment authority": do
 * `wrapFsValidator`'s verdict and the Node adapter's own `resolveRead`
 * verdict agree?
 *
 * Both oracles are pure and instance-free here — the wrapper's verdict is
 * observed by driving a real `wrapFsValidator` against a stub `FileSystem`
 * (throws or not); the adapter's verdict is computed with the exact same
 * steps `resolveRead` runs (`toAbsolute` → conditional `resolve` →
 * `pathContains`), reusing those exported primitives directly rather than
 * re-implementing them — a re-implemented oracle would prove nothing but its
 * own agreement with itself.
 *
 * Four of the five properties below assert plain agreement. The remaining
 * two assert a SPECIFIC, ratified divergence rather than raising a false
 * alarm on it: an in-repo `..`-collapsing (or Win32 dot-dot-space/dot
 * -shaped) read path is refused by the wrapper (which rejects any `..`
 * segment outright, including Win32 canonicalisation forms) but accepted by
 * the adapter (which only rejects when the RESOLVED path escapes); and the
 * three config-scope paths are accepted by the wrapper (its allowlist) but
 * refused by the adapter (no allowlist concept — it only knows roots). This
 * file is the proof that removing the wrapper from branded reads never
 * admits an escape beyond those two named, reviewed exceptions.
 */
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { pathContains, toAbsolute } from '../../../src/adapters/node/node-file-system.js';
import type { PathPolicy } from '../../../src/adapters/node/path-policy.js';
import { posixPolicy, windowsPolicy } from '../../../src/adapters/node/path-policy.js';
import { TsgitError } from '../../../src/domain/error.js';
import type { FileSystem } from '../../../src/ports/file-system.js';
import { wrapFsValidator } from '../../../src/repository/wrap-fs-validator.js';

const NUM_RUNS = 100;

type PolicyLabel = 'posix' | 'windows';

const ROOT_BY_POLICY: Record<PolicyLabel, string> = {
  posix: '/repo',
  windows: 'C:\\repo',
};

function arbPolicyLabel(): fc.Arbitrary<PolicyLabel> {
  return fc.constantFrom('posix', 'windows');
}

function policyFor(label: PolicyLabel): PathPolicy {
  return label === 'posix' ? posixPolicy : windowsPolicy;
}

function arbSegmentChar(): fc.Arbitrary<string> {
  return fc
    .oneof(
      fc.integer({ min: 97, max: 122 }), // a-z
      fc.integer({ min: 65, max: 90 }), // A-Z
      fc.integer({ min: 48, max: 57 }), // 0-9
    )
    .map((code) => String.fromCharCode(code));
}

function arbSegment(): fc.Arbitrary<string> {
  return fc.string({ unit: arbSegmentChar(), minLength: 1, maxLength: 8 });
}

function buildPath(policy: PathPolicy, root: string, segments: ReadonlyArray<string>): string {
  return segments.reduce((acc, seg) => acc + policy.sep + seg, root);
}

/** Every method resolves — isolates the property to the guard decision alone. */
const stubFs = (): FileSystem =>
  ({
    read: vi.fn(async () => new Uint8Array(0)),
    readSlice: vi.fn(async () => new Uint8Array(0)),
    readUtf8: vi.fn(async () => ''),
    write: vi.fn(async () => {}),
    writeStream: vi.fn(async () => {}),
    writeExclusive: vi.fn(async () => {}),
    writeUtf8: vi.fn(async () => {}),
    appendUtf8: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    stat: vi.fn(async () => ({})),
    lstat: vi.fn(async () => ({})),
    readdir: vi.fn(async () => []),
    mkdir: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    readlink: vi.fn(async () => ''),
    symlink: vi.fn(async () => {}),
    chmod: vi.fn(async () => {}),
    rmRecursive: vi.fn(async () => {}),
    openWithNoFollow: vi.fn(async () => ({})),
    homedir: () => '/home/user',
    xdgConfigHome: () => '/home/user/.config',
    systemConfigPath: () => '/etc/gitconfig',
  }) as unknown as FileSystem;

/** The wrapper's verdict for `path` against `root` — true when it delegates without throwing. */
async function wrapperAccepts(
  path: string,
  root: string,
  allowExternalPaths: ReadonlyArray<string> = [],
): Promise<boolean> {
  const sut = wrapFsValidator(stubFs(), root, allowExternalPaths);
  try {
    await sut.exists(path);
    return true;
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'PATHSPEC_OUTSIDE_REPO') return false;
    throw err;
  }
}

/** The adapter's `resolveRead` verdict for `path` against `root` — mirrors its exact steps. */
function adapterAccepts(path: string, root: string, policy: PathPolicy): boolean {
  const absolute = toAbsolute(path, root, policy);
  const candidate = absolute.indexOf('..') === -1 ? absolute : policy.resolve(absolute);
  return pathContains(root, candidate, policy);
}

describe('Given an arbitrary in-root path with no `..` segment', () => {
  describe('When compared against the adapter oracle', () => {
    it('Then the wrapper and the adapter agree: both accept', async () => {
      // Arrange + Act + Assert
      await fc.assert(
        fc.asyncProperty(
          arbPolicyLabel(),
          fc.array(arbSegment(), { minLength: 0, maxLength: 4 }),
          async (label, segments) => {
            const policy = policyFor(label);
            const root = ROOT_BY_POLICY[label];
            const path = segments.length === 0 ? root : buildPath(policy, root, segments);

            const wrapperVerdict = await wrapperAccepts(path, root);
            const adapterVerdict = adapterAccepts(path, root, policy);

            return wrapperVerdict === true && adapterVerdict === true;
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });
});

describe('Given an arbitrary out-of-root sibling path with no `..` segment', () => {
  describe('When compared against the adapter oracle', () => {
    it('Then the wrapper and the adapter agree: both refuse', async () => {
      // Arrange + Act + Assert
      await fc.assert(
        fc.asyncProperty(arbPolicyLabel(), arbSegment(), async (label, suffix) => {
          const policy = policyFor(label);
          const root = ROOT_BY_POLICY[label];
          const path = `${root}-${suffix}`;

          const wrapperVerdict = await wrapperAccepts(path, root);
          const adapterVerdict = adapterAccepts(path, root, policy);

          return wrapperVerdict === false && adapterVerdict === false;
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});

describe('Given an arbitrary `..`-escaping path (resolves genuinely outside root)', () => {
  describe('When compared against the adapter oracle', () => {
    it('Then the wrapper and the adapter agree: both refuse', async () => {
      // Arrange + Act + Assert
      await fc.assert(
        fc.asyncProperty(
          arbPolicyLabel(),
          arbSegment(),
          fc.array(arbSegment(), { minLength: 0, maxLength: 3 }),
          async (label, suffix, trailingSegments) => {
            const policy = policyFor(label);
            const root = ROOT_BY_POLICY[label];
            // The `outside-` prefix guarantees this segment can never
            // coincidentally equal the root's own basename ('repo'), which
            // would otherwise resolve back INSIDE root and falsify the
            // "genuinely escaping" premise.
            const outsideSegment = `outside-${suffix}`;
            const escaping = buildPath(policy, buildPath(policy, root, ['..']), [
              outsideSegment,
              ...trailingSegments,
            ]);

            const wrapperVerdict = await wrapperAccepts(escaping, root);
            const adapterVerdict = adapterAccepts(escaping, root, policy);

            return wrapperVerdict === false && adapterVerdict === false;
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });
});

describe('Given an arbitrary `..`-collapsing-inside path (resolves back under root)', () => {
  describe('When compared against the adapter oracle', () => {
    it('Then this is the ratified divergence: the wrapper refuses, the adapter accepts', async () => {
      // Arrange + Act + Assert
      await fc.assert(
        fc.asyncProperty(
          arbPolicyLabel(),
          arbSegment(),
          arbSegment(),
          async (label, dirSegment, fileSegment) => {
            const policy = policyFor(label);
            const root = ROOT_BY_POLICY[label];
            // `${root}/dirSegment/../fileSegment` resolves to
            // `${root}/fileSegment` — still contained.
            const collapsing = buildPath(policy, root, [dirSegment, '..', fileSegment]);

            const wrapperVerdict = await wrapperAccepts(collapsing, root);
            const adapterVerdict = adapterAccepts(collapsing, root, policy);

            return wrapperVerdict === false && adapterVerdict === true;
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });
});

describe('Given an arbitrary Win32 dot-dot-space/dot form (`.. ` / `...`) as an in-root segment', () => {
  describe('When compared against the adapter oracle', () => {
    it('Then this is the SAME ratified divergence: the wrapper refuses, the adapter accepts (Node never OS-canonicalises trailing dots/spaces)', async () => {
      // Arrange + Act + Assert
      await fc.assert(
        fc.asyncProperty(
          arbPolicyLabel(),
          fc.constantFrom('.. ', '...', '..  ', '....'),
          arbSegment(),
          async (label, win32Form, fileSegment) => {
            const policy = policyFor(label);
            const root = ROOT_BY_POLICY[label];
            const path = buildPath(policy, root, [win32Form, fileSegment]);

            const wrapperVerdict = await wrapperAccepts(path, root);
            const adapterVerdict = adapterAccepts(path, root, policy);

            return wrapperVerdict === false && adapterVerdict === true;
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });
});

describe('Given the three config-scope paths admitted through the wrapper allowlist', () => {
  describe('When compared against the adapter oracle', () => {
    it('Then this is the SECOND ratified divergence: the wrapper accepts (allowlist), the adapter refuses (no allowlist concept)', async () => {
      // Arrange
      const root = '/repo';
      const policy = posixPolicy;
      const configScopePaths = [
        '/home/user/.gitconfig',
        '/home/user/.config/git/config',
        '/etc/gitconfig',
      ];

      for (const path of configScopePaths) {
        // Act
        const wrapperVerdict = await wrapperAccepts(path, root, configScopePaths);
        const adapterVerdict = adapterAccepts(path, root, policy);

        // Assert
        expect(wrapperVerdict).toBe(true);
        expect(adapterVerdict).toBe(false);
      }
    });
  });
});
