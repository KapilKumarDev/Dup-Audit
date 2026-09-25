import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.js';
import { computeCoverage } from '../src/coverage.js';
import { collectInventory, countLines } from '../src/inventory.js';
import { makeRepo, sourceFile } from './helpers.js';

describe('countLines', () => {
  it('counts physical lines with or without a trailing newline', () => {
    assert.equal(countLines(''), 0);
    assert.equal(countLines('a'), 1);
    assert.equal(countLines('a\n'), 1);
    assert.equal(countLines('a\nb\n'), 2);
    assert.equal(countLines('a\n\nb'), 3);
  });
});

describe('collectInventory', () => {
  it('lists code files, honours .gitignore, and accounts for configured exclusions', async () => {
    const root = makeRepo({
      '.gitignore': 'secret.ts\n',
      'src/a.ts': 'const a = 1;\nconst b = 2;\n',
      'src/styles.css': '.a { color: red; }\n',
      'src/a.test.ts': 'test();\ntest();\ntest();\n',
      'src/vendor.min.js': 'x();\n',
      'secret.ts': 'ignored();\n',
      'README.md': '# not code\n',
    });
    const inventory = await collectInventory(root, structuredClone(DEFAULT_CONFIG));
    assert.deepEqual(inventory.files.map((file) => file.path).sort(), ['src/a.ts', 'src/styles.css']);
    assert.deepEqual(inventory.excluded, { files: 2, lines: 4 });
  });

  it('skips files that are still in the git index but gone from disk', async () => {
    const root = makeRepo({ 'keep.ts': 'a();\n', 'gone.ts': 'b();\n' });
    execFileSync('git', ['add', '.'], { cwd: root });
    rmSync(path.join(root, 'gone.ts'));
    const inventory = await collectInventory(root, structuredClone(DEFAULT_CONFIG));
    assert.deepEqual(inventory.files.map((file) => file.path), ['keep.ts']);
  });

  it('fails loudly outside a git repository', async () => {
    await assert.rejects(collectInventory('/', structuredClone(DEFAULT_CONFIG)), /git repository/);
  });
});

describe('computeCoverage', () => {
  it('measures analyzed lines and groups the gap by extension', () => {
    const files = [sourceFile('a.ts', 'x\ny\n'), sourceFile('b.vue', 'x\ny\nz\n'), sourceFile('c.vue', 'x\n')];
    const coverage = computeCoverage(files, new Set(['a.ts']));
    assert.equal(coverage.percent, (2 / 6) * 100);
    assert.deepEqual(coverage.uncoveredLinesByExtension, { '.vue': 4 });
  });

  it('reports 100% for an empty inventory', () => {
    assert.equal(computeCoverage([], new Set()).percent, 100);
  });
});
