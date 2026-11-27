import {
  WELCOME_CARD_INTRO_MAX,
  WELCOME_CARD_TITLE_MAX,
  type AgentSettingsView,
  type SettingsReply,
} from '@vonvon/protocol';
import {Editor} from './SettingsPanel';

type WelcomeCopy = {title: string; intro: string};
type WelcomeSection = NonNullable<AgentSettingsView['sections']['welcome']>;

export function WelcomeCardSettings({section, save}: {
  section: WelcomeSection;
  save: (patch: Partial<WelcomeCopy>, revision: string) => Promise<SettingsReply>;
}) {
  const titleId = 'welcome-card-title';
  const introId = 'welcome-card-intro';
  return <Editor
    title="入群欢迎卡"
    section={section}
    save={save}
    fieldLabels={{title: '卡片标题', intro: '开场文案'}}
    render={(draft, set, disabled) => <div className="welcome-card-copy">
      <label className="welcome-card-copy__field" htmlFor={titleId}>
        <span>卡片标题</span>
        <input
          id={titleId}
          className="settings-field"
          value={draft.title ?? section.stored.title}
          maxLength={WELCOME_CARD_TITLE_MAX}
          placeholder={section.effective.title}
          disabled={disabled}
          autoComplete="off"
          aria-describedby={`${titleId}-help`}
          onChange={event => set({...draft, title: event.target.value})}
        />
        <small id={`${titleId}-help`}>留空时使用默认标题。最多 {WELCOME_CARD_TITLE_MAX} 字。</small>
      </label>
      <label className="welcome-card-copy__field" htmlFor={introId}>
        <span>开场文案</span>
        <textarea
          id={introId}
          className="settings-field"
          value={draft.intro ?? section.stored.intro}
          maxLength={WELCOME_CARD_INTRO_MAX}
          placeholder={section.effective.intro}
          disabled={disabled}
          spellCheck={false}
          aria-describedby={`${introId}-help`}
          onChange={event => set({...draft, intro: event.target.value})}
        />
        <small id={`${introId}-help`}>支持 Markdown 和换行。留空时使用默认开场文案。最多 {WELCOME_CARD_INTRO_MAX} 字。</small>
      </label>
    </div>}
  />;
}
