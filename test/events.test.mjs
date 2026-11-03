import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { watchQueueEvents } from '../lib/events.mjs';
import { Dispatcher } from '../lib/dispatcher.mjs';
import { CodexQueue } from '../lib/codex-queue.mjs';
import { dropAcknowledgedPrompts } from '../lib/queue-cleanup.mjs';
const route={key:'one',codexThreadId:'11111111-1111-7111-8111-111111111111',dshSessionId:'session-22222222-2222-7222-8222-222222222222',dshWorkspaceId:'33333333-3333-7333-8333-333333333333',projectPath:process.cwd(),authorization:'user-approved'};
const msg={routeKey:'one',workstream:'bridge',kind:'notice',classification:'technical',body:'Synthetic connection evidence only.'};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function setup(t,overrides={}){
  const root=mkdtempSync(join(tmpdir(),'bridge-events-')),s=new Store(root);s.bind(route);t.after(()=>s.close());
  const calls=[],p={enabled:true,routes:{one:{...route,revision:1,businessPaused:true}}};
  const adapter={eligible:async()=>({ok:true}),enqueue:async args=>{calls.push(args);return {queuedSubmissionId:args.clientUserMessageId};},wake:async()=>({requestedAt:Date.now()}),...overrides};
  const d=new Dispatcher(s,adapter,{policy:()=>p});return {s,root,calls,p,d};
}
test('filesystem event delivers a new message without a timer poll; health is not a message',async t=>{
  const {s,root,calls,d}=setup(t);let events=0;
  const watch=watchQueueEvents(s,()=>{events++;void d.pump();});t.after(()=>watch.close());
  const other=new Store(root);t.after(()=>other.close());
  for(let i=0;i<5;i++)other.heartbeat('noise',{ready:true});
  await wait(100);assert.equal(events,0);assert.equal(calls.length,0);
  const m=other.send({...msg,messageId:'event-real'},'dsh');
  const deadline=Date.now()+2000;while(calls.length<1&&Date.now()<deadline)await wait(10);
  assert.equal(calls.length,1);assert.equal(s.message(m.messageId).state,'accepted');
  await wait(100);assert.equal(calls.length,1);
});
test('simultaneous dispatcher instances claim once and do not change target model',async t=>{
  const {s,root,d,calls,p}=setup(t);s.send({...msg,messageId:'collision'},'dsh');
  const second=new Store(root);t.after(()=>second.close());
  const d2=new Dispatcher(second,{eligible:async()=>({ok:true}),enqueue:async x=>{calls.push(x);return {queuedSubmissionId:'second'};},wake:async()=>({})},{policy:()=>p});
  await Promise.all([d.pump(),d2.pump(),d.pump()]);assert.equal(calls.length,1);assert.equal(calls[0].threadId,route.codexThreadId);
  assert.equal(calls[0].model,undefined);assert.equal(calls[0].thinking,undefined);
});
test('paused business remains queued while a later connection receipt can pass',async t=>{
  const {s,d,calls}=setup(t);s.send({...msg,messageId:'business',workstream:'main'},'dsh');s.send({...msg,messageId:'bridge'},'dsh');
  await d.pump();assert.equal(calls.length,1);assert.equal(s.message('business').state,'queued');assert.equal(s.message('bridge').state,'accepted');
});
test('started receipt releases the next reply without falsely completing business or flooding the inbox',async t=>{
  const {s,d,calls}=setup(t);s.send({...msg,messageId:'first'},'dsh');s.send({...msg,messageId:'second'},'dsh');s.send({...msg,messageId:'third'},'dsh');
  await d.pump();await d.pump();assert.equal(calls.length,1);
  s.ack({routeKey:'one',messageId:'first',state:'started'});await d.pump();assert.equal(calls.length,2);
  assert.equal(s.message('first').state,'started');assert.equal(s.message('second').state,'accepted');
  await d.pump();assert.equal(calls.length,2);assert.equal(s.message('third').state,'queued');
  s.ack({routeKey:'one',messageId:'first',state:'completed',evidence:'Synthetic receipt verified.'});
  await d.pump();assert.equal(calls.length,2);
  s.ack({routeKey:'one',messageId:'second',state:'started'});await d.pump();await d.pump();
  assert.equal(calls.length,3);assert.equal(s.message('second').state,'started');
});
test('offline/archive checks retain message; recovery event dispatches same ID',async t=>{
  let ready=false;const {s,d,calls}=setup(t,{eligible:async()=>({ok:ready,code:'CODEX_OFFLINE'})});s.send({...msg,messageId:'offline'},'dsh');
  await d.pump();assert.equal(s.message('offline').state,'queued');assert.equal(calls.length,0);
  ready=true;await d.pump();assert.equal(calls.length,1);assert.equal(s.message('offline').state,'accepted');
});
test('queue timeout remains unknown and is never blindly resubmitted',async t=>{
  let attempts=0;const {s,d}=setup(t,{enqueue:async()=>{attempts++;throw Error('timeout');}});s.send({...msg,messageId:'timeout'},'dsh');s.send({...msg,messageId:'behind-unknown'},'dsh');
  await d.pump();await d.pump();assert.equal(attempts,1);assert.equal(s.message('timeout').state,'unknown');assert.equal(s.message('behind-unknown').state,'queued');
});
test('wake failure keeps durable inbox receipt; it must not enqueue again',async t=>{
  const {s,d,calls}=setup(t,{wake:async()=>{throw Error('offline');}});s.send({...msg,messageId:'wake'},'dsh');
  await d.pump();await d.pump();assert.equal(calls.length,1);assert.equal(s.message('wake').state,'accepted');assert.ok(s.message('wake').receipt.queuedSubmissionId);
});
test('changed binding policy fails closed and Codex sender never enters DSH inbox pump',async t=>{
  const {s,d,calls,p}=setup(t);p.routes.one.codexThreadId='44444444-4444-7444-8444-444444444444';
  s.send({...msg,messageId:'wrong-binding'},'dsh');s.send({...msg,messageId:'outgoing'},'codex');await d.pump();assert.equal(calls.length,0);
});
test('inbox adapter cannot claim execution ownership or read histories',()=>{
  const q=Object.create(CodexQueue.prototype);
  assert.throws(()=>q.call('turn/start',{}),/QUEUE_RPC_NOT_ALLOWED/);
  assert.throws(()=>q.call('thread/resume',{}),/QUEUE_RPC_NOT_ALLOWED/);
  assert.throws(()=>q.call('thread/read',{includeTurns:true}),/THREAD_HISTORY_NOT_ALLOWED/);
});
test('busy recipient consuming a message removes only its own redundant queued wake',async t=>{
  const {s,d}=setup(t);const m=s.send({...msg,messageId:'consumed-while-busy'},'dsh');await d.pump();
  const r=s.message(m.messageId).receipt;
  const inbox=[{id:r.queuedSubmissionId,clientUserMessageId:r.clientUserMessageId},{id:'user-message',clientUserMessageId:'unrelated'}],deleted=[];
  const adapter={list:async()=>inbox,remove:async(threadId,id)=>{assert.equal(threadId,route.codexThreadId);deleted.push(id);inbox.splice(inbox.findIndex(x=>x.id===id),1);}};
  const seen=new Set();assert.equal(await dropAcknowledgedPrompts(s,adapter,seen),0);
  s.ack({routeKey:'one',messageId:m.messageId,state:'started'});
  assert.equal(await dropAcknowledgedPrompts(s,adapter,seen),1);assert.equal(await dropAcknowledgedPrompts(s,adapter,seen),0);
  assert.deepEqual(deleted,[r.queuedSubmissionId]);assert.equal(inbox[0].id,'user-message');assert.equal(s.message(m.messageId).state,'started');
});
