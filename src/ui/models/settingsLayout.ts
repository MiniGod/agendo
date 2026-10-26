// How the Settings page (../screens/SettingsScreen.tsx) and its team picker
// (../screens/SettingsEditScreens.tsx) fit a terminal too short for their rows.
// Kept apart from the screens, which import the providers and with them
// azureDevOps/env.ts — a module that reads config.json at import — so test/
// can load this bare.

/**
 * Lines the page spends on everything but its rows: the title, the hint, three
 * gaps, the config.json source line, Resource, the Authentication heading, a
 * line per backend and the last save's note — plus Ink's last line, which a
 * page as tall as the terminal would scroll the title away with.
 */
export function settingsChrome(backends: number, note: boolean): number {
  return 9 + backends + (note ? 1 : 0);
}

/**
 * The rows that fit in `room` lines, as [start, end): every one when they all
 * fit; otherwise a window around the cursor, one line shorter to leave room
 * for saying how many are out of view.
 */
export function settingsWindow(cursor: number, count: number, room: number): { start: number; end: number } {
  if (count <= room) return { start: 0, end: count };
  const page = Math.max(1, room - 1);
  const start = Math.min(Math.max(0, cursor - Math.floor(page / 2)), count - page);
  return { start, end: start + page };
}

/** The line under a windowed list: how many rows are above and below it. */
export function hiddenRowsText(above: number, below: number): string | null {
  const parts = [above > 0 ? `↑ ${above} more` : "", below > 0 ? `↓ ${below} more` : ""].filter(Boolean);
  return parts.length > 0 ? `  ${parts.join(" · ")}` : null;
}
