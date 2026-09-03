import type { Key } from "ink";

/**
 * The step a list key asks for: up and `k` go back one row, down and `j` on
 * one; null for any other key. Which rows the cursor may land on, and how it
 * wraps, is each list's own business.
 */
export function listStep(input: string, key: Key): 1 | -1 | null {
  if (key.upArrow || input === "k") return -1;
  if (key.downArrow || input === "j") return 1;
  return null;
}
