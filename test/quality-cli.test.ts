import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogGenerator } from '../src/catalog-generator.ts';
import { productionBindings } from '../src/production-bindings.ts';
import { runCli } from '../src/bootstrap.ts';
import { runTestRun } from '../src/test-runs.ts';
import type { TestRunRequest } from '../src/test-runs.ts';
import { RunHarness, fixtureRequest, policy } from './helpers/test-run-fixture.ts';

const confDirectory = fileURLToPath(new URL('../../conf/', import.meta.url));
const argv = ['test', 'run', '--project', 'raf', '--phase', 'implement', '--group', 'add-raf-test-run/unit'];

for (const qualityRequest of ['/fixture/quality request.json', undefined]) {
  test(`built CLI reaches TestRunResult ${qualityRequest ? 'with quality evidence' : 'without a quality request'}`, async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'raf-quality-cli-'));
    try {
      const artifactPath = join(temporary, 'catalog.json');
      new CatalogGenerator().build({ confDirectory, outputPath: artifactPath, bindings: productionBindings() });
      const harness = new RunHarness();
      let receivedQualityRequest: string | undefined;
      harness.ports.prepareQuality = async path => {
        receivedQualityRequest = path;
        throw Object.assign(new Error('fixture quality request unavailable'), { code: 'QUALITY_REQUEST_INVALID' });
      };
      const result = await runCli(qualityRequest ? [...argv, '--quality-request', qualityRequest] : argv, artifactPath, {
        'test run': params => runTestRun({ ...fixtureRequest(), ...params } as TestRunRequest, harness.config, policy, harness.context, harness.ports),
      });
      assert.equal(result.exitCode, 0, result.stderr);
      const run = JSON.parse(result.stdout);
      assert.equal(run.runId, 'fixture-run-1');
      assert.equal(run.group, 'add-raf-test-run/unit');
      assert.equal(receivedQualityRequest, qualityRequest);
      if (qualityRequest) {
        assert.ok(run.quality);
        assert.notEqual(run.outcome, 'passed');
        assert.equal(harness.spawns.length, 0);
      } else {
        assert.equal(run.outcome, 'passed');
        assert.equal(run.quality, undefined);
      }
      const help = await runCli(['help', 'test', 'run'], artifactPath, {});
      assert.equal(help.exitCode, 0);
      assert.match(help.stdout, /--quality-request/);
      const duplicate = await runCli([...argv, '--quality-request', 'a', '--quality-request', 'b'], artifactPath, {});
      assert.equal(JSON.parse(duplicate.stderr).code, 'DUPLICATE_ARGUMENT');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
