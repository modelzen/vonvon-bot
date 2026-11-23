import {Popover} from '@base-ui/react/popover';
import {Info} from 'lucide-react';
import {isSetupSkillName} from '@vonvon/protocol';
import './setup-skill.css';

export const setupSkillPurpose = '根据配方的需要，帮助你准备文件、工具、MCP、CLI 等依赖，检查环境，完成安装、部署、配置和首次启动。';

export function SetupSkillBadge({name, showInfo = true}: {name: string; showInfo?: boolean}) {
  if (!isSetupSkillName(name)) return null;
  return <span className="setup-skill-badge"><span>Setup</span>{showInfo && <SetupSkillInfo name={name}/>}</span>;
}

export function SetupSkillInfo({name}: {name: string}) {
  if (!isSetupSkillName(name)) return null;
  return <Popover.Root>
    <Popover.Trigger className="setup-skill-info" aria-label={`了解 ${name} 的 Setup 用途`}><Info size={14} aria-hidden="true"/></Popover.Trigger>
    <Popover.Portal><Popover.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={12} className="setup-skill-positioner">
      <Popover.Popup className="setup-skill-popup">
        <Popover.Title>Setup · 初始化配置</Popover.Title>
        <Popover.Description>{setupSkillPurpose}</Popover.Description>
        <p>将配方用于群聊后，可在该群运行这个技能，按提示补充信息并核对结果，再开始使用。</p>
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}
