// Links that came from outside the app (model output, imported plan files, saved search results) end up in
// <a href> and <img src>. Only plain web links are allowed: data:, file:, javascript: and OS protocol handlers
// (ms-msdt:, search-ms:, ...) would run something on click.

/** The URL normalized, if it is an absolute http(s) URL; otherwise undefined. */
export function httpUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}
