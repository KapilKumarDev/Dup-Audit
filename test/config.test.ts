import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CONFIG_FILE, DEFAULT_CONFIG, loadConfig } from '../src/config.js';
import { makeRepo } from './helpers.js';

const withConfig = (config: unknown): string => makeRepo({ [CONFIG_FILE]: JSON.stringify(config) });

describe('loadConfig', () => {
  it('returns the defaults when no config file exists', async () => {
    assert.deepEqual(await loadConfig(makeRepo({})), DEFAULT_CONFIG);
  });

  it('merges nested overrides over the defaults', async () => {
    const config = await loadConfig(withConfig({ structure: { similarity: 0.9 }, gates: { minCoveragePercent: 95 } }));
    assert.equal(config.structure.similarity, 0.9);
    assert.equal(config.structure.minNodes, DEFAULT_CONFIG.structure.minNodes);
    assert.equal(config.gates.minCoveragePercent, 95);
    assert.equal(config.gates.maxDuplicationPercent, DEFAULT_CONFIG.gates.maxDuplicationPercent);
  });

  it('never mutates the shared defaults', async () => {
    await loadConfig(withConfig({ ignore: ['x'] }));
    assert.ok(DEFAULT_CONFIG.ignore.length > 1);
  });

  it('rejects unknown keys so typos cannot silently disable a setting', async () => {
    await assert.rejects(loadConfig(withConfig({ structure: { similarty: 0.9 } })), /Unknown config key "structure.similarty"/);
  });

  it('rejects wrong types and out-of-range values, listing every problem', async () => {
    await assert.rejects(loadConfig(withConfig({ gates: { minCoveragePercent: '90' } })), /must be a number/);
    await assert.rejects(
      loadConfig(withConfig({ structure: { similarity: 1.5, minNodes: 0 }, detectors: ['nope'] })),
      (error: Error) => /similarity/.test(error.message) && /minNodes/.test(error.message) && /detectors/.test(error.message),
    );
  });

  it('fails when an explicitly requested config is missing or invalid JSON', async () => {
    const root = makeRepo({ 'bad.json': '{ nope' });
    await assert.rejects(loadConfig(root, path.join(root, 'missing.json')), /Cannot read config/);
    await assert.rejects(loadConfig(root, path.join(root, 'bad.json')), /not valid JSON/);
  });

  it('reads an explicit config path', async () => {
    const root = makeRepo({});
    const file = path.join(root, 'custom.json');
    writeFileSync(file, JSON.stringify({ css: { minDeclarations: 5 } }));
    assert.equal((await loadConfig(root, file)).css.minDeclarations, 5);
  });

  it('defaults baseline.enabled to false and accepts an override', async () => {
    assert.equal(DEFAULT_CONFIG.baseline.enabled, false);
    assert.equal((await loadConfig(withConfig({ baseline: { enabled: true } }))).baseline.enabled, true);
  });

  it('rejects a non-boolean baseline.enabled', async () => {
    await assert.rejects(loadConfig(withConfig({ baseline: { enabled: 'yes' } })), /must be a boolean/);
  });
});