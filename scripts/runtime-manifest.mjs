import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = 'integrations/codex/projects-pack-delegation/skills/projects-pack-delegation';
const files = [
  ['scripts/projects-pr.mjs', 'projects-pr-cli'],
  ['scripts/projects-aws-qualification.mjs', 'projects-aws-qualification-cli'],
  ['scripts/lib/action-authority.mjs', 'local-command-action-authority'],
  ['scripts/lib/aws-qualification-contract.mjs', 'pure-closed-aws-qualification-contract'],
  ['scripts/lib/aws-qualification-runner.mjs', 'local-single-dispatch-operator'],
  ['scripts/lib/bounded-process.mjs', 'bounded-process'],
  ['scripts/lib/host-actions.mjs', 'closed-host-actions'],
  ['scripts/lib/journal.mjs', 'durable-local-journal'],
  ['scripts/lib/projects-pr.mjs', 'local-runner'],
  ['scripts/lib/protocol.mjs', 'wire-validator'],
  ['scripts/lib/repository-lock.mjs', 'repository-lock'],
  ['scripts/lib/transport.mjs', 'authenticated-mcp-transport'],
  ['scripts/protocol/projects-pr-machine.schema.json', 'frozen-wire-schema'],
  ['scripts/protocol/projects-pr-machine.fixtures.json', 'frozen-wire-fixtures']
];

const entries = [];
for (const [relativePath, identity] of files) {
  const bytes = await fs.readFile(path.join(root, skill, relativePath));
  entries.push({ path: relativePath, sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length, identity });
}
const manifest = { schemaVersion: 1, kind: 'projects-pr-public-runtime-manifest',
  entrypoint: 'scripts/projects-pr.mjs', files: entries,
  dependencies: {
    'scripts/projects-pr.mjs': ['scripts/lib/projects-pr.mjs'],
    'scripts/projects-aws-qualification.mjs': ['scripts/lib/aws-qualification-runner.mjs'],
    'scripts/lib/aws-qualification-runner.mjs': [
      'scripts/lib/aws-qualification-contract.mjs', 'scripts/lib/transport.mjs'
    ],
    'scripts/lib/aws-qualification-contract.mjs': [],
    'scripts/lib/projects-pr.mjs': [
      'scripts/lib/action-authority.mjs', 'scripts/lib/bounded-process.mjs', 'scripts/lib/host-actions.mjs',
      'scripts/lib/journal.mjs', 'scripts/lib/protocol.mjs', 'scripts/lib/repository-lock.mjs',
      'scripts/lib/transport.mjs'
    ],
    'scripts/lib/action-authority.mjs': [],
    'scripts/lib/host-actions.mjs': ['scripts/lib/action-authority.mjs', 'scripts/lib/protocol.mjs'],
    'scripts/lib/transport.mjs': ['scripts/lib/protocol.mjs'],
    'scripts/lib/bounded-process.mjs': [],
    'scripts/lib/journal.mjs': [],
    'scripts/lib/protocol.mjs': [
      'scripts/protocol/projects-pr-machine.schema.json',
      'scripts/protocol/projects-pr-machine.fixtures.json'
    ],
    'scripts/lib/repository-lock.mjs': [],
    'scripts/protocol/projects-pr-machine.schema.json': [],
    'scripts/protocol/projects-pr-machine.fixtures.json': []
  }
};
const target = path.join(root, skill, 'scripts/runtime-manifest.json');
const text = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.includes('--check')) assert.equal(await fs.readFile(target, 'utf8'), text,
  'runtime manifest is stale');
else await fs.writeFile(target, text, { encoding: 'utf8', mode: 0o600 });
console.log(JSON.stringify({ kind: manifest.kind, entrypoint: manifest.entrypoint, files: manifest.files.length }));
