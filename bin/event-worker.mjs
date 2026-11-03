#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, DEFAULT_ROOT, need } from '../lib/store.mjs';
import { runEventWorker, workerStatus } from '../lib/event-runtime.mjs';
const root=process.env.DSH_CODEX_BRIDGE_ROOT||DEFAULT_ROOT;
const command=process.argv[2]||'status';
try{
  const configPath=join(root,'state/event-worker.config.json');
  if(command==='run'){await runEventWorker(root);}
  else if(command==='status'){console.log(JSON.stringify(workerStatus(root),null,2));}
  else if(command==='stop'){
    mkdirSync(join(root,'state'),{recursive:true});
    if(existsSync(configPath)){const c=JSON.parse(readFileSync(configPath,'utf8'));c.enabled=false;writeFileSync(configPath,JSON.stringify(c,null,2)+'\n');}
    writeFileSync(join(root,'state/event-worker.stop'),String(Date.now()));console.log('{"stopRequested":true}');}
  else if(command==='configure'){
    need(process.argv[3]==='--json-file','JSON_FILE_REQUIRED');
    const input=JSON.parse(readFileSync(process.argv[4],'utf8').replace(/^\uFEFF/,''));
    need(input.authorization==='user-approved','USER_AUTHORIZATION_REQUIRED');
    const store=new Store(root);const old=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{enabled:false,routes:{}};
    try{for(const item of input.routes){const r=store.route(item.routeKey);need(typeof item.businessPaused==='boolean','PAUSE_STATE_REQUIRED');
      old.routes[r.key]={codexThreadId:r.codexThreadId,dshSessionId:r.dshSessionId,revision:r.revision,businessPaused:item.businessPaused};}
      writeFileSync(configPath,JSON.stringify(old,null,2)+'\n');console.log('{"configured":true}');
    }finally{store.close();}
  }
  else if(command==='start'){
    need(process.platform==='win32','DESKTOP_ADAPTER_WINDOWS_ONLY');
    need(existsSync(configPath),'EVENT_WORKER_CONFIG_REQUIRED');
    const config=JSON.parse(readFileSync(configPath,'utf8'));config.enabled=true;writeFileSync(configPath,JSON.stringify(config,null,2)+'\n');
    const status=workerStatus(root);
    if(status.running)console.log(JSON.stringify({alreadyRunning:true,pid:status.pid}));
    else{need(existsSync(configPath),'EVENT_WORKER_CONFIG_REQUIRED');
      const log=openSync(join(root,'state/event-worker.log'),'a');
      const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'run'],{detached:true,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,DSH_CODEX_BRIDGE_ROOT:root}});
      child.on('error',()=>{process.exitCode=1;});child.unref();closeSync(log);console.log(JSON.stringify({startRequested:true,pid:child.pid}));
    }
  }else throw new Error('UNKNOWN_WORKER_COMMAND');
}catch(e){console.error(JSON.stringify({ok:false,error:e.code||e.message}));process.exitCode=1;}
