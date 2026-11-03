#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Store, VERSION, need } from '../lib/store.mjs';
import { invoke } from '../lib/api.mjs';
let store;
try{
  const [command='status',...rest]=process.argv.slice(2);
  if(command==='help'){console.log('bridge status|current|bind|send|receive|ack [--json-file path]\nJSON via stdin or --json-file. Coordinator: pending|claim|dispatch-result|reconcile|heartbeat. Task revisions require taskKey/taskRevision and explicit supersedes IDs. delivery=receipt stores a terminal notice without wakeup. Each result is JSON.');process.exit(0);}
  let args={};
  if(rest.length){need(rest.length===2&&rest[0]==='--json-file','INVALID_CLI_ARGUMENTS');args=JSON.parse(readFileSync(rest[1],'utf8').replace(/^\uFEFF/,''));}
  else if(!process.stdin.isTTY){const text=readFileSync(0,'utf8').replace(/^\uFEFF/,'').trim();if(text)args=JSON.parse(text);}
  store=new Store();let result;
  switch(command){
    case 'pending':result=store.pending('codex');break;
    case 'claim':result=store.claim(args.messageId,'codex');break;
    case 'dispatch-result':result=store.dispatchResult(args.messageId,args.outcome,args.receipt||{});break;
    case 'reconcile':result=store.reconcile(args);break;
    case 'heartbeat':store.heartbeat('coordinator',{version:VERSION,...args});result={ok:true};break;
    default:result=invoke(store,'bridge_'+command,args);
  }
  console.log(JSON.stringify({ok:true,result},null,2));
}catch(e){console.error(JSON.stringify({ok:false,error:e.code||'BRIDGE_COMMAND_FAILED'}));process.exitCode=1;}
finally{store?.close();}
