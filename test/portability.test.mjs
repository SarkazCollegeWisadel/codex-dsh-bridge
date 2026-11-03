import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';
import { workerScript } from '../lib/worker-launch.mjs';

const packageRoot=fileURLToPath(new URL('../',import.meta.url));
const temporary=()=>mkdtempSync(join(tmpdir(),'bridge-portable-'));
test('default data root honors explicit environment and stays outside package code',()=>{
  const root=temporary();
  const p=spawnSync(process.execPath,['--input-type=module','-e',
    "import {Store,DEFAULT_ROOT} from './lib/store.mjs';const s=new Store();console.log(JSON.stringify({root:s.root,defaultRoot:DEFAULT_ROOT,routes:s.routes()}));s.close();"],
    {cwd:packageRoot,encoding:'utf8',env:{...process.env,DSH_CODEX_BRIDGE_ROOT:root}});
  assert.equal(p.status,0,p.stderr);const result=JSON.parse(p.stdout);
  assert.equal(result.root,resolve(root));assert.equal(result.defaultRoot,resolve(root));assert.deepEqual(result.routes,[]);
  assert.equal(existsSync(join(root,'state/bridge.sqlite')),true);
  assert.equal(workerScript,fileURLToPath(new URL('../bin/event-worker.mjs',import.meta.url)));
  assert.equal(existsSync(join(root,'bin/event-worker.mjs')),false);
});
test('explicit route policy configuration does not start desktop delivery',()=>{
  const root=temporary(),store=new Store(root);
  store.bind({key:'sample',codexThreadId:'11111111-1111-7111-8111-111111111111',dshSessionId:'session-22222222-2222-7222-8222-222222222222',dshWorkspaceId:'33333333-3333-7333-8333-333333333333',projectPath:root,authorization:'user-approved'});store.close();
  const input=join(root,'input.json');writeFileSync(input,JSON.stringify({authorization:'user-approved',routes:[{routeKey:'sample',businessPaused:false}]}));
  const p=spawnSync(process.execPath,[workerScript,'configure','--json-file',input],{cwd:packageRoot,encoding:'utf8',env:{...process.env,DSH_CODEX_BRIDGE_ROOT:root}});
  assert.equal(p.status,0,p.stderr);const policy=JSON.parse(readFileSync(join(root,'state/event-worker.config.json'),'utf8'));
  assert.equal(policy.enabled,false);assert.equal(policy.routes.sample.businessPaused,false);assert.equal(policy.routes.sample.revision,1);
  assert.equal(existsSync(join(root,'state/event-worker.lock')),false);
});
test('worker stop is safe before first configuration and does not create a route',()=>{
  const root=join(temporary(),'fresh');
  const p=spawnSync(process.execPath,[workerScript,'stop'],{encoding:'utf8',env:{...process.env,DSH_CODEX_BRIDGE_ROOT:root}});
  assert.equal(p.status,0,p.stderr);assert.equal(JSON.parse(p.stdout).stopRequested,true);
  assert.equal(existsSync(join(root,'state/bridge.sqlite')),false);
});
test('invalid explicitly selected Codex executable never falls back to another install',()=>{
  const missing=join(temporary(),'nonexistent.exe');
  const p=spawnSync(process.execPath,['--input-type=module','-e',
    "import {codexExe} from './lib/codex-queue.mjs';try{codexExe();process.exitCode=2;}catch(e){console.log(e.message);}"],
    {cwd:packageRoot,encoding:'utf8',env:{...process.env,CODEX_APP_RUNTIME_CLI_PATH:missing}});
  assert.equal(p.status,0,p.stderr);assert.equal(p.stdout.trim(),'CODEX_CLI_SELECTION_REQUIRED');
});
