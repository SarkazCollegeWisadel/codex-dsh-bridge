import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Store } from '../lib/store.mjs';
import { Relay } from '../lib/relay.mjs';
import { invoke } from '../lib/api.mjs';
const route={key:'sample',codexThreadId:'11111111-1111-7111-8111-111111111111',dshSessionId:'session-22222222-2222-7222-8222-222222222222',dshWorkspaceId:'33333333-3333-7333-8333-333333333333',projectPath:resolve('.'),authorization:'user-approved'};
const message={routeKey:'sample',kind:'task',classification:'technical',body:'Check the synthetic add function.'};
function fixture(t){const root=mkdtempSync(join(tmpdir(),'dsh-codex-bridge-test-'));const store=new Store(root);store.bind(route);t.after(()=>store.close());return {root,store};}
const live={sessionId:route.dshSessionId,workspaceId:route.dshWorkspaceId,archived:false,running:false};
test('durable queue survives another connection and returns same ID once',t=>{
  const {root,store}=fixture(t);const a=store.send({...message,messageId:'durable-1'});const b=new Store(root);
  try{assert.equal(b.message(a.messageId).state,'queued');assert.equal(b.send({...message,messageId:a.messageId}).messageId,a.messageId);assert.equal(b.pending('dsh').length,1);
    assert.throws(()=>b.send({...message,messageId:a.messageId,body:'Different task.'}),/MESSAGE_ID_CONFLICT/);}finally{b.close();}
});
test('fixed IDs reject collisions and implicit rebindings',t=>{const {store}=fixture(t);
  assert.throws(()=>store.bind({...route,key:'other'}),/SESSION_ALREADY_BOUND/);
  assert.throws(()=>store.bind({...route,dshSessionId:'session-44444444-4444-7444-8444-444444444444'}),/BINDING_REVISION_REQUIRED/);
  assert.throws(()=>store.bind({...route,key:'not-approved',authorization:'inferred'}),/EXPLICIT_BINDING_REQUIRED/);
});
test('two directions round trip, acknowledgements and replies are idempotent',t=>{
  const {store}=fixture(t);const a=store.send(message);store.ack({routeKey:route.key,messageId:a.messageId},'dsh');
  const b=store.send({...message,kind:'evidence',inReplyTo:a.messageId,body:'Synthetic evidence: test passed.'},'dsh');
  assert.equal(store.message(a.messageId).state,'replied');store.ack({routeKey:route.key,messageId:b.messageId});
  const c=store.send({...message,kind:'review',inReplyTo:b.messageId,body:'Evidence checked; synthetic task complete.'});
  assert.equal(store.message(b.messageId).state,'replied');assert.equal(store.receive({routeKey:route.key,messageId:c.messageId},'dsh').length,1);
  store.ack({routeKey:route.key,messageId:b.messageId});assert.equal(store.message(b.messageId).state,'replied');
});
test('wrong route, wrong side and wrong workstream cannot acknowledge or reply',t=>{
  const {store}=fixture(t);store.bind({...route,key:'second',codexThreadId:'44444444-4444-7444-8444-444444444444',dshSessionId:'session-55555555-5555-7555-8555-555555555555'});
  const a=store.send(message);assert.throws(()=>store.ack({routeKey:'second',messageId:a.messageId},'dsh'),/ACK_ROUTE_MISMATCH/);
  assert.throws(()=>store.ack({routeKey:route.key,messageId:a.messageId}),/ACK_ROUTE_MISMATCH/);
  store.ack({routeKey:route.key,messageId:a.messageId},'dsh');
  assert.throws(()=>store.send({...message,routeKey:'second',inReplyTo:a.messageId},'dsh'),/REPLY_ROUTE_MISMATCH/);
  assert.throws(()=>store.send({...message,workstream:'bridge',inReplyTo:a.messageId},'dsh'),/REPLY_ROUTE_MISMATCH/);
});
test('shared technical artifacts validate hashes and deny outside files',t=>{
  const {root,store}=fixture(t);const content='Synthetic technical evidence only.';writeFileSync(join(root,'artifacts','evidence.txt'),content);
  const digest=createHash('sha256').update(content).digest('hex');assert.equal(store.send({...message,artifactRefs:[{path:'evidence.txt',sha256:digest}]}).artifactRefs.length,1);
  assert.throws(()=>store.send({...message,artifactRefs:[{path:'evidence.txt',sha256:'0'.repeat(64)}]}),/ARTIFACT_HASH_MISMATCH/);
  writeFileSync(join(root,'private.txt'),content);assert.throws(()=>store.send({...message,artifactRefs:[{path:join(root,'private.txt'),sha256:digest}]}),/ARTIFACT_OUTSIDE_SHARED_DIRECTORY/);
});
test('synthetic personal identifiers and secrets are refused without storage',t=>{
  const {store}=fixture(t);for(const body of ['Contact alice@example.test','Synthetic phone 13800138000','api_key = abcdefghijklmnopqrstuvwxyz','Bearer abcdefghijklmnopqrstuvwxyz','sk-abcdefghijklmnopqrstuvwxyz'])
    assert.throws(()=>store.send({...message,body}),/POSSIBLE_PRIVATE_CONTENT/);
  assert.equal(store.pending('dsh').length,0);assert.throws(()=>store.send({...message,classification:undefined}),/CONTENT_CLASSIFICATION_REQUIRED/);
});
test('reopened pending messages wait while host is offline',async t=>{
  const {store}=fixture(t);const a=store.send(message);let calls=0;const relay=new Relay(store,{list:async()=>{throw new Error('offline');},prompt:()=>{calls++;}});
  await relay.tick();assert.equal(calls,0);assert.equal(store.message(a.messageId).state,'queued');assert.equal(store.status().host.ready,false);
});
test('archived, missing, wrong workspace and busy sessions are not dispatched',async t=>{
  const {store}=fixture(t);const a=store.send(message);let calls=0;
  for(const list of [[],[{...live,archived:true}],[{...live,workspaceId:'other'}],[{...live,running:true}]]){
    await new Relay(store,{list:async()=>list,prompt:()=>{calls++;}}).tick();
    assert.equal(calls,0);assert.equal(store.message(a.messageId).state,'queued');
  }
});
test('native acceptance is recorded only after accepted=true and request uses same ID',async t=>{
  const {store}=fixture(t);const a=store.send(message);let count=0;
  const relay=new Relay(store,{list:async()=>[live],prompt:async(req,signal)=>{count++;assert.equal(req.requestId,a.messageId);assert.equal(req.mode,'queue');assert.ok(signal instanceof AbortSignal);return {accepted:true};}});
  await relay.tick();await relay.tick();assert.equal(count,1);assert.equal(store.message(a.messageId).state,'accepted');
});

