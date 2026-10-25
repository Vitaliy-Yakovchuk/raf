import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { testProjectFiles } from '/srv/dev/work/orchestrator/etchly-develop/test-support/vitest-project-files.ts';
const root = '/srv/dev/work/orchestrator';
const etchly = path.join(root, 'etchly-develop');
const target = path.dirname(new URL(import.meta.url).pathname);
const config = fs.readFileSync(path.join(etchly, 'worker/vitest.config.ts'), 'utf8');
const boundaries = JSON.parse(config.slice(config.indexOf('\n\t{ "src/security'), config.indexOf(' }, selectedTestFiles(root));') + 2).replaceAll(/([,{]\s*)(miniflare|wrangler)\s*:/g, '$1"$2":'));
const classified = testProjectFiles(path.join(etchly, 'worker'), ['src/**/*.test.ts','infra/**/*.test.ts','scripts/**/*.test.ts','eval/**/*.test.ts'], boundaries);
const plan = classified.d1.filter(file => /\/generation-plan-d1-(?:2127|campaign-2127)\.test\.ts$/u.test(file));
const inventory = classified.d1.filter(file => !plan.includes(file)).map(file => 'worker/' + file);
const examples = ['worker/src/analysis-output-1177-agent-tests/invalid-analysis-retried.test.ts','worker/src/accepted-source-1939-agent-tests/continuation.test.ts','worker/src/summary-pass-language-agent-tests/english-course-prompt-form.test.ts'];
const conf = JSON.parse(fs.readFileSync(path.join(root,'conf/test-runs.json')));
const overlap = Object.values(conf.projects.etchly.profiles).flatMap(p => p.unitFiles ?? []).filter(file => inventory.includes(file));
if (overlap.length || !examples.every(file => inventory.includes(file))) throw Error('Inventory classification/overlap audit failed');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
fs.writeFileSync(path.join(target, 'worker-d1-inventory.json'), JSON.stringify(inventory, null, 2)+'\n');
const unitOps = [
 {op:'add',path:'/projects/raf/profiles/node/unitFiles/-',value:'test/test-run-etchly-integration.test.ts'},
 {op:'add',path:'/projects/raf/groups/add-raf-test-run~1etchly-integration',value:{profileId:'node',files:['test/test-run-etchly-integration.test.ts']}}
];
fs.writeFileSync(path.join(target,'unit-registration.patch.json'),JSON.stringify(unitOps,null,2)+'\n');
const checks = ['scripts/shared-library-runtime.mjs','scripts/shared-library-aliases.ts','scripts/shared-libs-path.mjs','test-support/vitest-project-files.ts','test-support/temp-resources.ts','test-support/file-budget-runner.ts','worker/vitest.config.ts','worker/wrangler.jsonc','worker/scripts/migrate.ts','worker/migrations','worker/src/test-support/shared-worker-global-setup.ts','worker/src/test-support/d1-template-global-setup.ts','worker/src/test-support/d1-template-setup.ts','worker/src/test-support/shared-worker-setup.ts','worker/src/test-support/shared-worker-runtime.ts','worker/src/test-support/live-worker.ts','worker/src/test-support/miniflare.ts','node_modules/vitest/vitest.mjs','node_modules/wrangler/package.json','node_modules/miniflare/package.json','node_modules/workerd/package.json','node_modules/esbuild/package.json','app/dist/local/index.html'];
const profile = {testKind:'integration',cwd:'worker',executable:'node',argv:['--import','../scripts/shared-library-runtime.mjs','../node_modules/vitest/vitest.mjs','run','--configLoader','runner','--project','worker-d1-integration'],exactIds:'vitest-test-name',resultAdapter:'vitest-events',integrationFiles:inventory,environment:{isolatedHome:true,stateOrigin:true},checks,resourceEstimate:conf.projects.etchly.profiles['vitest-worker'].resourceEstimate};
const groups = Object.fromEntries(['worker-d1-invalid-analysis','worker-d1-accepted-source','worker-d1-summary-language'].map((name,i)=>['bound-generation-retries-and-spend/'+name,{profileId:'vitest-worker-d1-integration',files:[examples[i]]}]));
groups['add-raf-test-run/etchly-worker-d1-smoke']={profileId:'vitest-worker-d1-integration',files:examples};
const ops = [{op:'add',path:'/projects/etchly/profiles/vitest-worker-d1-integration',value:profile},...Object.entries(groups).map(([group,value])=>({op:'add',path:'/projects/etchly/groups/'+group.replaceAll('/','~1'),value}))];
fs.writeFileSync(path.join(target,'etchly-registration.patch.json'),JSON.stringify(ops,null,2)+'\n');
const sources = ['conf/projects.json','conf/test-runs.json','conf/flow.json','etchly-develop/worker/vitest.config.ts','etchly-develop/test-support/vitest-project-files.ts','etchly-develop/test-support/temp-resources.ts','etchly-develop/test-support/file-budget-runner.ts',...checks.filter(p=>!p.startsWith('node_modules/')&&!p.startsWith('app/dist')&&p!=='worker/migrations').map(p=>'etchly-develop/'+p),...examples.map(p=>'etchly-develop/'+p),'openspec/changes/add-raf-test-run/etchly-integration-profile.md','openspec/changes/add-raf-test-run/specs/core/process/feature-test-authoring/spec.md'];
const git = (cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
const audit={observedAt:new Date().toISOString(),method:'Static testProjectFiles import graph; no Vitest config evaluation, discovery or D1 execution',counts:Object.fromEntries(Object.entries(classified).map(([k,v])=>[k,v.length])),workerD1Count:inventory.length,inventorySha256:hash(JSON.stringify(inventory)),excludedPlanFiles:plan.map(f=>'worker/'+f),unitOverlap:overlap,examples:examples.map(file=>({file,project:'worker-d1-integration',sha256:hash(fs.readFileSync(path.join(etchly,file)))})),sourceHashes:Object.fromEntries([...new Set(sources)].map(p=>[p,fs.existsSync(path.join(root,p))?hash(fs.readFileSync(path.join(root,p))):null])),repositories:[root,etchly,path.join(root,'raf-develop')].map(repository=>({repository,sha:git(repository,['rev-parse','HEAD']),branch:git(repository,['branch','--show-current']),dirty:git(repository,['status','--porcelain=v1'])})),generation:{entrypoint:'/srv/dev/work/orchestrator/.git/modules/raf/raf-hotfix/generations/3557f6a4-89a2-41a3-b963-b4343aabc699/raf-main/bin/raf.ts',workingMainSha:git(path.join(root,'raf-main'),['rev-parse','HEAD'])},localCheckPaths:checks.map(p=>({path:p,exists:fs.existsSync(path.join(etchly,p))}))};
fs.writeFileSync(path.join(target,'static-audit.json'),JSON.stringify(audit,null,2)+'\n');
console.log(JSON.stringify({count:inventory.length,hash:audit.inventorySha256,overlap,examples:audit.examples,missing: audit.localCheckPaths.filter(x=>!x.exists)}));
