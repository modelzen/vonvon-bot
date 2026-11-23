import {describe, expect, it, vi} from 'vitest';
import {recipePreviewNavigationSchema} from '@vonvon/protocol';
import {captureRecipePreviewLaunches, RecipePreviewNavigation} from '../src/recipe-preview-navigation.js';

const recipeId='11111111-1111-4111-8111-111111111111';
const versionId='22222222-2222-4222-8222-222222222222';

describe('published recipe handoff navigation',()=>{
  it.each(['vonvon','vonvon-preview'] as const)('retains exact-version selection and confirmation navigation for %s',scheme=>{
    const navigation=new RecipePreviewNavigation(scheme),listener=vi.fn();
    navigation.onOpen(listener);
    const link=`${scheme}://recipes/${recipeId}/versions/${versionId}/handoff`;
    expect(navigation.open(link)).toBe(true);
    const first=navigation.pending()[0];
    expect(first).toEqual({kind:'handoff',recipeId,versionId,navigationId:expect.any(String)});
    expect(recipePreviewNavigationSchema.parse(first)).toEqual(first);
    expect(navigation.open(link)).toBe(true);
    expect(navigation.pending()).toEqual([first]);
    expect(listener).toHaveBeenCalledTimes(2);
    navigation.acknowledge(first.navigationId);
    expect(navigation.pending()).toEqual([]);
    navigation.open(link);
    expect(navigation.pending()[0].navigationId).not.toBe(first.navigationId);
  });

  it('rejects altered targets, other channels and implicit actions',()=>{
    const navigation=new RecipePreviewNavigation('vonvon-preview');
    const link=`vonvon-preview://recipes/${recipeId}/versions/${versionId}/handoff`;
    for(const invalid of [link.replace('vonvon-preview:','vonvon:'),link+'/',link+'?',link+'?confirm=true',link+'#',link+'#send',link+'\n',' '+link,
      link.replace('recipes/','user@recipes/'),link.replace('recipes/','recipes:42/'),link.replace(versionId,'latest'),
      link.replace(recipeId,'%31'+recipeId.slice(1)),link.replace('versions/','versions/../versions/'),link.replace('/handoff','/install')])expect(navigation.open(invalid),invalid).toBe(false);
    expect(navigation.pending()).toEqual([]);
    expect(recipePreviewNavigationSchema.safeParse({kind:'handoff',recipeId,versionId,navigationId:recipeId,confirm:true}).success).toBe(false);
  });

  it('captures cold and warm handoff launches without consuming the renderer confirmation',()=>{
    const navigation=new RecipePreviewNavigation('vonvon-preview'),reveal=vi.fn();
    const link=`vonvon-preview://recipes/${recipeId}/versions/${versionId}/handoff`;
    let warm:(argv:string[])=>void=()=>{};
    captureRecipePreviewLaunches(navigation,{argv:['app',link],onOpenUrl:()=>{},onSecondInstance:callback=>{warm=callback;},reveal});
    warm(['app',link]);
    expect(navigation.pending()).toHaveLength(1);
    expect(reveal).toHaveBeenCalledTimes(2);
  });

  it('opens the local draft list as an inert navigation with no creation or upload parameters',()=>{
    const navigation=new RecipePreviewNavigation('vonvon-preview');
    const link='vonvon-preview://recipes/drafts';
    expect(navigation.open(link)).toBe(true);
    const first=navigation.pending()[0];
    expect(first).toEqual({kind:'drafts',navigationId:expect.any(String)});
    expect(navigation.open(link)).toBe(true);
    expect(navigation.pending()).toEqual([first]);
    for(const invalid of [link+'/',link+'?upload=true',link+'#',link+'\n',link.replace('vonvon-preview:','vonvon:')])expect(navigation.open(invalid)).toBe(false);
  });
});
