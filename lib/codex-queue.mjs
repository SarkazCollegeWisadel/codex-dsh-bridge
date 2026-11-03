import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from './store.mjs';

export function codexExe(){
  const supplied=process.env.CODEX_APP_RUNTIME_CLI_PATH;
  if(supplied){if(existsSync(supplied))return supplied;throw new Error('CODEX_CLI_SELECTION_REQUIRED');}
  if(process.platform!=='win32'||!process.env.LOCALAPPDATA)throw new Error('CODEX_CLI_SELECTION_REQUIRED');
  const base=join(process.env.LOCALAPPDATA,'OpenAI/Codex/bin');
  if(!existsSync(base))throw new Error('CODEX_CLI_SELECTION_REQUIRED');
  const paths=readdirSync(base).map(x=>join(base,x,'codex.exe')).filter(existsSync);
  if(paths.length!==1)throw new Error('CODEX_CLI_SELECTION_REQUIRED');
  return paths[0];
}
// This client only reads metadata / manages the durable inbox. Never resume a
// conversation or start a turn on this process: the desktop remains its owner.
export class CodexQueue {
  constructor({exe=codexExe()}={}){
    this.pending=new Map();this.id=1;
    this.child=spawn(exe,['app-server','--stdio'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.stderr.resume();this.lines=createInterface({input:this.child.stdout});
    this.lines.on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}
      if(m.method&&m.id!==undefined){this.child.stdin.write(JSON.stringify({id:m.id,error:{code:-32601,message:'Bridge inbox client cannot execute agent requests'}})+'\n');return;}
      const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);
      if(m.error)p.reject(new Error('QUEUE_RPC_ERROR: '+m.error.message));else p.resolve(m.result);
    });
    this.child.on('error',()=>this.fail('QUEUE_PROCESS_ERROR'));this.child.on('exit',()=>this.fail('QUEUE_PROCESS_EXITED'));
  }
  fail(code){this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(code));}this.pending.clear();}
  call(method,params){
    if(!['initialize','thread/queue/add','thread/queue/list','thread/queue/delete','thread/read','thread/list'].includes(method))throw new Error('QUEUE_RPC_NOT_ALLOWED');
    if(method==='thread/read'&&params.includeTurns!==false)throw new Error('THREAD_HISTORY_NOT_ALLOWED');
    if(this.closed)return Promise.reject(new Error('QUEUE_CLOSED'));
    return new Promise((resolve,reject)=>{const id=this.id++;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('QUEUE_RPC_TIMEOUT'));},15000);
      this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  }
  async initialize(){const r=await this.call('initialize',{clientInfo:{name:'dsh_codex_event_bridge',version:VERSION},capabilities:{experimentalApi:true}});
    this.child.stdin.write(JSON.stringify({method:'initialized'})+'\n');return r;}
  close(){this.fail('QUEUE_CLOSED');this.lines.close();this.child.stdin.end();this.child.kill();}
}
export async function wakeDesktop(threadId){
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId))throw new Error('INVALID_THREAD_ID');
  const uri='codex://threads/wake/'+threadId;
  // OS-registered desktop wake-only link: no prompt/body and no foreground navigation.
  await new Promise((resolve,reject)=>{
    const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Start-Process -FilePath '${uri}' -WindowStyle Hidden`],{windowsHide:true,stdio:'ignore'});
    p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error('DESKTOP_WAKE_FAILED')));
  });
  return {uri,requestedAt:Date.now()};
}
