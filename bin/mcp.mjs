#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { Store, VERSION } from '../lib/store.mjs';
import { tools, invoke } from '../lib/api.mjs';
import { ensureEventWorker } from '../lib/worker-launch.mjs';
const store=new Store();
ensureEventWorker(store.root);
const supported=['2024-11-05','2025-03-26','2025-06-18'];
const respond=x=>process.stdout.write(JSON.stringify(x)+'\n');
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line',line=>{
  let request;
  try {
    if(Buffer.byteLength(line)>300000)throw new Error('MESSAGE_TOO_LARGE');request=JSON.parse(line);
    if(request.id===undefined)return;
    let result;
    switch(request.method){
      case 'initialize':result={protocolVersion:supported.includes(request.params?.protocolVersion)?request.params.protocolVersion:supported.at(-1),capabilities:{tools:{listChanged:false}},serverInfo:{name:'dsh-codex-agent-bridge',version:VERSION}};break;
      case 'ping':result={};break;
      case 'tools/list':result={tools};break;
      case 'tools/call':{
        try{const value=invoke(store,request.params.name,request.params.arguments||{});result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:{result:value},isError:false};}
        catch(e){result={content:[{type:'text',text:JSON.stringify({ok:false,error:e.code||'BRIDGE_TOOL_FAILED'})}],isError:true};}
        break;
      }
      default:respond({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}});return;
    }
    respond({jsonrpc:'2.0',id:request.id,result});
  }catch{respond({jsonrpc:'2.0',id:request?.id??null,error:{code:-32700,message:'Invalid JSON-RPC request'}});}
});
lines.on('close',()=>store.close());
