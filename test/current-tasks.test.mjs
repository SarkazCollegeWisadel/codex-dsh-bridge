import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Store } from '../lib/store.mjs';
import { Dispatcher } from '../lib/dispatcher.mjs';
import { Relay, promptText } from '../lib/relay.mjs';
import { invoke } from '../lib/api.mjs';

const route={key:'test',codexThreadId:'11111111-1111-7111-8111-111111111111',dshSessionId:'session-22222222-2222-7222-8222-222222222222',dshWorkspaceId:'33333333-3333-7333-8333-333333333333',projectPath:resolve('.'),authorization:'user-approved'};
const base={routeKey:'test',workstream:'main',kind:'task',classification:'technical',body:'Synthetic exact revision task.'};
function setup(t){const root=mkdtempSync(join(tmpdir(),'bridge-current-')),store=new Store(root);store.bind(route);t.after(()=>store.close());return {root,store};}
function task(store,id,revision=1,supersedes=[],taskKey='repair'){return store.send({...base,messageId:id,taskKey,taskRevision:revision,supersedes});}
function dispatcher(store,calls){return new Dispatcher(store,{eligible:async()=>({ok:true}),enqueue:async x=>{calls.push(x);return {queuedSubmissionId:x.clientUserMessageId};},wake:async()=>({})},{policy:()=>({enabled:true,routes:{test:{...route,revision:1,businessPaused:false}}})});}

test('explicit supersession retains original transport state and audit, excludes only named legacy work',t=>{
  const {store}=setup(t);store.send({...base,messageId:'legacy'});store.send({...base,messageId:'parallel'});
  task(store,'current',1,['legacy']);
  const old=store.message('legacy');assert.equal(old.state,'queued');assert.equal(old.execution.status,'superseded');assert.equal(old.execution.supersededBy,'current');
  assert.deepEqual(store.pending('dsh').map(x=>x.id),['current','parallel']);assert.equal(store.claim('legacy','dsh').claimed,false);
  const explicit=store.receive({routeKey:'test',messageId:'legacy'},'dsh')[0];assert.equal(explicit.currentTasks.tasks[0].messageId,'current');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE id='legacy' AND state='superseded'").get().n,1);
});

test('current task revision update is idempotent, explicit and monotonically consecutive',t=>{
  const {store}=setup(t);task(store,'v1');const a=task(store,'v2',2,['v1']);
  assert.equal(task(store,'v2',2,['v1']).messageId,a.messageId);
  assert.throws(()=>task(store,'skip',4,['v2']),/TASK_REVISION_CONFLICT/);
  assert.throws(()=>task(store,'implicit',3,[]),/PRIOR_TASK_MUST_BE_EXPLICITLY_SUPERSEDED/);
  assert.equal(store.current({routeKey:'test'}).tasks[0].taskRevision,2);
});

test('replies inherit old revision; late evidence stays retrievable without waking or completing current work',t=>{
  const {store}=setup(t);task(store,'v1');store.ack({routeKey:'test',messageId:'v1'},'dsh');task(store,'v2',2,['v1']);
  const old=store.send({...base,messageId:'late-proof',kind:'evidence',inReplyTo:'v1'},'dsh');
  assert.equal(old.taskRevision,1);assert.equal(old.execution.status,'superseded');assert.equal(store.pending().length,0);
  assert.equal(store.receive({routeKey:'test',messageId:'late-proof'})[0].body,base.body);
  assert.equal(store.message('v2').state,'queued');
  const ack=store.ack({routeKey:'test',messageId:'late-proof'});assert.equal(ack.acknowledged,false);assert.equal(ack.code,'MESSAGE_SUPERSEDED');assert.equal(ack.state,'queued');
});

test('DSH cannot advance a revision or relabel an obsolete reply as current',t=>{
  const {store}=setup(t);task(store,'v1');store.ack({routeKey:'test',messageId:'v1'},'dsh');task(store,'v2',2,['v1']);
  assert.throws(()=>store.send({...base,messageId:'forge',taskKey:'repair',taskRevision:3},'dsh'),/UNKNOWN_TASK_REVISION/);
  assert.throws(()=>store.send({...base,messageId:'relabel',kind:'evidence',inReplyTo:'v1',taskKey:'repair',taskRevision:2},'dsh'),/REPLY_TASK_MISMATCH/);
  assert.throws(()=>store.send({...base,messageId:'replace',taskKey:'repair',taskRevision:2,supersedes:['v2']},'dsh'),/INVALID_SUPERSEDES/);
  assert.equal(store.current({routeKey:'test'}).tasks[0].messageId,'v2');
});

