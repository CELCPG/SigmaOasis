/**
 * The User-Agent every outbound request carries.
 *
 * Deliberately a common browser string rather than an app-specific one. An
 * app-and-version UA ("Sigma Oasis/0.5 …", as v0.6 sent) announces the client and
 * its user population to every host contacted, which is a fingerprint a
 * privacy-first tool should not hand out. Following the Tor Browser approach,
 * every install sends the *same* string, and nothing in it is derived from the
 * local platform or Electron build — so one user looks like the next. Windows is
 * claimed regardless of host OS because it is the largest population to blend
 * into.
 *
 * Shared by the static fetch path (search.ts) and the headless renderer
 * (render.ts): if these disagreed, the two paths would be trivially
 * distinguishable from the server side.
 */
export const GENERIC_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
