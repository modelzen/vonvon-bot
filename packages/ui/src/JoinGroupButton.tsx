import {GlowButton} from './GlowButton';

type Props = {disabled?: boolean; onClick: () => void};

export function JoinGroupButton(props: Props) {
  return <GlowButton {...props} size="md">拉 Bot 入群</GlowButton>;
}
