import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

export const DEFAULT_ROOT = resolve(process.env.DSH_CODEX_BRIDGE_ROOT || join(homedir(), '.codex-dsh-bridge'));
export const VERSION = '0.3.0';
export class BridgeError extends Error { constructor(code) { super(code); this.code = code; } }
export const need = (ok, code) => { if (!ok) throw new BridgeError(code); };
const keyPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/;
const sha = x => createHash('sha256').update(x).digest('hex');
const json = x => JSON.stringify(x);
const parse = x => JSON.parse(x);
const states = ['queued','dispatching','accepted','started','replied','completed','failed','unknown'];
const secretPatterns = [
  /\bsk-[a-zA-Z0-9_-]{16,}\b/, /\bBearer\s+[a-zA-Z0-9._~-]{16,}/i,
  /(?:api[_-]?key|password|secret|access[_-]?token|SESSDATA)\s*[:=]\s*["']?[^\s"']{8,}/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
];
export function checkPublicText(value) {
  need(typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 48000,'INVALID_BODY');
  need(!secretPatterns.some(p=>p.test(value)), 'POSSIBLE_PRIVATE_CONTENT');
  return value;
}
export class Store {
  constructor(root = process.env.DSH_CODEX_BRIDGE_ROOT || DEFAULT_ROOT) {
    this.root=resolve(root); mkdirSync(join(this.root,'state'),{recursive:true}); mkdirSync(join(this.root,'artifacts'),{recursive:true});
    this.artifacts=realpathSync(join(this.root,'artifacts'));
    this.db=new DatabaseSync(join(this.root,'state','bridge.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS routes (key TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, route TEXT NOT NULL REFERENCES routes(key), direction TEXT NOT NULL,
        workstream TEXT NOT NULL, parent TEXT, payload TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL,
        created INTEGER NOT NULL, updated INTEGER NOT NULL, lease_until INTEGER, receipt TEXT);
      CREATE INDEX IF NOT EXISTS messages_pending ON messages(direction,state,created);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, time INTEGER NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS health (name TEXT PRIMARY KEY, time INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_heads (route TEXT NOT NULL, workstream TEXT NOT NULL, task_key TEXT NOT NULL,
        revision INTEGER NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id),
        PRIMARY KEY(route,workstream,task_key));
      CREATE TABLE IF NOT EXISTS message_supersessions (old_id TEXT PRIMARY KEY REFERENCES messages(id),
        new_id TEXT NOT NULL REFERENCES messages(id), created INTEGER NOT NULL);
      PRAGMA user_version=1;`);
  }
  close(){this.db.close();}
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r=fn(); this.db.exec('COMMIT'); return r; } catch(e) {this.db.exec('ROLLBACK');throw e;} }
  event(id,state,detail={}) {this.db.prepare('INSERT INTO events(id,time,state,detail) VALUES(?,?,?,?)').run(id,Date.now(),state,json(detail));}
  route(key) {const row=this.db.prepare('SELECT * FROM routes WHERE key=?').get(key);need(row,'ROUTE_NOT_FOUND');return {...parse(row.data),revision:row.revision};}
  routes(){return this.db.prepare('SELECT * FROM routes ORDER BY key').all().map(x=>({...parse(x.data),revision:x.revision}));}
  bind(input) {
    need(keyPattern.test(input.key),'INVALID_ROUTE_KEY');
    need(uuidPattern.test(input.codexThreadId||''),'INVALID_CODEX_ID');
    need(/^session-/.test(input.dshSessionId||'') && uuidPattern.test(input.dshSessionId.slice(8)),'INVALID_DSH_ID');
    need(uuidPattern.test(input.dshWorkspaceId||''),'INVALID_DSH_WORKSPACE_ID');
    need(isAbsolute(input.projectPath||''),'ABSOLUTE_PROJECT_PATH_REQUIRED');
    need(input.authorization === 'user-approved','EXPLICIT_BINDING_REQUIRED');
    const workstreams=(input.workstreams||[{key:'main',projectPath:input.projectPath}]).map(x=>({key:x.key,projectPath:x.projectPath}));
    need(workstreams.length>0 && workstreams.every(x=>keyPattern.test(x.key)&&isAbsolute(x.projectPath||'')),'INVALID_WORKSTREAM');
    const data={key:input.key,codexThreadId:input.codexThreadId,codexTitle:input.codexTitle||'',dshSessionId:input.dshSessionId,dshTitle:input.dshTitle||'',
      dshWorkspaceId:input.dshWorkspaceId,projectPath:input.projectPath,workstreams,enabled:input.enabled!==false,authorization:'user-approved'};
    return this.transaction(()=>{
      const old=this.db.prepare('SELECT * FROM routes WHERE key=?').get(input.key);
      const collision=this.routes().find(x=>x.key!==input.key&&(x.codexThreadId===data.codexThreadId||x.dshSessionId===data.dshSessionId));
      need(!collision,'SESSION_ALREADY_BOUND');
      if(old && old.data===json(data)) return this.route(input.key);
      if(old) {need(input.expectedRevision===old.revision,'BINDING_REVISION_REQUIRED');
        need(!this.db.prepare("SELECT id FROM messages WHERE route=? AND state NOT IN ('replied','completed','failed') LIMIT 1").get(input.key),'ROUTE_HAS_OPEN_MESSAGES');}
      this.db.prepare('INSERT INTO routes(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,revision=revision+1').run(input.key,json(data));
      this.event(null,'bound',{route:input.key});return this.route(input.key);
    });
  }
  forSession(sessionId) {const rows=this.routes().filter(x=>x.dshSessionId===sessionId&&x.enabled);need(rows.length===1,'CALLING_SESSION_NOT_BOUND');return rows[0];}
  checkArtifacts(refs=[]) {
    need(Array.isArray(refs)&&refs.length<=8,'INVALID_ARTIFACT_REFS');
    return refs.map(ref=>{
      need(typeof ref==='object'&&typeof ref.path==='string'&&/^[a-f0-9]{64}$/.test(ref.sha256||''),'INVALID_ARTIFACT_REF');
      const path=realpathSync(resolve(this.artifacts,ref.path)); const rel=relative(this.artifacts,path);
      need(rel && !rel.startsWith('..')&&!isAbsolute(rel),'ARTIFACT_OUTSIDE_SHARED_DIRECTORY');
      need(/\.(?:md|txt|json|patch|diff|csv)$/i.test(path),'TEXT_ARTIFACT_REQUIRED');
      need(statSync(path).size<=256000,'ARTIFACT_TOO_LARGE');
      const bytes=readFileSync(path); need(sha(bytes)===ref.sha256,'ARTIFACT_HASH_MISMATCH');
      const content=bytes.toString('utf8');need(!secretPatterns.some(p=>p.test(content)),'POSSIBLE_PRIVATE_CONTENT');
      return {path:rel.replaceAll('\\','/'),sha256:ref.sha256};
    });
  }
  send(input, source='codex') {
    need(['codex','dsh'].includes(source),'INVALID_SOURCE');
    const route=this.route(input.routeKey);need(route.enabled,'ROUTE_DISABLED');
    const workstream=input.workstream || (route.workstreams.length===1?route.workstreams[0].key:null);
    need(workstream==='bridge'||route.workstreams.some(x=>x.key===workstream),'WORKSTREAM_REQUIRED');
    need(['technical','sanitized'].includes(input.classification),'CONTENT_CLASSIFICATION_REQUIRED');
    need(['handshake','task','question','evidence','review','result','notice'].includes(input.kind),'INVALID_MESSAGE_KIND');
    const messageId=input.messageId||randomUUID();need(idPattern.test(messageId),'INVALID_MESSAGE_ID');
    const payload={messageId,routeKey:route.key,workstream,source,destination:source==='codex'?'dsh':'codex',inReplyTo:input.inReplyTo||null,
      kind:input.kind,classification:input.classification,body:checkPublicText(input.body),artifactRefs:this.checkArtifacts(input.artifactRefs)};
    return this.transaction(()=>{
      const definesTask=source==='codex'&&payload.kind==='task'&&input.taskKey!==undefined;
      let parent;
      if(payload.inReplyTo){
        parent=this.message(payload.inReplyTo);need(parent.routeKey===route.key&&parent.source!==source&&parent.workstream===workstream,'REPLY_ROUTE_MISMATCH');
        // Replies inherit the exact task revision, including obsolete evidence.
        // A fresh task instruction may explicitly advance it; a peer reply cannot.
        if(parent.taskKey&&!definesTask){
          need(input.taskKey===undefined||input.taskKey===parent.taskKey,'REPLY_TASK_MISMATCH');
          need(input.taskRevision===undefined||input.taskRevision===parent.taskRevision,'REPLY_TASK_MISMATCH');
          payload.taskKey=parent.taskKey;payload.taskRevision=parent.taskRevision;
        }
      }
      if(input.taskKey!==undefined||input.taskRevision!==undefined){
        need(keyPattern.test(input.taskKey||'')&&Number.isSafeInteger(input.taskRevision)&&input.taskRevision>0,'INVALID_TASK_REVISION');
        payload.taskKey=input.taskKey;payload.taskRevision=input.taskRevision;
      }
      if(input.supersedes!==undefined){
        need(definesTask&&Array.isArray(input.supersedes)&&input.supersedes.length<=64,'INVALID_SUPERSEDES');
        need(input.supersedes.every(id=>idPattern.test(id)&&id!==messageId)&&new Set(input.supersedes).size===input.supersedes.length,'INVALID_SUPERSEDES');
        payload.supersedes=[...input.supersedes].sort();
      }
      if(input.delivery!==undefined){
        need(input.delivery==='receipt'&&payload.kind==='notice'&&payload.inReplyTo&&payload.artifactRefs.length===0&&!definesTask,'INVALID_RECEIPT');
        payload.delivery='receipt';
      }
      const digest=sha(json(payload));
      const existing=this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
      if(existing){need(existing.hash===digest,'MESSAGE_ID_CONFLICT');return this.message(messageId);}
      if(parent){
        need(!['queued','failed','unknown'].includes(parent.state),'PARENT_NOT_RECEIVED');
      }
      if(payload.taskKey){
        const head=this.taskHead(route.key,workstream,payload.taskKey);
        if(definesTask){
          need(payload.taskRevision===(head?.revision||0)+1,'TASK_REVISION_CONFLICT');
          need(!head||(payload.supersedes||[]).includes(head.message_id),'PRIOR_TASK_MUST_BE_EXPLICITLY_SUPERSEDED');
        }else{
          need(head&&payload.taskRevision<=head.revision,'UNKNOWN_TASK_REVISION');
          need(this.db.prepare("SELECT id FROM messages WHERE route=? AND workstream=? AND json_extract(payload,'$.source')='codex' AND json_extract(payload,'$.kind')='task' AND json_extract(payload,'$.taskKey')=? AND json_extract(payload,'$.taskRevision')=?").get(route.key,workstream,payload.taskKey,payload.taskRevision),'UNKNOWN_TASK_REVISION');
        }
      }
      for(const id of payload.supersedes||[]){
        const old=this.message(id);
        need(old.routeKey===route.key&&old.workstream===workstream,'SUPERSEDES_ROUTE_MISMATCH');
        need(!old.taskKey||old.taskKey===payload.taskKey,'SUPERSEDES_TASK_MISMATCH');
        need(!this.db.prepare('SELECT old_id FROM message_supersessions WHERE old_id=?').get(id),'MESSAGE_ALREADY_SUPERSEDED');
      }
      const now=Date.now();
      this.db.prepare('INSERT INTO messages(id,route,direction,workstream,parent,payload,hash,state,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(messageId,route.key,payload.destination,workstream,payload.inReplyTo,json(payload),digest,'queued',now,now);
      this.event(messageId,'queued',{route:route.key,destination:payload.destination});
      if(definesTask){
        this.db.prepare('INSERT INTO task_heads(route,workstream,task_key,revision,message_id) VALUES(?,?,?,?,?) ON CONFLICT(route,workstream,task_key) DO UPDATE SET revision=excluded.revision,message_id=excluded.message_id')
          .run(route.key,workstream,payload.taskKey,payload.taskRevision,messageId);
        for(const id of payload.supersedes||[]){
          this.db.prepare('INSERT INTO message_supersessions(old_id,new_id,created) VALUES(?,?,?)').run(id,messageId,now);
          this.event(id,'superseded',{by:messageId,taskKey:payload.taskKey,taskRevision:payload.taskRevision,nativeCancellation:'not-attempted'});
        }
        this.event(messageId,'task-current',{taskKey:payload.taskKey,taskRevision:payload.taskRevision});
      }
      if(payload.delivery==='receipt')this.event(messageId,'receipt-recorded',{dispatch:false});
      if(payload.inReplyTo) this.updateState(payload.inReplyTo,'replied',{replyId:messageId});
      return this.message(messageId);
    });
  }
  taskHead(route,workstream,taskKey){return this.db.prepare('SELECT * FROM task_heads WHERE route=? AND workstream=? AND task_key=?').get(route,workstream,taskKey);}
  execution(payload){
    const head=payload.taskKey?this.taskHead(payload.routeKey,payload.workstream,payload.taskKey):null;
    let cursor=payload.messageId,supersededBy=null;const seen=new Set();
    while(cursor&&!seen.has(cursor)){
      seen.add(cursor);
      const replacement=this.db.prepare('SELECT new_id FROM message_supersessions WHERE old_id=?').get(cursor);
      if(replacement){supersededBy=replacement.new_id;break;}
      const row=this.db.prepare('SELECT parent,payload FROM messages WHERE id=?').get(cursor);
      const ancestor=row?parse(row.payload):null;
      // A task establishes a new execution boundary, including for its replies.
      // Inspect its own supersession above, but never inherit an older task's
      // supersession merely because the new task replies to historical evidence.
      if(ancestor?.source==='codex'&&ancestor.kind==='task'&&ancestor.taskKey)break;
      cursor=row?.parent;
    }
    if(head&&payload.taskRevision<head.revision)supersededBy=head.message_id;
    const receipt=payload.delivery==='receipt';
    return {actionable:!supersededBy&&!receipt,status:supersededBy?'superseded':receipt?'receipt':head?'current':'unversioned',
      supersededBy,currentMessageId:head?.message_id||null,currentRevision:head?.revision||null,
      nativeCancellation:this.db.prepare("SELECT seq FROM events WHERE id=? AND state='superseded-native-removed' LIMIT 1").get(payload.messageId)?'removed-pending':'not-attempted',instruction:supersededBy?'Do not execute obsolete work. Read current tasks; old transport state is retained.':receipt?'Record only; do not wake or send another receipt.':'Check current task revision and exact artifact hashes before acting.'};
  }
  message(id){const row=this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);need(row,'MESSAGE_NOT_FOUND');const payload=parse(row.payload);return {...payload,state:row.state,createdAt:row.created,updatedAt:row.updated,receipt:row.receipt?parse(row.receipt):null,execution:this.execution(payload)};}
  current({routeKey,workstream}={}){
    const route=this.route(routeKey);need(workstream===undefined||workstream==='bridge'||route.workstreams.some(x=>x.key===workstream),'INVALID_WORKSTREAM');
    const heads=this.db.prepare('SELECT * FROM task_heads WHERE route=? ORDER BY workstream,task_key').all(routeKey).filter(x=>!workstream||x.workstream===workstream);
    return {routeKey,bindingRevision:route.revision,tasks:heads.map(x=>{const m=this.message(x.message_id);return {taskKey:x.task_key,workstream:x.workstream,taskRevision:x.revision,messageId:x.message_id,state:m.state,artifactRefs:m.artifactRefs,supersedes:m.supersedes||[],execution:m.execution};}),
      nativeQueueBoundary:'Accepted/unknown native followups are not canceled by supersession. Read a message by ID and check execution before acting.'};
  }
  blocksDelivery(route,id){return this.db.prepare("SELECT id FROM messages WHERE route=? AND id<>? AND direction='codex' AND state IN ('dispatching','accepted','unknown')").all(route,id).some(x=>this.message(x.id).execution.actionable);}
  updateState(id,state,detail={}) {
    need(states.includes(state),'INVALID_STATE');
    this.db.prepare('UPDATE messages SET state=?,updated=?,lease_until=NULL,receipt=? WHERE id=?').run(state,Date.now(),json(detail),id);
    this.event(id,state,detail);
  }
  ack({messageId,routeKey,state='started',evidence},side='codex') {
    need(['accepted','started','completed'].includes(state),'INVALID_ACK_STATE');
    if(state==='completed')checkPublicText(evidence);
    return this.transaction(()=>{
      const m=this.message(messageId);need(m.routeKey===routeKey&&m.destination===side,'ACK_ROUTE_MISMATCH');
      if(m.execution.status==='superseded')return {...m,acknowledged:false,code:'MESSAGE_SUPERSEDED',currentTasks:this.current({routeKey,workstream:m.workstream})};
      if(['replied','completed'].includes(m.state)||m.state===state||(m.state==='started'&&state==='accepted'))return m;
      need(['queued','dispatching','accepted','started','unknown'].includes(m.state),'MESSAGE_NOT_ACKNOWLEDGEABLE');
      if(state==='completed')need(m.state==='started','ACK_STARTED_BEFORE_COMPLETION');
      this.updateState(messageId,state,{actor:side,...evidence?{evidence}:{}});return this.message(messageId);
    });
  }
  receive({routeKey,messageId,limit=10},side='codex') {
    this.route(routeKey);
    if(messageId){const m=this.message(messageId);need(m.routeKey===routeKey&&m.destination===side,'RECEIVE_ROUTE_MISMATCH');return [{...m,currentTasks:this.current({routeKey,workstream:m.workstream})}];}
    need(Number.isInteger(limit)&&limit>=1&&limit<=30,'INVALID_LIMIT');
    return this.db.prepare("SELECT id FROM messages WHERE route=? AND direction=? AND state NOT IN ('replied','completed','failed') ORDER BY CASE WHEN json_extract(payload,'$.taskRevision') IS NOT NULL THEN 0 ELSE 1 END,created")
      .all(routeKey,side).map(x=>this.message(x.id)).filter(m=>m.execution.actionable).slice(0,limit);
  }
  pending(side='codex') {
    this.expireClaims();
    return this.db.prepare("SELECT id,route,workstream,state,created FROM messages WHERE direction=? AND state='queued' ORDER BY CASE WHEN json_extract(payload,'$.taskRevision') IS NOT NULL THEN 0 ELSE 1 END,created")
      .all(side).map(x=>({...x,routeInfo:this.route(x.route)})).filter(x=>x.routeInfo.enabled&&this.message(x.id).execution.actionable);
  }
  expireClaims(){return this.transaction(()=>{
    for(const row of this.db.prepare("SELECT id FROM messages WHERE state='dispatching' AND lease_until<?").all(Date.now()))
      this.updateState(row.id,'unknown',{code:'DISPATCH_LEASE_EXPIRED'});
  });}
  claim(id,side='codex',leaseMs=60000) {
    return this.transaction(()=>{
      const m=this.message(id);need(m.destination===side,'CLAIM_SIDE_MISMATCH');
      if(!m.execution.actionable)return {claimed:false,state:m.state,execution:m.execution};
      if(m.state!=='queued')return {claimed:false,state:m.state};
      need(this.route(m.routeKey).enabled,'ROUTE_DISABLED');
      this.db.prepare("UPDATE messages SET state='dispatching',updated=?,lease_until=? WHERE id=?").run(Date.now(),Date.now()+leaseMs,id);
      this.event(id,'dispatching',{side});return {claimed:true,message:this.message(id)};
    });
  }
  dispatchResult(id,outcome,receipt={}) {
    need(['accepted','failed','unknown'].includes(outcome),'INVALID_DISPATCH_RESULT');
    return this.transaction(()=>{
      const m=this.message(id);if(['replied','completed','started','accepted'].includes(m.state))return m;
      need(m.state==='dispatching','DISPATCH_NOT_CLAIMED');this.updateState(id,outcome,receipt);return this.message(id);
    });
  }
  reconcile({messageId,outcome,evidence}) {
    need(['accepted','queued','failed'].includes(outcome),'INVALID_RECONCILE_RESULT');checkPublicText(evidence);
    return this.transaction(()=>{const m=this.message(messageId);need(['unknown','failed'].includes(m.state),'RECONCILIATION_NOT_NEEDED');
      need(outcome!=='queued'||m.execution.actionable,'MESSAGE_SUPERSEDED_OR_RECEIPT');
      this.updateState(messageId,outcome,{evidence});return this.message(messageId);});
  }
  heartbeat(name,data) {this.db.prepare('INSERT INTO health(name,time,data) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET time=excluded.time,data=excluded.data').run(name,Date.now(),json(data));}
  health(name){const row=this.db.prepare('SELECT * FROM health WHERE name=?').get(name);return row?{name,time:row.time,ageMs:Date.now()-row.time,...parse(row.data)}:null;}
  status(routeKey) {
    this.expireClaims();
    const routes=routeKey?[this.route(routeKey)]:this.routes();
    return {version:VERSION,root:this.root,host:this.health('dsh-host'),coordinator:this.health('coordinator'),routes:routes.map(r=>({...r,
      live:this.health('route:'+r.key),counts:this.db.prepare('SELECT state,COUNT(*) AS count FROM messages WHERE route=? GROUP BY state').all(r.key),
      currentTasks:this.current({routeKey:r.key}),
      recent:this.db.prepare('SELECT id,direction,workstream,state,created,updated FROM messages WHERE route=? ORDER BY created DESC LIMIT 8').all(r.key)}))};
  }
}
