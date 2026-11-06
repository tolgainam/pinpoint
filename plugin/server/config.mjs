/**
 * The bridge token, from the plugin's `token` option or a clone's own environment.
 *
 * plugin-mcp.json passes `${user_config.token}`. The documentation does not say what that
 * becomes when the user left the option empty, and text left unexpanded must not count as a
 * token: the bridge would then refuse every dispatch from an extension that has none.
 *
 * @param {string | undefined} raw
 * @returns {string | undefined}
 */
export function tokenFrom(raw) {
  const token = raw?.trim()
  return token && !token.startsWith('${') ? token : undefined
}
