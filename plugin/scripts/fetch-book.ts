import {readdir,readFile,mkdir,writeFile,lstat,realpath,rm} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {drawHybridId,parseHybrid} from '../src/hybrid-core';
import {hybridOptions} from '../src/hybrid-config';
import {sanitizeJpeg} from '../src/hybrid-public-jpeg';

/**
 * Book note from an ISBN: openBD summary first, NDL Search fills gaps. Cover
 * only from openBD (licence), only as a sanitized baseline JPEG. Never
 * overwrites, never writes outside the vault, never echoes paths or payloads.
 */
type Fetch=(url:string,init?:{headers?:Record<string,string>;signal?:AbortSignal})=>Promise<{ok:boolean;status:number;text():Promise<string>;arrayBuffer():Promise<ArrayBuffer>}>;
export interface BookDeps{fetch:Fetch;out:(line:string)=>void;random?:()=>number;}
interface Book{title?:string;authors:string[];year?:string;external?:string;cover?:string;}
interface NdlItem{isbns:string[];title?:string;volume?:string;creators:string[];publisher?:string;issued?:string;link?:string;}

const USER_AGENT='forester-hybrid-fetch-book/1.0 (+personal Obsidian book notes; contact via repository)';
const OPENBD='https://api.openbd.jp/v1/get?isbn=',NDL='https://ndlsearch.ndl.go.jp/api/opensearch';
class Failure extends Error{constructor(readonly code:string){super(code);}}

/** ISBN-10/13 with checksum; returns ISBN-13 digits or undefined. */
export function normalizeIsbn(input:string):string|undefined{
 const s=input.replace(/[-\s]/g,'').toUpperCase();
 if(/^\d{13}$/.test(s)){
  const sum=[...s].reduce((a,c,i)=>a+Number(c)*(i%2?3:1),0);
  return sum%10===0&&/^97[89]/.test(s)?s:undefined;
 }
 if(/^\d{9}[\dX]$/.test(s)){
  const sum=[...s].reduce((a,c,i)=>a+(c==='X'?10:Number(c))*(10-i),0);
  if(sum%11)return undefined;
  const body='978'+s.slice(0,9),check=(10-[...body].reduce((a,c,i)=>a+Number(c)*(i%2?3:1),0)%10)%10;
  return body+check;
 }
 return undefined;
}

const entities=(s:string)=>s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi,(_,e:string)=>{
 const k=e.toLowerCase();
 if(k[0]==='#')return String.fromCodePoint(k[1]==='x'?parseInt(k.slice(2),16):parseInt(k.slice(1),10));
 return ({lt:'<',gt:'>',quot:'"',apos:"'",amp:'&'} as Record<string,string>)[k];
}).trim();
const tags=(xml:string,name:string,attr?:RegExp)=>[...xml.matchAll(new RegExp(`<${name}(\\s[^>]*)?>([\\s\\S]*?)</${name}>`,'g'))].filter(m=>!attr||attr.test(m[1]??'')).map(m=>entities(m[2])).filter(Boolean);

/** NDL OpenSearch RSS → items. Regex over a fixed vocabulary; no entity expansion beyond the XML five. */
export function parseNdl(xml:string):NdlItem[]{
 return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([,x])=>{
  const link=tags(x,'link')[0];
  return {
   isbns:tags(x,'dc:identifier',/dcndl:ISBN(13)?"/).map(normalizeIsbn).filter((v):v is string=>!!v),
   title:tags(x,'dc:title')[0],volume:tags(x,'dcndl:volume')[0],creators:tags(x,'dc:creator'),
   publisher:tags(x,'dc:publisher')[0],issued:tags(x,'dcterms:issued')[0]??tags(x,'dc:date')[0],
   link:link&&/^https:\/\/ndlsearch\.ndl\.go\.jp\/books\/[A-Za-z0-9_-]+$/.test(link)?link:undefined,
  };
 });
}

