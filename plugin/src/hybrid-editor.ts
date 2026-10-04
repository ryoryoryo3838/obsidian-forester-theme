import { EditorState, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { HybridDocument, HybridResolution } from './hybrid-types';
import { planDisplay, foresterTokens, treeOutline, type OutlineEntry, type DisplaySpan, type EmbedFlags } from './hybrid-display';
export const hybridRefresh = StateEffect.define<null>();
export interface HybridEditorHost {
  document(state:EditorState): HybridDocument | null;
  resolve(target:string,path:string): HybridResolution;
  renderEmbed(el:HTMLElement,target:string,flags:EmbedFlags,path:string): (()=>void) | void;
  open(target:string,path:string): void;
}
class Label extends WidgetType {
  constructor(private label:string) {super();}
  eq(other:Label):boolean{return this.label===other.label;}
  toDOM():HTMLElement { const el=document.createElement('span');el.className='hybrid-taxon-number';el.textContent=this.label+' ';return el; }
}
class TocWidget extends WidgetType {
  constructor(readonly entries:OutlineEntry[],private path:string,private host:HybridEditorHost){super();}
  eq(other:TocWidget):boolean{return JSON.stringify(this.entries)===JSON.stringify(other.entries);}
  toDOM():HTMLElement{
    const details=document.createElement('details');details.className='hybrid-toc';
    const summary=document.createElement('summary');summary.textContent='Tree目次';details.append(summary);
    const list=(entries:OutlineEntry[]):HTMLElement=>{
      const ul=document.createElement('ul');
      for(const entry of entries){
        const li=document.createElement('li'),a=document.createElement('a');a.textContent=`${entry.number} ${entry.title}`;a.href='#';
        a.addEventListener('click',e=>{e.preventDefault();this.host.open(entry.target,this.path);});li.append(a);
        if(entry.children.length)li.append(list(entry.children));ul.append(li);
      }
      return ul;
    };
    details.append(list(this.entries));return details;
  }
  ignoreEvent():boolean{return true;}
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
    const entries=treeOutline(doc,(target,path)=>host.resolve(target,path??doc.path));
    if(entries.length)ranges.push(Decoration.widget({widget:new TocWidget(entries,doc.path,host),block:true,side:-1}).range(Math.min(doc.root.contentFrom,state.doc.length)));
    for(const h of plan.headings){
      if(h.at>state.doc.length)continue;
      const at=state.doc.lineAt(h.at).from;
      ranges.push(Decoration.line({class:'hybrid-tree-heading'}).range(at));
      if(h.label)ranges.push(Decoration.widget({widget:new Label(h.label),side:-1}).range(at));
    }
    for(const span of plan.spans){
      if(span.to>state.doc.length||span.to<=span.from)continue;
      const spec=span.kind==='metadata'?{}:{widget:new HybridWidget(span,doc.path,host),block:span.kind==='embed'};
      ranges.push(Decoration.replace(spec).range(span.from,span.to));
    }
    return Decoration.set(ranges,true);
  };
  const field=StateField.define<DecorationSet>({create:build,update:(value,tr)=>tr.docChanged||tr.selection||tr.reconfigured||tr.effects.some(e=>e.is(hybridRefresh))?build(tr.state):value,provide:f=>EditorView.decorations.from(f)});
  return [field,EditorView.atomicRanges.of(view=>view.state.field(field))];
}
