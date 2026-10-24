import {useEffect, useState} from 'react';
import {ThinkingOrb, type OrbState} from 'thinking-orbs';
import './operation-activity.css';

/** Only mount while the operation's request is pending. */
export function OperationActivity({label, state = 'working'}: {label: string; state?: OrbState}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 2000);
    return () => clearTimeout(timer);
  }, []);
  return <span className="operation-activity" role="status">
    <span className="operation-activity__orb">{visible && <ThinkingOrb state={state} size={20} theme="light" aria-hidden="true" />}</span>
    <span>{label}</span>
  </span>;
}
