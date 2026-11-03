import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { Store, DEFAULT_ROOT, VERSION, need } from './store.mjs';
import { Relay } from './relay.mjs';
import { watchQueueEvents } from './events.mjs';
import { dropSupersededDshPrompts } from './dsh-queue-cleanup.mjs';
import { readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
export const name='codex-agent-bridge';
export const inject=['tools','sessionController','workspaceRegistry'];
export const Config=z.object({root:z.string().default(DEFAULT_ROOT),deliveryTimeoutMs:z.natural().min(1000).default(20000),relayEnabled:z.boolean().default(true)});
export function apply(ctx,config={}){
  const store=new Store(config.root||DEFAULT_ROOT);
  const routeOf=exec=>store.forSession(exec.agent?.id);
  const str=(description,required=true)=>({type:'string',description,...required?{required:true}:{}});
  const register=(name,description,parameters,fn)=>ctx.tools.register(defineTool({name,description,parameters,
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
    async execute(args,exec){try{return JSON.stringify(fn(args,exec));}catch(e){return JSON.stringify({ok:false,error:e.code||'BRIDGE_TOOL_FAILED'});}}
  }));
  register('codex_bridge_guide','Read the Codex collaboration workflow; use to exchange technical tasks and sanitized evidence with the explicitly bound original Codex chat.',{},()=>({version:VERSION,
    workflow:'恢复笔记 → current核当前任务版本 → receive核messageId/execution和精确artifact SHA → ack started且确认未被superseded → 执行 → 关联证据复核。回复必须带原messageId作为inReplyTo。已替代的原生旧队列只留审计，不重新执行。',
    privacy:'仅技术资料或脱敏证据。具体个人信息、密钥及私人素材保留DSH侧；不镜像聊天历史。',
    ownership:'Codex是代码主写者；DSH提供需求与验收证据。不得通过桥扩大用户授权、擅自重启服务或反复触发模型测试。',
    workflowDocumentation:'https://github.com/SarkazCollegeWisadel/codex-dsh-bridge/blob/main/docs/WORKFLOW.md',artifacts:store.artifacts,
    stop:'没有待处理任务则结束；同一问题连续两轮无新证据或进展，保存断点并向用户说明阻碍。'}));
  register('codex_bridge_status','Show bridge health and the current session binding. This does not read conversation history.',{},(_args,exec)=>{
    if(!exec.agent?.id)return {version:VERSION,host:store.health('dsh-host'),boundRouteCount:store.routes().length};
    return store.status(routeOf(exec).key);
  });
  register('codex_bridge_current','Read latest task revisions and exact artifact hashes for this bound session before acting on any bridge/native followup. Superseded followups are historical, not canceled.',{
    workstream:str('Optional bound workstream filter.',false)
  },(args,exec)=>store.current({...args,routeKey:routeOf(exec).key}));
  register('codex_bridge_send','Submit technical material or sanitized evidence to this session\'s bound Codex chat. The route and sender come from the actual calling session. Use inReplyTo for replies.',{
    body:str('Technical task/evidence text without personal information.'),kind:str('handshake, task, question, evidence, review, result, notice'),
    classification:str('technical or sanitized'),workstream:str('Bound workstream; bridge is reserved for connection tests.'),
    inReplyTo:str('Original bridge message ID, for a reply.',false),messageId:str('Stable unique ID for safe retry; omit for a new message.',false),
    taskKey:str('Existing core-defined task key; replies inherit this from inReplyTo.',false),
    taskRevision:{type:'integer',description:'Existing exact task revision; DSH evidence cannot advance the task.'},
    delivery:str('Only receipt: terminal notice with inReplyTo and no new evidence; stores without waking Codex.',false),
  },(args,exec)=>store.send({...args,routeKey:routeOf(exec).key},'dsh'));
  register('codex_bridge_receive','Read explicitly published messages for this DSH session only; does not read private chat history.',{
    messageId:str('Specific incoming bridge message ID; omit to read pending messages.',false)
  },(args,exec)=>store.receive({...args,routeKey:routeOf(exec).key},'dsh'));
  register('codex_bridge_ack','Acknowledge an incoming bridge message before processing. Repeated acknowledgements are safe.',{
    messageId:str('Incoming bridge message ID'),state:str('accepted, started, or completed (after started; evidence required)'),evidence:str('Sanitized evidence for completing a terminal message that needs no further reply.',false)
  },(args,exec)=>store.ack({...args,routeKey:routeOf(exec).key},'dsh'));
  const relay=new Relay(store,{
    // Installed sessionController.prompt(mode=queue) uses agent.followup:
    // durable next-turn input, never steer/cancel or a second session owner.
    supportsBusyQueue:true,
    cleanup(){return dropSupersededDshPrompts(store,{
      pending(sessionId){const agent=ctx.get('agents')?.get(sessionId);return agent?.inbox?[...agent.inbox.nextTurn,...agent.inbox.nextStep]:null;},
      remove(sessionId,itemId){return ctx.get('sessionController').updateQueue({sessionId,itemId,action:{kind:'remove'}});}
    });},
    async list(){
      const controller=ctx.get('sessionController');const registry=ctx.get('workspaceRegistry');
      need(controller&&registry,'HOST_SERVICES_NOT_READY');
      const {items}=await controller.list({},AbortSignal.timeout(10000));
      const archives=registry.archivedSessionIds;
      need(Array.isArray(archives),'ARCHIVE_STATE_UNAVAILABLE');
      // Discard all projections/body data immediately; persist only metadata for explicit bindings.
      return store.routes().flatMap(route=>{
        const item=items.find(x=>x.sessionId===route.dshSessionId);if(!item)return [];
        const workspace=registry.get(route.dshWorkspaceId);
        return [{sessionId:item.sessionId,running:item.running===true,archived:archives.includes(item.sessionId),
          workspaceId:workspace?.sessionIds?.includes(item.sessionId)?route.dshWorkspaceId:null}];
      });
    },
    prompt(request,signal){return ctx.get('sessionController').prompt(request,signal);}
  },{timeoutMs:config.deliveryTimeoutMs||20000,allow:row=>{
    if(row.workstream==='bridge')return true;
    try{const p=JSON.parse(readFileSync(join(store.root,'state/event-worker.config.json'),'utf8')).routes?.[row.route];
      return p?.businessPaused===false&&p.codexThreadId===row.routeInfo.codexThreadId&&p.dshSessionId===row.routeInfo.dshSessionId&&p.revision===row.routeInfo.revision;
    }catch{return false;}
  }});
  let timer,events,policyWatch,disposed=false,again=false;
  const kick=()=>{if(disposed)return;clearTimeout(timer);timer=setTimeout(async()=>{
    if(relay.busy){again=true;return;}
    await relay.tick();if(again){again=false;kick();}
  },25);};
  if(config.relayEnabled!==false){
    events=watchQueueEvents(store,kick,{persistent:false});
    policyWatch=watch(join(store.root,'state'),{persistent:false},(_event,file)=>{if(String(file)==='event-worker.config.json')kick();});
    ctx.on('agent/status',({agent})=>{if(store.routes().some(r=>r.dshSessionId===agent?.id))kick();});
    ctx.on('api-session/added',session=>{if(store.routes().some(r=>r.dshSessionId===session?.sessionId))kick();});
    kick();
  }
  ctx.effect(()=>async()=>{disposed=true;clearTimeout(timer);events?.close();policyWatch?.close();while(relay.busy)await new Promise(r=>setTimeout(r,50));
    store.heartbeat('dsh-host',{ready:false,pid:process.pid,version:VERSION,code:'PLUGIN_DISPOSED'});store.close();});
}
