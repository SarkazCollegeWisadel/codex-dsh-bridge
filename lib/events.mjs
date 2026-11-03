import { watch } from 'node:fs';
import { join } from 'node:path';

// fs.watch uses Windows filesystem notifications, not an interval. Watching the
// directory survives SQLite WAL rotation and also works with the running 0.1.x
// DSH plugin. Health writes never count as new queue events.
export function watchQueueEvents(store,callback,{debounceMs=30,persistent=true}={}){
  let cursor=Number(store.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get().seq);
  let timer,closed=false;
  const scan=()=>{if(closed)return;clearTimeout(timer);timer=setTimeout(()=>{
    try{const rows=store.db.prepare('SELECT seq,id,state FROM events WHERE seq>? ORDER BY seq').all(cursor);
      if(rows.length){cursor=Number(rows.at(-1).seq);callback(rows);}
    }catch(error){callback([],{code:'EVENT_WATCH_READ_FAILED'});}
  },debounceMs);};
  const watcher=watch(join(store.root,'state'),{persistent},(_event,file)=>{
    if(file==null||/^bridge\.sqlite(?:-wal)?$/.test(String(file)))scan();
  });
  watcher.on('error',()=>callback([],{code:'EVENT_WATCH_FAILED'}));
  return {close(){closed=true;clearTimeout(timer);watcher.close();},get cursor(){return cursor;}};
}