test('independent tasks within one workstream and wrong route replacements stay separated',t=>{
  const {store}=setup(t);task(store,'a1');task(store,'b1',1,[],'parallel');
  assert.throws(()=>task(store,'cross',2,['a1','b1']),/SUPERSEDES_TASK_MISMATCH/);
  task(store,'a2',2,['a1']);assert.equal(store.message('b1').execution.actionable,true);
  store.bind({...route,key:'other',codexThreadId:'44444444-4444-7444-8444-444444444444',dshSessionId:'session-55555555-5555-7555-8555-555555555555'});
  store.send({...base,routeKey:'other',messageId:'other-route'});
  assert.throws(()=>task(store,'cross-route',3,['a2','other-route']),/SUPERSEDES_ROUTE_MISMATCH/);
});

test('unknown stays unknown when superseded; reconcile cannot blindly requeue it',t=>{
  const {store}=setup(t);store.send({...base,messageId:'uncertain'});store.claim('uncertain','dsh');store.dispatchResult('uncertain','unknown',{code:'TIMEOUT'});
  task(store,'now',1,['uncertain']);assert.equal(store.message('uncertain').state,'unknown');
  assert.throws(()=>store.reconcile({messageId:'uncertain',outcome:'queued',evidence:'Attempted blind retry.'}),/MESSAGE_SUPERSEDED_OR_RECEIPT/);
  store.reconcile({messageId:'uncertain',outcome:'accepted',evidence:'Exact native receipt independently recovered.'});
  assert.equal(store.message('uncertain').state,'accepted');assert.equal(store.message('uncertain').execution.nativeCancellation,'not-attempted');
});

test('superseded unknown no longer blocks the current valid Codex evidence lane',async t=>{
  const {store}=setup(t);const calls=[];store.send({...base,messageId:'old-result',kind:'result'},'dsh');store.claim('old-result');store.dispatchResult('old-result','unknown',{code:'TIMEOUT'});
  task(store,'now',1,['old-result']);store.ack({routeKey:'test',messageId:'now'},'dsh');
  store.send({...base,messageId:'current-evidence',kind:'evidence',inReplyTo:'now'},'dsh');
  await dispatcher(store,calls).pump();assert.equal(calls.length,1);assert.match(calls[0].prompt,/current-evidence/);assert.equal(store.message('old-result').state,'unknown');
});

test('explicit pure receipt is stored without recursive wake; legacy or substantive notices are not guessed away',async t=>{
  const {store}=setup(t);task(store,'request');store.ack({routeKey:'test',messageId:'request'},'dsh');
  const receipt=store.send({...base,messageId:'receipt',kind:'notice',delivery:'receipt',inReplyTo:'request'},'dsh');
  assert.equal(receipt.execution.status,'receipt');assert.equal(receipt.state,'queued');assert.equal(store.pending().length,0);
  const calls=[];await dispatcher(store,calls).pump();assert.equal(calls.length,0);
  store.send({...base,messageId:'new-information',kind:'notice'},'dsh');await dispatcher(store,calls).pump();assert.equal(calls.length,1);
  assert.throws(()=>store.send({...base,messageId:'invalid-receipt',kind:'evidence',delivery:'receipt',inReplyTo:'request'},'dsh'),/INVALID_RECEIPT/);
});

test('accepted native DSH followup is never reported canceled and obsolete ack cannot start it',async t=>{
  const {store}=setup(t);task(store,'old');const requests=[];
  const relay=new Relay(store,{supportsBusyQueue:true,list:async()=>[{sessionId:route.dshSessionId,workspaceId:route.dshWorkspaceId,archived:false,running:true}],prompt:async request=>{requests.push(request);return {accepted:true};}});
  await relay.tick();task(store,'new',2,['old']);await relay.tick();assert.equal(requests.length,2);
  const ack=store.ack({routeKey:'test',messageId:'old'},'dsh');assert.equal(ack.acknowledged,false);assert.equal(ack.state,'accepted');assert.equal(ack.execution.nativeCancellation,'not-attempted');
  assert.match(requests[1].content[0].text,/codex_bridge_current/);assert.match(requests[1].content[0].text,/execution.actionable/);
});

