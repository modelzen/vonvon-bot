import {pathToFileURL} from 'node:url';
import {makePool} from './database.mjs';
import {uuid} from './input.mjs';
export async function moderate(url,action,version,editor) {
  if(!['ban','feature','unfeature'].includes(action))throw Error('unknown_action');
  uuid(version);if(action==='feature')uuid(editor);
  const pool=makePool(url);
  try {
    const c=await pool.connect();
    try {
      const r=await c.query("select pg_has_role(session_user,'recipe_editor','member') and not exists(select from pg_roles where pg_has_role(session_user,oid,'member') and (rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication or rolname not in(session_user,'recipe_editor'))) and not (select pg_has_role(session_user,datdba,'member') from pg_database where datname=current_database()) as ok");
      if(!r.rows[0].ok)throw Error('dedicated_editor_login_required');
      await c.query('begin');await c.query('set local role recipe_editor');
      await c.query('select recipe_api.rich_moderate($1,$2,$3)',[action,version,editor??null]);await c.query('commit');
    }finally{c.release(true);}
  }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [action,version,editor]=process.argv.slice(2);
  try{await moderate(process.env.RECIPE_EDITOR_DATABASE_URL,action,version,editor);console.log('Operation completed');}
  catch{console.error('Recipe editorial operation refused');process.exitCode=1;}
}
