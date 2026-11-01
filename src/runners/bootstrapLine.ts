import { encodePairCode, type PairCodePayload } from './pairCode';

/**
 * @description The one line the operator runs on the runner machine. It is plain `sh` (a runner has nothing of charness yet): it
 * writes the pairing's temporary key and the hub's host key into a private temp folder (removed on exit), downloads the hub's own
 * charness package through the gate's `bootstrap` request, unpacks it, and hands over to the runner utility's `pair` step with the
 * pairing code.
 *
 * Contract with the runner utility: `runnerCli.js pair --bootstrap <unpacked folder> <code>` is started with a package that has NO
 * `node_modules` yet, so it reaches its install step (`npm install --omit=dev --ignore-scripts` into its own app folder) using
 * Node's built-ins only.
 *
 * Every value in the line passed a strict pattern (`pairCode.ts`) that has no quote, space, `$`, backtick or backslash; the line
 * itself is wrapped in single quotes and so holds none.
 */

const minNodeMajor = 22;
const minNodeMinor = 12;
const hubHostAlias = 'charness-hub';
const privateKeyFoldWidth = 70;
const privateKeyHeader = '-----BEGIN OPENSSH PRIVATE KEY-----';
const privateKeyFooter = '-----END OPENSSH PRIVATE KEY-----';
const connectTimeoutSeconds = 20;

function getPrivateKeyBody(privateKey: string): string {
  return privateKey.replace(privateKeyHeader, '').replace(privateKeyFooter, '').replace(/\s+/g, '');
}

/** @description The command to paste on the runner machine, for the pairing `payload`. */
export function buildBootstrapLine(payload: PairCodePayload): string {
  const code = encodePairCode(payload);
  const sshOptions = [
    '-T', '-F /dev/null', '-i "$d/key"',
    '-o BatchMode=yes', '-o IdentitiesOnly=yes', '-o IdentityAgent=none',
    '-o StrictHostKeyChecking=yes', '-o UserKnownHostsFile="$d/kh"', '-o GlobalKnownHostsFile=/dev/null',
    `-o HostKeyAlias=${hubHostAlias}`, `-o ConnectTimeout=${connectTimeoutSeconds}`,
    '-p "$p"',
  ].join(' ');
  const script = [
    'set -eu',
    'umask 077',
    'd=$(mktemp -d "${TMPDIR:-/tmp}/charness-runner.XXXXXXXX")',
    'trap "rm -rf \\"$d\\"" EXIT',
    'trap "exit 1" INT TERM',
    `u="${payload.user}"`,
    `h="${payload.host}"`,
    `p="${payload.port}"`,
    `k="${payload.hostKey}"`,
    `b="${getPrivateKeyBody(payload.privateKey)}"`,
    `command -v node >/dev/null 2>&1 && node -e "var v=process.versions.node.split(/[.]/);process.exit(v[0]>${minNodeMajor}||v[0]==${minNodeMajor}&&v[1]>=${minNodeMinor}?0:1)" || { echo "charness-runner: Node.js ${minNodeMajor}.${minNodeMinor} or newer is needed on this machine (https://nodejs.org)" >&2; exit 1; }`,
    `{ printf "%s\\n" "${privateKeyHeader}"; printf "%s" "$b" | fold -w ${privateKeyFoldWidth}; printf "\\n%s\\n" "${privateKeyFooter}"; } > "$d/key"`,
    `printf "%s %s\\n" ${hubHostAlias} "$k" > "$d/kh"`,
    `ssh ${sshOptions} "$u@$h" bootstrap > "$d/package.tgz"`,
    'mkdir "$d/pkg"',
    'tar -xzf "$d/package.tgz" -C "$d/pkg"',
    `node "$d/pkg/dist/runnerUtility/runnerCli.js" pair --bootstrap "$d/pkg" ${code}`,
  ].join('; ');
  if (script.includes("'")) throw new Error('the bootstrap script must not hold a single quote');
  return `sh -c '${script}'`;
}
