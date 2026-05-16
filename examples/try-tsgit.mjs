// Quick smoke test against a fresh tmp repo.
// Run from the tsgit project root after `npm run build`:
//   node examples/try-tsgit.mjs
import { mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openRepository } from '../dist/esm/index.node.js';

const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-try-'));
console.log(`workdir: ${cwd}`);

const repo = await openRepository({ cwd });
try {
  await repo.init();
  console.log('init ✓');

  await writeFile(path.join(cwd, 'README.md'), '# hello tsgit\n');
  await writeFile(path.join(cwd, 'src.txt'), 'first content\n');

  await repo.add(['README.md', 'src.txt']);
  console.log('add ✓');

  const author = {
    name: 'You',
    email: 'you@example.com',
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: '+0000',
  };

  const first = await repo.commit({ message: 'initial', author });
  console.log(`commit ✓  id=${first.id}  branch=${first.branch}`);

  // Modify and commit again.
  await writeFile(path.join(cwd, 'src.txt'), 'second content\n');
  await repo.add(['src.txt']);
  const second = await repo.commit({ message: 'update src', author });

  const status = await repo.status();
  console.log(`status   clean=${status.clean}  branch=${status.branch}`);

  const log = await repo.log();
  console.log(`log      ${log.length} commits`);
  for (const entry of log) console.log(`  - ${entry.id.slice(0, 7)}  ${entry.message.split('\n')[0]}`);

  // Branch + tag. Result is a discriminated union keyed on `kind`.
  await repo.branch({ kind: 'create', name: 'feature' });
  const branchList = await repo.branch({ kind: 'list' });
  if (branchList.kind === 'list') {
    console.log(`branches ${branchList.branches.map((b) => b.name).join(', ')}`);
  }

  await repo.tag({ kind: 'create', name: 'v0', target: second.id });
  const tagList = await repo.tag({ kind: 'list' });
  if (tagList.kind === 'list') {
    console.log(`tags     ${tagList.tags.map((t) => t.name).join(', ')}`);
  }

  // Primitive: read a blob.
  const tree = await repo.primitives.readTree(second.tree);
  const readme = tree.entries.find((e) => e.name === 'README.md');
  if (readme !== undefined) {
    const blob = await repo.primitives.readBlob(readme.id);
    console.log(`readBlob ${new TextDecoder().decode(blob.content).trim()}`);
  }
} finally {
  await repo.dispose();
  console.log('dispose ✓');
}
