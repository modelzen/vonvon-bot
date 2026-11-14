declare module '*services/recipe-api/src/rich-document.mjs' {
  type Content=import('@vonvon/protocol').RecipeRichContent;
  type Change=import('@vonvon/protocol').RecipeRichDraftChange;
  type Part=import('@vonvon/protocol').RecipeRichPartDescriptor;
  export function applyChanges(content:Content,changes:Change[],resolve:(source:{sourceIntentId:string;candidateId:string})=>{content:Content;itemId:string},
    seed:Uint8Array,parts?:Part[]):{doc:{content:Content}};
  export function richWireBytes(value:unknown):Buffer;
  export function freezeSnapshot(input:unknown,seed:Uint8Array):{content:Content};
}
declare module '*services/recipe-api/src/rich-proof.mjs' {
  export function richProof(key:import('node:crypto').KeyObject,binding:unknown):Buffer;
}
declare module '*services/recipe-api/src/credential-shapes.mjs' {
  export function credentialField(value:unknown):string|undefined;
}
