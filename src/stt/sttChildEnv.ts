/**
 * @description The environment of the processes the speech engine runs: the sidecar (Python, third-party packages)
 * and the install job (pip / uv, which run package code with network access). The bot's own environment holds its
 * Telegram token and whatever else the operator exported, none of which they need — so they get a short allowlist
 * instead: where programs are (`PATH`, `HOME`, `TMPDIR`), the locale, the proxy / CA settings that make the network
 * work behind a firewall, and the `HF_*` / `UV_*` / `PIP_*` settings of the tools themselves. Anything else is
 * added explicitly by the caller (the sidecar's token, the model cache path).
 */

const allowedNames: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
]);

const allowedPrefixes: readonly string[] = ['HF_', 'UV_', 'PIP_'];

/** @description `baseEnv` cut down to the allowlist; values are copied as they are, nothing is invented. */
export function getSttChildEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (allowedNames.has(name) || allowedPrefixes.some((prefix) => name.startsWith(prefix))) childEnv[name] = value;
  }
  return childEnv;
}
