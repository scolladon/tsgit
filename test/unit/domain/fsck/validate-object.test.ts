import { describe, expect, it } from 'vitest';
import { MSG_EXTRA_HEADER_ENTRY } from '../../../../src/domain/fsck/msg-ids.js';
import { resolveSeverity } from '../../../../src/domain/fsck/severity.js';
import { validateObject } from '../../../../src/domain/fsck/validate-object.js';
import { encode } from '../../../../src/domain/objects/encoding.js';

// ---------------------------------------------------------------------------
// Raw tree-entry builder helpers
// ---------------------------------------------------------------------------

function sha(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

const BLOB_SHA_HEX = 'd670460b4b4aece5915caf5c68d12f560a9fe3e4';
const BLOB_SHA = sha(BLOB_SHA_HEX);
const NULL_SHA = new Uint8Array(20);
const EMPTY_TREE_SHA = sha('4b825dc642cb6eb9a060e54bf8d69288fbee4904');

function buildTreeEntry(mode: string, name: string, rawSha: Uint8Array): Uint8Array {
  const modeBytes = encode(mode);
  const nameBytes = encode(name);
  const entry = new Uint8Array(modeBytes.length + 1 + nameBytes.length + 1 + rawSha.length);
  let offset = 0;
  entry.set(modeBytes, offset);
  offset += modeBytes.length;
  entry[offset++] = 0x20;
  entry.set(nameBytes, offset);
  offset += nameBytes.length;
  entry[offset++] = 0x00;
  entry.set(rawSha, offset);
  return entry;
}

function buildTree(...entries: Uint8Array[]): Uint8Array {
  const total = entries.reduce((sum, e) => sum + e.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const entry of entries) {
    result.set(entry, offset);
    offset += entry.length;
  }
  return result;
}

function buildCommit(options: {
  tree?: string;
  parents?: string[];
  author?: string;
  committer?: string;
  message?: string;
}): Uint8Array {
  const lines: string[] = [];
  if (options.tree !== undefined) lines.push(`tree ${options.tree}`);
  for (const p of options.parents ?? []) lines.push(`parent ${p}`);
  if (options.author !== undefined) lines.push(`author ${options.author}`);
  if (options.committer !== undefined) lines.push(`committer ${options.committer}`);
  const body = `${lines.join('\n')}\n\n${options.message ?? 'msg\n'}`;
  return encode(body);
}

function buildTag(options: {
  object?: string;
  type?: string;
  tag?: string;
  tagger?: string;
  extra?: string;
  message?: string;
}): Uint8Array {
  const lines: string[] = [];
  if (options.object !== undefined) lines.push(`object ${options.object}`);
  if (options.type !== undefined) lines.push(`type ${options.type}`);
  if (options.tag !== undefined) lines.push(`tag ${options.tag}`);
  if (options.tagger !== undefined) lines.push(`tagger ${options.tagger}`);
  if (options.extra !== undefined) lines.push(options.extra);
  const body = `${lines.join('\n')}\n\n${options.message ?? 'msg\n'}`;
  return encode(body);
}

const VALID_IDENTITY = 'Test User <test@example.com> 1234567890 +0000';
const VALID_COMMIT = buildCommit({
  tree: EMPTY_TREE_SHA.reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''),
  author: VALID_IDENTITY,
  committer: VALID_IDENTITY,
});
const VALID_TAG = buildTag({
  object: BLOB_SHA_HEX,
  type: 'blob',
  tag: 'v1.0',
  tagger: VALID_IDENTITY,
});

// ---------------------------------------------------------------------------
// tree — zeroPaddedFilemode
// ---------------------------------------------------------------------------

