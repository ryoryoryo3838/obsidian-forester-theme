import type { HybridResolution, HybridTree } from './hybrid-types';
export interface HeaderHost {
  resolve(target:string,path:string):HybridResolution;
  open(target:string,path:string):void;
  register(cleanup:()=>void):void;
}
/** Meta-line date labels, without treating note authors as citation authors. */
function dateLabel(value:string):string {
  const m=/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if(!m)return value;
  const month=Number(m[2]),day=Number(m[3]);
  if(!m[2])return m[1];
  if(month<1||month>12||m[3]&&(day<1||day>new Date(Date.UTC(Number(m[1]),month,0)).getUTCDate()))return value;
  // The design system's date: 2026年8月2日, as on the site.
  return `${m[1]}年${month}月${m[3]?day+'日':''}`;
}
function relationText(el:HTMLElement,value:string,path:string,host:HeaderHost,date=false):void {
  const pattern=/\[\[([^\]\r\n]+)\]\]/g;let from=0;
  for(let m;(m=pattern.exec(value));){
    el.append(el.ownerDocument.createTextNode(value.slice(from,m.index)));
    const [target,...alias]=m[1].split('|'),resolved=host.resolve(target,path);
    const label=alias.length?alias.join('|'):resolved.status==='resolved'?resolved.tree.meta.title:target;
    const a=el.ownerDocument.createElement('a');a.className='internal-link';a.textContent=date?dateLabel(label):label;a.href='#';
    const click=(event:Event)=>{event.preventDefault();event.stopPropagation();host.open(target,path);};
    a.addEventListener('click',click);host.register(()=>a.removeEventListener('click',click));el.append(a);from=pattern.lastIndex;
  }
  el.append(el.ownerDocument.createTextNode(date?dateLabel(value.slice(from)):value.slice(from)));
}
export function appendSlug(heading:HTMLElement,tree:HybridTree,host:HeaderHost):void {
  if(!tree.id)return;
  const a=heading.ownerDocument.createElement('a');a.className='hybrid-slug';a.textContent=`[${tree.id}]`;a.href='#';
  const target=tree.level===1?tree.path:`${tree.path}#^${tree.id}`;
  const click=(event:Event)=>{event.preventDefault();event.stopPropagation();host.open(target,tree.path);};
  a.addEventListener('click',click);host.register(()=>a.removeEventListener('click',click));heading.append(heading.ownerDocument.createTextNode(' '),a);
}
export function appendTaxon(heading:HTMLElement,tree:HybridTree,label:string):void {
  if(!label)return;
  const span=heading.ownerDocument.createElement('span');span.className='hybrid-taxon-number'+(tree.level===1?' hybrid-root-taxon':'');
  span.setAttribute('data-hybrid-badge',tree.key);span.textContent=label+(tree.level===1?'':' ');heading.prepend(span);
}
/** Frontmatter keys shown on the meta line, in the order Forester's metadata.xsl emits them. */
const META_LINE=['position','institution','venue','source','doi','orcid','external','slides','video'] as const;
const META_HREF:Partial<Record<typeof META_LINE[number],(value:string)=>[string,string]>>={
  doi:v=>['https://www.doi.org/'+v,v],orcid:v=>['https://orcid.org/'+v,v],external:v=>[v,v],slides:v=>[v,'Slides'],video:v=>[v,'Video'],
};
export function hasMetadata(tree:HybridTree):boolean {
  return tree.meta.dates.length>0||tree.meta.authors.length>0||!!tree.meta.contributors?.length||META_LINE.some(key=>tree.meta.properties?.[key]?.length);
}
export function renderMetadata(dom:Document,tree:HybridTree,host:HeaderHost):HTMLElement|null {
  const el=dom.createElement('div');el.className='hybrid-metadata';const list=dom.createElement('ul');el.append(list);
  const item=()=>{const li=dom.createElement('li');li.className='meta-item';list.append(li);return li;};
  for(const date of tree.meta.dates)relationText(item(),date,tree.path,host,true);
  // Native `author: false` hides the byline, as on the site.
  const contributors=tree.meta.contributors??[];
  if(tree.meta.properties?.author?.[0]!=='false'&&(tree.meta.authors.length||contributors.length)){const address=dom.createElement('address');address.className='author';
    tree.meta.authors.forEach((value,i)=>{if(i)address.append(dom.createTextNode(', '));relationText(address,value,tree.path,host);});
    if(contributors.length){address.append(dom.createTextNode(' with contributions from '));contributors.forEach((value,i)=>{if(i)address.append(dom.createTextNode(', '));relationText(address,value,tree.path,host);});}
    item().append(address);}
  for(const key of META_LINE)for(const value of tree.meta.properties?.[key]??[]){
    const href=META_HREF[key]?.(value);
    if(!href){relationText(item(),value,tree.path,host);continue;}
    const a=dom.createElement('a');a.className='external-link';a.href=href[0];a.textContent=href[1];a.target='_blank';a.rel='noopener';item().append(a);
  }
  return list.childElementCount?el:null;
}
export function renderTreeHeader(dom:Document,tree:HybridTree,label:string,host:HeaderHost,showMetadata=true):HTMLElement {
  const header=dom.createElement('header');header.className='hybrid-tree-header';
  const heading=dom.createElement(tree.level===1?'h1':'h2');heading.textContent=tree.meta.title;appendTaxon(heading,tree,label);appendSlug(heading,tree,host);header.append(heading);
  const metadata=showMetadata?renderMetadata(dom,tree,host):null;if(metadata)header.append(metadata);return header;
}
