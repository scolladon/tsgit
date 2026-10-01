import type { ObjectSourceAccess } from '../../../ports/object-source-access.js';

/** One object store: its `objects` directory and the filesystem access that reads it. */
export interface SourceLocation {
  readonly objectsDir: string;
  readonly fs: ObjectSourceAccess;
}
