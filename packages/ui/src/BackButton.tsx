import type {ButtonHTMLAttributes} from 'react';
import {ArrowLeft} from 'lucide-react';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {label?: string};

export function BackButton({label = '返回', ...props}: Props) {
  return <div className="today-back"><button {...props} type="button" aria-label={label}><ArrowLeft size={14}/><span>{label.replace(/^返回\s*/, '') || '返回'}</span></button></div>;
}
