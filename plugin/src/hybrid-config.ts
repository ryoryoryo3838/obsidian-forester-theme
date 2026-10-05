import type {HybridOptions} from './hybrid-types';
/** Persisted settings must not broaden public scope through type coercion. */
export function hybridOptions(value:unknown):HybridOptions{
 const object=value&&typeof value==='object'?value as Record<string,unknown>:{};
 const list=(key:string):string[]=>{const a=object[key];return Array.isArray(a)&&a.every(v=>typeof v==='string')?[...a]:[];};
 return {folders:list('folders'),excludedFolders:list('excludedFolders'),publicFolders:list('publicFolders'),reservedIds:list('reservedIds')};
}
