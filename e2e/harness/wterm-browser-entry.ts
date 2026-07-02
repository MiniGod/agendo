// Browser entry bundled (by bun) and served to the test page. It exposes the
// wterm DOM terminal as a global so wterm.ts can construct and drive it.
import { WTerm } from "@wterm/dom";

(globalThis as Record<string, unknown>).WTerm = WTerm;
