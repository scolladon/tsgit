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
// commit — nulInHeader suppresses further faults (early-return isolation)
// ---------------------------------------------------------------------------

describe('Given commit header NUL byte AND missing committer', () => {
  describe('When validateObject runs', () => {
    it('Then result is exactly [nulInHeader], suppressing missing-committer fault', () => {
      // Arrange
      const sut = validateObject;
      // Header has NUL: early-return fires before checking for committer.
      // Committer is also absent — but the guard short-circuits before that check.
      const rawBytes = encode(`tree ${BLOB_SHA_HEX}\x00junk\nauthor ${VALID_IDENTITY}\n\nmsg\n`);

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ msgId: 'nulInHeader', severity: 'error' });
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
// commit — badDateOverflow (ERROR)
// Pinned real git 2.54.0: timestamp > 9223372036854775807 (INT64_MAX = 2^63-1)
// emits badDateOverflow; timestamp == INT64_MAX is valid (no error).
// Non-numeric emits badDate (not badDateOverflow).
// ---------------------------------------------------------------------------

describe('Given commit with timestamp that overflows INT64_MAX (20-digit number)', () => {
  describe('When validateObject runs', () => {
    it('Then emits badDateOverflow at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> 99999999999999999999 +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert — badDateOverflow, not badDate
      expect(result).toContainEqual({ msgId: 'badDateOverflow', severity: 'error' });
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDate' }));
    });
  });
});

describe('Given commit with timestamp exactly at INT64_MAX (9223372036854775807)', () => {
  describe('When validateObject runs', () => {
    it('Then emits no date-related finding (boundary value is valid)', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> 9223372036854775807 +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert — no badDate or badDateOverflow
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDate' }));
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDateOverflow' }));
    });
  });
});

describe('Given commit with timestamp one above INT64_MAX (9223372036854775808)', () => {
  describe('When validateObject runs', () => {
    it('Then emits badDateOverflow at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> 9223372036854775808 +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badDateOverflow', severity: 'error' });
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDate' }));
    });
  });
});

