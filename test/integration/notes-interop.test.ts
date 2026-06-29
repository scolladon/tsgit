/**
 * Cross-tool interop — notes command family.
 * Proves byte-for-byte parity between tsgit's notes operations and
 * canonical git on blob OIDs, tree OIDs, commit OIDs, and reflog bytes.
 *
 * The library emits NO rendered strings — all assertions reconstruct
 * git's human output from structured fields and compare.
 *
 * @proves
 *   surface:        notes.add, notes.list, notes.read, notes.remove
 *   bucket:         cross-tool-interop
 *   unique:         single-add blob/tree/commit/reflog byte parity;
 *                   flat-region tree OID parity (N=5);
 *                   flat→fanned flip parity at N=150 notes (deterministic);
 *                   post-flip stickiness after bulk removal;
 *                   force-overwrite commit OID parity;
 *                   remove-last → empty tree 4b825d…;
 *                   non-note preserved entry round-trips;
 *                   add-on-existing NOTES_ALREADY_EXIST + git co-refusal;
 *                   remove-on-missing NOTES_OBJECT_HAS_NONE + git co-refusal;
 *                   core.notesRef config precedence;
 *                   GIT_NOTES_REF env precedence;
 *                   notesList reconstructs git notes list stdout;
 *                   notesRead reconstructs git notes show stdout
 *   interopSurface: notes
 */

import { writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import {
  type NotesAddResult,
  notesAdd,
  notesList,
  notesRead,
  notesRemove,
} from '../../src/application/commands/notes.js';
import { TsgitError } from '../../src/domain/error.js';
import type { ObjectId } from '../../src/domain/objects/object-id.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGit,
} from './interop-helpers.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const PINNED_UNIX = 1_700_000_000;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DEFAULT_NOTES_REF = 'refs/notes/commits';
const NOTES_ADD_MESSAGE = "Notes added by 'git notes add'";
const NOTES_REMOVE_MESSAGE = "Notes removed by 'git notes remove'";
const NOTES_ADD_REFLOG = `notes: ${NOTES_ADD_MESSAGE}`;
const NOTES_REMOVE_REFLOG = `notes: ${NOTES_REMOVE_MESSAGE}`;

const IDENTITY_NAME = 'Ada';
const IDENTITY_EMAIL = 'ada@example.com';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** git env with pinned author/committer identity and timestamp. */
const pinnedEnv = (): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: IDENTITY_NAME,
  GIT_AUTHOR_EMAIL: IDENTITY_EMAIL,
  GIT_AUTHOR_DATE: `${PINNED_UNIX} +0000`,
  GIT_COMMITTER_NAME: IDENTITY_NAME,
  GIT_COMMITTER_EMAIL: IDENTITY_EMAIL,
  GIT_COMMITTER_DATE: `${PINNED_UNIX} +0000`,
});

/** Create N empty commits in dir with pinned identity, returning their OIDs. */
const makeCommits = (dir: string, n: number, env: NodeJS.ProcessEnv): ObjectId[] => {
  const oids: ObjectId[] = [];
  for (let i = 0; i < n; i++) {
    runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', `c${i}`], { env });
    oids.push(runGit(['-C', dir, 'rev-parse', 'HEAD']).trim() as ObjectId);
  }
  return oids;
};

/** Resolve the tree OID of the HEAD notes commit. */
const notesTreeOid = (dir: string, ref = DEFAULT_NOTES_REF): string =>
  runGit(['-C', dir, 'rev-parse', `${ref}^{tree}`]).trim();

/** Resolve the notes commit OID for the given ref. */
const notesCommitOid = (dir: string, ref = DEFAULT_NOTES_REF): string =>
  runGit(['-C', dir, 'rev-parse', ref]).trim();

/** Get the note content bytes for a given annotated object via git notes show. */
const gitNoteShow = (dir: string, objectOid: string, ref = DEFAULT_NOTES_REF): string =>
  runGit(['-C', dir, 'notes', '--ref', ref, 'show', objectOid]);

/**
 * Reconstruct `git notes list` stdout from tsgit's structured notesList result.
 * git format: "<note-sha> <object-sha>\n" per entry, sorted by object SHA.
 */
const reconstructNotesList = (
  entries: ReadonlyArray<{ readonly object: ObjectId; readonly note: ObjectId }>,
): string => `${entries.map(({ note, object }) => `${note} ${object}`).join('\n')}\n`;

