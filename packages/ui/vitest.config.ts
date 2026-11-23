import {defineConfig} from 'vitest/config';

export default defineConfig({plugins:[{name:'main-sqlite-test-import',enforce:'pre',resolveId(id){return id==='node:sqlite'?{id,external:true}:undefined;}}]});