describe('Given commit with non-numeric timestamp (no digits)', () => {
  describe('When validateObject runs', () => {
    it('Then emits badDate (not badDateOverflow) at error severity', () => {
      // Arrange — non-numeric emits badDate, not badDateOverflow (distinct from overflow)
      const sut = validateObject;
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> not-a-number +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badDate', severity: 'error' });
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDateOverflow' }));
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
// commit — badTimezone boundary: hours === 24 (+2400) kills EqualityOperator mutant
// ---------------------------------------------------------------------------

describe('Given commit with timezone hours exactly 24 (+2400)', () => {
  describe('When validateObject runs', () => {
    it('Then emits badTimezone at error severity (24 is not a valid hour offset)', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> 1234567890 +2400',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert — hours must be strictly < 24; hours===24 is invalid
      expect(result).toContainEqual({ msgId: 'badTimezone', severity: 'error' });
    });
  });
});

describe('Given commit with timezone minutes exactly 60 (+0060)', () => {
  describe('When validateObject runs', () => {
    it('Then emits badTimezone at error severity (60 is not a valid minute offset)', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> 1234567890 +0060',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert — minutes must be strictly < 60; minutes===60 is invalid
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
// blob — .gitmodules with indented section header: trim() kills StringLiteral
// mutant that removes trim() — without trim, leading tab prevents section
// header recognition and the name is never parsed.
// ---------------------------------------------------------------------------

describe('Given .gitmodules blob with indented section header containing unsafe name', () => {
  describe('When validateObject runs', () => {
    it('Then emits gitmodulesName at error severity (leading whitespace is stripped from section headers)', () => {
      // Arrange
      const sut = validateObject;
      // The section header is indented with a tab — without rawLine.trim(), the leading
      // '\t' prevents startsWith('[') from matching, and the submodule name is never parsed.
      // With rawLine.trim(), the header is recognized, the name '..' is extracted, and
      // isUnsafeSubmoduleName('..') returns true → gitmodulesName emitted.
      const rawBytes = encode('\t[submodule ".."]\n\tpath = foo\n\turl = https://example.com\n');

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
// blob — non-.gitattributes blob with long line: filename guard must not fire
// Kills ConditionalExpression mutant that makes the guard always-true.
// ---------------------------------------------------------------------------

describe('Given a regular blob (not .gitattributes) with a very long line', () => {
  describe('When validateObject runs without fileName', () => {
    it('Then does not emit gitattributesLineLength (gitattributes check must not run for non-special blobs)', () => {
      // Arrange
      const sut = validateObject;
      // A blob with a line exceeding 2048 bytes. If the filename guard is mutated
      // to always-true, gitattributesLineLength fires spuriously.
      const longLine = 'x'.repeat(3000);
      const rawBytes = encode(`${longLine}\n`);

      // Act — no fileName; blob is not .gitattributes
      const result = sut({ kind: 'blob', rawBody: rawBytes, strict: false });

      // Assert — no gitattributes findings for a blob without the .gitattributes filename
      expect(result.map((f) => f.msgId)).not.toContain('gitattributesLineLength');
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
// tag — badDateOverflow in tagger line (ERROR)
// Pinned real git 2.54.0: fires for tag tagger timestamps > INT64_MAX,
// same rule as commit author/committer (both emit badDateOverflow, exit 1).
// ---------------------------------------------------------------------------

describe('Given tag with tagger timestamp that overflows INT64_MAX', () => {
  describe('When validateObject runs', () => {
    it('Then emits badDateOverflow at error severity', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTag({
        object: BLOB_SHA_HEX,
        type: 'blob',
        tag: 'v1.0',
        tagger: 'T <t@t.com> 99999999999999999999 +0000',
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badDateOverflow', severity: 'error' });
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDate' }));
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
// tree — treeEntrySortKey: dir-sort-key flips order (040000 mode kills mutant)
// Kill: mode==='040000'→false — without dir treatment, 'a' < 'a!' is sorted;
// with dir treatment, 'a/' > 'a!' is unsorted → treeNotSorted fires.
// ---------------------------------------------------------------------------

describe('Given tree with directory entry (040000) before file where dir sort key flips order', () => {
  describe('When validateObject runs', () => {
    it('Then emits treeNotSorted (040000 mode gets "/" appended for sort key)', () => {
      // Arrange
      const sut = validateObject;
      // Entry 'a' (040000, dir) before 'a!' (100644, file).
      // Sort keys: 'a/' vs 'a!'. '/' (0x2f) > '!' (0x21) → dir AFTER file in sort → treeNotSorted.
      // Without the dir treatment (mutant: mode==='040000' → false):
      //   sort key 'a' vs 'a!'. 'a' < 'a!' (string comparison) → sorted → NO treeNotSorted.
      // This difference kills the ConditionalExpression and StringLiteral mutants.
      const rawBytes = buildTree(
        buildTreeEntry('040000', 'a', BLOB_SHA),
        buildTreeEntry('100644', 'a!', BLOB_SHA),
      );

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert — dir sort key 'a/' > 'a!' triggers treeNotSorted
      expect(result).toContainEqual({ msgId: 'treeNotSorted', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — gitmodulesBlob: 100755 (.gitmodules as executable) must NOT emit
// Kill: StringLiteral mutant on REGULAR_FILE mode constants
// ---------------------------------------------------------------------------

describe('Given tree where .gitmodules is an executable file (mode 100755)', () => {
  describe('When validateObject runs', () => {
    it('Then does NOT emit gitmodulesBlob (executable is a regular file variant)', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('100755', '.gitmodules', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert — 100755 is a regular file; must NOT emit gitmodulesBlob
      expect(result.map((f) => f.msgId)).not.toContain('gitmodulesBlob');
    });
  });
});

// ---------------------------------------------------------------------------
// tree — mailmapSymlink: only '.mailmap' triggers it, not other symlinks
// Kill: StringLiteral mutant that changes '.mailmap' to ''
// ---------------------------------------------------------------------------

describe('Given tree with a symlink entry NOT named .mailmap', () => {
  describe('When validateObject runs', () => {
    it('Then does NOT emit mailmapSymlink for a non-mailmap symlink', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = buildTree(buildTreeEntry('120000', 'other-link', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert — mailmapSymlink must only fire for '.mailmap' specifically
      expect(result.map((f) => f.msgId)).not.toContain('mailmapSymlink');
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

// ---------------------------------------------------------------------------
// tag — badDateOverflow: tagger timestamp 19 digits but > INT64_MAX (line 36 branch)
// Pinned real git 2.54.0: '9223372036854775808' has same length as INT64_MAX_STR
// but is lexicographically greater → overflow (badDateOverflow, exit 1).
// ---------------------------------------------------------------------------

describe('Given tag with tagger timestamp that is 19 digits and exceeds INT64_MAX', () => {
  describe('When validateObject runs', () => {
    it('Then emits badDateOverflow at error severity', () => {
      // Arrange
      const sut = validateObject;
      // '9223372036854775808' == INT64_MAX + 1, same 19-digit length as INT64_MAX_STR,
      // so isTaggerTimestampOverflow falls through to the lexicographic comparison branch.
      const rawBytes = buildTag({
        object: BLOB_SHA_HEX,
        type: 'blob',
        tag: 'v1.0',
        tagger: 'T <t@t.com> 9223372036854775808 +0000',
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badDateOverflow', severity: 'error' });
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDate' }));
    });
  });
});

// ---------------------------------------------------------------------------
// tag — checkTaggerLine: no closing '>' in tagger address → no date-check (early return)
// Pinned real git 2.54.0: unclosed angle-bracket in tagger does not produce a
// badDate or badDateOverflow finding; the parser bails out before the date.
// ---------------------------------------------------------------------------

describe('Given tag with tagger line that has an opening angle-bracket but no closing one', () => {
  describe('When validateObject runs', () => {
    it('Then emits no badDateOverflow finding (date section never reached)', () => {
      // Arrange
      const sut = validateObject;
      // Tagger has '<' but no '>' — gtIdx === -1 branch fires, returning [] immediately.
      const rawBytes = buildTag({
        object: BLOB_SHA_HEX,
        type: 'blob',
        tag: 'v1.0',
        tagger: 'T <unclosed 9999999999999999999 +0000',
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert — no date fault because the parser bails before the date field
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDateOverflow' }));
    });
  });
});

// ---------------------------------------------------------------------------
// tag — checkTaggerLine: no space after closing '>' → no date-check (early return)
// Pinned real git 2.54.0: tagger '<email>' with no space separator does not
// produce a badDateOverflow finding; the parser bails out before the date.
// ---------------------------------------------------------------------------

describe('Given tag with tagger line that has no space after the closing angle-bracket', () => {
  describe('When validateObject runs', () => {
    it('Then emits no badDateOverflow finding (date section never reached)', () => {
      // Arrange
      const sut = validateObject;
      // Tagger has '<...>' but the character immediately after '>' is not a space.
      // afterGt.startsWith(' ') is false → early return [] without date check.
      const rawBytes = buildTag({
        object: BLOB_SHA_HEX,
        type: 'blob',
        tag: 'v1.0',
        tagger: 'T <t@t.com>9999999999999999999 +0000',
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert — no date fault because the parser bails before the date field
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDateOverflow' }));
    });
  });
});

// ---------------------------------------------------------------------------
// blob — .gitmodules submodule header endsWith('"') guard (line 45, mutant 9)
// Kill: && → || means a header that starts with 'submodule "' but does NOT
// end with '"' would still trigger the names.push branch.
// ---------------------------------------------------------------------------

describe('Given .gitmodules blob with malformed submodule header missing the closing double-quote', () => {
  describe('When validateObject runs', () => {
    it('Then does not extract the name from a header missing the closing double-quote', () => {
      // Arrange
      const sut = validateObject;
      // [submodule "..] — starts with 'submodule "' but does NOT end with '"'.
      // With && : startsWith=true, endsWith=false → condition false → names NOT pushed.
      // With || : startsWith=true → condition true → names.push('..') → gitmodulesName fires.
      const rawBytes = encode('[submodule "..]\n\tpath = foo\n\turl = https://example.com\n');

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitmodules',
      });

      // Assert — malformed header (no closing quote) must NOT produce gitmodulesName
      expect(result.map((f) => f.msgId)).not.toContain('gitmodulesName');
    });
  });
});

// ---------------------------------------------------------------------------
// blob — .gitmodules key==='url' guard (line 54, mutant 13)
// Kill: key === 'url' → true means ANY key=value pushes to urls array.
// ---------------------------------------------------------------------------

describe('Given .gitmodules blob with a non-url key whose value starts with a dash', () => {
  describe('When validateObject runs', () => {
    it('Then does not emit gitmodulesUrl for non-url keys (only url= matters)', () => {
      // Arrange
      const sut = validateObject;
      // 'path = -bad' — key is 'path', value starts with '-'.
      // If key==='url' guard is mutated to true, '-bad' is pushed to urls and gitmodulesUrl fires.
      const rawBytes = encode(
        '[submodule "sub"]\n\tpath = -bad\n\turl = https://safe.example.com\n',
      );

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitmodules',
      });

      // Assert — only 'url' keys count; 'path' with '-' value must NOT trigger gitmodulesUrl
      expect(result.map((f) => f.msgId)).not.toContain('gitmodulesUrl');
    });
  });
});

// ---------------------------------------------------------------------------
// blob — .gitmodules size exactly at limit (line 93, mutant 17)
// Kill: raw.length > GITMODULES_MAX_BYTES → >=
// ---------------------------------------------------------------------------

describe('Given .gitmodules blob of exactly 100 MiB (at the boundary, not over)', () => {
  describe('When validateObject runs', () => {
    it('Then does NOT emit gitmodulesLarge (boundary is exclusive: > not >=)', () => {
      // Arrange
      const sut = validateObject;
      // Exactly 100 MiB = 100 * 1024 * 1024. This is NOT over the limit.
      // With > : 100MiB > 100MiB = false → no error (correct).
      // With >= : 100MiB >= 100MiB = true → error (mutant detected).
      const rawBytes = new Uint8Array(100 * 1024 * 1024);

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitmodules',
      });

      // Assert — exactly at limit must NOT trigger gitmodulesLarge
      expect(result.map((f) => f.msgId)).not.toContain('gitmodulesLarge');
    });
  });
});

// ---------------------------------------------------------------------------
// blob — .gitattributes size exactly at limit (line 136, mutant 18)
// Kill: raw.length > GITATTRIBUTES_MAX_BYTES → >=
// ---------------------------------------------------------------------------

describe('Given .gitattributes blob of exactly 100 MiB (at the boundary, not over)', () => {
  describe('When validateObject runs', () => {
    it('Then does NOT emit gitattributesLarge (boundary is exclusive: > not >=)', () => {
      // Arrange
      const sut = validateObject;
      // Exactly 100 MiB. With > : false → no error (correct).
      // With >= : true → error (mutant detected).
      const rawBytes = new Uint8Array(100 * 1024 * 1024);

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitattributes',
      });

      // Assert — exactly at limit must NOT trigger gitattributesLarge
      expect(result.map((f) => f.msgId)).not.toContain('gitattributesLarge');
    });
  });
});

// ---------------------------------------------------------------------------
// blob — .gitattributes line length exactly at limit (line 147, mutant 19)
// Kill: lineBytes > GITATTRIBUTES_MAX_LINE_BYTES → >=
// ---------------------------------------------------------------------------

describe('Given .gitattributes blob with a line of exactly 2048 bytes', () => {
  describe('When validateObject runs', () => {
    it('Then does NOT emit gitattributesLineLength (2048 bytes is the limit, not over)', () => {
      // Arrange
      const sut = validateObject;
      // A line of exactly 2048 ASCII bytes. With > : 2048 > 2048 = false → no error.
      // With >= : 2048 >= 2048 = true → error (mutant detected).
      const exactLine = 'a'.repeat(2048);
      const rawBytes = encode(`${exactLine}\n`);

      // Act
      const result = sut({
        kind: 'blob',
        rawBody: rawBytes,
        strict: false,
        fileName: '.gitattributes',
      });

      // Assert — a line of exactly 2048 bytes must NOT trigger gitattributesLineLength
      expect(result.map((f) => f.msgId)).not.toContain('gitattributesLineLength');
    });
  });
});

// ---------------------------------------------------------------------------
// commit — multipleAuthors loop advances forward (line 207 i++ not i--)
// ---------------------------------------------------------------------------

describe('Given commit with exactly one extra author line (two author lines total)', () => {
  describe('When validateObject runs', () => {
    it('Then emits exactly one multipleAuthors finding', () => {
      // Arrange
      const sut = validateObject;
      // Two author lines: primary + one duplicate.
      // i++ correctly advances past the duplicate once; i-- would scan backward
      // and emit two multipleAuthors findings instead of one.
      const rawBytes = encode(
        `tree ${BLOB_SHA_HEX}\nauthor A <a@b.com> 1234567890 +0000\nauthor B <b@c.com> 1234567890 +0000\ncommitter ${VALID_IDENTITY}\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result.filter((f) => f.msgId === 'multipleAuthors')).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// commit — missing committer with no extra lines: boundary i < vs i<=
// (line 210: while i < lines.length scan stops before going out-of-bounds)
// ---------------------------------------------------------------------------

describe('Given commit with author but no committer and no intermediate lines', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingCommitter and does NOT emit missingAuthor', () => {
      // Arrange
      const sut = validateObject;
      // Header: tree + author only. No committer.
      // After processing author, i === lines.length exactly; second while exits
      // immediately (i < lines.length is false). committerLine is undefined →
      // missingCommitter. With i <= lines.length the loop runs one extra step
      // but the outcome is the same — the assertion targets a different invariant:
      // missingAuthor must NOT appear because we successfully parsed the author.
      const rawBytes = encode(`tree ${BLOB_SHA_HEX}\nauthor ${VALID_IDENTITY}\n\nmsg\n`);

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingCommitter', severity: 'error' });
      expect(result.filter((f) => f.msgId === 'missingAuthor')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// commit — committer with no name triggers missingNameBeforeEmail (line 220)
// slice(10) strips "committer " prefix; without it the "committer " part is
// treated as the name, masking the missing-name fault.
// ---------------------------------------------------------------------------

describe('Given commit with committer that has no name before the email angle-bracket', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingNameBeforeEmail for the committer', () => {
      // Arrange
      const sut = validateObject;
      // committer line has no name: "committer <email> timestamp tz"
      // After slice(10) the string is "<email> timestamp tz" → name="" →
      // missingNameBeforeEmail. Without slice(10), name="committer " which is
      // non-empty, so the fault would not be detected.
      const rawBytes = encode(
        `tree ${BLOB_SHA_HEX}\nauthor ${VALID_IDENTITY}\ncommitter <c@d.com> 1234567890 +0000\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingNameBeforeEmail', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — missing tree returns only missingTree (line 235 if nextIdx === -1)
// With ConditionalExpression→false the early-return is skipped, and
// checkAuthorAndCommitter(lines, -1, strict) fires, adding missingAuthor.
// ---------------------------------------------------------------------------

describe('Given commit with missing tree header', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingTree and does NOT emit missingAuthor', () => {
      // Arrange
      const sut = validateObject;
      // No tree line at all — checkTreeAndParents returns nextIdx === -1.
      // The early-return on nextIdx === -1 must fire; if skipped (→false mutant),
      // checkAuthorAndCommitter is called with startIdx=-1, sees lines[-1]=undefined,
      // and incorrectly adds a missingAuthor finding.
      const rawBytes = encode(`author ${VALID_IDENTITY}\ncommitter ${VALID_IDENTITY}\n\nmsg\n`);

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingTree', severity: 'error' });
      expect(result.filter((f) => f.msgId === 'missingAuthor')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tree — parseTreeEntriesTolerant: no space byte, null present, raw long enough
// Kills M2: spaceIdx === -1 guard replaced by spaceIdx === +1
// ---------------------------------------------------------------------------

describe('Given tree bytes with no space byte anywhere, but with a null byte and enough trailing bytes', () => {
  describe('When validateObject runs', () => {
    it('Then emits badTree (missing space between mode and name)', () => {
      // Arrange
      const sut = validateObject;
      // Raw: 8 non-space ASCII bytes + NUL + 20 sha bytes = 29 bytes total.
      // spaceIdx = indexOf(raw, 0x20) = -1 (no space byte).
      // Original: spaceIdx === -1 fires → badTree.
      // Mutant (=== +1): -1 !== +1 → skips guard; shaEnd = (-1+1+20) = 20 ≤ 29 → no shaEnd fault.
      const raw = new Uint8Array(29);
      for (let i = 0; i < 8; i++) raw[i] = 0x61; // 'a' — no space
      raw[8] = 0x00; // null (no space before it)
      raw.set(BLOB_SHA, 9);

      // Act
      const result = sut({ kind: 'tree', rawBody: raw, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badTree', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — parseTreeEntriesTolerant: NUL inside mode, raw sized so mutant exits loop cleanly
// Kills M3: indexOf(raw, 0x00, spaceIdx + 1) → indexOf(raw, 0x00, spaceIdx - 1)
// ---------------------------------------------------------------------------

describe('Given tree bytes with a NUL byte at position spaceIdx-1, and raw sized to mutant shaEnd', () => {
  describe('When validateObject runs', () => {
    it('Then emits badTree (original nullIdx overshoots raw.length; mutant exits loop cleanly with bad entry)', () => {
      // Arrange
      const sut = validateObject;
      // Raw: "100" + NUL(pos 3) + SPACE(pos 4) + "file"(pos 5..8) + NUL(pos 9) + 14 sha bytes
      //   total: 4 + 1 + 4 + 1 + 14 = 24 bytes.
      // spaceIdx=4. spaceIdx !== -1, spaceIdx !== offset(0).
      //
      // Original: indexOf(raw, 0x00, 5) → finds NUL at 9. nullIdx=9.
      //   shaEnd = 9+1+20 = 30. raw.length=24. 30 > 24 → badTree!
      //
      // Mutant (spaceIdx-1=3): indexOf(raw, 0x00, 3) → finds NUL at 3 (inside mode field).
      //   nullIdx=3. shaEnd = 3+1+20 = 24. raw.length=24. 24 ≤ 24 → no shaEnd fault.
      //   Entry parsed with name=raw.subarray(5,3)=empty. offset=24. Loop exits. No badTree.
      const raw = new Uint8Array(24);
      raw[0] = 0x31; // '1'
      raw[1] = 0x30; // '0'
      raw[2] = 0x30; // '0'
      raw[3] = 0x00; // NUL inside mode — at spaceIdx-1
      raw[4] = 0x20; // space (spaceIdx=4)
      raw[5] = 0x66; // 'f'
      raw[6] = 0x69; // 'i'
      raw[7] = 0x6c; // 'l'
      raw[8] = 0x65; // 'e'
      raw[9] = 0x00; // NUL terminating name
      // bytes 10..23: 14 non-null sha bytes (prefix of BLOB_SHA)
      raw.set(BLOB_SHA.subarray(0, 14), 10);

      // Act
      const result = sut({ kind: 'tree', rawBody: raw, strict: false });

      // Assert — original: badTree (shaEnd=30 > raw.length=24); mutant: no badTree
      expect(result).toContainEqual({ msgId: 'badTree', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — parseTreeEntriesTolerant: no null after space, raw sized exactly to mutant shaEnd
// Kills M4 (if false skips guard) and M5 (nullIdx === +1 skips when nullIdx=-1)
// ---------------------------------------------------------------------------

describe('Given tree bytes with space present but no null after it, and raw sized exactly to mutant shaEnd', () => {
  describe('When validateObject runs', () => {
    it('Then emits badTree (nullIdx === -1 guard fires; mutant skips and exits loop cleanly with wrong entry)', () => {
      // Arrange
      const sut = validateObject;
      // Raw: "ab" + SPACE + 17 non-null bytes = 20 bytes. No NUL after the space.
      // spaceIdx=2. indexOf(raw, 0x00, 3) = -1 (no NUL from pos 3 onward). nullIdx=-1.
      //
      // Original: nullIdx === -1 → badTree immediately.
      //
      // M4 (if false): skips. shaEnd = (-1+1+20) = 20. raw.length=20. 20 ≤ 20 → no shaEnd fault.
      //   Entry parsed (wrong). offset=20. Loop exits (20 < 20 = false). No badTree emitted.
      // M5 (nullIdx === +1): -1 !== +1 → skips. Same result as M4.
      const raw = new Uint8Array(20);
      raw[0] = 0x61; // 'a'
      raw[1] = 0x62; // 'b'
      raw[2] = 0x20; // space (spaceIdx=2)
      for (let i = 3; i < 20; i++) raw[i] = 0x61; // 'a' — non-null filler

      // Act
      const result = sut({ kind: 'tree', rawBody: raw, strict: false });

      // Assert — original catches nullIdx=-1 → badTree; mutants skip guard and exit cleanly
      expect(result).toContainEqual({ msgId: 'badTree', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — treeEntrySortKey: file "a-" before dir "a" (40000) is correct git order
// Kills M7 (isDir=false), M8 (mode==='' not '40000'), M10 (!isDir→isDir), M11 (cond→true)
// ---------------------------------------------------------------------------

describe('Given tree with file "a-" (mode 100644) before directory "a" (mode 40000), which is correct git order', () => {
  describe('When validateObject runs', () => {
    it('Then does not emit treeNotSorted (dir sort key "a/" makes file "a-" correctly precede it)', () => {
      // Arrange
      const sut = validateObject;
      // git sort keys: "a-" (file) = "a-"; "a" (dir, 40000) = "a/".
      // compareBytes("a-", "a/") = '-'(0x2d) vs '/'(0x2f) → 0x2d < 0x2f → correct order.
      // M7 (isDir=false): dir "a" → key "a". compareBytes("a-","a") = len diff 2-1=1 > 0 → treeNotSorted.
      // M8 (mode==='' for first cond): '40000'!=='' && '40000'!=='040000' → isDir=false. Same as M7.
      // M10 (if isDir → return nameBytes): dir "a" → key "a". Same as M7.
      // M11 (if true → return nameBytes): every entry skips slash. Same as M7.
      const rawBytes = buildTree(
        buildTreeEntry('100644', 'a-', BLOB_SHA),
        buildTreeEntry('40000', 'a', BLOB_SHA),
      );

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result.filter((f) => f.msgId === 'treeNotSorted')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tree — treeEntrySortKey: dir "a" before file "a-" is WRONG git order
// Kills M7 (isDir=false), M10 (!isDir→isDir), M11 (cond→true) from the positive direction
// ---------------------------------------------------------------------------

describe('Given tree with directory "a" (mode 40000) before file "a-" (mode 100644), which is wrong git order', () => {
  describe('When validateObject runs', () => {
    it('Then emits treeNotSorted (dir sort key "a/" > file sort key "a-")', () => {
      // Arrange
      const sut = validateObject;
      // git sort keys: "a" (dir) = "a/"; "a-" (file) = "a-".
      // compareBytes("a/", "a-") = '/'(0x2f) - '-'(0x2d) = 2 > 0 → treeNotSorted.
      // M7 (isDir=false): dir key="a". compareBytes("a","a-") = 1-2=-1 → NOT treeNotSorted. MISS.
      // M10/M11 (dir returns nameBytes): dir "a" → key "a". Same miss.
      const rawBytes = buildTree(
        buildTreeEntry('40000', 'a', BLOB_SHA),
        buildTreeEntry('100644', 'a-', BLOB_SHA),
      );

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'treeNotSorted', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tree — treeEntrySortKey: files with shared prefix must not get slash injected
// Kills M6 (isDir=true), M9 (mode!=='040000'), M12 (cond→false, always appends slash)
// ---------------------------------------------------------------------------

describe('Given tree with file "bbb" before file "bbb-x" (both mode 100644), which is correct order', () => {
  describe('When validateObject runs', () => {
    it('Then does not emit treeNotSorted (file sort keys have no slash)', () => {
      // Arrange
      const sut = validateObject;
      // Sort keys: "bbb" < "bbb-x" (prefix match, shorter wins). Correct.
      // M6 (isDir=true): both get slash. "bbb/" vs "bbb-x/". '/'(0x2f) > '-'(0x2d) → treeNotSorted.
      // M9 (mode!=='040000'): '100644'!=='040000' → isDir=true. Same as M6.
      // M12 (if false → never early-return): always appends slash. Same as M6.
      const rawBytes = buildTree(
        buildTreeEntry('100644', 'bbb', BLOB_SHA),
        buildTreeEntry('100644', 'bbb-x', BLOB_SHA),
      );

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result.filter((f) => f.msgId === 'treeNotSorted')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tree — largePathname boundary: name of exactly 4096 bytes must NOT trigger the finding
// Kills M13: byteLength > MAX_NAME_BYTES → byteLength >= MAX_NAME_BYTES
// ---------------------------------------------------------------------------

describe('Given tree with entry name of exactly 4096 ASCII bytes (at the boundary)', () => {
  describe('When validateObject runs', () => {
    it('Then does NOT emit largePathname (4096 bytes is the limit, not over it)', () => {
      // Arrange
      const sut = validateObject;
      // 4096 'a' chars = 4096 UTF-8 bytes: byteLength === MAX_NAME_BYTES.
      // Original (>): 4096 > 4096 = false → no largePathname.
      // Mutant (>=): 4096 >= 4096 = true → largePathname. FALSE POSITIVE.
      const exactName = 'a'.repeat(4096);
      const rawBytes = buildTree(buildTreeEntry('100644', exactName, BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result.filter((f) => f.msgId === 'largePathname')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tree — .gitignore as a regular file must not emit gitignoreSymlink
// Kills M16: name==='.gitignore' && isSymlink → name==='.gitignore' || isSymlink
// ---------------------------------------------------------------------------

describe('Given tree with .gitignore as a regular file (mode 100644)', () => {
  describe('When validateObject runs', () => {
    it('Then does NOT emit gitignoreSymlink (only symlink mode triggers this finding)', () => {
      // Arrange
      const sut = validateObject;
      // mode='100644' → isSymlink=false.
      // Original (&&): name==='.gitignore' && false = false → no gitignoreSymlink.
      // Mutant (||): name==='.gitignore' || false = true → gitignoreSymlink. FALSE POSITIVE.
      const rawBytes = buildTree(buildTreeEntry('100644', '.gitignore', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result.filter((f) => f.msgId === 'gitignoreSymlink')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tree — .mailmap as a regular file must not emit mailmapSymlink
// Kills M19: name==='.mailmap' && isSymlink → name==='.mailmap' || isSymlink
// ---------------------------------------------------------------------------

describe('Given tree with .mailmap as a regular file (mode 100644)', () => {
  describe('When validateObject runs', () => {
    it('Then does NOT emit mailmapSymlink (only symlink mode triggers this finding)', () => {
      // Arrange
      const sut = validateObject;
      // mode='100644' → isSymlink=false.
      // Original (&&): name==='.mailmap' && false = false → no mailmapSymlink.
      // Mutant (||): name==='.mailmap' || false = true → mailmapSymlink. FALSE POSITIVE.
      const rawBytes = buildTree(buildTreeEntry('100644', '.mailmap', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result.filter((f) => f.msgId === 'mailmapSymlink')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tree — zero-padded valid mode must not additionally emit badFilemode (normMode normalisation)
// Kills M20: mode.startsWith('0') on normMode line → mode.endsWith('0')
// ---------------------------------------------------------------------------

describe('Given tree with zero-padded mode "0100644" (normalises to valid mode "100644")', () => {
  describe('When validateObject runs', () => {
    it('Then emits zeroPaddedFilemode but NOT badFilemode (normMode is a valid mode after slice)', () => {
      // Arrange
      const sut = validateObject;
      // mode='0100644': line-188 startsWith('0')=true → zeroPaddedFilemode (unchanged by M20).
      // Original (line-194 startsWith): normMode='100644'. VALID_MODES.has('100644')=true → no badFilemode.
      // Mutant (line-194 endsWith('0')): '0100644'.endsWith('4')=false → normMode='0100644'.
      //   VALID_MODES.has('0100644')=false → badFilemode emitted. FALSE POSITIVE.
      const rawBytes = buildTree(buildTreeEntry('0100644', 'file', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert — zeroPaddedFilemode is expected; badFilemode must NOT appear
      expect(result).toContainEqual({ msgId: 'zeroPaddedFilemode', severity: 'warning' });
      expect(result.filter((f) => f.msgId === 'badFilemode')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tree — duplicate entry names: equal sort keys must not trigger treeNotSorted
// Kills M22: compareBytes(prev, curr) > 0 → compareBytes(prev, curr) >= 0
// ---------------------------------------------------------------------------

describe('Given tree with two entries sharing the same name (duplicate)', () => {
  describe('When validateObject runs', () => {
    it('Then emits duplicateEntries but NOT treeNotSorted (equal sort key is not a sort violation)', () => {
      // Arrange
      const sut = validateObject;
      // Two identical entries → identical sort keys → compareBytes(key, key) = 0.
      // Original (> 0): 0 > 0 = false → no treeNotSorted.
      // Mutant (>= 0): 0 >= 0 = true → treeNotSorted. FALSE POSITIVE.
      const rawBytes = buildTree(
        buildTreeEntry('100644', 'file', BLOB_SHA),
        buildTreeEntry('100644', 'file', BLOB_SHA),
      );

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert — duplicate is flagged, but equal sort key is not a sort violation
      expect(result).toContainEqual({ msgId: 'duplicateEntries', severity: 'error' });
      expect(result.filter((f) => f.msgId === 'treeNotSorted')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tag — isTaggerTimestampOverflow boundary: INT64_MAX is valid (not overflow)
// Kills A1 (>= in length check), A4 (return true always), A5 (>= in string cmp).
// Pinned real git 2.54.0: 9223372036854775807 == INT64_MAX is accepted.
// ---------------------------------------------------------------------------

describe('Given tag with tagger timestamp exactly equal to INT64_MAX (9223372036854775807)', () => {
  describe('When validateObject runs', () => {
    it('Then emits no badDateOverflow (INT64_MAX itself is not an overflow)', () => {
      // Arrange
      const sut = validateObject;
      // '9223372036854775807' has length 19 == INT64_MAX_STR.length.
      // length guard (>) is false → falls through to string comparison.
      // '9223372036854775807' > '9223372036854775807' is false → not overflow.
      // A1 mutant (>=): 19 >= 19 = true → early-return true → badDateOverflow. FAILS.
      // A4 mutant (return true): always overflow → badDateOverflow. FAILS.
      // A5 mutant (>=): '9223...' >= '9223...' = true → badDateOverflow. FAILS.
      const rawBytes = buildTag({
        object: BLOB_SHA_HEX,
        type: 'blob',
        tag: 'v1.0',
        tagger: 'T <t@t.com> 9223372036854775807 +0000',
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDateOverflow' }));
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDate' }));
    });
  });
});

// ---------------------------------------------------------------------------
// tag — isTaggerTimestampOverflow: 20-digit number starting with 1 overflows
// Kills A2 (skip length>19 early-return): 10000000000000000000 > INT64_MAX
// numerically but '1...' < '9...' lexicographically, so without the length
// guard the string comparison incorrectly returns false (no overflow).
// ---------------------------------------------------------------------------

describe('Given tag with tagger timestamp of 20 digits starting with 1 (10000000000000000000)', () => {
  describe('When validateObject runs', () => {
    it('Then emits badDateOverflow (20-digit number exceeds INT64_MAX regardless of leading digit)', () => {
      // Arrange
      const sut = validateObject;
      // '10000000000000000000' has length 20 > 19 → early-return true (overflow).
      // A2 mutant (if false): skips the length guard entirely, falls through to
      // string comparison: '10000000000000000000' > '9223372036854775807' = false
      // (lexicographic: '1' < '9') → returns false → no badDateOverflow. FAILS.
      const rawBytes = buildTag({
        object: BLOB_SHA_HEX,
        type: 'blob',
        tag: 'v1.0',
        tagger: 'T <t@t.com> 10000000000000000000 +0000',
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badDateOverflow', severity: 'error' });
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDate' }));
    });
  });
});

// ---------------------------------------------------------------------------
// tag — isTaggerTimestampOverflow: 18-digit all-nines timestamp is valid
// Kills A3 (skip length<19 early-return): '999999999999999999' is less than
// INT64_MAX numerically but '9...' > '9...' lexicographic comparison is
// ambiguous without the length guard.
// ---------------------------------------------------------------------------

describe('Given tag with tagger timestamp of 18 nines (999999999999999999, less than INT64_MAX)', () => {
  describe('When validateObject runs', () => {
    it('Then emits no badDateOverflow (18-digit number is within range)', () => {
      // Arrange
      const sut = validateObject;
      // '999999999999999999' has length 18 < 19 → early-return false (no overflow).
      // A3 mutant (if false): skips the length guard, falls through to string
      // comparison: '999999999999999999' > '9223372036854775807' — char 0 '9'='9',
      // char 1 '9' vs '2' → '9'>'2' = true → returns true → badDateOverflow. FAILS.
      const rawBytes = buildTag({
        object: BLOB_SHA_HEX,
        type: 'blob',
        tag: 'v1.0',
        tagger: 'T <t@t.com> 999999999999999999 +0000',
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDateOverflow' }));
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDate' }));
    });
  });
});

// ---------------------------------------------------------------------------
// tag — typeVal non-empty but unknown type emits missingTypeEntry
// Kills D1: || → && means a non-empty invalid type is silently accepted.
// ---------------------------------------------------------------------------

describe('Given tag with non-empty but unknown type value (e.g. "frog")', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingTypeEntry at error severity (unknown type is not valid)', () => {
      // Arrange
      const sut = validateObject;
      // typeVal = 'frog': typeVal !== '' (first OR-condition false), but
      // !VALID_OBJECT_TYPES.has('frog') = true (second OR-condition true).
      // Original (||): true → missingTypeEntry emitted.
      // D1 mutant (&&): false && true = false → missingTypeEntry NOT emitted. FAILS.
      const rawBytes = encode(
        `object ${BLOB_SHA_HEX}\ntype frog\ntag v1.0\ntagger ${VALID_IDENTITY}\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'missingTypeEntry', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tag — taggerLine.slice(7) strips the "tagger " prefix before parsing
// Kills F1: taggerLine without slice(7) passes "tagger Name <email>" to
// checkTaggerLine, where "tagger Name" becomes the name part. "tagger Name"
// ends with 'e' not ' ', triggering missingSpaceBeforeEmail spuriously.
// The kill test uses a tagger whose name-before-email starts with "tagger "
// (the literal prefix), which is detected only when the prefix is NOT stripped.
// ---------------------------------------------------------------------------

describe('Given tag with a valid tagger where the identity has a space before the email', () => {
  describe('When validateObject runs', () => {
    it('Then emits no missingSpaceBeforeEmail (the tagger prefix is stripped before parsing)', () => {
      // Arrange
      const sut = validateObject;
      // taggerLine = 'tagger Test User <test@example.com> 1234567890 +0000'
      // slice(7)  → 'Test User <test@example.com> ...' → name='Test User ', ends with ' ' → OK.
      // F1 mutant (no slice): → 'tagger Test User <test@example.com> ...' →
      // name='tagger Test User ', ends with ' ' → still OK. So F1 is subtle.
      // Use a tagger where the raw (unsliced) form would trigger the space check:
      // 'tagger A<a@a.com> 1234567890 +0000' → sliced: 'A<a@a.com>...' → name='A', no space → missingSpaceBeforeEmail.
      // But without slice: 'tagger A<a@a.com>...' → name='tagger A', no space → missingSpaceBeforeEmail.
      // Both produce the same finding. So we need a case where the prefix changes the outcome.
      //
      // Key case: taggerLine is 'tagger <t@t.com> 1234567890 +0000' (no name, just email).
      // slice(7)  → '<t@t.com> ...' → ltIdx=0, name='', !name.endsWith(' ')=true →
      //            missingSpaceBeforeEmail (correct: no name before email).
      // F1 mutant (no slice): 'tagger <t@t.com> ...' → ltIdx=7, name='tagger ',
      //            name.endsWith(' ')=true → passes name check → no missingSpaceBeforeEmail.
      //            The email content is then parsed for the date.
      // So with F1 mutant, 'tagger <t@t.com> ...' does NOT emit missingSpaceBeforeEmail.
      // A valid test: a tag with NO name before email should emit missingSpaceBeforeEmail.
      const rawBytes = encode(
        `object ${BLOB_SHA_HEX}\ntype blob\ntag v1.0\ntagger <t@t.com> 1234567890 +0000\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert — no name before email in tagger: missingSpaceBeforeEmail must fire
      expect(result).toContainEqual({ msgId: 'missingSpaceBeforeEmail', severity: 'error' });
    });
  });
});

// ---------------------------------------------------------------------------
// tag — checkTaggerLine: timestamp regex anchoring (C3: /^\d+/ vs /^\d+$/)
// A timestamp of mixed digits and letters like '12345abc' passes /^\d+/ but
// not /^\d+$/ — the overflow check must not fire for such non-numeric strings.
// ---------------------------------------------------------------------------

describe('Given tag with tagger timestamp containing trailing non-digit characters', () => {
  describe('When validateObject runs', () => {
    it('Then emits no badDateOverflow (only purely numeric timestamps are overflow-checked)', () => {
      // Arrange
      const sut = validateObject;
      // Timestamp '99999999999999999999abc' (23 chars): /^\d+$/ = false (has 'abc') → no
      // overflow check. C3 mutant (/^\d+/): matches '9...' → checks overflow →
      // length 23 > 19 → true → badDateOverflow emitted. FAILS.
      const rawBytes = buildTag({
        object: BLOB_SHA_HEX,
        type: 'blob',
        tag: 'v1.0',
        tagger: 'T <t@t.com> 99999999999999999999abc +0000',
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDateOverflow' }));
    });
  });
});

// ---------------------------------------------------------------------------
// tag — checkTaggerLine: timestamp regex anchoring (C4: /\d+$/ vs /^\d+$/)
// A timestamp with a leading non-digit prefix like 'abc99999999999999999999'
// passes /\d+$/ but not /^\d+$/ — the overflow check must not fire.
// ---------------------------------------------------------------------------

describe('Given tag with tagger timestamp containing leading non-digit characters', () => {
  describe('When validateObject runs', () => {
    it('Then emits no badDateOverflow (leading non-digits disqualify the overflow check)', () => {
      // Arrange
      const sut = validateObject;
      // Timestamp 'abc99999999999999999999' (25 chars): /^\d+$/ = false (has 'abc') → no
      // overflow check. C4 mutant (/\d+$/): matches trailing '9...' → checks overflow →
      // length 25 > 19 → true → badDateOverflow emitted. FAILS.
      const rawBytes = buildTag({
        object: BLOB_SHA_HEX,
        type: 'blob',
        tag: 'v1.0',
        tagger: 'T <t@t.com> abc99999999999999999999 +0000',
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDateOverflow' }));
    });
  });
});

// ---------------------------------------------------------------------------
// tag — valid tag with blank-line separator and message body returns no findings
// Note: G1 (!= -1), G2 (always text), G3 (=== +1), G4 (true) are provably
// equivalent mutants. The blankIdx slice limits headerText, but validators only
// check fixed line indices (0, 1, nextIdx, nextIdx+1). Message content lands at
// indices ≥ 4, which no validator inspects, so no observable difference exists.
// ---------------------------------------------------------------------------

describe('Given valid tag with a blank-line separator and a message body', () => {
  describe('When validateObject runs', () => {
    it('Then emits no findings (valid tag structure regardless of message body content)', () => {
      // Arrange
      const sut = validateObject;
      const rawBytes = encode(
        `object ${BLOB_SHA_HEX}\ntype blob\ntag v1.0\ntagger ${VALID_IDENTITY}\n\ntype invalid\n`,
      );

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert — a structurally valid tag returns no findings
      expect(result).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tag — checkObjectAndType early-return: nextIdx -1 stops checkTagAndTagger
// Kills H1 (if false) and H2 (=== +1): when checkObjectAndType returns
// nextIdx: -1 (e.g. missing object header), validateTag must not call
// checkTagAndTagger. If it does, lines[-1]=undefined triggers missingTag.
// ---------------------------------------------------------------------------

describe('Given tag without an object line (checkObjectAndType returns nextIdx: -1)', () => {
  describe('When validateObject runs', () => {
    it('Then emits only missingObject and NOT missingTag (early return halts tag/tagger check)', () => {
      // Arrange
      const sut = validateObject;
      // No 'object' header → checkObjectAndType returns nextIdx: -1.
      // validateTag early-returns on nextIdx === -1 with only [missingObject].
      // H1 mutant (if false): skips early return → calls checkTagAndTagger(lines, -1, strict)
      //   → lines[-1] = undefined → missingTag emitted. FAILS (missingTag in result).
      // H2 mutant (=== +1): nextIdx(-1) === +1 = false → also skips early return → same.
      const rawBytes = buildTag({
        type: 'blob',
        tag: 'v1.0',
        tagger: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert — exactly missingObject, no missingTag or missingTaggerEntry
      expect(result).toContainEqual({ msgId: 'missingObject', severity: 'error' });
      expect(result.filter((f) => f.msgId === 'missingTag')).toHaveLength(0);
      expect(result.filter((f) => f.msgId === 'missingTaggerEntry')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tag — checkObjectAndType missing-object branch: nextIdx in returned struct is -1
// Kills S12 (line 83 nextIdx: -1 → +1): if nextIdx returns +1 instead of -1,
// validateTag calls checkTagAndTagger(lines, 1, strict). For a tag with only
// 'type' and 'tagger' (no 'object', no 'tag'), lines[1] is the tagger line,
// which does NOT start with 'tag ' → missingTag spuriously emitted.
// ---------------------------------------------------------------------------

describe('Given tag with type and tagger but neither object nor tag-name line', () => {
  describe('When validateObject runs', () => {
    it('Then emits only missingObject and NOT missingTag (struct nextIdx=-1 halts processing)', () => {
      // Arrange
      const sut = validateObject;
      // Lines: ['type blob', 'tagger IDENTITY']
      // checkObjectAndType sees lines[0]='type blob' (not 'object ...') → missingObject,
      // returns { findings: [missingObject], nextIdx: -1 }.
      // S12 mutant (nextIdx: +1): validateTag calls checkTagAndTagger(lines, 1, strict).
      // lines[1] = 'tagger IDENTITY' → NOT 'tag ...' → missingTag emitted. FAILS.
      const rawBytes = encode(`type blob\ntagger ${VALID_IDENTITY}\n\nmsg\n`);

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert — only missingObject; processing must stop before tag/tagger checks
      expect(result).toContainEqual({ msgId: 'missingObject', severity: 'error' });
      expect(result.filter((f) => f.msgId === 'missingTag')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tag — checkObjectAndType missing-type branch: nextIdx in returned struct is -1
// Kills S13 (line 95 nextIdx: -1 → +1): if nextIdx returns +1 instead of -1,
// validateTag calls checkTagAndTagger(lines, 1, strict). For a tag with 'object'
// and 'tagger' but no 'type' or 'tag', lines[1] is the tagger line, which does
// NOT start with 'tag ' → missingTag spuriously emitted.
// ---------------------------------------------------------------------------

describe('Given tag with object and tagger but neither type nor tag-name line', () => {
  describe('When validateObject runs', () => {
    it('Then emits only missingType and NOT missingTag (struct nextIdx=-1 halts processing)', () => {
      // Arrange
      const sut = validateObject;
      // Lines: ['object SHA', 'tagger IDENTITY']
      // checkObjectAndType: lines[0]='object SHA' ✓, lines[1]='tagger IDENTITY' not 'type ...'
      // → missingType pushed, returns { findings: [missingType], nextIdx: -1 }.
      // S13 mutant (nextIdx: +1): validateTag calls checkTagAndTagger(lines, 1, strict).
      // lines[1] = 'tagger IDENTITY' → NOT 'tag ...' → missingTag emitted. FAILS.
      const rawBytes = encode(`object ${BLOB_SHA_HEX}\ntagger ${VALID_IDENTITY}\n\nmsg\n`);

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert — only missingType; processing must stop before tag/tagger checks
      expect(result).toContainEqual({ msgId: 'missingType', severity: 'error' });
      expect(result.filter((f) => f.msgId === 'missingTag')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tag — checkObjectAndType invalid-type branch: nextIdx in returned struct is -1
// Kills S17 (line 103 nextIdx: -1 → +1): if nextIdx returns +1 instead of -1
// for an invalid type (e.g. 'frog'), validateTag calls checkTagAndTagger(lines, 1).
// lines[1] = 'type frog' → NOT 'tag ...' → missingTag spuriously emitted alongside
// missingTypeEntry, producing more findings than expected.
// ---------------------------------------------------------------------------

describe('Given tag with a non-empty invalid type value (e.g. "frog")', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingTypeEntry and NOT missingTag (struct nextIdx=-1 halts tag/tagger check)', () => {
      // Arrange
      const sut = validateObject;
      // Lines: ['object SHA', 'type frog', 'tag v1.0', 'tagger IDENTITY']
      // checkObjectAndType: typeVal='frog', !VALID_OBJECT_TYPES.has → missingTypeEntry pushed,
      // returns { findings: [missingTypeEntry], nextIdx: -1 }.
      // S17 mutant (nextIdx: +1): checkTagAndTagger(lines, 1, strict) is called.
      // lines[1] = 'type frog' → NOT 'tag ...' → missingTag emitted. FAILS.
      const rawBytes = encode(
        `object ${BLOB_SHA_HEX}\ntype frog\ntag v1.0\ntagger ${VALID_IDENTITY}\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert — missingTypeEntry present, missingTag absent
      expect(result).toContainEqual({ msgId: 'missingTypeEntry', severity: 'error' });
      expect(result.filter((f) => f.msgId === 'missingTag')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tag — checkTagAndTagger: taggerLine has wrong prefix (not 'tagger ') → missingTaggerEntry
// Kills E18 (StringLiteral 'tagger ' → ''): !taggerLine.startsWith('') is always
// false, so the prefix check never fires. A line like 'author ...' instead of
// 'tagger ...' would slip through without emitting missingTaggerEntry.
// The undefined-branch alone (taggerLine === undefined) is NOT enough to kill
// this mutant, because the existing no-tagger test uses a missing tagger line
// (undefined) which is caught by the first OR-operand regardless of startsWith.
// ---------------------------------------------------------------------------

describe('Given tag where tagger line is present but has wrong prefix (author instead of tagger)', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingTaggerEntry (wrong prefix disqualifies the tagger line)', () => {
      // Arrange
      const sut = validateObject;
      // Manually encode: tagger slot replaced with 'author' prefix.
      // taggerLine = 'author T <t@t.com> 1234567890 +0000' → defined, exists in
      // the right position, but does NOT start with 'tagger '.
      // Original: !taggerLine.startsWith('tagger ') = true → missingTaggerEntry.
      // E18 mutant ('tagger ' → ''): !taggerLine.startsWith('') = false →
      // condition false → missingTaggerEntry NOT emitted. FAILS.
      const rawBytes = encode(
        `object ${BLOB_SHA_HEX}\ntype blob\ntag v1.0\nauthor T <t@t.com> 1234567890 +0000\n\nmsg\n`,
      );

      // Act
      const result = sut({ kind: 'tag', rawBody: rawBytes, strict: false });

      // Assert — wrong-prefix tagger line must trigger missingTaggerEntry
      expect(result).toContainEqual({ msgId: 'missingTaggerEntry', severity: 'info' });
    });
  });
});

// ---------------------------------------------------------------------------
// commit — isValidTimezone: TIMEZONE_RE bypass (line 38 ConditionalExpression→false)
// Kills B1: if (!TIMEZONE_RE.test(tz)) return false → if (false) return false.
// '+003a' fails TIMEZONE_RE (non-digit at position 4) but has numerically
// plausible hours=0 and minutes=parseInt('3a')=3. With B1 the regex guard is
// bypassed and isValidTimezone returns true → no badTimezone.
// ---------------------------------------------------------------------------

describe('Given commit author with timezone containing a non-digit character that fails TIMEZONE_RE', () => {
  describe('When validateObject runs', () => {
    it('Then emits badTimezone (regex guard rejects non-digit in tz field)', () => {
      // Arrange
      const sut = validateObject;
      // '+003a' fails /^[+-]\d{4}$/ (position 4 is 'a').
      // Original: !TIMEZONE_RE.test → return false → badTimezone.
      // B1 mutant (if false): regex guard skipped → hours=0 <24, minutes=parseInt('3a')=3 <60
      // → returns true → no badTimezone. FAILS.
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> 1234567890 +003a',
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
// commit — isValidTimezone: slice(1,3) and slice(3,5) mutations (lines 39-40)
// Kills B2 (tz.slice(1,3) → tz) and B3 (tz.slice(3,5) → tz).
// A valid timezone '+0230' (hours=2, minutes=30) must NOT emit badTimezone.
// B2: hours = parseInt('+0230') = 230 ≥ 24 → returns false → badTimezone.
// B3: minutes = parseInt('+0230') = 230 ≥ 60 → returns false → badTimezone.
// ---------------------------------------------------------------------------

describe('Given commit author with a valid timezone offset of +0230', () => {
  describe('When validateObject runs', () => {
    it('Then emits no badTimezone (hours=2 <24 and minutes=30 <60)', () => {
      // Arrange
      const sut = validateObject;
      // '+0230': passes TIMEZONE_RE; hours=parseInt('02')=2 <24; minutes=parseInt('30')=30 <60.
      // B2 mutant (slice(1,3)→tz): hours=parseInt('+0230')=230 ≥24 → false → badTimezone. FAILS.
      // B3 mutant (slice(3,5)→tz): minutes=parseInt('+0230')=230 ≥60 → false → badTimezone. FAILS.
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> 1234567890 +0230',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badTimezone' }));
    });
  });
});

// ---------------------------------------------------------------------------
// commit — isTimestampOverflow length>19 guard (line 52 ConditionalExpression→false)
// Kills C1: if (timestamp.length > 19) return true → if (false) return true.
// '10000000000000000000' has 20 digits so the length guard fires (20>19=true).
// C1 mutant (if false): falls through to string comparison.
// '10000000000000000000' > '9223372036854775807' is false ('1' < '9') →
// no overflow detected → no badDateOverflow.
// ---------------------------------------------------------------------------

describe('Given commit author with 20-digit timestamp starting with 1 (10000000000000000000)', () => {
  describe('When validateObject runs', () => {
    it('Then emits badDateOverflow (20 digits exceeds INT64_MAX regardless of leading digit)', () => {
      // Arrange
      const sut = validateObject;
      // length=20 > 19 → return true → badDateOverflow.
      // C1 mutant (if false): '10000000000000000000'>'9223372036854775807'='1'<'9'→false → no overflow. FAILS.
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> 10000000000000000000 +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badDateOverflow', severity: 'error' });
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDate' }));
    });
  });
});

// ---------------------------------------------------------------------------
// commit — isTimestampOverflow length<19 guard (line 53 ConditionalExpression→false)
// Kills C2: if (timestamp.length < 19) return false → if (false) return false.
// '999999999999999999' (18 nines) has length 18 < 19 → early-return false.
// C2 mutant (if false): falls through to string comparison.
// '999999999999999999' > '9223372036854775807': '9'='9', char 1 '9'>'2' → true
// → spurious badDateOverflow.
// ---------------------------------------------------------------------------

describe('Given commit author with 18-digit all-nines timestamp (999999999999999999)', () => {
  describe('When validateObject runs', () => {
    it('Then emits no badDateOverflow (18-digit value is within INT64_MAX range)', () => {
      // Arrange
      const sut = validateObject;
      // length=18 < 19 → return false → no overflow.
      // C2 mutant (if false): '999999999999999999'>'9223372036854775807':'9'='9','9'>'2'→true → badDateOverflow. FAILS.
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> 999999999999999999 +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDateOverflow' }));
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDate' }));
    });
  });
});

// ---------------------------------------------------------------------------
// commit — checkTimestamp zeroPaddedDate guard (line 58 EqualityOperator >=1)
// Kills D1: timestamp.length > 1 → timestamp.length >= 1.
// Single-character '0' starts with '0' and has length 1.
// Original (> 1): 1 > 1 = false → no zeroPaddedDate.
// D1 mutant (>= 1): 1 >= 1 = true → zeroPaddedDate. FAILS.
// ---------------------------------------------------------------------------

describe('Given commit author with single-character zero timestamp ("0")', () => {
  describe('When validateObject runs', () => {
    it('Then emits no zeroPaddedDate (single "0" is not a zero-padded date)', () => {
      // Arrange
      const sut = validateObject;
      // '0': startsWith('0')=true, length=1. Original (>1): 1>1=false → no zeroPaddedDate.
      // D1 mutant (>=1): 1>=1=true → zeroPaddedDate. FAILS.
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> 0 +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert — '0' is a valid timestamp (epoch); must not trigger zeroPaddedDate
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'zeroPaddedDate' }));
    });
  });
});

// ---------------------------------------------------------------------------
// commit — checkTimestamp badDate regex anchoring: missing ^ anchor (line 61 /\d+$/)
// Kills E1: /^\d+$/ → /\d+$/.
// 'abc123' ends with digits so /\d+$/ matches → !/\d+$/.test('abc123')=false → no badDate.
// Original /^\d+$/: 'abc123' fails (starts with 'a') → badDate.
// ---------------------------------------------------------------------------

describe('Given commit author timestamp with leading non-digit characters ("abc123")', () => {
  describe('When validateObject runs', () => {
    it('Then emits badDate (timestamp must be all digits; leading letters disqualify it)', () => {
      // Arrange
      const sut = validateObject;
      // 'abc123': /^\d+$/ = false → badDate.
      // E1 mutant (/\d+$/): 'abc123' ends with '3' → matches → no badDate. FAILS.
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> abc123 +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badDate', severity: 'error' });
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDateOverflow' }));
    });
  });
});

// ---------------------------------------------------------------------------
// commit — checkTimestamp badDate regex anchoring: missing $ anchor (line 61 /^\d+/)
// Kills E2: /^\d+$/ → /^\d+/.
// '123abc' starts with digits so /^\d+/ matches → !/^\d+/.test('123abc')=false → no badDate.
// Original /^\d+$/: '123abc' fails (ends with 'c') → badDate.
// ---------------------------------------------------------------------------

describe('Given commit author timestamp with trailing non-digit characters ("123abc")', () => {
  describe('When validateObject runs', () => {
    it('Then emits badDate (timestamp must be all digits; trailing letters disqualify it)', () => {
      // Arrange
      const sut = validateObject;
      // '123abc': /^\d+$/ = false → badDate.
      // E2 mutant (/^\d+/): starts with '1' → matches → no badDate. FAILS.
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> 123abc +0000',
        committer: VALID_IDENTITY,
      });

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert
      expect(result).toContainEqual({ msgId: 'badDate', severity: 'error' });
      expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badDateOverflow' }));
    });
  });
});

// ---------------------------------------------------------------------------
// commit — checkIdentityLine ltIdx===-1 branch (line 80 Block/Unary/Conditional)
// Kills F1 (block {}), F2 (ltIdx===+1), F3 (if false).
// An identity string with '>' but no '<' has ltIdx=-1.
// Original: if (ltIdx===-1) pushes missingEmail and returns early.
// With any line-80 mutant: the block is skipped; gtIdx finds the '>'; the
// date section parses without emitting missingEmail.
// ---------------------------------------------------------------------------

describe('Given commit author identity with ">" but no "<" (opening angle-bracket absent)', () => {
  describe('When validateObject runs', () => {
    it('Then emits missingEmail (ltIdx===-1 guard fires on missing opening bracket)', () => {
      // Arrange
      const sut = validateObject;
      // 'Test User> 1234567890 +0000': indexOf('<')=-1, indexOf('>')=9.
      // Original: ltIdx===-1 → push missingEmail, return immediately.
      // F1 mutant (block {}): skipped → gtIdx=9, date parses → no missingEmail. FAILS.
      // F2 mutant (ltIdx===+1): -1!==+1=false → skipped → same. FAILS.
      // F3 mutant (if false): → same as F1. FAILS.
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'Test User> 1234567890 +0000',
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
// commit — checkIdentityLine split /\s+/ → /\s/ (line 120)
// Kills G1: afterGt.trim().split(/\s+/) → split(/\s/).
// Two consecutive tab characters between timestamp and timezone cause
// split(/\s+/) to yield ['timestamp', 'tz'] while split(/\s/) yields
// ['timestamp', '', 'tz'] — putting '' in the timezone slot and skipping
// the timezone validity check.
// ---------------------------------------------------------------------------

describe('Given commit author with double-tab separator between timestamp and an invalid timezone', () => {
  describe('When validateObject runs', () => {
    it('Then emits badTimezone (split /\\s+/ collapses consecutive whitespace correctly)', () => {
      // Arrange
      const sut = validateObject;
      // afterGt = ' 1234567890\t\t+9900' (space after '>'; two tabs before tz).
      // afterGt.startsWith(' ') = true. afterGt.trim() = '1234567890\t\t+9900'.
      // split(/\s+/): ['1234567890', '+9900'] → tz='+9900' (hours=99≥24) → badTimezone.
      // G1 mutant (/\s/): ['1234567890', '', '+9900'] → tz='' → no check → no badTimezone. FAILS.
      const rawBytes = buildCommit({
        tree: BLOB_SHA_HEX,
        author: 'T <t@t.com> 1234567890\t\t+9900',
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
// commit — parseHeaderLines StringLiteral '\n\n' → 'Stryker was here!' (line 142)
// Kills H1: text.indexOf('\n\n') → text.indexOf('Stryker was here!').
// With H1 the blank-line sentinel is never found (blankIdx=-1 always) so
// messageBody is always '' — nullInCommit can never be detected.
// ---------------------------------------------------------------------------

describe('Given commit with a NUL byte in the body (after the blank-line separator)', () => {
  describe('When validateObject runs', () => {
    it('Then emits nullInCommit (NUL in body detected via messageBody check)', () => {
      // Arrange
      const sut = validateObject;
      // NUL is only in the body; headerText has no NUL so nulInHeader does NOT fire.
      // messageBody.includes('\x00') = true → nulInCommit.
      // H1 mutant (indexOf('Stryker...')): blankIdx=-1 always → messageBody='' → no nulInCommit. FAILS.
      const rawBytes = encode(
        `tree ${BLOB_SHA_HEX}\nauthor ${VALID_IDENTITY}\ncommitter ${VALID_IDENTITY}\n\n\x00body`,
      );

      // Act
      const result = sut({ kind: 'commit', rawBody: rawBytes, strict: false });

      // Assert — nulInCommit (warning), not nulInHeader, because the NUL is only in the body
      expect(result).toContainEqual({ msgId: 'nulInCommit', severity: 'warning' });
      expect(result.filter((f) => f.msgId === 'nulInHeader')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// tree — normMode calculation uses startsWith, not endsWith (line 194, M20)
// Kill: mode.startsWith('0') → mode.endsWith('0')
// '40000' ends with '0' but does NOT start with '0': endsWith mutant
// strips the leading '4' instead of the leading '0', producing normMode='4000'.
// VALID_MODES.has('4000') = false → badFilemode spuriously emitted.
// Original startsWith: '40000' does NOT start with '0' → normMode='40000'.
// VALID_MODES.has('40000') = true → no badFilemode.
// ---------------------------------------------------------------------------

describe('Given tree entry with canonical directory mode "40000"', () => {
  describe('When validateObject runs', () => {
    it('Then does NOT emit badFilemode (40000 is valid; endsWith mutant would strip wrong char)', () => {
      // Arrange
      const sut = validateObject;
      // mode='40000': startsWith('0')=false → normMode='40000' → VALID_MODES ✓ → no badFilemode.
      // M20 mutant (endsWith('0')): '40000'.endsWith('0')=true → normMode='4000' → VALID_MODES ✗ → badFilemode.
      const rawBytes = buildTree(buildTreeEntry('40000', 'subdir', BLOB_SHA));

      // Act
      const result = sut({ kind: 'tree', rawBody: rawBytes, strict: false });

      // Assert
      expect(result.filter((f) => f.msgId === 'badFilemode')).toHaveLength(0);
    });
  });
});
