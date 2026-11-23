import type {ReactNode} from 'react';
import {Blocks} from 'lucide-react';
import {Button} from '../reference/components/ui';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';

export function groupProviderIcon(backend: string) {
  const path = backend === 'codex-appserver' ? './agent-icons/codex-light.png' : backend === 'claude-agent' ? './agent-icons/claude-code.svg' : undefined;
  return path ? <img src={path} className={backend === 'codex-appserver' ? 'gd-provider-icon--codex' : undefined} alt="" width={16} height={16}/> : <Blocks size={16} aria-hidden="true"/>;
}

export function ExecutionPermissionSummary({id, label, description, footer, action, onAction, children}: {
  id?: string; label: string; description?: string; footer?: ReactNode; action?: string; onAction?: () => void; children?: ReactNode;
}) {
  return <SettingsGroup id={id} label="执行权限" className="permission-summary" footer={footer}>
    <SettingsRow title={label} description={description} trailing={onAction && action &&
      <span data-search-title="修改权限"><Button size="sm" onClick={onAction}>{action}</Button></span>}/>
    {children}
  </SettingsGroup>;
}
