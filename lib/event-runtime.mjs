import { readFileSync, writeFileSync, existsSync, readdirSync, watch, unlinkSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Store, VERSION } from './store.mjs';
import { watchQueueEvents } from './events.mjs';
import { Dispatcher, DELIVERY_POLICY_REVISION } from './dispatcher.mjs';
import { CodexQueue, wakeDesktop } from './codex-queue.mjs';
import { dropAcknowledgedPrompts } from './queue-cleanup.mjs';

export const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
export const desktopRunning=()=>{try{return readdirSync('\\\\.\\pipe\\').some(n=>n.startsWith('codex-app-tools-'));}catch{return false;}};
export function workerStatus(root){
  const path=join(root,'state/event-worker-status.json');
  const s=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{mode:'event-driven',state:'not-started'};
  return {...s,running:s.state==='watching'&&Number.isInteger(s.pid)&&alive(s.pid),desktopRunning:desktopRunning()};
}
export async function runEventWorker(root){
  if(process.platform!=='win32')throw new Error('DESKTOP_ADAPTER_WINDOWS_ONLY');
  const store=new Store(root),state=join(root,'state');
  const configPath=join(state,'event-worker.config.json'),lockPath=join(state,'event-worker.lock');
  if(existsSync(lockPath)){
    const old=JSON.parse(readFileSync(lockPath,'utf8'));
    if(alive(old.pid)){store.close();return;}
    unlinkSync(lockPath);
  }
  const lock=openSync(lockPath,'wx');writeFileSync(lock,JSON.stringify({pid:process.pid,startedAt:Date.now()}));closeSync(lock);
  const readConfig=()=>JSON.parse(readFileSync(configPath,'utf8'));
  const status={schemaVersion:1,mode:'event-driven',version:VERSION,deliveryPolicyRevision:DELIVERY_POLICY_REVISION,state:'watching',pid:process.pid,startedAt:Date.now(),dispatches:0,lastEventSeq:0,scheduledModelWakeups:0};
  status.dispatches=Number(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE state='accepted' AND json_extract(detail,'$.transport')='codex-native-inbox'").get().n);
  status.lastEventSeq=Number(store.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get().seq);
  const record=()=>{
    writeFileSync(join(state,'event-worker-status.json'),JSON.stringify(status,null,2)+'\n');
    store.heartbeat('coordinator',{...status,scheduledAutomation:'deleted',requiresActiveCoordinatorTurn:false});
  };
  record();
  let queue,queueInit,closing=false,pumpPromise=Promise.resolve(),scheduled=false,dirty=false;
  const blocked=new Map(),woken=new Set(),cleaned=new Set();
  async function client(){
    if(queue&&!queue.closed)return queue;
    if(!queueInit)queueInit=(async()=>{queue=new CodexQueue();await queue.initialize();return queue;})().finally(()=>{queueInit=null;});
    return queueInit;
  }
  const dispatcher=new Dispatcher(store,{
    async eligible(route){
      if(!desktopRunning())return {ok:false,code:'CODEX_OFFLINE'};
      const prior=blocked.get(route.key);if(prior&&Date.now()-prior.time<10000)return {ok:false,code:prior.code};
      const q=await client();
      const {thread}=await q.call('thread/read',{threadId:route.codexThreadId,includeTurns:false});
      if(thread.id!==route.codexThreadId||thread.canAcceptDirectInput===false)return {ok:false,code:'THREAD_NOT_WRITABLE'};
      // The name narrows metadata enumeration only. It never selects a target;
      // identity always comes from the explicit route ID.
      let cursor=null,found=false;
      for(let n=0;n<20;n++){
        const page=await q.call('thread/list',{archived:false,useStateDbOnly:true,searchTerm:thread.name||route.codexTitle,limit:100,...cursor?{cursor}:{}});
        found=page.data.some(t=>t.id===route.codexThreadId);if(found||!page.nextCursor)break;cursor=page.nextCursor;
      }
      if(!found){blocked.set(route.key,{time:Date.now(),code:'THREAD_ARCHIVED_OR_NOT_VISIBLE'});return {ok:false,code:'THREAD_ARCHIVED_OR_NOT_VISIBLE'};}
      blocked.delete(route.key);return {ok:true};
    },
    async enqueue({threadId,clientUserMessageId,prompt}){
      const q=await client();
      const list=await q.call('thread/queue/list',{threadId,limit:100});
      const same=list.data.find(x=>x.clientUserMessageId===clientUserMessageId);
      const item=same??(await q.call('thread/queue/add',{threadId,clientUserMessageId,input:[{type:'text',text:prompt}]})).queuedSubmission;
      return {queuedSubmissionId:item.id};
    },
    async wake(threadId){return wakeDesktop(threadId);}
  },{policy:readConfig,onRecord:item=>{
    const key=JSON.stringify(item);if(status.lastRecordKey===key)return;
    status.lastRecordKey=key;status.lastRecord=item;status.lastEventAt=Date.now();
    if(item.code==='NATIVE_QUEUE_ACCEPTED'){status.dispatches++;woken.add(item.queuedSubmissionId);}
    record();
  }});
  async function recoverQueuedWakes(){
    if(!desktopRunning())return;
    const rows=store.db.prepare("SELECT id FROM messages WHERE direction='codex' AND state='accepted'").all();
    for(const {id} of rows){
      const m=store.message(id),r=m.receipt,route=store.route(m.routeKey),p=readConfig().routes?.[m.routeKey];
      if(!m.execution.actionable)continue;
      if(r?.transport!=='codex-native-inbox'||!r.queuedSubmissionId||woken.has(r.queuedSubmissionId)||!route.enabled||p?.codexThreadId!==route.codexThreadId||p?.dshSessionId!==route.dshSessionId||p?.revision!==route.revision||!readConfig().enabled)continue;
      if(p.businessPaused!==false&&m.workstream!=='bridge')continue;
      if(!(await dispatcher.adapter.eligible(route)).ok)continue;
      const q=await client();
      const {data}=await q.call('thread/queue/list',{threadId:route.codexThreadId,limit:100});
      if(!data.some(x=>x.id===r.queuedSubmissionId&&x.clientUserMessageId===r.clientUserMessageId))continue;
      await wakeDesktop(route.codexThreadId);woken.add(r.queuedSubmissionId);
      store.event(id,'desktop-wake-requested',{recovery:true,queuedSubmissionId:r.queuedSubmissionId});
    }
  }
  function schedule(){
    if(closing)return;
    dirty=true;if(scheduled)return;scheduled=true;
    pumpPromise=new Promise(resolve=>setTimeout(async()=>{
      dirty=false;
      if(closing){scheduled=false;resolve();return;}
      try{
        if(desktopRunning())await dropAcknowledgedPrompts(store,{
          list:async threadId=>(await (await client()).call('thread/queue/list',{threadId,limit:100})).data,
          remove:async(threadId,queuedSubmissionId)=>(await client()).call('thread/queue/delete',{threadId,queuedSubmissionId})
        },cleaned);
        await dispatcher.pump();await recoverQueuedWakes();
      }
      catch{status.lastError='EVENT_DISPATCH_FAILED';record();}
      finally{queue?.close();queue=null;scheduled=false;resolve();if(dirty)schedule();}
    },30));
  }
  const events=watchQueueEvents(store,(rows,error)=>{
    if(error){status.lastError=error.code;record();return;}
    status.lastEventSeq=Number(rows.at(-1)?.seq||status.lastEventSeq);
    status.lastEventAt=Date.now();record();
    // State-transition notifications also allow the next queued item after ack.
    schedule();
  });
  const controls=watch(state,(_event,file)=>{
    if(String(file)==='event-worker.config.json'){blocked.clear();schedule();}
    if(String(file)==='event-worker.stop'&&existsSync(join(state,'event-worker.stop')))void stop();
  });
  // Desktop startup/database changes retry held work. No timer or model turn.
  // Read only filesystem notifications, never private histories or auth files.
  let appWatch;const codexHome=process.env.CODEX_HOME||join(homedir(),'.codex');
  try{appWatch=watch(codexHome,(_event,file)=>{
    if(/^state_\d+\.sqlite(?:-wal)?$/.test(String(file))&&store.db.prepare("SELECT 1 FROM messages WHERE direction='codex' AND state IN ('queued','accepted') LIMIT 1").get())schedule();
  });}catch{status.lastError='APP_RECONNECT_WATCH_UNAVAILABLE';record();}
  async function stop(){
    if(closing)return;closing=true;events.close();controls.close();appWatch?.close();
    await pumpPromise;queue?.close();status.state='stopped';status.stoppedAt=Date.now();record();store.close();
    try{unlinkSync(lockPath);}catch{}
  }
  process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
  if(existsSync(join(state,'event-worker.stop')))unlinkSync(join(state,'event-worker.stop'));
  schedule();
}
