// A busy Agent may consume a newly arrived bridge message itself before its
// queued wake prompt starts. Remove only that exact now-redundant inbox entry.
export async function dropAcknowledgedPrompts(store,adapter,seen=new Set()){
  const rows=store.db.prepare(`SELECT e.id,e.detail FROM events e JOIN messages m ON m.id=e.id
    WHERE e.state='accepted' AND m.direction='codex'
    AND json_extract(e.detail,'$.transport')='codex-native-inbox'`).all();
  let removed=0;const pages=new Map();
  for(const row of rows){
    const receipt=JSON.parse(row.detail),id=receipt.queuedSubmissionId;
    if(!id||seen.has(id))continue;
    const m=store.message(row.id),route=store.route(m.routeKey);
    const obsolete=m.execution?.status==='superseded';
    if(!obsolete&&!['started','replied','completed'].includes(m.state))continue;
    if(route.codexThreadId!==receipt.threadId)continue;
    if(!pages.has(receipt.threadId))pages.set(receipt.threadId,await adapter.list(receipt.threadId));
    const item=pages.get(receipt.threadId).find(x=>x.id===id&&x.clientUserMessageId===receipt.clientUserMessageId);
    if(item){
      await adapter.remove(receipt.threadId,id);
      store.event(row.id,obsolete?'superseded-native-removed':'redundant-wake-removed',{transport:'codex-native-inbox',queuedSubmissionId:id,reason:obsolete?'EXPLICITLY_SUPERSEDED':'RECIPIENT_ALREADY_ACKNOWLEDGED'});removed++;
    }
    seen.add(id);
  }
  return removed;
}
