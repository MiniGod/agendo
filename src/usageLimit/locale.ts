// The locale the reset time is printed in. Its own module because the value
// comes from three environment variables and two checks the runtime makes,
// and usageLimit.ts is at its line budget.

/**
 * A POSIX locale value as a BCP-47 tag: drop the .codeset and @modifier
 * suffixes, then `_` → `-`. `C` and `POSIX` name no locale at all.
 */
function localeTag(raw: string): string | undefined {
  const tag = raw.split(/[.@]/)[0].replace(/_/g, "-");
  return !tag || tag === "C" || tag === "POSIX" ? undefined : tag;
}

/** `tag` when the runtime can format in it; undefined when it can't, or the tag is structurally invalid (supportedLocalesOf throws). */
function supportedLocale(tag: string): string | undefined {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf(tag).length ? tag : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The user's BCP-47 locale, taken from the POSIX locale environment
 * (LC_ALL > LC_TIME > LANG) and normalized: `en_GB.UTF-8@euro` → `en-GB`.
 * Returns undefined for the C/POSIX locale, an unset environment, or a tag ICU
 * doesn't know — callers then fall back to the runtime default.
 *
 * We resolve this ourselves because Bun's default `Intl` locale is a hardcoded
 * en-US regardless of the environment, which would give every user 12-hour
 * times; its ICU *data* is complete, so an explicit tag formats correctly.
 */
export function envLocale(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env.LC_ALL || env.LC_TIME || env.LANG;
  const tag = raw ? localeTag(raw) : undefined;
  return tag ? supportedLocale(tag) : undefined;
}
