/**
 * Discriminator for write-target categories used across the CQS port triple
 * — `WriteEventEmitter` (command), `WriteEventStream` (subscribe), and
 * `GenerationView` (query). See ADR-157 for the rationale of splitting
 * those three concerns across separate port files; `WriteScope` lives in
 * its own file so none of the three ports needs to import another's
 * declaration, preserving the CQS split at the import-graph level.
 */
export type WriteScope = 'index' | 'refs' | 'objects';
