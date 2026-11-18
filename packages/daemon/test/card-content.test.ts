import { describe, expect, it } from 'vitest';
import { extractRawCardText, extractSendCardText, isDegradedCardContent, isSendCard, isStreamingCard, parseRawCardWrapper } from '../src/bot/card-content';

// Synthetic Base automation card using the raw_card_content json_card shape.
const RAW_BASE_CARD = {
  body: {
    id: '_1',
    property: {
      elements: [
        {
          id: '_2',
          property: {
            elements: [
              { id: '_2_0', property: { userID: 'ou_example_user' }, tag: 'at' },
              { id: '_2_1', property: { content: ' 请处理这条记录 ', textAlign: 'left' }, tag: 'plain_text' },
              {
                id: '_2_2',
                property: {
                  content: '查看示例记录',
                  url: { url: 'https://base.example.test/base/ExampleBase?table=tblExampleTable&record=recExampleRecord' },
                },
                tag: 'link',
              },
            ],
            originTag: 'markdown',
          },
          tag: 'markdown',
        },
        {
          id: '_3',
          property: {
            columns: [
              {
                id: '_4',
                property: {
                  elements: [
                    {
                      id: '_5',
                      property: {
                        actions: [{ action: { url: 'https://base.example.test/base/ExampleBase?ccm_open_type=im_card_automation_button' }, type: 'open_url' }],
                        text: {
                          id: '_6',
                          property: { elements: [{ id: '_6_0', property: { content: '查看详情' }, tag: 'plain_text' }] },
                          tag: 'markdown',
                        },
                      },
                      tag: 'button',
                    },
                  ],
                },
                tag: 'column',
              },
            ],
          },
          tag: 'column_set',
        },
        { id: '_7', property: {}, tag: 'hr' },
        {
          id: '_8',
          property: {
            elements: [],
            i18nElements: {
              en_us: [
                { id: '_8_en_us_0', property: { content: 'From ' }, tag: 'plain_text' },
                { id: '_8_en_us_1', property: { content: 'Untitled base', url: { url: 'https://base.example.test/base/ExampleBase?ccm_open_type=im_card_automation_link' } }, tag: 'link' },
              ],
              zh_cn: [
                { id: '_8_zh_cn_0', property: { content: '来自 ' }, tag: 'plain_text' },
                { id: '_8_zh_cn_1', property: { content: '未命名多维表格', url: { url: 'https://base.example.test/base/ExampleBase?ccm_open_type=im_card_automation_link' } }, tag: 'link' },
              ],
            },
          },
          tag: 'markdown',
        },
      ],
    },
    tag: 'body',
  },
  header: {
    property: { title: { property: { content: '请关注记录' }, tag: 'plain_text' } },
    tag: 'card_header',
  },
  schema: '2.0',
};

describe('isDegradedCardContent', () => {
  it('flags the SDK fallback and the client-upgrade placeholder', () => {
    expect(isDegradedCardContent('[interactive card]')).toBe(true);
    expect(isDegradedCardContent('  ')).toBe(true);
    expect(isDegradedCardContent('请升级至最新版本客户端，以查看内容')).toBe(true);
  });
  it('leaves real content alone', () => {
    expect(isDegradedCardContent('请处理这条记录')).toBe(false);
  });
});

describe('parseRawCardWrapper', () => {
  it('unwraps the json_card envelope', () => {
    const body = JSON.stringify({ json_card: JSON.stringify({ schema: '2.0' }), json_attachment: {} });
    expect(parseRawCardWrapper(body)).toEqual({ schema: '2.0' });
  });
  it('returns the parsed body when not wrapped, undefined on garbage', () => {
    expect(parseRawCardWrapper('{"a":1}')).toEqual({ a: 1 });
    expect(parseRawCardWrapper('not json')).toBeUndefined();
  });
});

