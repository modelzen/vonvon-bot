"""Run against check.mjs --review ONLY: synthetic roles, real pages, API and SQL."""
import os, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
port = int(os.environ.get('RECIPE_REVIEW_PORT','49184'))
base = f'http://127.0.0.1:{port}'
name='每周复盘 '+str(time.time_ns())[-8:]
with sync_playwright() as pw:
    options={'headless': True}
    if os.environ.get('CHROMIUM_BIN'): options['executable_path']=os.environ['CHROMIUM_BIN']
    browser=pw.chromium.launch(**options)
    errors=[]
    def open_page():
        c=browser.new_context(locale='zh-CN', viewport={'width':920,'height':820});p=c.new_page()
        p.on('pageerror',lambda err:errors.append(str(err)));p.set_default_timeout(6500)
        return p
    a=open_page();a.goto(base+'/studio');a.get_by_text('登录后继续').click()
    a.get_by_role('button',name='使用 GitHub 登录').click()
    a.get_by_role('button',name='新建文字草稿').click()
    for f,val in {'name':name,'summary':'汇总本周的决定','overview':'## 这份配方适合谁','version':'1.0','role':'只整理群里明确作出的决定'}.items():
        a.locator('[name='+f+']').fill(val)
    a.locator('[name=access]').select_option('coded')
    writes=[]
    a.on('request',lambda req: writes.append(req.url) if req.url.endswith('/api/v1/drafts') and req.method=='POST' else None)
    a.locator('[name=overview]').fill('-----BEGIN PRIVATE KEY-----')
    a.get_by_role('button',name='保存草稿').click();expect(a.get_by_role('status')).to_contain_text('移除')
    assert not writes,'suspected credential was sent'
    a.locator('[name=overview]').fill('## 这份配方适合谁')
    a.get_by_role('button',name='保存草稿').click()
    expect(a.get_by_role('status')).to_contain_text('私人草稿已保存')
    a.get_by_role('button',name='预览发布').click();expect(a.get_by_role('dialog')).to_contain_text(name)
    a.get_by_role('button',name='返回编辑').click();expect(a.locator('#result')).to_be_hidden()
    a.get_by_role('button',name='预览发布').click();a.get_by_role('button',name='确认发布').click()
    expect(a.locator('#result')).to_be_visible()
    detail=a.locator('#published').get_attribute('href')
    code=a.locator('#initial-code').inner_text().split('：',1)[1]
    r=open_page();r.goto(base+detail);expect(r.get_by_role('heading',name=name)).to_be_visible()
    expect(r.locator('[data-tab=settings]')).to_have_count(0)
    r.get_by_role('button',name='获取配方').click();r.get_by_role('button',name='使用 Google 登录').click()
    expect(r.get_by_role('heading',name=name)).to_be_visible();r.get_by_role('button',name='获取配方').click()
    r.get_by_role('textbox',name='分享码').fill(code);r.get_by_role('dialog').get_by_role('button',name='获取配方').click()
    r.get_by_role('button',name='配置').click();expect(r.get_by_text('只整理群里明确作出的决定')).to_be_visible()
    r.get_by_role('link',name='已获取',exact=True).click();expect(r.get_by_text(name,exact=True)).to_be_visible()
    a.reload();listing=a.locator('#history li').filter(has_text=name).first
    listing.get_by_role('button',name='分享码').click();expect(a.locator('#code-list')).to_contain_text('已兑换')
    a.locator('#amount').fill('2');a.get_by_role('button',name='生成分享码').click()
    expect(a.locator('#code-list li')).to_have_count(3)
    a.on('dialog',lambda dialog:dialog.accept())
    a.locator('#code-list li').filter(has_text='可用').first.get_by_role('button',name='停用').click()
    expect(a.locator('#code-list')).to_contain_text('已停用')
    if os.environ.get('RECIPE_EVIDENCE'):
        out=Path(os.environ['RECIPE_EVIDENCE']);out.mkdir(parents=True,exist_ok=True)
        r.screenshot(path=str(out/'recipe-library.png'))
    assert not errors,errors
    print('PASS: browser author login → edit → cancel/confirm publish → reader login returns to exact version → redeem → config/library → author sees redemption and disables a fresh code.')
    browser.close()
