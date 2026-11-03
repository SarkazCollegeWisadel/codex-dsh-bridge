import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { Store } from '../lib/store.mjs';
import { applySuccessor, migrationPlan, inspectSuccessor, syncSuccessorPolicy, readHeaderOnly } from '../lib/successor.mjs';
const from='session-22222222-2222-7222-8222-222222222222',to='session-44444444-4444-7444-8444-444444444444';
const workspaceId='33333333-3333-7333-8333-333333333333';
const route={key:'test',codexThreadId:'11111111-1111-7111-8111-111111111111',dshSessionId:from,dshWorkspaceId:workspaceId,projectPath:resolve('.'),authorization:'user-approved'};
const base={routeKey:'test',workstream:'main',kind:'task',classification:'technical',body:'Synthetic technical task.'};
function setup(t){
 const root=mkdtempSync(join(tmpdir(),'successor-')),store=new Store(root);store.bind(route);t.after(()=>store.close());
 const facts={from,to,workspaceId,sourceDetached:true,successorArchived:false,child:{id:to,parentSession:from,isSeeded:true}};
 const input={routeKey:'test',from,to,expectedRevision:1,authorization:'user-approved',carryMessageIds:[],observedAfter:Date.now()};
 store.heartbeat('route:test',{ready:false,code:'WORKSPACE_MISMATCH'});return{root,store,facts,input};
}
test('migration preserves every message byte/state and task head; moves only binding identity',t=>{
 const {store,facts,input}=setup(t);store.send({...base,messageId:'old'});store.ack({routeKey:'test',messageId:'old'},'dsh');
 store.send({...base,messageId:'new',taskKey:'repair',taskRevision:1,supersedes:['old']});
 store.send({...base,messageId:'ping',workstream:'bridge',kind:'handshake'});input.carryMessageIds=['ping','new'];
 const before=store.db.prepare('SELECT * FROM messages ORDER BY id').all(),tasks=store.current({routeKey:'test'}).tasks;
 const result=applySuccessor(store,input,facts);assert.equal(result.route.revision,2);assert.equal(result.route.dshSessionId,to);
 assert.deepEqual(store.db.prepare('SELECT * FROM messages ORDER BY id').all(),before);assert.deepEqual(store.current({routeKey:'test'}).tasks,tasks);
 assert.equal(store.message('old').state,'started');assert.equal(store.message('old').execution.actionable,false);
 assert.deepEqual(store.pending('dsh').map(x=>x.id).sort(),['new','ping']);assert.throws(()=>store.forSession(from),/CALLING_SESSION_NOT_BOUND/);
 assert.equal(store.forSession(to).codexThreadId,route.codexThreadId);assert.throws(()=>applySuccessor(store,input,facts),/BINDING_REVISION_MISMATCH/);
});
for(const state of ['dispatching','accepted','unknown','started'])test('blocks unresolved source '+state,t=>{
 const {store,facts,input}=setup(t);store.send({...base,messageId:'busy'});store.claim('busy','dsh');
 if(['accepted','unknown'].includes(state))store.dispatchResult('busy',state);if(state==='started')store.ack({routeKey:'test',messageId:'busy'},'dsh');
 assert.throws(()=>applySuccessor(store,input,facts),/SOURCE_DELIVERY_UNRESOLVED|SOURCE_WORK_STILL_ACTIVE/);assert.equal(store.route('test').revision,1);
});
test('wrong lineage, revision, explicit carry set, or authorization cannot mutate binding',t=>{
 const {store,facts,input}=setup(t);store.send({...base,messageId:'queued'});
 assert.throws(()=>migrationPlan(store,input,facts),/CARRY_SET_MISMATCH/);input.carryMessageIds=['queued'];
 assert.throws(()=>migrationPlan(store,{...input,authorization:'inferred'},facts),/EXPLICIT_SUCCESSOR/);
 assert.throws(()=>migrationPlan(store,{...input,expectedRevision:2},facts),/BINDING_REVISION/);
 assert.throws(()=>migrationPlan(store,input,{...facts,child:{...facts.child,parentSession:to}}),/SUCCESSOR_FACTS/);
 assert.equal(store.route('test').dshSessionId,from);
});
test('fresh unavailability is required; idle cached status is not live proof',t=>{
 const {store,facts,input}=setup(t);store.heartbeat('route:test',{ready:true,code:'READY'});
 assert.throws(()=>applySuccessor(store,input,facts),/FRESH_SOURCE/);
 store.heartbeat('route:test',{ready:false,code:'WORKSPACE_MISMATCH'});
 store.db.prepare('UPDATE health SET time=? WHERE name=?').run(Date.now()-60000,'route:test');
 assert.throws(()=>applySuccessor(store,{...input,observedAfter:0},facts),/FRESH_SOURCE/);
});
test('policy sync is repeatable and preserves other routes, pause and extra settings',t=>{
 const {store,root,facts,input}=setup(t);const path=join(root,'state/event-worker.config.json');
 const config={enabled:true,extra:'keep',routes:{test:{codexThreadId:route.codexThreadId,dshSessionId:from,revision:1,businessPaused:true},other:{setting:'untouched'}}};writeFileSync(path,JSON.stringify(config));
 applySuccessor(store,input,facts);syncSuccessorPolicy(store,path,'test',input);syncSuccessorPolicy(store,path,'test',input);
 const after=JSON.parse(readFileSync(path));assert.deepEqual(after.routes.other,config.routes.other);assert.equal(after.extra,'keep');assert.equal(after.routes.test.businessPaused,true);assert.equal(after.routes.test.revision,2);
});
test('header parser returns only identity, not prompts; archive/workspace checks use fixed IDs',async t=>{
 const {root}=setup(t),home=join(root,'dsh');mkdirSync(join(home,'storages'),{recursive:true});
 for(const id of [from,to]){const dir=join(home,'sessions','project',id);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'session.v4.jsonl.zstd'),zstdCompressSync(Buffer.from(JSON.stringify({type:'session',version:4,id,parentSession:id===to?from:undefined,isSeeded:id===to,createdAt:1,privateSentinel:'DO_NOT_RETURN'})+'\n'+JSON.stringify({type:'user/message',text:'SYNTHETIC_PRIVATE_SENTINEL'})+'\n')));}
 const path=join(home,'storages/workspace.json'),workspace={global:{archivedSessionIds:[]},tables:{workspaces:{[workspaceId]:{sessionIds:[to]}}}};writeFileSync(path,JSON.stringify(workspace));
 const result=await inspectSuccessor(home,from,to,workspaceId);assert.equal(result.child.parentSession,from);assert.ok(!JSON.stringify(result).includes('SENTINEL'));
 workspace.global.archivedSessionIds=[to];writeFileSync(path,JSON.stringify(workspace));await assert.rejects(inspectSuccessor(home,from,to,workspaceId),/SUCCESSOR_ARCHIVED/);
 workspace.global.archivedSessionIds=[];workspace.tables.workspaces[workspaceId].sessionIds.push(from);writeFileSync(path,JSON.stringify(workspace));await assert.rejects(inspectSuccessor(home,from,to,workspaceId),/SUCCESSOR_WORKSPACE_MISMATCH/);
});