describe('extractRawCardText', () => {
  const text = extractRawCardText(RAW_BASE_CARD);

  it('leads with the card title', () => {
    expect(text.split('\n')[0]).toBe('请关注记录');
  });

  it('keeps the body text and the Base record link', () => {
    expect(text).toContain('请处理这条记录');
    expect(text).toContain('[查看示例记录](https://base.example.test/base/ExampleBase?table=tblExampleTable&record=recExampleRecord)');
  });

  it('keeps the button label and the footer source link', () => {
    expect(text).toContain('查看详情');
    expect(text).toContain('[未命名多维表格](https://base.example.test/base/ExampleBase?ccm_open_type=im_card_automation_link)');
  });

  it('renders the footer in one locale only (no ×5 i18n duplication)', () => {
    expect(text).toContain('来自');
    expect(text).not.toContain('From ');
    expect(text).not.toContain('Untitled base');
  });

  it('drops the @ placeholder and empties (no bare open_id, no blank lines)', () => {
    expect(text).not.toContain('ou_example_user');
    expect(text.split('\n').every((l) => l.trim().length > 0)).toBe(true);
  });

  it('yields nothing for an empty / unparseable card', () => {
    expect(extractRawCardText({})).toBe('');
    expect(extractRawCardText(null)).toBe('');
  });
});

