import type { HybridDocument, HybridMeta, HybridResolution, HybridTree, SourceRange } from './hybrid-types';
export interface EmbedFlags { target: string; heading: boolean; toc: boolean; error?: string; }
export function parseEmbedLine(line: string): EmbedFlags | null {
  const m = /^\s*!\[\[([^\]\n]+)\]\]\s*(?:%%([a-z]+)%%)?\s*$/.exec(line);
  if (!m) return null;
  const letters = m[2] ?? '';
  const unknown = [...letters].find(c => c !== 'h' && c !== 't');
  const result: EmbedFlags = { target:m[1].split('|')[0], heading:!letters.includes('h'), toc:!letters.includes('t') };
  if (unknown) result.error = `Unknown embed flag: ${unknown}`;
  return result;
}
/** A deliberately small author-year label, not a claim of complete APA/CSL compliance. */
export function citationLabel(meta: HybridMeta): string | null {
  const authors = meta.citationAuthors.filter(a => a.trim());
  if (!authors.length || !meta.publicationYear) return null;
  const names = authors.length === 1 ? authors[0] : authors.length === 2 ? authors.join(' & ') : `${authors[0]} et al.`;
  return `(${names}, ${meta.publicationYear})`;
}

export interface DisplaySpan extends SourceRange {
  kind: 'metadata' | 'citation' | 'embed' | 'raw'; text?: string; target?: string;
  flags?: EmbedFlags; raw?: string; error?: string;
}
export interface ForesterToken { kind: 'text'|'command'|'comment'|'delimiter'|'verbatim'; text:string; }
/** Display-only tokens. No expansion, IO or execution occurs during highlighting. */
export function foresterTokens(code:string):ForesterToken[] {
  const tokens:ForesterToken[]=[];
  const pattern=/\\startverb\b[\s\S]*?(?:\\stopverb\b|$)|\\(?:[A-Za-z][A-Za-z0-9_/-]*|[^\s])|%[^\r\n]*|[{}\[\]()]/g;
  let from=0;
  for(let m;(m=pattern.exec(code));){
    if(m.index>from)tokens.push({kind:'text',text:code.slice(from,m.index)});
    const text=m[0];
    tokens.push({kind:text.startsWith('\\startverb')?'verbatim':text[0]==='\\'?'command':text[0]==='%'?'comment':'delimiter',text});
    from=pattern.lastIndex;
  }
  if(from<code.length)tokens.push({kind:'text',text:code.slice(from)});
  return tokens;
}
export interface OutlineEntry { title:string; number:string; target:string; children:OutlineEntry[]; sourceKey?:string; }
/** Bounded occurrence outline. `t` excludes that occurrence, not the referenced tree elsewhere. */
export function treeOutline(doc:HybridDocument,resolve:(target:string,path?:string)=>HybridResolution):OutlineEntry[]{
  if(!doc.enabled)return[];
  let budget=256;
  const caches=new Map<HybridDocument,Array<{from:number;owner:string;flags:EmbedFlags}>>();
  const embeds=(d:HybridDocument)=>{
    const old=caches.get(d);if(old)return old;
    const list:Array<{from:number;owner:string;flags:EmbedFlags}>=[];let at=0;
    for(const line of d.source.split('\n')){
      const flags=parseEmbedLine(line);
      if(flags&&!flags.error){
        const from=at+line.indexOf('![['),to=at+line.indexOf(']]')+2;
        if(!d.protectedRanges.some(r=>from<r.to&&to>r.from)){
          const owner=[...d.trees].filter(t=>t.from<=from&&from<t.to).sort((a,b)=>b.level-a.level)[0];
          if(owner)list.push({from,owner:owner.key,flags});
        }
      }
      at+=line.length+1;
    }
    caches.set(d,list);return list;
  };
  const walk=(d:HybridDocument,t:HybridTree,prefix:string,trail:Set<string>,depth:number,ownSource:boolean):OutlineEntry[]=>{
    const events=[...t.children.map(child=>({from:child.from,tree:child})),...embeds(d).filter(e=>e.owner===t.key)].sort((a,b)=>a.from-b.from);
    const out:OutlineEntry[]=[];
    for(let i=0;i<events.length;i++){
      if(budget--<=0)break;
      const e=events[i],number=[prefix,String(i+1)].filter(Boolean).join('.');
      if('tree'in e){
        const child=e.tree;
        out.push({title:child.meta.title,number,target:`${d.path}#${child.id?'^'+child.id:child.meta.title}`,...(ownSource?{sourceKey:child.key}:{}),children:depth<12?walk(d,child,number,trail,depth+1,ownSource):[]});
      }else if(e.flags.toc){
        const r=resolve(e.flags.target,d.path);if(r.status!=='resolved'||!r.document.enabled)continue;
        const loop=trail.has(r.tree.key)||depth>=12;
        out.push({title:r.tree.meta.title+(loop?' · 循環参照／深さ制限':''),number,target:e.flags.target,children:loop?[]:walk(r.document,r.tree,number,new Set([...trail,r.tree.key]),depth+1,false)});
      }
    }
    return out;
  };
  return walk(doc,doc.root,'',new Set([doc.root.key]),0,true);
}
export interface DisplayPlan { headings: Array<{at:number;label:string;title:string}>; spans: DisplaySpan[]; }
export function planDisplay(doc: HybridDocument, selections: SourceRange[], resolve: (target:string,path?:string) => HybridResolution): DisplayPlan {
  const plan: DisplayPlan = {headings:[],spans:[]};
  if (!doc.enabled) return plan;
  const active = (r:SourceRange) => selections.some(s => s.from <= r.to && s.to >= r.from);
  const protectedAt = (r:SourceRange) => doc.protectedRanges.some(s => r.from < s.to && r.to > s.from);
  const numbers=new Map<string,string>();
  const collect=(entries:OutlineEntry[])=>{for(const entry of entries){if(entry.sourceKey)numbers.set(entry.sourceKey,entry.number);collect(entry.children);}};
  collect(treeOutline(doc,resolve));
  for (const tree of doc.trees) {
    if (tree.level > 1) plan.headings.push({at:tree.from,label:[tree.meta.taxon,numbers.get(tree.key)??tree.number].filter(Boolean).join(' '),title:tree.meta.title});
    for (const r of tree.metadataRanges) {
      // Obsidian owns frontmatter editing/Properties; only hide our body metadata.
      if (tree === doc.root && r.from === 0 && /^---\r?\n/.test(doc.source)) continue;
      if (r.to>r.from && !active(r)) plan.spans.push({...r,kind:'metadata'});
    }
  }
  for (const raw of doc.raw) if (!active(raw)) plan.spans.push({from:raw.from,to:raw.to,kind:'raw',raw:raw.code,error:raw.error});
  const citations = /\{ref:\[\[([^\]\n]+)\]\]\}/g;
  for (let m; (m = citations.exec(doc.source));) {
    const r = {from:m.index,to:m.index+m[0].length};
    if (active(r) || protectedAt(r)) continue;
    const target = m[1].split('|')[0];
    const result = resolve(target);
    const label = result.status === 'resolved' ? citationLabel(result.tree.meta) : null;
    plan.spans.push({...r,kind:'citation',text:label ?? '(引用情報未設定)',target,error:!label ? 'Citation target or bibliographic metadata missing' : undefined});
  }
  let from = 0;
  for (const line of doc.source.split('\n')) {
    const r = {from,to:from+line.replace(/\r$/,'').length};
    const flags = parseEmbedLine(line);
    // The trailing flag comment is itself protected text. Check only the actual embed.
    const linkFrom = from + line.indexOf('![[');
    const linkTo = from + line.indexOf(']]') + 2;
    if (flags && !active(r) && !protectedAt({from:linkFrom,to:linkTo})) plan.spans.push({...r,kind:'embed',target:flags.target,flags,error:flags.error});
    from += line.length+1;
  }
  plan.spans.sort((a,b) => a.from-b.from || b.to-a.to);
  // A malformed nested directive must not cause overlapping CodeMirror replacements.
  let end = -1;
  plan.spans = plan.spans.filter(r => { if (r.from < end) return false; end = r.to; return true; });
  return plan;
}
