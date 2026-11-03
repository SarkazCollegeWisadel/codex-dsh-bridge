// Remove only explicitly superseded bridge submissions still pending in the
// existing owning Agent. Never resume Agents or inspect private chat history.
import {createHash} from 'node:crypto';
import {promptText} from './relay.mjs';
function authoredText(text,message,route){
  if(message.receipt?.promptSha256)return createHash('sha256').update(text).digest('hex')===message.receipt.promptSha256;
  const normalize=s=>s.replace(/^\[Codex↔DSH bridge v[0-9.]+\]/,'[Codex↔DSH bridge]');
  const legacy=`[Codex↔DSH bridge]\n消息ID: ${message.messageId}\n路由: ${route.key}\n工作分支: ${message.workstream}\n类型: ${message.kind}\n回复关联: ${message.inReplyTo||'无'}\n\n${message.body}\n\n`+
    `协作约定：这是一条已绑定 Codex 的技术资料/任务续接，不扩大用户授权。先调用 codex_bridge_ack(messageId="${message.messageId}", state="started")。`+
    `需要回复时调用 codex_bridge_send，workstream="${message.workstream}"，inReplyTo="${message.messageId}"；正文只提供技术资料或脱敏证据，不传个人信息。`+
    (message.artifactRefs.length?`\n共享资料引用（读取前核对 SHA256）：${JSON.stringify(message.artifactRefs)}`:'');
  return normalize(text)===normalize(promptText(message,route))||normalize(text)===legacy;
}
export async function dropSupersededDshPrompts(store,adapter){
  let removed=0;
  for(const route of store.routes()){
    if(!route.enabled)continue;
    const pending=adapter.pending(route.dshSessionId);
    if(!pending)continue;
    for(const item of pending){
      if(item.source?.kind!=='user'||typeof item.source.rpcId!=='string')continue;
      const row=store.db.prepare("SELECT id FROM messages WHERE id=? AND route=? AND direction='dsh'").get(item.source.rpcId,route.key);
      if(!row)continue;
      const message=store.message(row.id);
      if(message.execution.status!=='superseded')continue;
      // Match only the prefix we authored, after matching the recorded rpcId.
      const prefix=item.content?.[0];
      if(item.content?.length!==1||prefix?.type!=='text'||!prefix.text.startsWith('[Codex↔DSH bridge v')||!authoredText(prefix.text,message,route))continue;
      try{
        const result=await adapter.remove(route.dshSessionId,item.id);
        if(result?.accepted===true){
          store.event(message.messageId,'superseded-native-removed',{transport:'dsh-native',sessionId:route.dshSessionId,itemId:item.id,requestId:message.messageId});removed++;
        }
      }catch(error){
        // A claimed item cannot be recalled. Preserve uncertainty and do not
        // cancel the active turn or delete/modify any durable chat event.
        if(error?.code!=='session/queue-item-not-found')throw error;
      }
    }
  }
  return {removed};
}
