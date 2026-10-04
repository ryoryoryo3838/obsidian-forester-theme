import {readdir,readFile,mkdir,writeFile,rename,rm,lstat,realpath} from 'node:fs/promises';
import {resolve,join,relative,dirname,basename,isAbsolute,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseHybrid,indexHybrid} from '../src/hybrid-core';
import {projectPublic} from '../src/hybrid-public';
import {hybridOptions} from '../src/hybrid-config';

function inside(root:string,path:string):boolean{
 const rel=relative(root,path);
 return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));
}

/** Validate even a not-yet-created output namespace without making directories. */
async function canonicalOutput(out:string,vault:string):Promise<string>{
 try{
  const info=await lstat(out);
  if(info.isSymbolicLink()||!info.isFile())throw new Error('Output must be a regular file, not a symlink');
 }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const suffix=[basename(out)];
 let ancestor=dirname(out);
 for(;;){
  // Catch only lstat's ENOENT. A dangling ancestor symlink must fail realpath,
  // not be mistaken for a missing directory that mkdir could safely create.
  try{await lstat(ancestor);break;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const parent=dirname(ancestor);
  if(parent===ancestor)throw new Error('No existing output ancestor');
  suffix.unshift(basename(ancestor));ancestor=parent;
 }
 const canonicalAncestor=await realpath(ancestor);
 if(!(await lstat(canonicalAncestor)).isDirectory())throw new Error('Output parent must be a directory');
 // Inspect every existing ancestor: entering the vault and then escaping it
 // through another symlink is still a source namespace and is forbidden.
 for(let parent=ancestor;;parent=dirname(parent)){
  if(inside(vault,await realpath(parent)))throw new Error('Output must be outside the source vault');
  if(dirname(parent)===parent)break;
 }
 const canonical=join(canonicalAncestor,...suffix);
 if(inside(vault,canonical))throw new Error('Output must be outside the source vault');
 return canonical;
}

/** Read-only vault traversal, no symlink following, no build/eval/network side effects. */
async function main():Promise<void>{
 const args=process.argv.slice(2),allowed=new Set(['--vault','--out','--config']);
 const values=new Map<string,string>();
 for(let i=0;i<args.length;i+=2){if(!allowed.has(args[i])||!args[i+1]||values.has(args[i]))throw new Error('Usage: project-public --vault PATH --out OUTPUT.json [--config CONFIG.json]');values.set(args[i],args[i+1]);}
 if(!values.has('--vault')||!values.has('--out'))throw new Error('Both --vault and --out are required');
 const lexicalVault=resolve(values.get('--vault')!),vault=await realpath(lexicalVault),requestedOut=resolve(values.get('--out')!);
 if(!requestedOut.endsWith('.json'))throw new Error('Output must be a .json artifact');
 if(inside(lexicalVault,requestedOut)||inside(vault,requestedOut))throw new Error('Output must be outside the source vault');
 const out=await canonicalOutput(requestedOut,vault);
 const config=values.has('--config')?await realpath(resolve(values.get('--config')!)):undefined;
 if(config===out)throw new Error('Output must not overwrite the configuration input');
 const options=hybridOptions(config?JSON.parse(await readFile(config,'utf8')):undefined);
 const paths:string[]=[];
 const walk=async(dir:string):Promise<void>=>{
  for(const entry of await readdir(dir,{withFileTypes:true})){
   if(entry.name.startsWith('.')||entry.name==='node_modules')continue;
   const p=join(dir,entry.name);
   if(entry.isSymbolicLink())continue;
   if(entry.isDirectory())await walk(p);
   else if(entry.isFile()&&entry.name.endsWith('.md'))paths.push(p);
  }
 };
 await walk(vault);paths.sort();
 const docs=[];
 for(const path of paths)docs.push(parseHybrid(relative(vault,path).split('\\').join('/'),await readFile(path,'utf8'),options));
 const projection=projectPublic(indexHybrid(docs));
 if(projection.diagnostics.some(d=>d.severity==='error')){
  // Projection diagnostics are intentionally source-free. Never echo YAML errors or private paths.
  process.stderr.write(JSON.stringify({status:'blocked',diagnostics:projection.diagnostics})+'\n');process.exitCode=1;return;
 }
 // Pin writes to the validated canonical namespace, never the caller's parent aliases.
 if(await canonicalOutput(out,vault)!==out)throw new Error('Output namespace changed');
 await mkdir(dirname(out),{recursive:true});
 if(await canonicalOutput(out,vault)!==out)throw new Error('Output namespace changed');
 const temporary=out+'.'+randomUUID()+'.tmp';
 try{await writeFile(temporary,JSON.stringify({format:'forester-public-v1',trees:projection.trees},null,2)+'\n',{flag:'wx',mode:0o600});await rename(temporary,out);}finally{await rm(temporary,{force:true});}
 process.stdout.write(JSON.stringify({status:'ok',publicTrees:projection.trees.length})+'\n');
}
main().catch(()=>{process.stderr.write('Public projection failed. Check local input/configuration; no private source details are emitted.\n');process.exitCode=1;});
