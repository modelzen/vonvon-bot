import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {canonicalizeRichRecipeContent, recipeDetailSchema, type RecipeDetail} from '@vonvon/protocol';
import {RecipeCard, RecipeDetails, RecipeConfiguration, RecipeMarkdown, recipeSections} from '../src/community/RecipeContent';
import {RichChangeList, RichConfiguration} from '../src/community/RichConfiguration';
import {uniqueRecipes} from '../src/community/CommunityPage';
import {AppShell} from '../src/LocalShell';

const recipe: RecipeDetail = {recipeId: '11111111-1111-4111-8111-111111111111', versionId: '22222222-2222-4222-8222-222222222222', revision: 1,
  public: {name: '排错助手', summary: '解释用法与排查问题', overview: '# 使用方法\n只处理你选择的问题。', version: '1.0', access: 'direct'},
  owned: false, acquired: false, config: {role: '私有角色哨兵', setup: {steps: [{kind: 'config', title: '检查配置', instructions: '打开设置核对。', required: true}]}}};

it('places community second and keeps Bot and group navigation, including before the first Bot', () => {
  for (const firstUse of [false, true]) {
    const html = renderToStaticMarkup(<AppShell page="community" view="agents" title="社区" firstUse={firstUse} onNavigate={() => {}} onOpenList={() => {}}><p/></AppShell>);
    const nav = html.slice(html.indexOf('aria-label="主要导航"'), html.indexOf('</nav>'));
    expect(nav.indexOf('>此刻<')).toBeLessThan(nav.indexOf('>社区<'));
    expect(nav.indexOf('>社区<')).toBeLessThan(nav.indexOf('>Bot'));
    expect(nav.indexOf('>Bot')).toBeLessThan(nav.indexOf('>群组'));
    expect(html).not.toContain('aria-label="设置" title="设置" aria-current');
  }
});
it('keeps public details as a reading surface and exposes the full configuration navigation for direct versions', () => {
  const html = renderToStaticMarkup(<RecipeDetails recipe={recipe}/>);
  for (const label of ['概览', '模型与权限', '能力', '沟通方式', '任务', '第 1 次发布']) expect(html).toContain(label);
  expect(html).not.toContain('使用前准备');
  expect(html).not.toContain('记忆');
  expect(html.match(/<nav aria-label="配方详细信息">([\s\S]*?)<\/nav>/)?.[1].match(/<button /g)).toHaveLength(5);
  for (const label of ['管理发布', '准备新版', '分享码管理', '编辑草稿']) expect(html).not.toContain(label);
  expect(html).toContain('<h2>使用方法</h2>');
});
it('shows only the introduction for an unacquired gated version and the server contract rejects an accidental private config', () => {
  const gated = {...recipe, public: {...recipe.public, access: 'coded' as const}, config: undefined};
  const html = renderToStaticMarkup(<RecipeDetails recipe={gated}/>);
  expect(html).toContain('获取此版本后');
  for (const label of ['私有角色哨兵', '模型与权限', '能力', '使用前准备']) expect(html).not.toContain(label);
  expect(recipeDetailSchema.safeParse({...gated, config: recipe.config}).success).toBe(false);
});
it.each(['public', 'acquired', 'library', 'owned'] as const)('does not expose historical recipe memory in %s detail', context => {
  const content = JSON.parse(readFileSync(new URL('../../protocol/test/fixtures/recipe-rich-v2.content.json', import.meta.url), 'utf8'));
  content.parts = []; delete content.finalLogo;
  content.memories = content.memories.map((memory: {itemId: string; originId: string}) => ({...memory, text: {kind: 'inline', value: 'HISTORICAL_RECIPE_MEMORY_SENTINEL'}}));
  const doc = canonicalizeRichRecipeContent(content);
  const rich = {content: doc.content, texts: {}, canonical: Buffer.from(doc.canonicalUTF8).toString('base64url')};
  const historical = recipeDetailSchema.parse({...recipe, format: 'rich-v2', config: undefined, rich, owned: context === 'owned', acquired: context === 'acquired' || context === 'library'});
  for (const section of recipeSections) {
    const html = renderToStaticMarkup(<RecipeDetails recipe={historical} section={section}/>);
    expect(html).not.toContain('HISTORICAL_RECIPE_MEMORY_SENTINEL');
    expect(html).not.toContain('记忆');
    expect(html.match(/<nav aria-label="配方详细信息">([\s\S]*?)<\/nav>/)?.[1].match(/<button /g)).toHaveLength(5);
  }
  expect(renderToStaticMarkup(<RichConfiguration view={rich} section="记忆"/>)).toBe('');
});
it('describes the legacy cleanup operation without exposing legacy memory content', () => {
  expect(renderToStaticMarkup(<RichChangeList changes={[{op: 'removeLegacyMemories'}]}/>)).toContain('记忆不会包含在配方中。');
});
it('uses factual metadata without invented artwork, counts, categories, free badges or authors', () => {
  const html = renderToStaticMarkup(<RecipeCard recipe={recipe} hero onOpen={() => {}}/>);
  expect(html).toContain('最新配方'); expect(html).toContain('排错助手'); expect(html).toContain('解释用法与排查问题');
  for (const invented of ['精选', '免费', '人使用', '热门', '<img', '作者']) expect(html).not.toContain(invented);
});
it('does not ask an acquired-library visitor for another code', () => {
  const coded={...recipe,public:{...recipe.public,access:'coded' as const}};
  expect(renderToStaticMarkup(<RecipeCard recipe={coded} onOpen={()=>{}}/>)).toContain('需分享码');
  expect(renderToStaticMarkup(<RecipeCard recipe={coded} context="library" onOpen={()=>{}}/>)).not.toContain('需分享码');
});
it('shows missing config honestly and keeps imported setup as readable text without executing HTML', () => {
  const model = renderToStaticMarkup(<RecipeConfiguration config={recipe.config!} section="模型与权限"/>);
  expect(model.match(/未指定/g)).toHaveLength(2);
  const legacy = {...recipe,config:{...recipe.config!,setup:{steps:[{...recipe.config!.setup!.steps[0]!,check:'确认设置已保存'}]}}};
  const setup = renderToStaticMarkup(<RecipeDetails recipe={legacy}/>);
  expect(setup).toContain('<summary>补充说明</summary>');
  expect(setup).toContain('检查配置'); expect(setup).toContain('打开设置核对。'); expect(setup).toContain('确认设置已保存');
  expect(setup).not.toContain('使用前准备'); expect(setup).not.toContain('必需');
  const html = renderToStaticMarkup(<RecipeMarkdown text={'<script>danger()</script>\n**强调**\n```sh\nrm -rf example\n```'}/>);
  expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;'); expect(html).toContain('<strong>强调</strong>'); expect(html).toContain('<pre><code>rm -rf example</code></pre>');
});
it('appends paginated results without duplicate versions or changing the loaded order', () => {
  const other = {...recipe, versionId: '33333333-3333-4333-8333-333333333333'};
  expect(uniqueRecipes([recipe], [recipe, other, other])).toEqual([recipe, other]);
});
it('renders the launch recipe feedback and troubleshooting links as real safe links', () => {
  const help=JSON.parse(readFileSync(new URL('../../../content/recipes/vonvon-help/recipe.json',import.meta.url),'utf8'));
  const html=renderToStaticMarkup(<RecipeMarkdown text={help.public.overview}/>);
  expect(html).toContain('<a href="https://my.feishu.cn/share/base/ExampleReference6" target="_blank" rel="noopener noreferrer">官方问题反馈表单</a>');
  expect(html).toContain('<a href="https://vonvon.cc/docs/troubleshooting/" target="_blank" rel="noopener noreferrer">官方排错指南</a>');
  expect(html).not.toContain('[官方问题反馈表单]');
});
it('keeps unsafe Markdown destinations and links inside code as literal text', () => {
  const unsafe=['javascript:alert(1)','data:text/html;base64,PHNjcmlwdD4=','file:///tmp/private','//example.com/path','https://user:pass@example.com/path'];
  const text=unsafe.map(url=>`[链接](${url})`).join('\n')+'\n`[代码](https://example.com)`\n```md\n[围栏](https://example.com)\n```';
  const html=renderToStaticMarkup(<RecipeMarkdown text={text}/>);
  expect(html).not.toContain('<a ');
  for(const url of unsafe)expect(html).toContain(url);
  expect(html).toContain('<code>[代码](https://example.com)</code>');
});
