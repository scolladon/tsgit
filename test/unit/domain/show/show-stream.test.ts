import { describe, expect, it } from 'vitest';

import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { renderShowStream, type ShowStreamNode } from '../../../../src/domain/show/show-stream.js';

const OID_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as ObjectId;
const OID_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as ObjectId;

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const commitNode = (id: ObjectId, text: string): ShowStreamNode => ({ kind: 'commit', id, text });
const treeNode = (text: string): ShowStreamNode => ({ kind: 'tree', text });
const blobNode = (content: Uint8Array): ShowStreamNode => ({ kind: 'blob', content });

describe('renderShowStream', () => {
  describe('Given a single commit node, When renderShowStream runs', () => {
    it('Then the commit text is emitted verbatim', () => {
      // Arrange
      const nodes = [commitNode(OID_A, 'commit A\n')];

      // Act
      const sut = renderShowStream(nodes);

      // Assert
      expect(decode(sut)).toBe('commit A\n');
    });
  });

  describe('Given two distinct commits, When renderShowStream runs', () => {
    it('Then a blank-line separator precedes the second', () => {
      // Arrange
      const nodes = [commitNode(OID_A, 'commit A\n'), commitNode(OID_B, 'commit B\n')];

      // Act
      const sut = renderShowStream(nodes);

      // Assert
      expect(decode(sut)).toBe('commit A\n\ncommit B\n');
    });
  });

  describe('Given a blob followed by a commit, When renderShowStream runs', () => {
    it('Then no separator precedes the commit', () => {
      // Arrange
      const nodes = [
        blobNode(new TextEncoder().encode('hello\n')),
        commitNode(OID_A, 'commit A\n'),
      ];

      // Act
      const sut = renderShowStream(nodes);

      // Assert
      expect(decode(sut)).toBe('hello\ncommit A\n');
    });
  });

  describe('Given a tree followed by a commit, When renderShowStream runs', () => {
    it('Then a separator precedes the commit', () => {
      // Arrange
      const nodes = [treeNode('tree t\n\na.txt\n'), commitNode(OID_A, 'commit A\n')];

      // Act
      const sut = renderShowStream(nodes);

      // Assert
      expect(decode(sut)).toBe('tree t\n\na.txt\n\ncommit A\n');
    });
  });

  describe('Given two blobs, When renderShowStream runs', () => {
    it('Then the raw bytes are concatenated with no separator', () => {
      // Arrange
      const nodes = [blobNode(new Uint8Array([0, 1, 2])), blobNode(new Uint8Array([255, 254]))];

      // Act
      const sut = renderShowStream(nodes);

      // Assert
      expect(Array.from(sut)).toEqual([0, 1, 2, 255, 254]);
    });
  });

  describe('Given a tag node with a commit target, When renderShowStream runs', () => {
    it('Then the tag block, a separator, then the target are emitted', () => {
      // Arrange
      const nodes: ShowStreamNode[] = [
        { kind: 'tag', text: 'tag v1\n\nrelease\n', target: commitNode(OID_A, 'commit A\n') },
      ];

      // Act
      const sut = renderShowStream(nodes);

      // Assert
      expect(decode(sut)).toBe('tag v1\n\nrelease\n\ncommit A\n');
    });
  });

  describe('Given the same commit listed twice, When renderShowStream runs', () => {
    it('Then the duplicate is de-duplicated', () => {
      // Arrange
      const nodes = [
        commitNode(OID_A, 'commit A\n'),
        commitNode(OID_B, 'commit B\n'),
        commitNode(OID_A, 'commit A\n'),
      ];

      // Act
      const sut = renderShowStream(nodes);

      // Assert
      expect(decode(sut)).toBe('commit A\n\ncommit B\n');
    });
  });
});
