// The argv of `open`, parsed apart from running it — the same split listArgs.ts
// makes for `list`. `open` takes one session id, one of two link selectors, a
// print switch and the scope selectors `status` has, for the same reason
// `status` has them: `open` resolves a short id too, and launching a browser at
// the wrong repo's PR is a worse outcome than printing the wrong status. The
// walk is pure over an argv tail, so each refusal is an assertion in test/.

import { requireValue, unknownArgument } from "./args.ts";

/** Which of a session's links `open` should open. */
export type OpenWant = "pr" | "item";

export interface OpenArgs {
  token?: string;
  want?: OpenWant;
  printOnly: boolean;
  pathArg?: string;
  repoArg?: string;
}

/** The link a selector flag names; `--issue`, `--work-item` and `--workitem` are one flag. */
const SELECTORS = new Map<string, OpenWant>([
  ["--pr", "pr"],
  ["--issue", "item"],
  ["--work-item", "item"],
  ["--workitem", "item"],
]);

/** Two conflicting selectors is a mistake, not a silent last-one-wins. */
function takeSelector(out: OpenArgs, sel: OpenWant): void {
  if (out.want && out.want !== sel) {
    console.error(`open: use only one of --pr / --work-item`);
    process.exit(1);
  }
  out.want = sel;
}

/** A bare token is the id, once; a dashed one nobody knows is refused, not repurposed. */
function takePositional(out: OpenArgs, a: string): void {
  if (a.startsWith("-")) unknownArgument("open", a);
  if (out.token === undefined) out.token = a;
  else {
    console.error(`open: unexpected argument "${a}"`);
    process.exit(1);
  }
}

export function parseOpenArgs(argv: string[]): OpenArgs {
  const out: OpenArgs = { printOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const sel = SELECTORS.get(a);
    if (sel) takeSelector(out, sel);
    else if (a === "--print" || a === "-p") out.printOnly = true;
    else if (a === "--path") out.pathArg = requireValue("open", a, argv[++i]);
    else if (a === "--repo") out.repoArg = requireValue("open", a, argv[++i]);
    else takePositional(out, a);
  }
  return out;
}
