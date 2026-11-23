declare module '*services/recipe-api/src/rich-document.mjs' {
  type Content=import('@vonvon/protocol').RecipeRichContent;
  type Change=import('@vonvon/protocol').RecipeRichDraftChange;
  type Part=import('@vonvon/protocol').RecipeRichPartDescriptor;
  export function applyChanges(content:Content,changes:Change[],resolve:(source:{sourceIntentId:string;candidateId:string})=>{content:Content;itemId:string},
    seed:Uint8Array,parts?:Part[],onStep?:(content:Content)=>void):{doc:{content:Content}};
  export function richWireBytes(value:unknown):Buffer;
  export interface InventoryItem {kind:string;itemId:string;originId:string;baselineSha256:string;contentFingerprint:string}
  export function inventory(content:Content):InventoryItem[];
  export function freezeSnapshot(input:unknown,seed:Uint8Array,prior?:ReadonlyMap<string,InventoryItem>):{content:Content};
}
declare module '*services/recipe-api/src/rich-proof.mjs' {
  export function richProof(key:import('node:crypto').KeyObject,binding:unknown):Buffer;
}
declare module '*services/recipe-api/src/credential-shapes.mjs' {
  export function credentialField(value:unknown):string|undefined;
}
