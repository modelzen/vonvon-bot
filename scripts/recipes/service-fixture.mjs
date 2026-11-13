// Locate the actual port emitted by the service instead of racing to reserve a TCP port.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
export async function startLocalRecipeApi(root,env){
  const {startRecipeService}=await import(pathToFileURL(join(root,'services/recipe-api/src/main.mjs')));
  const running=await startRecipeService(env);
  return {origin:'http://127.0.0.1:'+running.server.address().port,close:()=>running.close()};
}