// The send-format JSON a pull returns with card_msg_content_type=user_card_content (e10).
describe('extractSendCardText', () => {
  it('reads a 2.0 card: header title, then the body', () => {
    const card = {
      schema: '2.0',
      config: { streaming_mode: false },
      header: { title: { tag: 'plain_text', content: '排查结论' } },
      body: { elements: [
        { tag: 'markdown', content: '网关的 500 都来自 **OrderService**' },
        { tag: 'column_set', columns: [{ tag: 'column', elements: [{ tag: 'markdown', content: '下一步：回滚 v3' }] }] },
      ] },
    };
    expect(extractSendCardText(card)).toBe('排查结论\n网关的 500 都来自 **OrderService**\n下一步：回滚 v3');
  });

  it('reads a 1.0 card: div lark_md, fields and markdown', () => {
    const card = {
      header: { title: { tag: 'plain_text', content: '部署清单' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '环境：生产' }, fields: [{ is_short: true, text: { tag: 'lark_md', content: '负责人：张三' } }] },
        { tag: 'markdown', content: '低峰期执行' },
        { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '确认' } }] },
      ],
    };
    expect(extractSendCardText(card)).toBe('部署清单\n环境：生产\n负责人：张三\n低峰期执行');
  });

  it('keeps only the answer: no process panel, status lines, notes, images or buttons', () => {
    const card = { schema: '2.0', body: { elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '上下文 43% · 86k/200k', text_size: 'notation' } },
      { tag: 'collapsible_panel', header: { title: { content: '执行了 3 条命令' } }, elements: [{ tag: 'markdown', content: '$ rm -rf build' }] },
      { tag: 'img', img_key: 'img_x' },
      { tag: 'markdown', content: '改好了，测试都过了' },
      { tag: 'markdown', content: '耗时 12 秒', text_size: 'notation' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '来自小P' }] },
      { tag: 'button', text: { tag: 'plain_text', content: '⏹ 停止' } },
    ] } };
    expect(extractSendCardText(card)).toBe('改好了，测试都过了');
  });

  it('keeps only the answer of a Vonvon run card as user_card_content returns it (no sizes or colours)', () => {
    const card = { schema: '2.0', config: { streaming_mode: false, summary: { content: '已完成' } }, body: { elements: [
      { element_id: '_3', tag: 'div', text: { content: '上下文 15% · 61k/400k', tag: 'lark_md' }, width: 'fill' },
      { content: "<font color='grey'>用时 5秒</font>", element_id: '_2', tag: 'markdown' },
      { content: '这里是第一行示例回答。\n1. 这里是第二行示例回答。\n', element_id: '_1', tag: 'markdown' },
    ] } };
    expect(extractSendCardText(card)).toBe('这里是第一行示例回答。\n1. 这里是第二行示例回答。');
    const meters = ['🟡 上下文 72% · 288k/400k', '上下文 已用 12k', '上下文 —'];
    for (const content of meters) {
      expect(extractSendCardText({ body: { elements: [{ tag: 'div', text: { tag: 'lark_md', content } }, { tag: 'markdown', content: '好' }] } })).toBe('好');
    }
    // Colour inside the answer keeps its text; a grey line that is only part of a text stays.
    expect(extractSendCardText({ body: { elements: [
      { tag: 'markdown', content: "<font color='red'>注意</font>：别删 build" },
      { tag: 'markdown', content: "结论 <font color='grey'>（草稿）</font>" },
      { tag: 'markdown', content: '上下文 15% 是我估的' },
    ] } })).toBe('注意：别删 build\n结论 （草稿）\n上下文 15% 是我估的');
    // Only Vonvon's own grey status lines go; another bot's grey answer or caveat stays.
    const grey = (t: string) => ({ tag: 'markdown', content: `<font color='grey'>${t}</font>` });
    expect(extractSendCardText({ body: { elements: ['❌ 用时 1分钟 · 失败', '已处理 3秒', '执行过程 · 已停止', '🗜️ 已压缩 85% → 20%', '正在输出', '🤖 由 Vonvon Bot 于 10-15 17:36 生成'].map(grey) } })).toBe('');
    expect(extractSendCardText({ body: { elements: [grey('⚠️ 无法回答'), grey('注：以上为估算')] } })).toBe('⚠️ 无法回答\n注：以上为估算');
  });

  it('de-duplicates lines and reads one locale of an i18n card', () => {
    expect(extractSendCardText({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: '同一句' }, { tag: 'markdown', content: '同一句' }] } })).toBe('同一句');
    expect(extractSendCardText({ i18n_elements: { en_us: [{ tag: 'markdown', content: 'hello' }], zh_cn: [{ tag: 'markdown', content: '你好' }] } })).toBe('你好');
  });

  it('reads i18n_content where a title or a text has no content', () => {
    expect(extractSendCardText({ schema: '2.0',
      header: { title: { tag: 'plain_text', i18n_content: { en_us: 'Title', zh_cn: '标题' } } },
      body: { elements: [
        { tag: 'markdown', i18n_content: { en_us: 'Body', zh_cn: '正文' } },
        { tag: 'div', text: { tag: 'plain_text', i18n_content: { zh_cn: '一行' } } },
      ] } })).toBe('标题\n正文\n一行');
  });

  it('yields nothing for an empty or unreadable card', () => {
    expect(extractSendCardText({ schema: '2.0', body: { elements: [{ tag: 'img' }] } })).toBe('');
    expect(extractSendCardText(null)).toBe('');
  });

  it('tells the send format from the down-converted shape, and reads the streaming flag', () => {
    expect(isSendCard({ schema: '2.0', body: {} })).toBe(true);
    expect(isSendCard({ elements: [{ tag: 'markdown', content: 'x' }] })).toBe(true);
    expect(isSendCard({ title: 'T', elements: [[{ tag: 'text', text: 'x' }]] })).toBe(false);
    expect(isStreamingCard(JSON.stringify({ config: { streaming_mode: true } }))).toBe(true);
    expect(isStreamingCard(JSON.stringify({ config: { streaming_mode: false } }))).toBe(false);
    expect(isStreamingCard('not json')).toBe(false);
  });
});

it('omits handoff status notes but keeps other grey prose (s27b)', () => {
  const card = { body: { elements: [
    { tag: 'markdown', content: "<font color='grey'>→ 想 @ 小审（bot），没发出：发送失败</font>" },
    { tag: 'markdown', content: "<font color='grey'>→ 还想 @ 成员，没发：一条最多 @ 5 个</font>" },
    { tag: 'markdown', content: "<font color='grey'>→ 还想说</font>" },
    { tag: 'markdown', content: "<font color='grey'>→ 想想别的</font>" },
  ] } };
  const text = extractSendCardText(card);
  expect(text).not.toContain('→ 想 @');
  expect(text).not.toContain('→ 还想 @');
  expect(text).toContain('→ 还想说');
  expect(text).toContain('→ 想想别的');
});
