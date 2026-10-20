// A count of every key the TUI has dispatched. Work that answers a key
// asynchronously (the list's `x` / `X` inspecting tmux before it asks) reads it
// before and after, so it can tell whether the user pressed anything in between
// — including keys typed into the search box, which no mode change records.
let seq = 0;

/** Called once per dispatched key, before any handler sees it. */
export function noteKey(): void {
  seq++;
}

export function keySeq(): number {
  return seq;
}