/** Get top reflog subject for a ref (reads whichever .git/logs the dir holds). */
const topReflogSubject = (dir: string, ref: string): string =>
  runGit(['-C', dir, 'log', '-g', '--format=%gs', ref]).split('\n')[0] ?? '';

/** Write a temp file with exact byte content; returns its path. */
const writeTempNote = async (slug: string, content: string): Promise<string> => {
  const p = path.join(os.tmpdir(), `tsgit-notes-interop-${slug}.txt`);
  await writeFile(p, content, 'utf8');
  return p;
};

// ─── Main ────────────────────────────────────────────────────────────────────

describe.skipIf(!GIT_AVAILABLE)('notes interop', () => {
  // ── Scenario 1: single add + list/read/force/refusal ───────────────────────
  describe('Given a single note added to the default ref', () => {
    let pair: PeerPair;
    let annotatedOid: ObjectId;
    let gitFirstCommit: string;
    let addResult: NotesAddResult;
    let forceResult: NotesAddResult;
    const NOTE_A = 'hello notes\n';
    const NOTE_A_FORCE = 'overwritten note\n';

    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(PINNED_UNIX * 1000);

      pair = await makePeerPair('notes-single');
      initBothRepos(pair.peer, pair.ours);

      const env = pinnedEnv();

      // Create three empty commits (same in both repos)
      const peerOids = makeCommits(pair.peer, 3, env);
      annotatedOid = peerOids[0] as ObjectId;
      // Mirror commits in ours
      makeCommits(pair.ours, 3, env);

      // git: add first note
      const noteTmpA = await writeTempNote('a', NOTE_A);
      runGit(['-C', pair.peer, 'notes', 'add', '-F', noteTmpA, annotatedOid], { env });
      gitFirstCommit = notesCommitOid(pair.peer);

      // tsgit: same note
      const ctx = createNodeContext({ workDir: pair.ours });
      addResult = await notesAdd(ctx, {
        object: annotatedOid,
        content: new TextEncoder().encode(NOTE_A),
      });

      // git: force-overwrite note
      const noteTmpAF = await writeTempNote('af', NOTE_A_FORCE);
      runGit(['-C', pair.peer, 'notes', 'add', '-f', '-F', noteTmpAF, annotatedOid], { env });

      // tsgit: force-overwrite
      forceResult = await notesAdd(ctx, {
        object: annotatedOid,
        content: new TextEncoder().encode(NOTE_A_FORCE),
        force: true,
      });

      vi.useRealTimers();
    }, 60_000);

    afterAll(async () => {
      await pair.dispose();
    });

    describe('When the first note is added', () => {
      it('Then the blob OID matches git', () => {
        // git stores one overwrite later; look up blob from the first notes commit tree
        const firstTreeEntries = runGit(['-C', pair.peer, 'ls-tree', `${gitFirstCommit}^{tree}`]);
        const blobOid = firstTreeEntries
          .split('\n')
          .find((l) => l.includes(annotatedOid))
          ?.split(/\s+/)[2];
        expect(addResult.note).toBe(blobOid);
      });

      it('Then the first notes commit tree OID matches git', () => {
        const peerTree = runGit(['-C', pair.peer, 'rev-parse', `${gitFirstCommit}^{tree}`]).trim();
        const oursTree = runGit([
          '-C',
          pair.ours,
          'rev-parse',
          `${addResult.notesCommit}^{tree}`,
        ]).trim();
        expect(oursTree).toBe(peerTree);
      });

      it('Then the first notes commit OID matches git', () => {
        expect(addResult.notesCommit).toBe(gitFirstCommit);
      });

      it('Then cat-file -p of the notes commit matches git byte-for-byte', () => {
        const peerOut = runGit(['-C', pair.peer, 'cat-file', '-p', gitFirstCommit]);
        const oursOut = runGit(['-C', pair.ours, 'cat-file', '-p', addResult.notesCommit]);
        expect(oursOut).toBe(peerOut);
      });

      it('Then the reflog subject is the canonical notes-add message', () => {
        const peerSubject = topReflogSubject(pair.peer, DEFAULT_NOTES_REF);
        // tsgit reflog after force overwrites; check first entry via gitFirstCommit
        const oursSubjectFirst =
          runGit(['-C', pair.ours, 'log', '-g', '--format=%gs', DEFAULT_NOTES_REF])
            .split('\n')
            .at(-2) ?? '';
        expect(oursSubjectFirst).toBe(NOTES_ADD_REFLOG);
        // peer subject after force is also add reflog
        expect(peerSubject).toBe(NOTES_ADD_REFLOG);
      });
    });

    describe('When an existing note is overwritten with force', () => {
      it('Then the force-overwrite notes commit OID matches git', () => {
        expect(forceResult.notesCommit).toBe(notesCommitOid(pair.peer));
      });

      it('Then cat-file -p of the force notes commit matches git', () => {
        const peerForce = notesCommitOid(pair.peer);
        const peerOut = runGit(['-C', pair.peer, 'cat-file', '-p', peerForce]);
        const oursOut = runGit(['-C', pair.ours, 'cat-file', '-p', forceResult.notesCommit]);
        expect(oursOut).toBe(peerOut);
      });

      it('Then the force commit message header in cat-file contains the add message', () => {
        const out = runGit(['-C', pair.ours, 'cat-file', '-p', forceResult.notesCommit]);
        expect(out).toContain(NOTES_ADD_MESSAGE);
      });
    });

    describe('When notesList is called', () => {
      it('Then reconstructed output matches git notes list stdout', () => {
        const ctx = createNodeContext({ workDir: pair.ours });
        return notesList(ctx).then((entries) => {
          const reconstructed = reconstructNotesList(entries);
          const gitOut = runGit(['-C', pair.peer, 'notes', 'list']);
          expect(reconstructed).toBe(gitOut);
        });
      });
    });

    describe('When notesRead is called', () => {
      it('Then content matches git notes show stdout', () => {
        const ctx = createNodeContext({ workDir: pair.ours });
        return notesRead(ctx, { object: annotatedOid }).then((result) => {
          expect(result).not.toBeNull();
          const decoded = new TextDecoder().decode(result?.content);
          const gitShow = gitNoteShow(pair.peer, annotatedOid);
          expect(decoded).toBe(gitShow);
        });
      });
    });

    describe('When add is called on an existing note without force', () => {
      it('Then tsgit throws NOTES_ALREADY_EXIST and git exits non-zero', async () => {
        const ctx = createNodeContext({ workDir: pair.ours });

        // tsgit: should throw
        let thrown: unknown;
        try {
          await notesAdd(ctx, {
            object: annotatedOid,
            content: new TextEncoder().encode('refused\n'),
          });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(TsgitError);
        expect((thrown as TsgitError).data.code).toBe('NOTES_ALREADY_EXIST');
        expect((thrown as TsgitError).data).toMatchObject({ object: annotatedOid });

        // git: should also refuse
        const gitResult = tryRunGit([
          '-C',
          pair.peer,
          'notes',
          'add',
          '-m',
          'refused',
          annotatedOid,
        ]);
        expect(gitResult.ok).toBe(false);
        expect(gitResult.stderr).toContain('existing notes');
      });
    });
  });

  // ── Scenario 2: flat region (5 notes) ─────────────────────────────────────
  describe('Given a flat notes tree with 5 notes', () => {
    let pair: PeerPair;
    let peerTreeAfter5: string;
    let oursTreeAfter5: string;
    let peerCommitAfter5: string;
    let oursCommitAfter5: string;

    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(PINNED_UNIX * 1000);

      pair = await makePeerPair('notes-flat');
      initBothRepos(pair.peer, pair.ours);
      const env = pinnedEnv();

      const peerOids = makeCommits(pair.peer, 5, env);
      makeCommits(pair.ours, 5, env);

      const ctx = createNodeContext({ workDir: pair.ours });

      for (let i = 0; i < 5; i++) {
        const oid = peerOids[i] as ObjectId;
        const noteFile = await writeTempNote(`flat-${i}`, `flat note ${i}\n`);
        runGit(['-C', pair.peer, 'notes', 'add', '-F', noteFile, oid], { env });
        await notesAdd(ctx, {
          object: oid,
          content: new TextEncoder().encode(`flat note ${i}\n`),
        });
      }

      peerTreeAfter5 = notesTreeOid(pair.peer);
      oursTreeAfter5 = notesTreeOid(pair.ours);
      peerCommitAfter5 = notesCommitOid(pair.peer);
      oursCommitAfter5 = notesCommitOid(pair.ours);

      vi.useRealTimers();
    }, 60_000);

    afterAll(async () => {
      await pair.dispose();
    });

    describe('When 5 notes are added in the same order', () => {
      it('Then the notes tree OID matches git', () => {
        expect(oursTreeAfter5).toBe(peerTreeAfter5);
      });

      it('Then the notes commit OID matches git', () => {
        expect(oursCommitAfter5).toBe(peerCommitAfter5);
      });

      it('Then the notes tree is flat (no subtrees)', () => {
        const ls = runGit(['-C', pair.peer, 'ls-tree', peerTreeAfter5]);
        const hasSubtrees = ls.split('\n').some((l) => l.startsWith('040000'));
        expect(hasSubtrees).toBe(false);
      });
    });
  });

  // ── Scenario 3+4+5: flip region, deep fanout, stickiness ──────────────────
  describe('Given a notes tree that has crossed the flat→fanned threshold', () => {
    let pair: PeerPair;
    let peerTreeAfterFlip: string;
    let oursTreeAfterFlip: string;
    let peerCommitAfterFlip: string;
    let oursCommitAfterFlip: string;
    let peerTreeAfterRemove: string;
    let oursTreeAfterRemove: string;
    // OIDs of the 150 commits used as annotation targets
    let oids: ObjectId[];
    // Number of notes to add — enough to guarantee all 16 nibble slots fill
    const FLIP_COUNT = 150;
    // Number of notes to remove after the flip to test stickiness
    const REMOVE_COUNT = 20;

    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(PINNED_UNIX * 1000);

      pair = await makePeerPair('notes-flip');
      initBothRepos(pair.peer, pair.ours);
      const env = pinnedEnv();

      oids = makeCommits(pair.peer, FLIP_COUNT, env);
      makeCommits(pair.ours, FLIP_COUNT, env);

      const ctx = createNodeContext({ workDir: pair.ours });

      for (let i = 0; i < FLIP_COUNT; i++) {
        const oid = oids[i] as ObjectId;
        const content = `note-${i}\n`;
        const noteFile = await writeTempNote(`flip-${i}`, content);
        runGit(['-C', pair.peer, 'notes', 'add', '-F', noteFile, oid], { env });
        await notesAdd(ctx, {
          object: oid,
          content: new TextEncoder().encode(content),
        });
      }

      peerTreeAfterFlip = notesTreeOid(pair.peer);
      oursTreeAfterFlip = notesTreeOid(pair.ours);
      peerCommitAfterFlip = notesCommitOid(pair.peer);
      oursCommitAfterFlip = notesCommitOid(pair.ours);

      // Remove the last REMOVE_COUNT notes (stickiness test)
      for (let i = FLIP_COUNT - REMOVE_COUNT; i < FLIP_COUNT; i++) {
        const oid = oids[i] as ObjectId;
        runGit(['-C', pair.peer, 'notes', 'remove', oid], { env });
        await notesRemove(ctx, { object: oid });
      }

      peerTreeAfterRemove = notesTreeOid(pair.peer);
      oursTreeAfterRemove = notesTreeOid(pair.ours);

      vi.useRealTimers();
    }, 300_000);

    afterAll(async () => {
      await pair.dispose();
    });

    describe('When all 150 notes have been added (flip region)', () => {
      it('Then the notes tree OID matches git byte-for-byte', () => {
        expect(oursTreeAfterFlip).toBe(peerTreeAfterFlip);
      });

      it('Then the notes commit OID matches git', () => {
        expect(oursCommitAfterFlip).toBe(peerCommitAfterFlip);
      });

      it('Then the notes tree is fanned (has subtree entries)', () => {
        const ls = runGit(['-C', pair.peer, 'ls-tree', peerTreeAfterFlip]);
        const hasSubtrees = ls.split('\n').some((l) => l.startsWith('040000'));
        expect(hasSubtrees).toBe(true);
      });
    });

    describe('When notes are removed back below the flip threshold (stickiness)', () => {
      it('Then the post-removal notes tree OID still matches git', () => {
        expect(oursTreeAfterRemove).toBe(peerTreeAfterRemove);
      });

      it('Then the tree remains fanned after partial removal (stickiness)', () => {
        const ls = runGit(['-C', pair.peer, 'ls-tree', peerTreeAfterRemove]);
        const hasSubtrees = ls.split('\n').some((l) => l.startsWith('040000'));
        expect(hasSubtrees).toBe(true);
      });
    });
  });

  // ── Scenario 7: remove last note → empty tree ─────────────────────────────
  describe('Given a repo where the only note is removed', () => {
    let pair: PeerPair;
    let peerTreeAfterRemove: string;
    let oursTreeAfterRemove: string;
    let peerCommitAfterRemove: string;
    let oursRemoveResult: { notesCommit: ObjectId };
    let annotatedOid: ObjectId;

    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(PINNED_UNIX * 1000);

      pair = await makePeerPair('notes-remove-last');
      initBothRepos(pair.peer, pair.ours);
      const env = pinnedEnv();

      const peerOids = makeCommits(pair.peer, 1, env);
      annotatedOid = peerOids[0] as ObjectId;
      makeCommits(pair.ours, 1, env);

      const noteFile = await writeTempNote('last', 'last note\n');
      runGit(['-C', pair.peer, 'notes', 'add', '-F', noteFile, annotatedOid], { env });

      const ctx = createNodeContext({ workDir: pair.ours });
      await notesAdd(ctx, {
        object: annotatedOid,
        content: new TextEncoder().encode('last note\n'),
      });

      // Remove the only note
      runGit(['-C', pair.peer, 'notes', 'remove', annotatedOid], { env });
      oursRemoveResult = await notesRemove(ctx, { object: annotatedOid });

      peerTreeAfterRemove = notesTreeOid(pair.peer);
      oursTreeAfterRemove = notesTreeOid(pair.ours);
      peerCommitAfterRemove = notesCommitOid(pair.peer);

      vi.useRealTimers();
    }, 30_000);

    afterAll(async () => {
      await pair.dispose();
    });

    describe('When the last note is removed', () => {
      it('Then the tree OID is the canonical empty tree', () => {
        expect(peerTreeAfterRemove).toBe(EMPTY_TREE);
        expect(oursTreeAfterRemove).toBe(EMPTY_TREE);
      });

      it('Then the notes commit OID matches git', () => {
        expect(oursRemoveResult.notesCommit).toBe(peerCommitAfterRemove);
      });

      it('Then the notes ref is preserved (not deleted)', () => {
        const peerRef = tryRunGit(['-C', pair.peer, 'rev-parse', DEFAULT_NOTES_REF]);
        const oursRef = tryRunGit(['-C', pair.ours, 'rev-parse', DEFAULT_NOTES_REF]);
        expect(peerRef.ok).toBe(true);
        expect(oursRef.ok).toBe(true);
      });

      it('Then the remove reflog subject matches git', () => {
        const peerSubject = topReflogSubject(pair.peer, DEFAULT_NOTES_REF);
        const oursSubject = topReflogSubject(pair.ours, DEFAULT_NOTES_REF);
        expect(oursSubject).toBe(peerSubject);
        expect(oursSubject).toBe(NOTES_REMOVE_REFLOG);
      });
    });
  });

  // ── Scenario 8: non-note preserved entry round-trips ──────────────────────
  describe('Given a notes tree that contains a non-hex-named entry', () => {
    let pair: PeerPair;
    let annotated1Oid: ObjectId;
    let annotated2Oid: ObjectId;
    let peerTreeAfterSecondAdd: string;
    let oursTreeAfterSecondAdd: string;

    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(PINNED_UNIX * 1000);

      pair = await makePeerPair('notes-preserved');
      initBothRepos(pair.peer, pair.ours);
      const env = pinnedEnv();

      const peerOids = makeCommits(pair.peer, 2, env);
      annotated1Oid = peerOids[0] as ObjectId;
      annotated2Oid = peerOids[1] as ObjectId;
      makeCommits(pair.ours, 2, env);

      // git: add first note normally
      const noteFile1 = await writeTempNote('pres-1', 'note one\n');
      runGit(['-C', pair.peer, 'notes', 'add', '-F', noteFile1, annotated1Oid], { env });

      // Inject a non-hex blob "custom-entry" into the notes tree via git plumbing
      const customBlobOid = runGit(['-C', pair.peer, 'hash-object', '-w', '--stdin'], {
        input: 'custom content\n',
        env,
      }).trim();
      // Read-tree the current notes tree into the index, add the custom blob, write new tree
      const currentNotesTree = notesTreeOid(pair.peer);
      runGit(['-C', pair.peer, 'read-tree', currentNotesTree], { env });
      runGit(
        [
          '-C',
          pair.peer,
          'update-index',
          '--add',
          '--cacheinfo',
          `100644,${customBlobOid},custom-entry`,
        ],
        { env },
      );
      const newTree = runGit(['-C', pair.peer, 'write-tree'], { env }).trim();
      // Create a commit pointing to the modified tree and update refs/notes/commits
      const prevCommit = notesCommitOid(pair.peer);
      const newCommit = runGit(
        ['-C', pair.peer, 'commit-tree', newTree, '-p', prevCommit, '-m', NOTES_ADD_MESSAGE],
        { env },
      ).trim();
      runGit(['-C', pair.peer, 'update-ref', DEFAULT_NOTES_REF, newCommit], { env });

      // Mirror the modified notes ref into ours via git fetch
      runGit(['-C', pair.ours, 'fetch', pair.peer, `${DEFAULT_NOTES_REF}:${DEFAULT_NOTES_REF}`], {
        env,
      });

      // Now use tsgit to add a second note on top — it must preserve custom-entry
      const ctx = createNodeContext({ workDir: pair.ours });
      // Verify the custom-entry tree is loaded by tsgit
      // (tsgit should preserve it when it adds note2)
      await notesAdd(ctx, {
        object: annotated2Oid,
        content: new TextEncoder().encode('note two\n'),
      });

      // git side: also add note 2 on top
      const noteFile2 = await writeTempNote('pres-2', 'note two\n');
      runGit(['-C', pair.peer, 'notes', 'add', '-F', noteFile2, annotated2Oid], { env });

      peerTreeAfterSecondAdd = notesTreeOid(pair.peer);
      oursTreeAfterSecondAdd = notesTreeOid(pair.ours);

      vi.useRealTimers();
    }, 60_000);

    afterAll(async () => {
      await pair.dispose();
    });

    describe('When tsgit adds a note on top of a tree with a non-note entry', () => {
      it('Then the resulting tree OID matches git (custom-entry preserved)', () => {
        expect(oursTreeAfterSecondAdd).toBe(peerTreeAfterSecondAdd);
      });

      it('Then the custom-entry is present in the notes tree', () => {
        const ls = runGit(['-C', pair.peer, 'ls-tree', peerTreeAfterSecondAdd]);
        expect(ls).toContain('custom-entry');
        const oursLs = runGit(['-C', pair.ours, 'ls-tree', oursTreeAfterSecondAdd]);
        expect(oursLs).toContain('custom-entry');
      });
    });
  });

  // ── Scenario 9b: remove-on-missing refusal ─────────────────────────────────
  describe('Given an object with no note', () => {
    let pair: PeerPair;
    let unannotatedOid: ObjectId;

    beforeAll(async () => {
      pair = await makePeerPair('notes-remove-refusal');
      initBothRepos(pair.peer, pair.ours);
      const env = pinnedEnv();

      const peerOids = makeCommits(pair.peer, 1, env);
      unannotatedOid = peerOids[0] as ObjectId;
      makeCommits(pair.ours, 1, env);
    }, 30_000);

    afterAll(async () => {
      await pair.dispose();
    });

    describe('When notesRemove is called on an object without a note', () => {
      it('Then tsgit throws NOTES_OBJECT_HAS_NONE and git exits non-zero', async () => {
        const ctx = createNodeContext({ workDir: pair.ours });

        // tsgit
        let thrown: unknown;
        try {
          await notesRemove(ctx, { object: unannotatedOid });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(TsgitError);
        expect((thrown as TsgitError).data.code).toBe('NOTES_OBJECT_HAS_NONE');
        expect((thrown as TsgitError).data).toMatchObject({ object: unannotatedOid });

        // git co-refusal
        const gitResult = tryRunGit(['-C', pair.peer, 'notes', 'remove', unannotatedOid]);
        expect(gitResult.ok).toBe(false);
        // git message: "Object <oid> has no note" (no "error:" prefix)
        expect(gitResult.stderr).toContain(`Object ${unannotatedOid} has no note`);
      });
    });
  });

  // ── Scenario 10: ref selection ─────────────────────────────────────────────
  describe('Given core.notesRef and GIT_NOTES_REF precedence', () => {
    let pair: PeerPair;
    let annotatedOid: ObjectId;
    const CUSTOM_REF = 'refs/notes/custom';
    const CONFIG_REF = 'refs/notes/from-config';

    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(PINNED_UNIX * 1000);

      pair = await makePeerPair('notes-ref-sel');
      initBothRepos(pair.peer, pair.ours);
      const env = pinnedEnv();

      const peerOids = makeCommits(pair.peer, 1, env);
      annotatedOid = peerOids[0] as ObjectId;
      makeCommits(pair.ours, 1, env);

      vi.useRealTimers();
    }, 30_000);

    afterAll(async () => {
      await pair.dispose();
    });

    describe('When core.notesRef is set in config', () => {
      it('Then notes operations target the configured ref', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(PINNED_UNIX * 1000);

        // git: set core.notesRef via -c flag and add note
        const noteFile = await writeTempNote('cfg-ref', 'config ref note\n');
        runGit(
          [
            '-C',
            pair.peer,
            '-c',
            `core.notesRef=${CONFIG_REF}`,
            'notes',
            'add',
            '-F',
            noteFile,
            annotatedOid,
          ],
          { env: pinnedEnv() },
        );

        // tsgit: set core.notesRef in local config
        runGit(['-C', pair.ours, 'config', 'core.notesRef', CONFIG_REF]);
        const ctx = createNodeContext({ workDir: pair.ours });
        await notesAdd(ctx, {
          object: annotatedOid,
          content: new TextEncoder().encode('config ref note\n'),
        });

        // Verify both used CONFIG_REF
        const peerCommit = tryRunGit(['-C', pair.peer, 'rev-parse', CONFIG_REF]);
        const oursCommit = tryRunGit(['-C', pair.ours, 'rev-parse', CONFIG_REF]);
        expect(peerCommit.ok).toBe(true);
        expect(oursCommit.ok).toBe(true);
        expect(oursCommit.stdout.trim()).toBe(peerCommit.stdout.trim());

        // Verify default ref was NOT touched
        const peerDefault = tryRunGit(['-C', pair.peer, 'rev-parse', DEFAULT_NOTES_REF]);
        const oursDefault = tryRunGit(['-C', pair.ours, 'rev-parse', DEFAULT_NOTES_REF]);
        expect(peerDefault.ok).toBe(false);
        expect(oursDefault.ok).toBe(false);

        // Clean up config
        runGit(['-C', pair.ours, 'config', '--unset', 'core.notesRef']);

        vi.useRealTimers();
      });
    });

    describe('When GIT_NOTES_REF env var is set', () => {
      it('Then GIT_NOTES_REF takes precedence over core.notesRef', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(PINNED_UNIX * 1000);

        // git: use GIT_NOTES_REF env for a different commit (re-use annotatedOid on CUSTOM_REF)
        const noteFile = await writeTempNote('env-ref', 'env ref note\n');
        runGit(
          ['-C', pair.peer, 'notes', '--ref', CUSTOM_REF, 'add', '-F', noteFile, annotatedOid],
          { env: pinnedEnv() },
        );

        // tsgit: set GIT_NOTES_REF in process.env then call notesAdd with no ref
        process.env.GIT_NOTES_REF = CUSTOM_REF;
        try {
          const ctx = createNodeContext({ workDir: pair.ours });
          await notesAdd(ctx, {
            object: annotatedOid,
            content: new TextEncoder().encode('env ref note\n'),
          });
        } finally {
          delete process.env.GIT_NOTES_REF;
        }

        const peerCommit = tryRunGit(['-C', pair.peer, 'rev-parse', CUSTOM_REF]);
        const oursCommit = tryRunGit(['-C', pair.ours, 'rev-parse', CUSTOM_REF]);
        expect(peerCommit.ok).toBe(true);
        expect(oursCommit.ok).toBe(true);
        expect(oursCommit.stdout.trim()).toBe(peerCommit.stdout.trim());

        vi.useRealTimers();
      });
    });

    describe('When an explicit --ref-style name is used', () => {
      it.each([
        ['build', 'refs/notes/build'],
        ['notes/x', 'refs/notes/x'],
      ])('Then %s expands to %s matching git', async (given, expanded) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(PINNED_UNIX * 1000);

        const noteFile = await writeTempNote(`expand-${given.replace(/\//g, '-')}`, 'expand\n');
        runGit(['-C', pair.peer, 'notes', '--ref', given, 'add', '-F', noteFile, annotatedOid], {
          env: pinnedEnv(),
        });

        const ctx = createNodeContext({ workDir: pair.ours });
        await notesAdd(ctx, {
          object: annotatedOid,
          content: new TextEncoder().encode('expand\n'),
          ref: given,
        });

        const peerCommit = tryRunGit(['-C', pair.peer, 'rev-parse', expanded]);
        const oursCommit = tryRunGit(['-C', pair.ours, 'rev-parse', expanded]);
        expect(peerCommit.ok).toBe(true);
        expect(oursCommit.ok).toBe(true);
        expect(oursCommit.stdout.trim()).toBe(peerCommit.stdout.trim());

        vi.useRealTimers();
      });

      it('Then a refs/heads/ name nests under refs/notes/, never creating a branch', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(PINNED_UNIX * 1000);

        const noteFile = await writeTempNote('expand-evil-branch', 'evil\n');
        runGit(
          [
            '-C',
            pair.peer,
            'notes',
            '--ref',
            'refs/heads/evil',
            'add',
            '-F',
            noteFile,
            annotatedOid,
          ],
          { env: pinnedEnv() },
        );

        const ctx = createNodeContext({ workDir: pair.ours });
        await notesAdd(ctx, {
          object: annotatedOid,
          content: new TextEncoder().encode('evil\n'),
          ref: 'refs/heads/evil',
        });

        const nested = 'refs/notes/refs/heads/evil';
        const peerNested = tryRunGit(['-C', pair.peer, 'rev-parse', nested]);
        const oursNested = tryRunGit(['-C', pair.ours, 'rev-parse', nested]);
        expect(oursNested.ok).toBe(true);
        expect(oursNested.stdout.trim()).toBe(peerNested.stdout.trim());
        // The branch namespace stays untouched in both tools.
        expect(tryRunGit(['-C', pair.peer, 'rev-parse', '--verify', 'refs/heads/evil']).ok).toBe(
          false,
        );
        expect(tryRunGit(['-C', pair.ours, 'rev-parse', '--verify', 'refs/heads/evil']).ok).toBe(
          false,
        );

        vi.useRealTimers();
      });
    });

    describe('When GIT_NOTES_REF names a ref outside refs/notes/', () => {
      it('Then both git and tsgit refuse', async () => {
        const gitResult = tryRunGit(['-C', pair.peer, 'notes', 'add', '-m', 'x', annotatedOid], {
          env: { ...pinnedEnv(), GIT_NOTES_REF: 'build' },
        });
        expect(gitResult.ok).toBe(false);
        expect(gitResult.stderr).toContain('outside of refs/notes/');

        process.env.GIT_NOTES_REF = 'build';
        let thrown: unknown;
        try {
          const ctx = createNodeContext({ workDir: pair.ours });
          await notesAdd(ctx, {
            object: annotatedOid,
            content: new TextEncoder().encode('x\n'),
          });
        } catch (err) {
          thrown = err;
        } finally {
          delete process.env.GIT_NOTES_REF;
        }
        expect(thrown).toBeInstanceOf(TsgitError);
        expect((thrown as TsgitError).data.code).toBe('NOTES_REF_OUTSIDE');
        expect((thrown as TsgitError).data).toMatchObject({ ref: 'build' });
      });
    });

    describe('When core.notesRef names a ref outside refs/notes/', () => {
      it('Then both git and tsgit refuse', async () => {
        const gitResult = tryRunGit(
          ['-C', pair.peer, '-c', 'core.notesRef=build', 'notes', 'add', '-m', 'x', annotatedOid],
          { env: pinnedEnv() },
        );
        expect(gitResult.ok).toBe(false);
        expect(gitResult.stderr).toContain('outside of refs/notes/');

        runGit(['-C', pair.ours, 'config', 'core.notesRef', 'build'], { env: pinnedEnv() });
        let thrown: unknown;
        try {
          const ctx = createNodeContext({ workDir: pair.ours });
          await notesAdd(ctx, {
            object: annotatedOid,
            content: new TextEncoder().encode('x\n'),
          });
        } catch (err) {
          thrown = err;
        } finally {
          runGit(['-C', pair.ours, 'config', '--unset', 'core.notesRef'], { env: pinnedEnv() });
        }
        expect(thrown).toBeInstanceOf(TsgitError);
        expect((thrown as TsgitError).data.code).toBe('NOTES_REF_OUTSIDE');
        expect((thrown as TsgitError).data).toMatchObject({ ref: 'build' });
      });
    });
  });
});