test('task revision artifacts are exact hashes and visible in current tool',t=>{
  const {root,store}=setup(t);const body='Synthetic fixture code revision.';writeFileSync(join(root,'artifacts','v1.txt'),body);const sha256=createHash('sha256').update(body).digest('hex');
  store.send({...base,messageId:'v1',taskKey:'repair',taskRevision:1,artifactRefs:[{path:'v1.txt',sha256}]});
  const current=invoke(store,'bridge_current',{routeKey:'test'});assert.equal(current.tasks[0].artifactRefs[0].sha256,sha256);
  assert.match(promptText(store.message('v1'),store.route('test')),new RegExp(sha256));
});

test('new explicit task can reply to superseded evidence without inheriting obsolete execution',t=>{
  const {store}=setup(t);task(store,'v1');store.ack({routeKey:'test',messageId:'v1'},'dsh');
  store.send({...base,messageId:'e1',kind:'evidence',inReplyTo:'v1'},'dsh');store.ack({routeKey:'test',messageId:'e1'});
  store.send({...base,messageId:'v2',taskKey:'repair',taskRevision:2,supersedes:['v1'],inReplyTo:'e1'});
  assert.equal(store.message('v2').execution.actionable,true);assert.equal(store.message('e1').execution.status,'superseded');
  store.ack({routeKey:'test',messageId:'v2'},'dsh');
  store.send({...base,messageId:'e2',kind:'evidence',inReplyTo:'v2'},'dsh');
  assert.equal(store.message('e2').execution.actionable,true);
  assert.equal(store.ack({routeKey:'test',messageId:'e2'}).state,'started');
  store.send({...base,messageId:'review2',kind:'review',inReplyTo:'e2'});
  assert.equal(store.message('review2').execution.actionable,true);
  task(store,'v3',3,['v2']);
  assert.equal(store.message('e2').execution.status,'superseded');
  assert.equal(store.message('review2').execution.status,'superseded');
});

test('new versioned task replacing legacy ancestor keeps descendant evidence current',t=>{
  const {store}=setup(t);
  store.send({...base,messageId:'legacy'});store.ack({routeKey:'test',messageId:'legacy'},'dsh');
  store.send({...base,messageId:'legacy-proof',kind:'evidence',inReplyTo:'legacy'},'dsh');
  store.ack({routeKey:'test',messageId:'legacy-proof'});
  store.send({...base,messageId:'new-task',taskKey:'repair',taskRevision:1,supersedes:['legacy'],inReplyTo:'legacy-proof'});
  store.ack({routeKey:'test',messageId:'new-task'},'dsh');
  const evidence=store.send({...base,messageId:'new-proof',kind:'result',inReplyTo:'new-task'},'dsh');
  assert.equal(evidence.execution.actionable,true);
  assert.deepEqual(store.pending('codex').map(x=>x.id),['new-proof']);
  assert.equal(store.message('legacy-proof').execution.status,'superseded');
  task(store,'newer-task',2,['new-task','new-proof']);
  assert.equal(store.message('new-proof').execution.status,'superseded');
});

test('concurrent distinct revision writers cannot both replace the same current task',async t=>{
  const {root,store}=setup(t);task(store,'v1');
  const run=id=>new Promise((resolveDone,reject)=>{
    const child=spawn(process.execPath,['bin/bridge.mjs','send'],{cwd:resolve(import.meta.dirname,'..'),env:{...process.env,DSH_CODEX_BRIDGE_ROOT:root},windowsHide:true});let out='',err='';
    child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('close',code=>resolveDone({code,out,err}));
    child.stdin.end(JSON.stringify({...base,messageId:id,taskKey:'repair',taskRevision:2,supersedes:['v1']}));
  });
  const results=await Promise.all([run('v2-a'),run('v2-b')]);assert.deepEqual(results.map(x=>x.code).sort(),[0,1]);
  assert.match(results.find(x=>x.code===1).err,/TASK_REVISION_CONFLICT/);assert.equal(store.current({routeKey:'test'}).tasks.length,1);
});

test('version state survives reopen without changing route permission or models',t=>{
  const {root,store}=setup(t);task(store,'v1');task(store,'v2',2,['v1']);const before=store.route('test');const reopened=new Store(root);
  try{assert.equal(reopened.message('v1').execution.status,'superseded');assert.equal(reopened.current({routeKey:'test'}).tasks[0].taskRevision,2);assert.deepEqual(reopened.route('test'),before);}finally{reopened.close();}
});
