// The key handlers, in the order a key is offered to them. Each owns a mode
// (or one group of the list's keys) and answers true when it has taken the
// key; the list's own handler is the last link, with nothing left to guard.
import type { Key } from "ink";
import type { KeyContext } from "./context.ts";
import { handleAgentKeys } from "./agent.ts";
import { handleBranchKeys } from "./branch.ts";
import { handleCloneKeys, handleCloningKeys } from "./clone.ts";
import { handleIdentityKeys } from "./identity.ts";
import { handleInitKeys } from "./init.ts";
import { handleListKeys } from "./list.ts";
import { handleOpenKeys } from "./open.ts";
import { handleProfileKeys } from "./profile.ts";
import { handleProviderKeys } from "./provider.ts";
import { handleQuitKeys } from "./quit.ts";
import { handleRepoKeys } from "./repo.ts";
import { handleWtchoiceKeys } from "./wtchoice.ts";
import { handleSearchKeys } from "./search.ts";
import { handleSettingsKeys } from "./settings.ts";

export type KeyHandler = (input: string, key: Key, ctx: KeyContext) => boolean;

export const KEY_HANDLERS: readonly KeyHandler[] = [
  handleOpenKeys,
  handleSearchKeys,
  handleQuitKeys,
  handleAgentKeys,
  handleRepoKeys,
  handleCloneKeys,
  handleCloningKeys,
  handleInitKeys,
  handleWtchoiceKeys,
  handleBranchKeys,
  handleSettingsKeys,
  handleProviderKeys,
  handleIdentityKeys,
  handleProfileKeys,
  handleListKeys,
];

/** Offer a key to each handler in turn, stopping at the first that takes it. */
export function dispatchKey(input: string, key: Key, ctx: KeyContext, handlers: readonly KeyHandler[] = KEY_HANDLERS): void {
  for (const h of handlers) if (h(input, key, ctx)) return;
}
