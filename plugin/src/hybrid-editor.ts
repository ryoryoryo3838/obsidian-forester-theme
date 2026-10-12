import { EditorState, Prec, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';
import type { HybridDocument, HybridResolution, HybridTree } from './hybrid-types';
import { planDisplay, parseEmbedLine, rootHeadingAt, foresterTokens, type DisplaySpan, type EmbedFlags } from './hybrid-display';
import { appendTaxon, appendSlug, renderMetadata, renderTreeHeader } from './hybrid-header';
import type { BackmatterGroups } from './hybrid-backmatter';
export const hybridRefresh = StateEffect.define<null>();
export interface EditorBackmatter {
  groups: BackmatterGroups;
  contextKey: string;
  signature: string;
}
export interface HybridEditorHost {
  document(state:EditorState): HybridDocument | null;
  resolve(target:string,path:string): HybridResolution;
  renderEmbed(el:HTMLElement,target:string,flags:EmbedFlags,path:string): (()=>void) | void;
  open(target:string,path:string): void;
  /** Rendering ownership only; does not alter the canonical numbering plan. */
  nativeEmbed?(target:string,path:string):boolean;
  backmatter?(document:HybridDocument,state:EditorState):EditorBackmatter | null;
  renderBackmatter?(el:HTMLElement,document:HybridDocument,snapshot:EditorBackmatter):(()=>void) | void;
}
class BackmatterWidget extends WidgetType {
  private cleanup?:()=>void;
  constructor(readonly backmatter:EditorBackmatter,private document:HybridDocument,private host:HybridEditorHost){super();}
  eq(other:BackmatterWidget):boolean{return this.host===other.host&&this.document.path===other.document.path&&this.document.source===other.document.source&&this.backmatter.signature===other.backmatter.signature;}
  toDOM():HTMLElement {
    const el=globalThis.document.createElement('div');el.className='hybrid-backmatter-host';
    this.cleanup=this.host.renderBackmatter?.(el,this.document,this.backmatter)??undefined;
    return el;
  }
  destroy():void{this.cleanup?.();this.cleanup=undefined;}
  ignoreEvent():boolean{return true;}
}
class HeaderPart extends WidgetType {
  private cleanups:Array<()=>void>=[];
  constructor(private tree:HybridTree,private kind:'taxon'|'slug'|'metadata'|'header',private headerLabel:string,private host:HybridEditorHost){super();}
  eq(other:HeaderPart):boolean{if(this.kind==='metadata'||this.kind==='header')return false; /* resolved relation labels can change without local metadata edits */ return this.kind===other.kind&&this.headerLabel===other.headerLabel&&this.tree.id===other.tree.id&&this.tree.path===other.tree.path&&JSON.stringify(this.tree.meta)===JSON.stringify(other.tree.meta);}
  toDOM():HTMLElement {
    const el=document.createElement(this.kind==='slug'?'span':'div');el.className=`hybrid-header-${this.kind}`;
    const host={resolve:(target:string,path:string)=>this.host.resolve(target,path),open:(target:string,path:string)=>this.host.open(target,path),register:(cleanup:()=>void)=>this.cleanups.push(cleanup)};
    if(this.kind==='taxon')appendTaxon(el,this.tree,this.headerLabel);
    else if(this.kind==='slug')appendSlug(el,this.tree,host);
    else if(this.kind==='metadata'){const metadata=renderMetadata(document,this.tree,host);if(metadata)el.append(metadata);}
    else el.append(renderTreeHeader(document,this.tree,this.headerLabel,host));
    return el;
  }
  destroy():void{for(const cleanup of this.cleanups.splice(0))cleanup();}
  ignoreEvent():boolean{return true;}
}
class Label extends WidgetType {
  constructor(private label:string) {super();}
  eq(other:Label):boolean{return this.label===other.label;}
  toDOM():HTMLElement { const el=document.createElement('span');el.className='hybrid-taxon-number';el.textContent=this.label+' ';return el; }
}
class HybridWidget extends WidgetType {
  private cleanup?:()=>void;
  constructor(readonly span:DisplaySpan,private path:string,private host:HybridEditorHost){super();}
  eq(other:HybridWidget):boolean{return false; /* referenced title/body changes must rerender */}
  toDOM(view:EditorView):HTMLElement {
    const el=document.createElement(this.span.kind==='embed'?'div':'span');
    el.className=`hybrid-${this.span.kind}`;
    if(this.span.error){el.classList.add('hybrid-error');el.title=this.span.error;}
    if(this.span.kind==='citation'){
      const a=document.createElement('a');a.textContent=this.span.text??'';a.className='internal-link';a.href='#';
      a.addEventListener('click',e=>{e.preventDefault();this.host.open(this.span.target??'',this.path);});el.append(a);
    }else if(this.span.kind==='raw'){
      const label=document.createElement('span');label.className='hybrid-raw-label';label.textContent='Forester · 未評価';
      const code=document.createElement('code');
      for(const token of foresterTokens(this.span.raw??'')){const part=document.createElement('span');part.className=`hybrid-token-${token.kind}`;part.textContent=token.text;code.append(part);}
      el.append(label,code);
    }else if(this.span.kind==='embed'){
      if(this.span.error)el.textContent=this.span.error;
      else this.cleanup=this.host.renderEmbed(el,this.span.target??'',this.span.flags!,this.path)??undefined;
    }
    // Double-click deliberately enters the original source; selection rebuilds this field.
    el.addEventListener('dblclick',()=>{view.dispatch({selection:{anchor:this.span.from}});view.focus();});
    return el;
  }
  destroy():void{this.cleanup?.();}
  ignoreEvent():boolean{return true;}
}
/** StateField, not ViewPlugin, so multiline/block replacements are valid CodeMirror decorations. */
export function createHybridEditor(host:HybridEditorHost):Extension {
  const build=(state:EditorState):DecorationSet=>{
    const doc=host.document(state);
    if(!doc?.enabled)return Decoration.none;
    const selected=state.selection.ranges.map(r=>({from:r.from,to:r.to}));
    const plan=planDisplay(doc,selected,(target,path)=>host.resolve(target,path??doc.path));
    const ranges:Range<Decoration>[]=[];
    const labels=new Map(plan.headings.map(h=>[h.at,h.label]));
    for(const tree of doc.trees){
      const position=tree===doc.root?rootHeadingAt(doc):tree.from;
      if(position===null)continue;
      if(position>state.doc.length)continue;
      const line=state.doc.lineAt(position),active=selected.some(s=>s.from<=line.to&&s.to>=line.from);
      ranges.push(Decoration.line({class:'hybrid-tree-heading'}).range(line.from));
      const label=tree===doc.root?tree.meta.taxon??'':labels.get(tree.from)??'';
      if(label)ranges.push(Decoration.widget({widget:tree===doc.root?new HeaderPart(tree,'taxon',label,host):new Label(label),block:tree===doc.root,side:-1}).range(line.from));
      if(tree.id&&!active){
        const suffix=new RegExp('\\s+\\^'+tree.id+'\\s*$').exec(line.text);
        const widget=new HeaderPart(tree,'slug','',host);
        ranges.push(suffix?Decoration.replace({widget}).range(line.from+suffix.index,line.to):Decoration.widget({widget,side:1}).range(line.to));
      }
      if(tree.meta.authors.length||tree.meta.dates.length)ranges.push(Decoration.widget({widget:new HeaderPart(tree,'metadata','',host),block:true,side:1}).range(line.to));
    }
    for(const span of plan.spans){
      if(span.to>state.doc.length||span.to<=span.from)continue;
      if(span.kind==='embed'&&host.nativeEmbed?.(span.target??'',doc.path))continue;
      const spec=span.kind==='metadata'?{}:{widget:new HybridWidget(span,doc.path,host),block:span.kind==='embed'};
      ranges.push(Decoration.replace(spec).range(span.from,span.to));
    }
    const backmatter=host.backmatter?.(doc,state);
    if(backmatter&&host.renderBackmatter)ranges.push(Decoration.widget({widget:new BackmatterWidget(backmatter,doc,host),block:true,side:1}).range(state.doc.length));
    return Decoration.set(ranges,true);
  };
  const field=StateField.define<DecorationSet>({create:build,update:(value,tr)=>tr.docChanged||tr.selection||tr.reconfigured||tr.effects.some(e=>e.is(hybridRefresh))?build(tr.state):value,provide:f=>EditorView.decorations.from(f)});
  // The active literal must stay editable. Native filename lookup cannot resolve
  // a tree-only ID, so hide its card, not the source or the native decoration.
  const editingIdEmbeds=ViewPlugin.define(view=>{
    const hiddenClass='hybrid-editing-id-embed',owned=new Set<HTMLElement>();
    const window=view.dom.ownerDocument.defaultView!;
    let frame:number|null=null,destroyed=false;
    const clear=()=>{for(const el of owned)el.classList.remove(hiddenClass);owned.clear();};
    const sync=()=>{
      frame=null;if(destroyed)return;
      const wanted=new Set<HTMLElement>(),candidates:Array<{el:HTMLElement;target:string;from:number;to:number}>=[];
      // Reject off-cursor/native-rendered DOM before asking for a semantic plan.
      // A native card's ID alone never grants ownership of another occurrence.
      for(const el of Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.internal-embed[src]'))){
        const target=el.getAttribute('src')??'';
        if(!/^[A-Za-z0-9-]+$/.test(target)||el.closest('.cm-content')!==view.contentDOM||el.closest('.hybrid-embed,.hybrid-backmatter-host')||el.parentElement?.closest('.internal-embed,.markdown-preview-view,.markdown-rendered')||el.querySelector('.markdown-preview-view,.markdown-rendered'))continue;
        // CM can map a descendant of a ranged native widget to its end.
        let at:number;try{at=view.posAtDOM(el);}catch{continue;}
        if(!Number.isInteger(at)||at<0||at>view.state.doc.length)continue;
        const line=view.state.doc.lineAt(at),flags=parseEmbedLine(line.text);
        if(!flags||flags.error||flags.target!==target)continue;
        const literal=/!\[\[[^\]\r\n]+\]\]/.exec(line.text);
        if(!literal)continue;
        const from=line.from+literal.index,to=from+literal[0].length;
        if(at<from||at>to||!view.state.selection.ranges.some(r=>r.from<=to&&r.to>=from))continue;
        candidates.push({el,target,from,to});
      }
      const doc=candidates.length?host.document(view.state):null;
      if(doc?.enabled&&doc.source===view.state.doc.toString()){
        // Empty selections recover the canonical, protected-range-aware plan;
        // the normal field intentionally omits this span while it is edited.
        const plan=planDisplay(doc,[],(target,path)=>host.resolve(target,path??doc.path));
        for(const {el,target,from,to} of candidates){
          if(!plan.spans.some(span=>span.kind==='embed'&&!span.error&&span.target===target&&span.from<=from&&span.to>=to)||host.nativeEmbed?.(target,doc.path))continue;
          const result=host.resolve(target,doc.path);
          if(result.status==='resolved'&&result.document.enabled&&result.tree.id?.toLowerCase()===target.toLowerCase())wanted.add(el);
        }
      }
      for(const el of owned)if(!wanted.has(el)){el.classList.remove(hiddenClass);owned.delete(el);}
      for(const el of wanted)if(!owned.has(el)){el.classList.add(hiddenClass);owned.add(el);}
    };
    const schedule=()=>{if(!destroyed&&frame===null)frame=window.requestAnimationFrame(sync);};
    // Native card population may follow CM's update. Observe this view only;
    // class changes are deliberately excluded to avoid observing our own writes.
    const observer=new window.MutationObserver(schedule);
    observer.observe(view.contentDOM,{childList:true,subtree:true});
    schedule();
    return{
      update(update){
        if(update.docChanged||update.selectionSet||update.transactions.some(tr=>tr.reconfigured||tr.effects.some(e=>e.is(hybridRefresh)))){clear();schedule();}
        else if(update.viewportChanged)schedule();
      },
      destroy(){destroyed=true;observer.disconnect();if(frame!==null)window.cancelAnimationFrame(frame);clear();}
    };
  });
  return [Prec.highest(field),EditorView.atomicRanges.of(view=>view.state.field(field)),editingIdEmbeds];
}