describe('Given tree with zero-padded filemode', () => {
  describe('When validateObject runs with default severity', () => {
    it('Then emits zeroPaddedFilemode at warning severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('0100644', 'file.txt', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'zeroPaddedFilemode', severity: 'warning' });
    });
  });

  describe('When validateObject runs with strict mode', () => {
    it('Then emits zeroPaddedFilemode at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('0100644', 'file.txt', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: true });

      // Assert
      expect(result).toContainEqual({ msgId: 'zeroPaddedFilemode', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — treeNotSorted (ERROR, not upgraded by strict)
// ---------------------------------------------------------------------------

describe('Given tree with entries in wrong sort order', () => {
  describe('When validateObject runs with default severity', () => {
    it('Then emits treeNotSorted at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(
        buildTreeEntry('100644', 'z-file', BLOB_SHA),
        buildTreeEntry('100644', 'a-file', BLOB_SHA),
      );

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'treeNotSorted', severity: 'error' });
    });
  });

  describe('When validateObject runs with strict mode', () => {
    it('Then emits treeNotSorted at error severity unchanged', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(
        buildTreeEntry('100644', 'z-file', BLOB_SHA),
        buildTreeEntry('100644', 'a-file', BLOB_SHA),
      );

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: true });

      // Assert
      expect(result).toContainEqual({ msgId: 'treeNotSorted', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — missingSpaceBeforeEmail (ERROR, not upgraded)
// ---------------------------------------------------------------------------

describe('Given commit with missing space before email', () => {
  describe('When validateObject runs on commit', () => {
    it('Then emits missingSpaceBeforeEmail at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'Test<test@example.com> 1234567890 +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingSpaceBeforeEmail', severity: 'error' });
    });
  });

  describe('When validateObject runs on commit with strict mode', () => {
    it('Then emits missingSpaceBeforeEmail at error severity unchanged', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'Test<test@example.com> 1234567890 +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: true });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingSpaceBeforeEmail', severity: 'error' });
    });
  });
});

describe('Given tag with missing space before email in tagger', () => {
  describe('When validateObject runs on tag', () => {
    it('Then emits missingSpaceBeforeEmail at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTag({
        object: BLOB_SHA_HEX,
        type: 'blob',
        tag: 'v1.0',
        tagger: 'Test<test@example.com> 1234567890 +0000',
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingSpaceBeforeEmail', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tag — missingTaggerEntry (INFO, not upgraded by strict)
// ---------------------------------------------------------------------------

describe('Given tag without tagger entry', () => {
  describe('When validateObject runs on tag', () => {
    it('Then emits missingTaggerEntry at info severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTag({
        object: BLOB_SHA_HEX,
        type: 'blob',
        tag: 'v1.0',
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingTaggerEntry', severity: 'info' });
    });
  });

  describe('When validateObject runs on tag with strict mode', () => {
    it('Then emits missingTaggerEntry at info severity unchanged', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTag({
        object: BLOB_SHA_HEX,
        type: 'blob',
        tag: 'v1.0',
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: true });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingTaggerEntry', severity: 'info' });
    });
  });
});

// ---------------------------------------------------------------------------
// Valid objects return no findings
// ---------------------------------------------------------------------------

describe('Given a valid commit object', () => {
  describe('When validateObject runs', () => {
    it('Then returns empty findings', () => {
      // Arrange
      const sut = validateObject;

      // Act
      const result = sut({ kind: 'commit', rawBody: VALID_COMMIT, strict: false });

      // Assert
      expect(result).toHaveLength(0);
    });
  });
});

describe('Given a valid tag object', () => {
  describe('When validateObject runs', () => {
    it('Then returns empty findings', () => {
      // Arrange
      const sut = validateObject;

      // Act
      const result = sut({ kind: 'tag', rawBody: VALID_TAG, strict: false });

      // Assert
      expect(result).toHaveLength(0);
    });
  });
});

describe('Given a valid tree object', () => {
  describe('When validateObject runs', () => {
    it('Then returns empty findings', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('100644', 'file.txt', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toHaveLength(0);
    });
  });
});

describe('Given a valid blob object', () => {
  describe('When validateObject runs', () => {
    it('Then returns empty findings', () => {
      // Arrange
      const sut = validateObject;

      // Act
      const result = sut({ kind: 'blob', rawBody: encode('hello world\n'), strict: false });

      // Assert
      expect(result).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tree — emptyName (WARN → error under strict)
// ---------------------------------------------------------------------------

describe('Given tree with empty entry name', () => {
  describe('When validateObject runs with default severity', () => {
    it('Then emits emptyName at warning severity', () => {
      // Arrange
      const sut = validateObject;
      // entry: "100644 \0<sha>" — name is empty string
      const rawBytes = buildTree(buildTreeEntry('100644', '', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'emptyName', severity: 'warning' });
    });
  });

  describe('When validateObject runs with strict mode', () => {
    it('Then emits emptyName at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('100644', '', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: true });

      // Assert
      expect(result).toContainEqual({ msgId: 'emptyName', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — hasDot (WARN → error under strict)
// ---------------------------------------------------------------------------

describe('Given tree with entry named "."', () => {
  describe('When validateObject runs with default severity', () => {
    it('Then emits hasDot at warning severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('100644', '.', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'hasDot', severity: 'warning' });
    });
  });

  describe('When validateObject runs with strict mode', () => {
    it('Then emits hasDot at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('100644', '.', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: true });

      // Assert
      expect(result).toContainEqual({ msgId: 'hasDot', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — hasDotdot (WARN → error under strict)
// ---------------------------------------------------------------------------

describe('Given tree with entry named ".."', () => {
  describe('When validateObject runs with default severity', () => {
    it('Then emits hasDotdot at warning severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('100644', '..', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'hasDotdot', severity: 'warning' });
    });
  });

  describe('When validateObject runs with strict mode', () => {
    it('Then emits hasDotdot at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('100644', '..', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: true });

      // Assert
      expect(result).toContainEqual({ msgId: 'hasDotdot', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — hasDotgit (WARN → error under strict)
// ---------------------------------------------------------------------------

describe('Given tree with entry named ".git"', () => {
  describe('When validateObject runs with default severity', () => {
    it('Then emits hasDotgit at warning severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('100644', '.git', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'hasDotgit', severity: 'warning' });
    });
  });

  describe('When validateObject runs with strict mode', () => {
    it('Then emits hasDotgit at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('100644', '.git', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: true });

      // Assert
      expect(result).toContainEqual({ msgId: 'hasDotgit', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — fullPathname (WARN → error under strict)
// ---------------------------------------------------------------------------

describe('Given tree with entry name containing "/"', () => {
  describe('When validateObject runs with default severity', () => {
    it('Then emits fullPathname at warning severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('100644', 'foo/bar', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'fullPathname', severity: 'warning' });
    });
  });

  describe('When validateObject runs with strict mode', () => {
    it('Then emits fullPathname at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('100644', 'foo/bar', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: true });

      // Assert
      expect(result).toContainEqual({ msgId: 'fullPathname', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — nullSha1 (WARN → error under strict)
// ---------------------------------------------------------------------------

describe('Given tree with null SHA1 entry', () => {
  describe('When validateObject runs with default severity', () => {
    it('Then emits nullSha1 at warning severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('100644', 'file', NULL_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'nullSha1', severity: 'warning' });
    });
  });

  describe('When validateObject runs with strict mode', () => {
    it('Then emits nullSha1 at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('100644', 'file', NULL_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: true });

      // Assert
      expect(result).toContainEqual({ msgId: 'nullSha1', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — largePathname (WARN → error under strict)
// ---------------------------------------------------------------------------

describe('Given tree with entry name exceeding 4096 bytes', () => {
  describe('When validateObject runs with default severity', () => {
    it('Then emits largePathname at warning severity', () => {
      // Arrange
      const sut = validateObject;
      const longName = 'a'.repeat(4097);
      const rawBytes = buildTree(buildTreeEntry('100644', longName, BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'largePathname', severity: 'warning' });
    });
  });

  describe('When validateObject runs with strict mode', () => {
    it('Then emits largePathname at error severity', () => {
      // Arrange
      const sut = validateObject;
      const longName = 'a'.repeat(4097);
      const rawBytes = buildTree(buildTreeEntry('100644', longName, BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: true });

      // Assert
      expect(result).toContainEqual({ msgId: 'largePathname', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — nulInCommit (WARN → error under strict) on commit body
// ---------------------------------------------------------------------------

describe('Given commit with NUL byte in message body', () => {
  describe('When validateObject runs with default severity', () => {
    it('Then emits nulInCommit at warning severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = encode(
        `tree ${BLOB_SHA_HEX}\nauthor ${VALID_IDENTITY}\ncommitter ${VALID_IDENTITY}\n\nmessage\x00here\n`,
      );

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'nulInCommit', severity: 'warning' });
    });
  });

  describe('When validateObject runs with strict mode', () => {
    it('Then emits nulInCommit at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = encode(
        `tree ${BLOB_SHA_HEX}\nauthor ${VALID_IDENTITY}\ncommitter ${VALID_IDENTITY}\n\nmessage\x00here\n`,
      );

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: true });

      // Assert
      expect(result).toContainEqual({ msgId: 'nulInCommit', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — badFilemode (INFO, not upgraded)
// ---------------------------------------------------------------------------

describe('Given tree with unknown file mode', () => {
  describe('When validateObject runs', () => {
    it('Then emits badFilemode at info severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('100666', 'file', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badFilemode', severity: 'info' });
    });
  });

  describe('When validateObject runs with strict mode', () => {
    it('Then emits badFilemode at info severity unchanged', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('100666', 'file', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: true });

      // Assert
      expect(result).toContainEqual({ msgId: 'badFilemode', severity: 'info' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — duplicateEntries (ERROR)
// ---------------------------------------------------------------------------

describe('Given tree with duplicate entry names', () => {
  describe('When validateObject runs', () => {
    it('Then emits duplicateEntries at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(
        buildTreeEntry('100644', 'file', BLOB_SHA),
        buildTreeEntry('100644', 'file', BLOB_SHA),
      );

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'duplicateEntries', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — badTree (ERROR) — truncated/unparseable tree
// ---------------------------------------------------------------------------

describe('Given tree with truncated content', () => {
  describe('When validateObject runs', () => {
    it('Then emits badTree at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = encode('100644 incomplete');

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badTree', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — gitmodulesSymlink (ERROR): .gitmodules entry is a symlink
// ---------------------------------------------------------------------------

describe('Given tree where .gitmodules is a symlink', () => {
  describe('When validateObject runs', () => {
    it('Then emits gitmodulesSymlink at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('120000', '.gitmodules', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'gitmodulesSymlink', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — gitattributesSymlink (INFO): .gitattributes entry is a symlink
// ---------------------------------------------------------------------------

describe('Given tree where .gitattributes is a symlink', () => {
  describe('When validateObject runs', () => {
    it('Then emits gitattributesSymlink at info severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('120000', '.gitattributes', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'gitattributesSymlink', severity: 'info' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — gitignoreSymlink (INFO): .gitignore entry is a symlink
// ---------------------------------------------------------------------------

describe('Given tree where .gitignore is a symlink', () => {
  describe('When validateObject runs', () => {
    it('Then emits gitignoreSymlink at info severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('120000', '.gitignore', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'gitignoreSymlink', severity: 'info' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — mailmapSymlink (INFO): .mailmap entry is a symlink
// ---------------------------------------------------------------------------

describe('Given tree where .mailmap is a symlink', () => {
  describe('When validateObject runs', () => {
    it('Then emits mailmapSymlink at info severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('120000', '.mailmap', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'mailmapSymlink', severity: 'info' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — gitmodulesBlob (ERROR): .gitmodules is not a regular file
// ---------------------------------------------------------------------------

describe('Given tree where .gitmodules is a directory (non-blob)', () => {
  describe('When validateObject runs', () => {
    it('Then emits gitmodulesBlob at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('40000', '.gitmodules', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'gitmodulesBlob', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — gitattributesBlob (ERROR): .gitattributes is not a regular file
// ---------------------------------------------------------------------------

describe('Given tree where .gitattributes is a directory (non-blob)', () => {
  describe('When validateObject runs', () => {
    it('Then emits gitattributesBlob at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('40000', '.gitattributes', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'gitattributesBlob', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — missingTree (ERROR)
// ---------------------------------------------------------------------------

describe('Given commit without tree line', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingTree at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildCommit({
        author: VALID_IDENTITY,
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingTree', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — missingAuthor (ERROR)
// ---------------------------------------------------------------------------

describe('Given commit without author line', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingAuthor at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingAuthor', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — missingCommitter (ERROR)
// ---------------------------------------------------------------------------

describe('Given commit without committer line', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingCommitter at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingCommitter', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — multipleAuthors (ERROR)
// ---------------------------------------------------------------------------

describe('Given commit with multiple author lines', () => {
  describe('When validateObject runs', () => {
    it('Then emits multipleAuthors at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = encode(
        `tree ${BLOB_SHA_HEX}\nauthor A <a@b.com> 1234567890 +0000\nauthor B <b@c.com> 1234567890 +0000\ncommitter ${VALID_IDENTITY}\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'multipleAuthors', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — nulInHeader (FATAL: error severity)
// ---------------------------------------------------------------------------

describe('Given commit with NUL byte in header', () => {
  describe('When validateObject runs', () => {
    it('Then emits nulInHeader at error severity', () => {
      // Arrange
      const sut = validateObject;
      // NUL in author name within the header section
      const rawBytes = encode(
        `tree ${BLOB_SHA_HEX}\nauthor T\x00est <t@t.com> 1234567890 +0000\ncommitter ${VALID_IDENTITY}\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'nulInHeader', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — zeroPaddedDate (ERROR)
// ---------------------------------------------------------------------------

describe('Given commit with zero-padded timestamp', () => {
  describe('When validateObject runs', () => {
    it('Then emits zeroPaddedDate at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> 01234567890 +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'zeroPaddedDate', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — badDate (ERROR)
// ---------------------------------------------------------------------------

describe('Given commit with non-numeric timestamp', () => {
  describe('When validateObject runs', () => {
    it('Then emits badDate at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> abc +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badDate', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — badTimezone (ERROR)
// ---------------------------------------------------------------------------

describe('Given commit with invalid timezone offset', () => {
  describe('When validateObject runs', () => {
    it('Then emits badTimezone at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> 1234567890 +99999',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badTimezone', severity: 'error' });
    });
  });
});

describe('Given commit with timezone that matches format but has out-of-range hours', () => {
  describe('When validateObject runs', () => {
    it('Then emits badTimezone at error severity (hours >= 24)', () => {
      // Arrange
      const sut = validateObject;
      // +9900 passes TIMEZONE_RE (/^[+-]\d{4}$/) but hours=99 >= 24 →
      // hours < 24 is false → && short-circuits → isValidTimezone returns false.
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> 1234567890 +9900',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badTimezone', severity: 'error' });
    });
  });
});

describe('Given commit with timezone that matches format but has out-of-range minutes', () => {
  describe('When validateObject runs', () => {
    it('Then emits badTimezone at error severity (minutes >= 60)', () => {
      // Arrange
      const sut = validateObject;
      // +0099 passes TIMEZONE_RE but hours=0 < 24 and minutes=99 >= 60 →
      // hours < 24 is true, minutes < 60 is false → isValidTimezone returns false.
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> 1234567890 +0099',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badTimezone', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — missingSpaceBeforeDate (ERROR)
// ---------------------------------------------------------------------------

describe('Given commit with no space between email and date', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingSpaceBeforeDate at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com>1234567890 +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingSpaceBeforeDate', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — missingEmail (ERROR)
// ---------------------------------------------------------------------------

describe('Given commit with no email angle brackets in author', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingEmail at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'TestName 1234567890 +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingEmail', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — missingNameBeforeEmail (ERROR)
// ---------------------------------------------------------------------------

describe('Given commit with no name before email', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingNameBeforeEmail at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: '<t@t.com> 1234567890 +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingNameBeforeEmail', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — badParentSha1 (ERROR)
// ---------------------------------------------------------------------------

describe('Given commit with invalid parent SHA1', () => {
  describe('When validateObject runs', () => {
    it('Then emits badParentSha1 at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = encode(
        `tree ${BLOB_SHA_HEX}\nparent ${'Z'.repeat(40)}\nauthor ${VALID_IDENTITY}\ncommitter ${VALID_IDENTITY}\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badParentSha1', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — badTreeSha1 (ERROR)
// ---------------------------------------------------------------------------

describe('Given commit with invalid tree SHA1', () => {
  describe('When validateObject runs', () => {
    it('Then emits badTreeSha1 at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = encode(
        `tree ${'Z'.repeat(40)}\nauthor ${VALID_IDENTITY}\ncommitter ${VALID_IDENTITY}\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badTreeSha1', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tag — missingObject (ERROR)
// ---------------------------------------------------------------------------

describe('Given tag without object line', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingObject at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTag({
        type: 'blob',
        tag: 'v1.0',
        tagger: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingObject', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tag — missingType (ERROR)
// ---------------------------------------------------------------------------

describe('Given tag without type line', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingType at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTag({
        object: BLOB_SHA_HEX,
        tag: 'v1.0',
        tagger: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingType', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tag — missingTypeEntry (ERROR): type line present but empty
// ---------------------------------------------------------------------------

describe('Given tag with empty type value', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingTypeEntry at error severity', () => {
      // Arrange
      const sut = validateObject;
      // "type \n" — type header present but empty value
      const rawBytes = encode(
        `object ${BLOB_SHA_HEX}\ntype \ntag v1.0\ntagger ${VALID_IDENTITY}\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingTypeEntry', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tag — missingTag (ERROR)
// ---------------------------------------------------------------------------

describe('Given tag without tag-name line', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingTag at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTag({
        object: BLOB_SHA_HEX,
        type: 'blob',
        tagger: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingTag', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tag — missingTagEntry (ERROR): tag line present but empty name
// ---------------------------------------------------------------------------

describe('Given tag with empty tag name', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingTagEntry at error severity', () => {
      // Arrange
      const sut = validateObject;
      // "tag \n" — tag header present but empty value
      const rawBytes = encode(
        `object ${BLOB_SHA_HEX}\ntype blob\ntag \ntagger ${VALID_IDENTITY}\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingTagEntry', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tag — badTagName (INFO)
// ---------------------------------------------------------------------------

describe('Given tag with tag name containing NUL', () => {
  describe('When validateObject runs', () => {
    it('Then emits badTagName at info severity', () => {
      // Arrange
      const sut = validateObject;
      // tag name with NUL is invalid
      const rawBytes = encode(
        `object ${BLOB_SHA_HEX}\ntype blob\ntag bad\x00name\ntagger ${VALID_IDENTITY}\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badTagName', severity: 'info' });
    });
  });

  describe('When validateObject runs with strict mode', () => {
    it('Then emits badTagName at info severity unchanged', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = encode(
        `object ${BLOB_SHA_HEX}\ntype blob\ntag bad\x00name\ntagger ${VALID_IDENTITY}\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: true });

      // Assert
      expect(result).toContainEqual({ msgId: 'badTagName', severity: 'info' });
    });
  });
});

// ---------------------------------------------------------------------------
// tag — badObjectSha1 (ERROR)
// ---------------------------------------------------------------------------

describe('Given tag with invalid object SHA1', () => {
  describe('When validateObject runs', () => {
    it('Then emits badObjectSha1 at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTag({
        object: 'Z'.repeat(40),
        type: 'blob',
        tag: 'v1.0',
        tagger: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badObjectSha1', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tag — extraHeaderEntry (IGNORE — not emitted by default)
// ---------------------------------------------------------------------------

describe('Given tag with extra unknown header', () => {
  describe('When validateObject runs', () => {
    it('Then does not emit extraHeaderEntry (IGNORE severity)', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTag({
        object: BLOB_SHA_HEX,
        type: 'blob',
        tag: 'v1.0',
        tagger: VALID_IDENTITY,
        extra: 'foo bar',
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result.map((f) => f.msgId)).not.toContain(MSG_EXTRA_HEADER_ENTRY);
    });
  });
});

// ---------------------------------------------------------------------------
// blob — gitmodulesName (ERROR)
// ---------------------------------------------------------------------------

describe('Given .gitmodules blob with invalid submodule name', () => {
  describe('When validateObject runs', () => {
    it('Then emits gitmodulesName at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = encode('[submodule ".."]\n\tpath = foo\n\turl = https://example.com\n');

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitmodules',
      });

      // Assert
      expect(result).toContainEqual({ msgId: 'gitmodulesName', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// blob — gitmodulesUrl (ERROR)
// Pinned real git 2.54.0: URLs starting with '-' trigger gitmodulesUrl
// ---------------------------------------------------------------------------

describe('Given .gitmodules blob with a disallowed URL (starts with --)', () => {
  describe('When validateObject runs', () => {
    it('Then emits gitmodulesUrl at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = encode('[submodule "evil"]\n\tpath = evil\n\turl = --upload-pack=evil\n');

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitmodules',
      });

      // Assert
      expect(result).toContainEqual({ msgId: 'gitmodulesUrl', severity: 'error' });
    });
  });
});

describe('Given .gitmodules blob with a single-dash URL (starts with -)', () => {
  describe('When validateObject runs', () => {
    it('Then emits gitmodulesUrl at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = encode('[submodule "sub"]\n\tpath = sub\n\turl = -evil-url\n');

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitmodules',
      });

      // Assert
      expect(result).toContainEqual({ msgId: 'gitmodulesUrl', severity: 'error' });
    });
  });
});

describe('Given .gitmodules blob with a safe URL (https://)', () => {
  describe('When validateObject runs', () => {
    it('Then does NOT emit gitmodulesUrl', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = encode(
        '[submodule "sub"]\n\tpath = sub\n\turl = https://example.com/repo.git\n',
      );

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitmodules',
      });

      // Assert — safe URL must not produce gitmodulesUrl
      expect(result.map((f) => f.msgId)).not.toContain('gitmodulesUrl');
    });
  });
});

// ---------------------------------------------------------------------------
// blob — gitmodulesParse (INFO)
// ---------------------------------------------------------------------------

describe('Given .gitmodules blob with parse error', () => {
  describe('When validateObject runs', () => {
    it('Then emits gitmodulesParse at info severity', () => {
      // Arrange
      const sut = validateObject;
      // Invalid INI syntax — unclosed section header
      const rawBytes = encode('[not-a-valid-section\n\tpath = foo\n');

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitmodules',
      });

      // Assert
      expect(result).toContainEqual({ msgId: 'gitmodulesParse', severity: 'info' });
    });
  });
});

// ---------------------------------------------------------------------------
// blob — .gitmodules line without '=' sign (silent skip branch)
// ---------------------------------------------------------------------------

describe('Given .gitmodules blob with a bare key line (no = sign)', () => {
  describe('When validateObject runs', () => {
    it('Then emits no findings (bare key is silently ignored)', () => {
      // Arrange
      const sut = validateObject;
      // A line that is not a comment, not a section header, and has no '='
      // exercises the silent-skip branch inside processGitmodulesLine.
      const rawBytes = encode(
        '[submodule "sub"]\n\tpath = sub\n\turl = https://example.com/repo.git\n\tbarekey\n',
      );

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitmodules',
      });

      // Assert — bare key does not trigger gitmodulesUrl or gitmodulesParse
      expect(result).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// blob — gitattributesLineLength (ERROR)
// ---------------------------------------------------------------------------

describe('Given .gitattributes blob with line exceeding 2048 bytes', () => {
  describe('When validateObject runs', () => {
    it('Then emits gitattributesLineLength at error severity', () => {
      // Arrange
      const sut = validateObject;
      const longLine = `*.txt ${'key=val '.repeat(300)}`; // well over 2048 bytes
      const rawBytes = encode(`${longLine}\n`);

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitattributes',
      });

      // Assert
      expect(result).toContainEqual({ msgId: 'gitattributesLineLength', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// blob — no false positives for valid .gitmodules
// ---------------------------------------------------------------------------

describe('Given valid .gitmodules blob', () => {
  describe('When validateObject runs', () => {
    it('Then returns no gitmodules findings', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = encode(
        '[submodule "valid"]\n\tpath = sub\n\turl = https://example.com/repo\n',
      );

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitmodules',
      });

      // Assert
      const gitmodulesFindings = result.filter((f) => f.msgId.startsWith('gitmodules'));
      expect(gitmodulesFindings).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// blob — no false positives for valid .gitattributes
// ---------------------------------------------------------------------------

describe('Given valid .gitattributes blob', () => {
  describe('When validateObject runs', () => {
    it('Then returns no gitattributes findings', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = encode('*.ts text eol=lf\n*.png binary\n');

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitattributes',
      });

      // Assert
      const gitattributesFindings = result.filter((f) => f.msgId.startsWith('gitattributes'));
      expect(gitattributesFindings).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Strict-upgrade invariant: INFO ids are NOT upgraded
// ---------------------------------------------------------------------------

describe('Given an INFO severity id (badFilemode) with strict mode', () => {
  describe('When validateObject runs', () => {
    it('Then severity remains info, not upgraded to error', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('100666', 'file', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: true });

      // Assert
      const finding = result.find((f) => f.msgId === 'badFilemode');
      expect(finding?.severity).toBe('info');
    });
  });
});

// ---------------------------------------------------------------------------
// severity — resolveSeverity fallback for unknown msgId
// ---------------------------------------------------------------------------

describe('Given an unknown msgId not in the default-severity catalogue', () => {
  describe('When resolveSeverity is called', () => {
    it('Then returns error as the default fallback', () => {
      // Arrange
      const sut = resolveSeverity;

      // Act
      const result = sut('totallyUnknownMsgId', false);

      // Assert
      expect(result).toBe('error');
    });
  });

  describe('When resolveSeverity is called with strict:true', () => {
    it('Then still returns error (no upgrade possible for unknown id)', () => {
      // Arrange
      const sut = resolveSeverity;

      // Act
      const result = sut('totallyUnknownMsgId', true);

      // Assert
      expect(result).toBe('error');
    });
  });
});

// ---------------------------------------------------------------------------
// blob — gitmodulesLarge (ERROR): blob size exceeds 100 MiB limit
// ---------------------------------------------------------------------------

describe('Given .gitmodules blob exceeding 100 MiB', () => {
  describe('When validateObject runs', () => {
    it('Then emits gitmodulesLarge at error severity and returns immediately', () => {
      // Arrange
      const sut = validateObject;
      // Allocate exactly one byte over the 100 MiB limit (all zeros = valid INI by
      // default, but the size guard fires first before any content parsing).
      const rawBytes = new Uint8Array(100 * 1024 * 1024 + 1);

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitmodules',
      });

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ msgId: 'gitmodulesLarge', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// blob — gitattributesLarge (ERROR): blob size exceeds 100 MiB limit
// ---------------------------------------------------------------------------

describe('Given .gitattributes blob exceeding 100 MiB', () => {
  describe('When validateObject runs', () => {
    it('Then emits gitattributesLarge at error severity and returns immediately', () => {
      // Arrange
      const sut = validateObject;
      // Allocate exactly one byte over the 100 MiB limit.
      const rawBytes = new Uint8Array(100 * 1024 * 1024 + 1);

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitattributes',
      });

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ msgId: 'gitattributesLarge', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — missingEmail via unclosed angle bracket (< without >)
// ---------------------------------------------------------------------------

describe('Given commit with author that has < but no closing >', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingEmail at error severity', () => {
      // Arrange
      const sut = validateObject;
      // Author has opening '<' but no closing '>' — the gtIdx === -1 branch in
      // checkIdentityLine must fire and emit missingEmail then return early.
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'Test <unclosed 1234567890 +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingEmail', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tag — tagger line with no angle bracket at all (checkTaggerLine ltIdx === -1)
// ---------------------------------------------------------------------------

describe('Given tag with tagger line that has no < character', () => {
  describe('When validateObject runs', () => {
    it('Then emits no missingSpaceBeforeEmail finding (checkTaggerLine returns empty)', () => {
      // Arrange
      const sut = validateObject;
      // The tagger line has no '<', so checkTaggerLine returns [] early (ltIdx === -1).
      const rawBytes = encode(
        `object ${BLOB_SHA_HEX}\ntype blob\ntag v1.0\ntagger NoEmailNameHere\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert — checkTaggerLine's early-return branch produces no findings for the
      // tagger line itself (the tag is otherwise valid so no other findings either)
      expect(result.filter((f) => f.msgId === 'missingSpaceBeforeEmail')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tag — validateTag with no blank-line separator (blankIdx === -1 branch)
// ---------------------------------------------------------------------------

describe('Given tag body with no blank-line separator between header and message', () => {
  describe('When validateObject runs', () => {
    it('Then parses the entire body as header with no crash and returns findings', () => {
      // Arrange
      const sut = validateObject;
      // No '\n\n' in the body: headerText === the full text (blankIdx === -1 branch).
      // A valid tag in this form produces no findings.
      const rawBytes = encode(
        `object ${BLOB_SHA_HEX}\ntype blob\ntag v1.0\ntagger ${VALID_IDENTITY}`,
      );

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert — no findings for a structurally valid tag even without blank separator
      expect(result).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tree — treeEntrySortKey directory branch (mode '40000' appends '/')
// ---------------------------------------------------------------------------

describe('Given tree with a file entry followed by a directory entry in correct sort order', () => {
  describe('When validateObject runs', () => {
    it('Then exercises the directory sort-key path and emits no treeNotSorted finding', () => {
      // Arrange
      const sut = validateObject;
      // 'aaa' (file, 100644) followed by 'bbb' (dir, 40000): git sort 'aaa' < 'bbb/'
      // so this is correctly sorted. treeEntrySortKey appends '/' for the dir entry.
      const rawBytes = buildTree(
        buildTreeEntry('100644', 'aaa', BLOB_SHA),
        buildTreeEntry('40000', 'bbb', BLOB_SHA),
      );

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result.filter((f) => f.msgId === 'treeNotSorted')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tree — parseTreeEntriesTolerant spaceIdx === offset (mode is empty)
// ---------------------------------------------------------------------------

describe('Given tree bytes where mode field is empty (space is the first byte)', () => {
  describe('When validateObject runs', () => {
    it('Then emits badTree at error severity', () => {
      // Arrange
      const sut = validateObject;
      // Tree entry starting with space: mode is empty → spaceIdx === offset branch.
      // Format: <space><name>\0<sha20> — the leading space means spaceIdx === offset.
      const nameBytes = new TextEncoder().encode('file');
      const raw = new Uint8Array(1 + nameBytes.length + 1 + 20);
      raw[0] = 0x20; // leading space — empty mode
      raw.set(nameBytes, 1);
      raw[1 + nameBytes.length] = 0x00; // null terminator

      // Act
      const result = sut({ kind: 'tree', rawBody: raw, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badTree', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — parseTreeEntriesTolerant shaEnd > raw.length (truncated SHA)
// ---------------------------------------------------------------------------

describe('Given tree bytes with valid mode+name but truncated SHA', () => {
  describe('When validateObject runs', () => {
    it('Then emits badTree at error severity', () => {
      // Arrange
      const sut = validateObject;
      // Valid mode ' 100644', space, name 'f', null — then only 10 bytes of SHA
      // instead of 20, so shaEnd (1+6+1+1+20=29) > raw.length (1+6+1+1+10=19).
      const modeBytes = new TextEncoder().encode('100644');
      const nameBytes = new TextEncoder().encode('f');
      const raw = new Uint8Array(modeBytes.length + 1 + nameBytes.length + 1 + 10);
      raw.set(modeBytes, 0);
      raw[modeBytes.length] = 0x20; // space after mode
      raw.set(nameBytes, modeBytes.length + 1);
      raw[modeBytes.length + 1 + nameBytes.length] = 0x00; // null terminator
      // remaining 10 bytes are the truncated SHA (zeros)

      // Act
      const result = sut({ kind: 'tree', rawBody: raw, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badTree', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — .gitmodules as regular file (isRegular=true, else-if(!isRegular) false)
// ---------------------------------------------------------------------------

describe('Given tree with .gitmodules as a regular file (mode 100644)', () => {
  describe('When validateObject runs', () => {
    it('Then emits no gitmodulesBlob or gitmodulesSymlink finding', () => {
      // Arrange
      const sut = validateObject;
      // Mode 100644 → isSymlink=false, isRegular=true → else if(!isRegular) is false
      const rawBytes = buildTree(buildTreeEntry('100644', '.gitmodules', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result.filter((f) => f.msgId === 'gitmodulesBlob')).toHaveLength(0);
      expect(result.filter((f) => f.msgId === 'gitmodulesSymlink')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tree — .gitattributes as regular file (isRegular=true, else-if(!isRegular) false)
// ---------------------------------------------------------------------------

describe('Given tree with .gitattributes as a regular file (mode 100644)', () => {
  describe('When validateObject runs', () => {
    it('Then emits no gitattributesBlob or gitattributesSymlink finding', () => {
      // Arrange
      const sut = validateObject;
      // Mode 100644 → isSymlink=false, isRegular=true → else if(!isRegular) is false
      const rawBytes = buildTree(buildTreeEntry('100644', '.gitattributes', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result.filter((f) => f.msgId === 'gitattributesBlob')).toHaveLength(0);
      expect(result.filter((f) => f.msgId === 'gitattributesSymlink')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// blob — .gitmodules with non-submodule section header (startsWith=false branch)
// ---------------------------------------------------------------------------

describe('Given .gitmodules blob with a non-submodule section header', () => {
  describe('When validateObject runs', () => {
    it('Then emits no finding (non-submodule sections are ignored by the name parser)', () => {
      // Arrange
      const sut = validateObject;
      // [core] section: header = 'core', startsWith('submodule "') = false → short-circuit
      const rawBytes = encode('[core]\n\tfilemode = true\n');

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitmodules',
      });

      // Assert
      expect(result).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// commit — committer with bad identity (checkIdentityLine returns non-empty)
// ---------------------------------------------------------------------------

describe('Given commit with committer that has no space before email', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingSpaceBeforeEmail for committer via checkIdentityLine', () => {
      // Arrange
      const sut = validateObject;
      // Committer has no space before '<', triggering checkIdentityLine to return a
      // non-empty array for the committer loop at line 195 (findings.push(f)).
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: VALID_IDENTITY,
        committer: 'Bad<bad@example.com> 1234567890 +0000',
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingSpaceBeforeEmail', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — extra header between author and committer (while i++ path)
// ---------------------------------------------------------------------------

describe('Given commit with an extra non-committer line between author and committer', () => {
  describe('When validateObject runs', () => {
    it('Then skips the extra line and still finds committer (while loop i++ body)', () => {
      // Arrange
      const sut = validateObject;
      // The while loop at `while (!startsWith('committer')) i++` advances past extra
      // headers (like mergetag) between author and committer.
      const rawBytes = encode(
        `tree ${BLOB_SHA_HEX}\nauthor ${VALID_IDENTITY}\nmergetag extra\ncommitter ${VALID_IDENTITY}\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert — no missingCommitter finding (committer was found after skip)
      expect(result.filter((f) => f.msgId === 'missingCommitter')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// commit — SHA-256 tree OID (isValidSha: SHA256_HEX_RE true branch)
// ---------------------------------------------------------------------------

describe('Given commit with a SHA-256 tree OID (64 hex chars)', () => {
  describe('When validateObject runs', () => {
    it('Then emits no badTreeSha1 finding (SHA-256 OID is valid)', () => {
      // Arrange
      const sut = validateObject;
      // 64-hex-char SHA-256 OID: SHA1_HEX_RE.test() = false, SHA256_HEX_RE.test() = true.
      const sha256TreeOid = 'a'.repeat(64);
      const rawBytes = encode(
        `tree ${sha256TreeOid}\nauthor ${VALID_IDENTITY}\ncommitter ${VALID_IDENTITY}\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result.filter((f) => f.msgId === 'badTreeSha1')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// commit — no blank-line separator (parseHeaderLines blankIdx === -1)
// ---------------------------------------------------------------------------

describe('Given commit body with no blank-line separator between header and message', () => {
  describe('When validateObject runs', () => {
    it('Then treats entire body as header, returns findings from parsed headers', () => {
      // Arrange
      const sut = validateObject;
      // No '\n\n' in the body: blankIdx === -1 → headerText = entire text, messageBody = ''.
      // A valid commit without a blank separator still has all the right headers.
      const rawBytes = encode(
        `tree ${BLOB_SHA_HEX}\nauthor ${VALID_IDENTITY}\ncommitter ${VALID_IDENTITY}`,
      );

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert — no findings for a structurally valid commit even without blank separator
      expect(result).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// commit — identity line with timestamp only, no timezone (parts[1] undefined)
// ---------------------------------------------------------------------------

describe('Given commit with author that has no timezone after the timestamp', () => {
  describe('When validateObject runs', () => {
    it('Then emits no finding for missing timezone (empty string is accepted)', () => {
      // Arrange
      const sut = validateObject;
      // Identity ends with just a timestamp but no timezone: parts[1] is undefined
      // in checkIdentityLine, timezone = '' from the ?? '' fallback, and the
      // timezone validation condition (timezone !== '') is false so no finding.
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'Test User <test@example.com> 1234567890',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert — no badTimezone finding for empty timezone
      expect(result.filter((f) => f.msgId === 'badTimezone')).toHaveLength(0);
    });
  });
});
