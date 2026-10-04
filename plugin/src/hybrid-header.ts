import type { HybridResolution, HybridTree } from './hybrid-types';
export interface HeaderHost {
  resolve(target:string,path:string):HybridResolution;
  open(target:string,path:string):void;
  register(cleanup:()=>void):void;
}
/** Native date labels, without treating note authors as citation authors. */
function dateLabel(value:string):string {
  const m=/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if(!m)return value;
  const month=Number(m[2]),day=Number(m[3]);
  if(!m[2])return m[1];
  if(month<1||month>12||m[3]&&(day<1||day>new Date(Date.UTC(Number(m[1]),month,0)).getUTCDate()))return value;
  const name=['January','February','March','April','May','June','July','August','September','October','November','December'][month-1];
  return `${name}${m[3]?' '+day:''}, ${m[1]}`;
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
export function renderMetadata(dom:Document,tree:HybridTree,host:HeaderHost):HTMLElement|null {
  const el=dom.createElement('div');el.className='hybrid-metadata';const list=dom.createElement('ul');el.append(list);
  for(const date of tree.meta.dates){const li=dom.createElement('li');li.className='meta-item';relationText(li,date,tree.path,host,true);list.append(li);}
  if(tree.meta.authors.length){const li=dom.createElement('li');li.className='meta-item';const address=dom.createElement('address');address.className='author';
    tree.meta.authors.forEach((value,i)=>{if(i)address.append(dom.createTextNode(', '));relationText(address,value,tree.path,host);});li.append(address);list.append(li);}
  return list.childElementCount?el:null;
}
export function renderTreeHeader(dom:Document,tree:HybridTree,label:string,host:HeaderHost):HTMLElement {
  const header=dom.createElement('header');header.className='hybrid-tree-header';
  const heading=dom.createElement(tree.level===1?'h1':'h2');heading.textContent=tree.meta.title;appendTaxon(heading,tree,label);appendSlug(heading,tree,host);header.append(heading);
  const metadata=renderMetadata(dom,tree,host);if(metadata)header.append(metadata);return header;
}
