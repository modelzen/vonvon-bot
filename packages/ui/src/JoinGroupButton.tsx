import {GlowButton} from './GlowButton';

type Props = {disabled?: boolean; onClick: () => void};

export function JoinGroupButton(props: Props) {
  return <GlowButton {...props}>拉 Bot 入群</GlowButton>;
}