test('verified native queue admits behind a busy turn once without steering',async t=>{
  const {store}=fixture(t);const a=store.send(message);const calls=[];
  const relay=new Relay(store,{supportsBusyQueue:true,list:async()=>[{...live,running:true}],
    prompt:async req=>{calls.push(req);return {accepted:true};}});
  await relay.tick();await relay.tick();
  assert.equal(calls.length,1);assert.equal(calls[0].requestId,a.messageId);
  assert.equal(calls[0].mode,'queue');assert.equal(calls[0].sessionId,route.dshSessionId);
  assert.equal(store.message(a.messageId).state,'accepted');
  assert.equal(store.message(a.messageId).receipt.queuedWhileRunning,true);
});

test('busy native queue capability never bypasses pause, archive or binding gates',async t=>{
  const {store}=fixture(t);const a=store.send(message);let calls=0;
  for(const [current,allow] of [[{...live,running:true},()=>false],
      [{...live,running:true,archived:true},()=>true],[{...live,running:true,workspaceId:'other'},()=>true]]){
    await new Relay(store,{supportsBusyQueue:true,list:async()=>[current],prompt:async()=>{calls++;return {accepted:true};}},{allow}).tick();
    assert.equal(calls,0);assert.equal(store.message(a.messageId).state,'queued');
  }
});
test('timeouts become unknown and are not blindly retried',async t=>{
  const {store}=fixture(t);const a=store.send(message);let count=0;
  const relay=new Relay(store,{list:async()=>[live],prompt:()=>{count++;return new Promise(()=>{});}},{timeoutMs:15});
  await relay.tick();await relay.tick();assert.equal(count,1);assert.equal(store.message(a.messageId).state,'unknown');
  store.reconcile({messageId:a.messageId,outcome:'accepted',evidence:'Synthetic receipt confirms admission.'});assert.equal(store.message(a.messageId).state,'accepted');
});
test('late acknowledgement wins over transport failure',async t=>{
  const {store}=fixture(t);const a=store.send(message);
  await new Relay(store,{list:async()=>[live],prompt:async()=>{store.ack({routeKey:route.key,messageId:a.messageId},'dsh');throw new Error('late failure');}}).tick();
  assert.equal(store.message(a.messageId).state,'started');
});
test('crashed coordinator claim expires to unknown, never silently to queued',t=>{
  const {store}=fixture(t);const a=store.send(message,'dsh');assert.equal(store.claim(a.messageId).claimed,true);assert.equal(store.claim(a.messageId).claimed,false);
  store.db.prepare('UPDATE messages SET lease_until=0 WHERE id=?').run(a.messageId);store.expireClaims();assert.equal(store.message(a.messageId).state,'unknown');assert.deepEqual(store.pending(),[]);
});
test('public API cannot forge DSH sender or extra routing fields',t=>{
  const {store}=fixture(t);assert.throws(()=>invoke(store,'bridge_send',{...message,source:'dsh'}),/UNKNOWN_PARAMETER/);
  assert.throws(()=>invoke(store,'bridge_receive',{}),/MISSING_PARAMETER/);assert.throws(()=>store.forSession('not-bound'),/CALLING_SESSION_NOT_BOUND/);
});
test('terminal message closes with evidence without another reply loop',t=>{
  const {store}=fixture(t);const a=store.send(message,'dsh');
  assert.throws(()=>store.ack({routeKey:route.key,messageId:a.messageId,state:'completed',evidence:'Receipt checked.'}),/ACK_STARTED_BEFORE_COMPLETION/);
  store.ack({routeKey:route.key,messageId:a.messageId});
  assert.throws(()=>store.ack({routeKey:route.key,messageId:a.messageId,state:'completed'}),/INVALID_BODY/);
  store.ack({routeKey:route.key,messageId:a.messageId,state:'completed',evidence:'Receipt checked; no further reply needed.'});
  assert.equal(store.message(a.messageId).state,'completed');assert.equal(store.receive({routeKey:route.key}).length,0);
});
test('MCP initialization/list/status work over real stdio',t=>{
  const {root}=fixture(t);const input=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'bridge_status',arguments:{}}}].map(JSON.stringify).join('\n')+'\n';
  const r=spawnSync(process.execPath,['bin/mcp.mjs'],{cwd:resolve(import.meta.dirname,'..'),env:{...process.env,DSH_CODEX_BRIDGE_ROOT:root},input,encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0,r.stderr);const rows=r.stdout.trim().split('\n').map(JSON.parse);assert.equal(rows.length,3);assert.equal(rows[0].result.protocolVersion,'2025-06-18');assert.equal(rows[1].result.tools.length,6);assert.ok(rows[1].result.tools.some(t=>t.name==='bridge_current'));assert.equal(rows[2].result.isError,false);
});
test('concurrent CLI senders produce one durable message for same ID',async t=>{
  const {root,store}=fixture(t);const payload=JSON.stringify({...message,messageId:'concurrent-1'});
  const run=()=>new Promise((res,rej)=>{const child=spawn(process.execPath,['bin/bridge.mjs','send'],{cwd:resolve(import.meta.dirname,'..'),env:{...process.env,DSH_CODEX_BRIDGE_ROOT:root},windowsHide:true});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',rej);child.on('close',code=>res({code,out,err}));child.stdin.end(payload);});
  const results=await Promise.all([run(),run(),run()]);for(const r of results)assert.equal(r.code,0,r.err);
  assert.equal(store.pending('dsh').length,1);
});
