// Open the tsgit repo itself and read its history with tsgit's own API.
// Run from the project root after `npm run build`:
//   node examples/try-on-self.mjs
import { openRepository } from '../dist/esm/index.node.js';

const repo = await openRepository({ cwd: process.cwd() });
try {
  console.log(`workdir: ${repo.ctx.layout.workDir}`);
  console.log(`gitdir : ${repo.ctx.layout.gitDir}`);

  const status = await repo.status();
  console.log(`status   clean=${status.clean}  branch=${status.branch}`);

  const headId = await repo.primitives.resolveRef(status.branch ?? 'HEAD');
  console.log(`HEAD     ${headId}`);

  const log = await repo.log({ depth: 10 });
  console.log(`\nlast ${log.length} commits:`);
  for (const entry of log) {
    const subject = entry.message.split('\n')[0];
    console.log(`  ${entry.id.slice(0, 7)}  ${subject}`);
  }

  const branchList = await repo.branch({ kind: 'list' });
  if (branchList.kind === 'list') {
    console.log(`\nbranches (${branchList.branches.length}):`);
    for (const b of branchList.branches) {
      console.log(`  ${b.name.padEnd(40)}  ${b.id.slice(0, 7)}`);
    }
  }

  const tagList = await repo.tag({ kind: 'list' });
  if (tagList.kind === 'list') {
    console.log(`\ntags (${tagList.tags.length}):`);
    for (const t of tagList.tags) {
      console.log(`  ${t.name.padEnd(40)}  ${t.id.slice(0, 7)}`);
    }
  }

  // Inspect HEAD's tree. FileMode is the canonical git mode string —
  // 40000=tree, 100644=file, 100755=exec, 120000=symlink, 160000=submodule.
  const tree = await repo.primitives.readTree(headId);
  const KIND_BY_MODE = {
    '40000': 'tree',
    100644: 'file',
    100755: 'exec',
    120000: 'symlink',
    160000: 'gitlink',
  };
  const kind = (mode) => KIND_BY_MODE[mode] ?? `mode:${mode}`;
  console.log(`\nHEAD tree has ${tree.entries.length} top-level entries:`);
  for (const entry of tree.entries) {
    console.log(`  ${kind(entry.mode).padEnd(7)} ${entry.id.slice(0, 7)}  ${entry.name}`);
  }

  // Read a file's content via primitives.
  const readme = tree.entries.find((e) => e.name === 'README.md');
  if (readme !== undefined && kind(readme.mode) === 'file') {
    const blob = await repo.primitives.readBlob(readme.id);
    const text = new TextDecoder().decode(blob.content);
    const firstLine = text.split('\n')[0];
    console.log(`\nREADME.md first line: "${firstLine}" (${blob.content.length} bytes)`);
  }

  // Walk commits to count merges vs. straight-line commits.
  let total = 0;
  let merges = 0;
  for await (const commit of repo.primitives.walkCommits({ from: [headId] })) {
    total += 1;
    if (commit.data.parents.length > 1) merges += 1;
  }
  console.log(`\nfull history: ${total} commits, ${merges} merges`);
} finally {
  await repo.dispose();
}
