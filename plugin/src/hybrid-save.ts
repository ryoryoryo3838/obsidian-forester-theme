import type { HybridSavePlan } from './hybrid-types';
export interface HybridStore { read(path:string):Promise<string>; compareWrite(path:string,before:string,after:string,purpose?:'forward'|'rollback'):Promise<boolean>; }
export interface HybridCommit { committed:boolean; conflicts:string[]; partial:string[]; }
/** Compare snapshots first; a stale source must not cause unrelated notes to be modified. */
export async function commitHybridPlan(plan:HybridSavePlan,store:HybridStore,sourcePath?:string):Promise<HybridCommit>{
  const conflicts:string[]=[];
  for(const edit of plan.edits){
    try{if(await store.read(edit.path)!==edit.before)conflicts.push(edit.path);}catch{conflicts.push(edit.path);}
  }
  if(conflicts.length)return{committed:false,conflicts,partial:[]};
  const written:typeof plan.edits=[];
  // An interrupted multi-file save must not expose references before their target IDs exist.
  const ordered=sourcePath===undefined?plan.edits:[...plan.edits.filter(e=>e.path!==sourcePath),...plan.edits.filter(e=>e.path===sourcePath)];
  for(const edit of ordered){
    let changed=false;
    try{changed=await store.compareWrite(edit.path,edit.before,edit.after);}catch{
      // An adapter may throw after the actual disk/editor mutation succeeded.
      try{if(await store.read(edit.path)===edit.after)written.push(edit);}catch{written.push(edit);}
    }
    if(!changed){
      const partial:string[]=[];
      for(const previous of [...written].reverse()){
        try{if(!await store.compareWrite(previous.path,previous.after,previous.before,'rollback'))partial.push(previous.path);}catch{partial.push(previous.path);}
      }
      return{committed:false,conflicts:[edit.path],partial};
    }
    written.push(edit);
  }
  return{committed:true,conflicts:[],partial:[]};
}
