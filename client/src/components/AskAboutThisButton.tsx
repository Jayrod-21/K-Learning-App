/**
 * AskAboutThisButton — "Ask about this" → seed Chat with a reviewed item
 * (F-020).
 *
 * A small ghost button every review surface (Mistakes log, TOPIK mock
 * reveal, TOPIK study reveal, Diagnostic reveal) drops under its reveal
 * content. Clicking it builds the seed message from the item fields
 * (`buildAskSeed`) and navigates to Chat with the seed in router state —
 * Chat pre-fills its composer with it (`ChatSeedState`); nothing is
 * auto-sent, the user reviews and hits Send.
 *
 * The conversation mode is pinned to `topik_prep`: every surface wired to
 * this button is a TOPIK review context, so a lazily-started conversation
 * should open in the TOPIK-prep persona rather than the casual default.
 */
import { type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from './Button';
import { Icon } from './Icon';
import {
  buildAskSeed,
  type AskSeedInput,
  type ChatSeedState,
} from '../lib/askSeed';

/**
 * The Chat route (`App.tsx`). Kept as the raw path rather than a nav-manifest
 * lookup: the ROUTE is the stable contract here — F-016 may rename Chat's
 * nav entry, but renaming the route would break every deep link anyway.
 */
const CHAT_PATH = '/chat';

export interface AskAboutThisButtonProps extends AskSeedInput {
  className?: string;
}

export function AskAboutThisButton({
  className,
  ...seed
}: AskAboutThisButtonProps): JSX.Element {
  const navigate = useNavigate();

  const handleClick = (): void => {
    const state: ChatSeedState = {
      seedText: buildAskSeed(seed),
      mode: 'topik_prep',
    };
    navigate(CHAT_PATH, { state });
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      className={className}
      onClick={handleClick}
      leadingIcon={<Icon name="chat" size={14} />}
    >
      Ask about this
    </Button>
  );
}
