import { need, VERSION } from './store.mjs';
import {createHash} from 'node:crypto';
export function promptText(message,route) {
  return `[Codex↔DSH bridge v${VERSION}]\n消息ID: ${message.messageId}\n路由: ${route.key}\n工作分支: ${message.workstream}\n类型: ${message.kind}\n回复关联: ${message.inReplyTo||'无'}\n\n${message.body}\n\n`+
    `任务版本：${message.taskKey||'旧式未版本化'}/${message.taskRevision||'无'}。原生队列中的正文可能已经过时，投递不代表仍可执行。`+
    `协作约定：先调用 codex_bridge_current，再 codex_bridge_receive(messageId="${message.messageId}")，检查 execution.actionable 和当前 taskRevision/资料 SHA。若已 superseded，仅保留历史，不执行、不再发送确认回执。`+
    `确认仍有效后调用 codex_bridge_ack(messageId="${message.messageId}", state="started")，再检查回执是否 MESSAGE_SUPERSEDED。任何原生排队/版本变化均不扩大用户授权。`+
    `需要回复时调用 codex_bridge_send，workstream="${message.workstream}"，inReplyTo="${message.messageId}"；正文只提供技术资料或脱敏证据，不传个人信息。纯终止回执用 kind="notice", delivery="receipt"，无需双方互相确认。`+
    (message.artifactRefs.length?`\n共享资料引用（读取前核对 SHA256）：${JSON.stringify(message.artifactRefs)}`:'');
}
export class Relay {
  constructor(store,adapter,{timeoutMs=20000,allow=()=>true}={}){this.store=store;this.adapter=adapter;this.timeoutMs=timeoutMs;this.allow=allow;this.busy=false;this.lastIndexAt=0;}
  async tick(){
    if(this.busy)return;this.busy=true;
    try {
      if(this.adapter.cleanup)await this.adapter.cleanup();
      const pending=this.store.pending('dsh');
      if(!pending.length && Date.now()-this.lastIndexAt<10000)return;
      const summaries=await this.adapter.list();this.lastIndexAt=Date.now();
      this.store.heartbeat('dsh-host',{ready:true,pid:process.pid,version:VERSION});
      for(const route of this.store.routes()) {
        const live=summaries.find(x=>x.sessionId===route.dshSessionId);
        const healthy=!!live&&!live.archived&&live.workspaceId===route.dshWorkspaceId;
        this.store.heartbeat('route:'+route.key,{ready:healthy,known:!!live,archived:live?.archived??null,running:live?.running??null,
          identityMatched:healthy,code:healthy?'READY':!live?'SESSION_NOT_VISIBLE':live.archived?'SESSION_ARCHIVED':'WORKSPACE_MISMATCH'});
      }
      // One prompt per route per tick. Only a verified native followup adapter
      // may queue behind a running turn; generic adapters still wait for idle.
      const visited=new Set();
      for(const row of pending){
        if(!this.allow(row))continue;
        if(visited.has(row.route))continue;visited.add(row.route);
        const health=this.store.health('route:'+row.route);
        if(!health?.ready||(health.running&&this.adapter.supportsBusyQueue!==true))continue;
        const claim=this.store.claim(row.id,'dsh',this.timeoutMs+5000);if(!claim.claimed)continue;
        let timer;const abort=new AbortController();
        const text=promptText(claim.message,row.routeInfo),promptSha256=createHash('sha256').update(text).digest('hex');
        try {
          const result=await Promise.race([
            this.adapter.prompt({requestId:row.id,sessionId:row.routeInfo.dshSessionId,mode:'queue',content:[{type:'text',text}],clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone},abort.signal),
            new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new Error('DELIVERY_TIMEOUT'));},this.timeoutMs);})]);
          need(result?.accepted===true,'HOST_DID_NOT_ACCEPT');
          this.store.dispatchResult(row.id,'accepted',{transport:'dsh-native',requestId:row.id,promptSha256,mode:'queue',queuedWhileRunning:health.running===true});
        }catch(e){this.store.dispatchResult(row.id,'unknown',{code:e.code||'DELIVERY_OUTCOME_UNKNOWN',promptSha256});}
        finally{clearTimeout(timer);}
      }
    }catch(e){this.store.heartbeat('dsh-host',{ready:false,pid:process.pid,version:VERSION,code:e.code||'HOST_UNAVAILABLE'});}
    finally{this.busy=false;}
  }
}
