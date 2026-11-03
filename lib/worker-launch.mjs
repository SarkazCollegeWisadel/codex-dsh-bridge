import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerStatus } from './event-runtime.mjs';
export const workerScript = fileURLToPath(new URL('../bin/event-worker.mjs', import.meta.url));
export function ensureEventWorker(root){
  if(process.platform!=='win32')return;
  try{
    const config=join(root,'state/event-worker.config.json');
    if(!existsSync(config)||JSON.parse(readFileSync(config,'utf8')).enabled!==true||workerStatus(root).running)return;
    const child=spawn(process.execPath,[workerScript,'start'],{windowsHide:true,detached:true,stdio:'ignore',env:{...process.env,DSH_CODEX_BRIDGE_ROOT:root}});
    child.on('error',()=>{});child.unref();
  }catch{/* Connection/status commands remain usable even when startup needs repair. */}
}
