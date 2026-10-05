import {StateField} from '@codemirror/state';
export { EditorSuggest, SuggestModal, FuzzySuggestModal, ItemView } from './controller-obsidian-mock.mjs';
export const editorInfoField=StateField.define({create:()=>null,update:v=>v});
export const editorLivePreviewField=StateField.define({create:()=>true,update:v=>v});
export class Component{load(){}unload(){}addChild(c){return c;}register(){} }
export class MarkdownRenderChild extends Component{constructor(el){super();this.containerEl=el;}}
export class Plugin extends Component{
 constructor(app){super();this.app=app;this.commands=[];this.extensions=[];this.postprocessors=[];this.cleanups=[];}
 async loadData(){return null;}async saveData(){}register(f){this.cleanups.push(f);}registerEvent(){}addCommand(c){this.commands.push(c);}addSettingTab(){}registerMarkdownPostProcessor(fn){this.postprocessors.push(fn);}registerMarkdownCodeBlockProcessor(){}registerEditorExtension(e){this.extensions.push(e);}registerView(){}registerEditorSuggest(){}
}
export class PluginSettingTab{constructor(app,plugin){this.app=app;this.plugin=plugin;}}
export class MarkdownView{};
export class TFile{constructor(path){this.path=path;this.basename=path.replace(/\.md$/,'');this.extension='md';}}
export class Notice{constructor(message){this.message=message;}}
export class Modal{constructor(app){this.app=app;}open(){}close(){}}
export class Setting{};
export const Platform={isMobile:false};
export const Keymap={isModEvent:()=>false};
export const debounce=fn=>fn;
export const MarkdownRenderer={render:async()=>{},renderMarkdown:async()=>{}};
