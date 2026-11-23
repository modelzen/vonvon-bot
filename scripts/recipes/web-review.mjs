// A developer-only loopback identity provider so the *real* website can complete
// PKCE against a throwaway PG instance. No external identity or product account.
import { createHash, randomBytes } from 'node:crypto';
import { createRecipeWeb } from '../../services/recipe-web/server.mjs';
export async function startReview({apiOrigin,issuer,jwt,accounts}){
  const port=Number(process.env.RECIPE_REVIEW_PORT||49184);
  const webOrigin='http://127.0.0.1:'+port;
  const web=createRecipeWeb({RECIPE_WEB_PORT:String(port),RECIPE_WEB_ORIGIN:webOrigin,RECIPE_API_ORIGIN:apiOrigin,SUPABASE_URL:new URL(issuer).origin,SUPABASE_PUBLISHABLE_KEY:'local-review-only'});
  const codes=new Map();const roles={github:accounts[0],google:accounts[1],apple:accounts[2]};
  async function auth(req,res){
    const target=new URL(req.url,issuer);
    if(req.method==='GET'&&target.pathname==='/auth/v1/authorize'){
      const p=target.searchParams,provider=p.get('provider'),challenge=p.get('code_challenge');
      if(!Object.hasOwn(roles,provider)||p.get('redirect_to')!==webOrigin+'/auth/callback'||p.get('code_challenge_method')?.toLowerCase()!=='s256'||!challenge)return res.writeHead(400).end();
      const code=randomBytes(24).toString('base64url');codes.set(code,{challenge,who:roles[provider],until:Date.now()+60000});
      res.writeHead(303,{location:webOrigin+'/auth/callback?code='+code,'Cache-Control':'no-store'}).end();return;
    }
    if(req.method==='POST'&&target.pathname==='/auth/v1/token'){
      let txt='';for await(const part of req){txt+=part;if(txt.length>2048)return res.writeHead(413).end()}
      const {auth_code,code_verifier}=JSON.parse(txt);const saved=codes.get(auth_code);codes.delete(auth_code);
      if(!saved||saved.until<Date.now()||typeof code_verifier!=='string'||createHash('sha256').update(code_verifier).digest('base64url')!==saved.challenge)return res.writeHead(401).end();
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({access_token:jwt(saved.who,{exp:Math.floor(Date.now()/1000)+3600}),refresh_token:randomBytes(16).toString('hex'),expires_in:3600}));return;
    }
    res.writeHead(404).end();
  }
  await new Promise((resolve,reject)=>web.once('error',reject).listen(port,'127.0.0.1',resolve));
  return {web,webOrigin,auth};
}
