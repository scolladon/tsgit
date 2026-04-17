import type { FileMode, FilePath, ObjectId } from '../objects/index.js';

export type DiffChangeType = 'add' | 'delete' | 'modify' | 'rename' | 'type-change';

export interface AddChange {
  readonly type: 'add';
  readonly newPath: FilePath;
  readonly newId: ObjectId;
  readonly newMode: FileMode;
}

export interface DeleteChange {
  readonly type: 'delete';
  readonly oldPath: FilePath;
  readonly oldId: ObjectId;
  readonly oldMode: FileMode;
}

export interface ModifyChange {
  readonly type: 'modify';
  readonly path: FilePath;
  readonly oldId: ObjectId;
  readonly newId: ObjectId;
  readonly oldMode: FileMode;
  readonly newMode: FileMode;
}

export interface RenameChange {
  readonly type: 'rename';
  readonly oldPath: FilePath;
  readonly newPath: FilePath;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

export interface TypeChangeChange {
  readonly type: 'type-change';
  readonly path: FilePath;
  readonly oldId: ObjectId;
  readonly newId: ObjectId;
  readonly oldMode: FileMode;
  readonly newMode: FileMode;
}

export type DiffChange = AddChange | DeleteChange | ModifyChange | RenameChange | TypeChangeChange;

export interface TreeDiff {
  readonly changes: ReadonlyArray<DiffChange>;
}
