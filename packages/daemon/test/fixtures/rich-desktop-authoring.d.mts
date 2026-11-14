import type {DesktopAuthoringRequest,DesktopAuthoringReply,AuthoringSaved,RecipeAuthoringRequest,RecipeAuthoringReply} from '@vonvon/protocol';
export function mainController(options:{accountId:string;botId:string;groupId:string;daemon:(req:RecipeAuthoringRequest)=>Promise<RecipeAuthoringReply>;
  api?:string;broker?:string;bearer?:string}):{
  controller:{request(req:DesktopAuthoringRequest):Promise<DesktopAuthoringReply>;closeAll():void};
  saved:AuthoringSaved[];generation:AbortController;
};