const AUTHOR_ROLES=/^(著|作|文|原作|原著|編|編著|著者|作者|共著|ほか著|他著)$/;
const ANY_ROLE=/^(著|作|文|原作|原著|編|編著|著者|作者|共著|ほか著|他著|訳|翻訳|共訳|監訳|絵|画|イラスト|監修|解説|写真)$/;
/** "森, 博嗣, 1957-" → "森博嗣"; "Smith, John, 1950-" → "John Smith". */
function heading(name:string):string{
 const parts=name.split(/\s*,\s*/).filter(p=>p&&!/^\d/.test(p));
 if(parts.length<2)return parts[0]??'';
 return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(parts[0])?parts[0]+parts[1]:parts[1]+' '+parts[0];
}
/** Split openBD/NDL author strings into names, dropping obvious role suffixes; keep only authors when roles are explicit. */
export function cleanAuthors(raw:string[]):string[]{
 const entries:{name:string;role?:string}[]=[];
 for(const value of raw){
  const roled=[...value.matchAll(/([^／\s][^／]*?)\s*／\s*([^\s／]+)/g)];
  if(roled.length){for(const [,name,role] of roled)entries.push({name,role});continue;}
  let name=value.trim(),role:string|undefined,m=/^(.*?)\s*\[([^\]]+)\]$/.exec(name);
  if(m){name=m[1];role=m[2];}
  else if((m=/^(.*\S)\s+(\S+)$/.exec(name))&&ANY_ROLE.test(m[2])){name=m[1];role=m[2];}
  entries.push({name,role});
 }
 const named=entries.map(e=>({...e,name:heading(e.name.trim()).replace(/\s+/g,' ').trim()})).filter(e=>e.name);
 const authors=named.filter(e=>!e.role||AUTHOR_ROLES.test(e.role));
 return [...new Set((authors.length?authors:named).map(e=>e.name))];
}

async function get(deps:BookDeps,url:string,code:string):Promise<{text():Promise<string>;arrayBuffer():Promise<ArrayBuffer>}|undefined>{
 let response;
 try{response=await deps.fetch(url,{headers:{'User-Agent':USER_AGENT},signal:AbortSignal.timeout(10000)});}catch{throw new Failure(code);}
 if(response.status===404)return undefined;
 if(!response.ok)throw new Failure(code);
 return response;
}
const ndlQuery=async(deps:BookDeps,query:string)=>{
 const r=await get(deps,NDL+'?'+query,'ndl-unavailable');
 try{return r?parseNdl(await r.text()):[];}catch{throw new Failure('ndl-unavailable');}
};

