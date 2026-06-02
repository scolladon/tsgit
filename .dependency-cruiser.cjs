/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-cannot-import-outward',
      comment: 'Domain layer must have zero outward dependencies (hexagonal architecture)',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: {
        path: '^src/(application|ports|adapters|operators|transport)/',
      },
    },
    {
      name: 'domain-cannot-import-repository',
      comment: 'Domain layer must not import the repository facade',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: { path: '^src/repository\\.ts' },
    },
    {
      name: 'primitives-cannot-import-commands',
      comment: 'Primitives are lower-level than commands — no reverse dependency',
      severity: 'error',
      from: { path: '^src/application/primitives/' },
      to: { path: '^src/application/commands/' },
    },
    {
      name: 'primitives-cannot-import-adapters',
      comment:
        'Primitives are low-level building blocks: they depend on ports + domain + same-tier primitives, never on concrete adapters. A primitive reaching into the adapter / snapshot-factory layer is an upward, anti-hexagonal edge — the composition root (repository.ts) wires adapters. Keeps the walker (primitive) below the snapshot (higher-level construct built on it), never the reverse.',
      severity: 'error',
      from: { path: '^src/application/primitives/' },
      to: { path: '^src/adapters/' },
    },
    {
      name: 'ports-cannot-import-adapters',
      comment: 'Ports define interfaces — they must not depend on implementations',
      severity: 'error',
      from: { path: '^src/ports/' },
      to: { path: '^src/adapters/' },
    },
    {
      name: 'ports-cannot-import-application',
      comment: 'Port interfaces must not depend on application, operators, transport, or repository',
      severity: 'error',
      from: { path: '^src/ports/' },
      to: { path: '^src/(application|operators|transport|repository\\.ts)' },
    },
    {
      name: 'operators-must-be-standalone',
      comment: 'Operators are pure AsyncIterable utilities with zero domain/app dependencies',
      severity: 'error',
      from: { path: '^src/operators/' },
      to: {
        path: '^src/(domain|application|ports|adapters|transport)/',
      },
    },
    {
      name: 'transport-only-depends-on-ports',
      comment: 'Transport middleware may only depend on port interfaces',
      severity: 'error',
      from: { path: '^src/transport/' },
      to: {
        path: '^src/(domain|application|adapters|operators)/',
      },
    },
    {
      name: 'no-circular',
      comment: 'No circular dependencies allowed (type-only cycles are safe — erased at runtime)',
      severity: 'error',
      from: {},
      to: {
        circular: true,
        viaOnly: { dependencyTypesNot: ['type-only'] },
      },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