const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));};
/** Only plain directories below the canonical vault; symlinked components refuse. */
async function ensureFolder(vault:string,folder:string):Promise<string>{
 let dir=vault;
 for(const part of folder.split('/')){
  dir=join(dir,part);
  try{const info=await lstat(dir);if(info.isSymbolicLink()||!info.isDirectory())throw new Failure('unsafe-folder');}
  catch(e){if(e instanceof Failure||(e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await mkdir(dir);}
 }
 if(!inside(vault,await realpath(dir)))throw new Failure('unsafe-folder');
 return dir;
}

/** Every frontmatter `forester-id`/`id` and every parsed tree ID, so the draw never collides. */
async function vaultIds(vault:string):Promise<string[]>{
 const ids:string[]=[],options=hybridOptions(undefined);
 const walk=async(dir:string):Promise<void>=>{
  for(const entry of await readdir(dir,{withFileTypes:true})){
   if(entry.name.startsWith('.')||entry.name==='node_modules'||entry.isSymbolicLink())continue;
   const p=join(dir,entry.name);
   if(entry.isDirectory()){await walk(p);continue;}
   if(!entry.isFile()||!entry.name.endsWith('.md'))continue;
   const source=await readFile(p,'utf8'),front=/^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
   if(front)for(const m of front[1].matchAll(/^(?:forester-id|id)\s*:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/gm))ids.push(m[1]);
   try{for(const tree of parseHybrid(relative(vault,p),source,options).trees)if(tree.id)ids.push(tree.id);}catch{/* frontmatter scan still applies */}
  }
 };
 await walk(vault);
 return ids;
}

const fileTitle=(title:string)=>title.normalize('NFC').replace(/[\u0000-\u001f\u007f\\/:*?"<>|#^[\]]/g,' ').replace(/\s+/g,' ').trim().replace(/^\.+/,'').slice(0,120).trim();
const yamlString=(s:string)=>JSON.stringify(s);

export async function fetchBook(argv:string[],deps:BookDeps):Promise<void>{
 const allowed=new Set(['--vault','--isbn','--folder','--search','--creator']),values=new Map<string,string>();
 for(let i=0;i<argv.length;i+=2){
  if(!argv[i+1]||!allowed.has(argv[i])||values.has(argv[i]))throw new Failure('usage');
  values.set(argv[i],argv[i+1]);
 }
 if(values.has('--search')){
  if(values.size!==(values.has('--creator')?2:1))throw new Failure('usage');
  const creator=values.has('--creator')?'&creator='+encodeURIComponent(values.get('--creator')!):'';
  const seen=new Set<string>();
  for(const item of await ndlQuery(deps,'title='+encodeURIComponent(values.get('--search')!)+creator+'&mediatype=books&cnt=20')){
   const isbn=item.isbns[0];
   if(!isbn||seen.has(isbn))continue;
   seen.add(isbn);
   deps.out(JSON.stringify({isbn,title:[item.title,item.volume].filter(Boolean).join(' '),creator:item.creators.join('; '),publisher:item.publisher??'',issued:item.issued??''}));
  }
  return;
 }
 if(!values.has('--vault')||!values.has('--isbn')||values.has('--creator'))throw new Failure('usage');
 const folder=values.get('--folder')??'PUBLIC/books';
 if(!/^[^/.][^/]*(?:\/[^/.][^/]*)*$/.test(folder)||folder.includes('\\'))throw new Failure('unsafe-folder');
 const isbn=normalizeIsbn(values.get('--isbn')!);
 if(!isbn)throw new Failure('invalid-isbn');
 let vault:string;
 try{vault=await realpath(resolve(values.get('--vault')!));if(!(await lstat(vault)).isDirectory())throw 0;}catch{throw new Failure('invalid-vault');}

 const book:Book={authors:[]},sources:string[]=[];
 const bd=await get(deps,OPENBD+isbn,'openbd-unavailable');
 let record:unknown;
 try{record=bd?JSON.parse(await bd.text())?.[0]:undefined;}catch{throw new Failure('openbd-unavailable');}
 const summary=record&&typeof record==='object'?(record as {summary?:Record<string,unknown>}).summary:undefined;
 if(summary&&typeof summary==='object'){
  const s=(k:string)=>typeof summary[k]==='string'&&(summary[k] as string).trim()?(summary[k] as string).trim():undefined;
  book.title=s('title')?.split(' = ')[0].trim()||undefined;book.authors=s('author')?cleanAuthors([s('author')!]):[];
  book.year=/^(\d{4})/.exec(s('pubdate')??'')?.[1];
  const cover=s('cover');if(cover&&/^https:\/\/[^\s]+$/.test(cover))book.cover=cover;
  sources.push('openbd');
 }
 const ndl=(await ndlQuery(deps,'isbn='+isbn)).find(item=>item.isbns.includes(isbn));
 if(ndl){
  book.title??=[ndl.title,ndl.volume].filter(Boolean).join(' ')||undefined;
  if(!book.authors.length)book.authors=cleanAuthors(ndl.creators);
  book.year??=/(\d{4})/.exec(ndl.issued??'')?.[1];
  book.external=ndl.link;
  sources.push('ndl');
 }
 if(!book.title)throw new Failure('not-found');
 const name=fileTitle(book.title);
 if(!name)throw new Failure('unsafe-title');

 const dir=await ensureFolder(vault,folder),note=join(dir,name+'.tree.md');
 try{await lstat(note);throw new Failure('exists');}catch(e){if(e instanceof Failure)throw e;}
 let cover:Uint8Array|undefined;
 if(book.cover){
  const response=await get(deps,book.cover,'cover-unavailable').catch(()=>undefined);
  if(response){try{cover=sanitizeJpeg(new Uint8Array(await response.arrayBuffer()))?.bytes;}catch{cover=undefined;}}
 }
 const id=drawHybridId(await vaultIds(vault),[],deps.random);
 const front=[
  '---',
  `forester-id: ${/^[0-9]+E[0-9]+$/.test(id)?yamlString(id):id}`,
  `title: ${yamlString(book.title)}`,
  'taxon: Book',
  'citation-authors:'+(book.authors.length?'\n'+book.authors.map(a=>'  - '+yamlString(a)).join('\n'):' []'),
  ...(book.year?[`publication-year: ${yamlString(book.year)}`]:[]),
  ...(book.external?[`external: ${yamlString(book.external)}`]:[]),
  `isbn: ${yamlString(isbn)}`,
  '---',
 ];
 let image:string|undefined;
 if(cover){
  const assets=await ensureFolder(vault,folder+'/_assets');
  image=join(assets,isbn+'.jpg');
  await writeFile(image,cover,{flag:'wx',mode:0o644}).catch(()=>{throw new Failure('exists');});
 }
 const body=(cover?`![[${isbn}.jpg]]\n`:'')+'\n';
 try{await writeFile(note,front.join('\n')+'\n'+body,{flag:'wx',mode:0o644});}
 catch{if(image)await rm(image,{force:true});throw new Failure('exists');}
 deps.out(JSON.stringify({status:'ok',path:relative(vault,note).split(sep).join('/'),id,cover:!!cover,...(book.cover&&!cover?{coverSkipped:'unsupported-or-unavailable'}:{}),sources}));
}

async function main():Promise<void>{
 try{await fetchBook(process.argv.slice(2),{fetch:globalThis.fetch as unknown as Fetch,out:line=>process.stdout.write(line+'\n')});}
 catch(e){
  // Generic codes only: no paths, URLs or remote payloads.
  process.stdout.write(JSON.stringify({status:'error',code:e instanceof Failure?e.code:'failed'})+'\n');process.exitCode=1;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main();
