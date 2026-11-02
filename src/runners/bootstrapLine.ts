import { linuxAdminGroups, macAdminGroup } from '../runnerUtility/adminCheck';
import { serviceFollowsFlag } from '../runnerUtility/pairArgs';
import { launcherPathInHome } from '../runnerUtility/runnerHome';
import { gateMarker, maxGateNoiseBytes } from './gateProtocol';
import { encodePairCode, type PairCodePayload } from './pairCode';

/**
 * @description The one line the operator runs on the runner machine. It is plain `sh` (a runner has nothing of charness yet): it
 * writes the pairing's temporary key and the hub's host key into a private temp folder (removed on exit), downloads the hub's own
 * charness package through the gate's `bootstrap` request, unpacks it, and hands over to the runner utility's `pair` step with the
 * pairing code and the id of the archive it downloaded (the hub announces it in the marker line; the first step checks the archive against it). What the hub's shell printed before the gate ran (a banner, a motd) is skipped: the answer opens with the marker line,
 * which `grep -b` finds among the first {@link maxGateNoiseBytes} bytes, and the archive is cut out from the byte after it.
 *
 * Contract with the runner utility: `runnerCli.js pair --bootstrap <unpacked folder> --archive <file> --package-id <id> <code>` is started with a package that has NO
 * `node_modules` yet, so it reaches its install step (`npm install --omit=dev --ignore-scripts` into its own app folder) using
 * Node's built-ins only.
 *
 * Every value in the line passed a strict pattern (`pairCode.ts`) that has no quote, space, `$`, backtick or backslash; the line
 * itself is wrapped in single quotes and so holds none.
 *
 * The ADMIN line ({@link buildAdminBootstrapLine}) is the same script behind an account switch: `sudo sh -c '<checks>' sh '<script>'
 * <account>`. As root the checks run first (the account exists, is not root and not an admin — it runs the agents' code — and the OS is
 * known), then the script runs AS the account (`sudo -u <account> -H`: its files are the account's, never root's), then the account's
 * launcher installs the always-on service (`service install --system --user <account>`: the one other thing that needs root). The script
 * travels as the line's first argument, so it is not quoted twice; the account is the LAST word, where an edit after pasting is easiest.
 * Nothing creates an account. The pairing code stays single use, 10 minutes, a secret; sudo logs the command line, and a spent code is worth nothing.
 */

const minNodeMajor = 22;
const minNodeMinor = 12;
const hubHostAlias = 'charness-hub';
const privateKeyFoldWidth = 70;
const privateKeyHeader = '-----BEGIN OPENSSH PRIVATE KEY-----';
const privateKeyFooter = '-----END OPENSSH PRIVATE KEY-----';
const connectTimeoutSeconds = 20;
/** The marker line of a `bootstrap` answer as an extended regular expression: the marker, the request, optional `key=value` fields. */
const bootstrapMarkerPattern = `^${gateMarker} bootstrap( [a-z]+=[A-Za-z0-9._:@/-]*)*$`;

function getPrivateKeyBody(privateKey: string): string {
  return privateKey.replace(privateKeyHeader, '').replace(privateKeyFooter, '').replace(/\s+/g, '');
}

/** @description The account the admin line pairs unless the operator changes its last word. */
export const defaultRunnerAccount = 'runner';
/** The characters of an account name the admin line lets through (a character class body): none is special to a shell, and a name never starts with `-`. */
const accountNameChars = 'A-Za-z0-9._-';
const accountNamePattern = new RegExp(`^(?!-)[${accountNameChars}]+$`);

/** @description Is `name` a plain account name (letters, digits, `.`, `_`, `-`; no leading `-`)? The admin line refuses anything else. */
export function checkIsAccountName(name: string): boolean {
  return accountNamePattern.test(name);
}

/** The script that pairs the account running it: `sh` that needs nothing of charness. `isServiceFollowing`: an admin's line installs the service next. */
function renderPairingScript(payload: PairCodePayload, isServiceFollowing: boolean): string {
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
    `ssh ${sshOptions} "$u@$h" bootstrap > "$d/answer" || { echo "charness-runner: the hub refused or did not answer (has the line expired or been used already? the ssh message above says which)" >&2; exit 1; }`,
    `hit=$(head -c ${maxGateNoiseBytes} "$d/answer" | LC_ALL=C grep -a -b -o -E -e "${bootstrapMarkerPattern}" | head -n 1)`,
    '[ -n "$hit" ] || { echo "charness-runner: the hub did not send the package (has the line expired or been used already?)" >&2; exit 1; }',
    'o=${hit%%:*}; t=${hit#*:}',
    'tail -c +$((o + ${#t} + 2)) "$d/answer" > "$d/package.tgz"',
    'mkdir "$d/pkg"',
    'tar -xzf "$d/package.tgz" -C "$d/pkg"',
    `node "$d/pkg/dist/runnerUtility/runnerCli.js" pair --bootstrap "$d/pkg" --archive "$d/package.tgz" --package-id "\${t##*id=}"${isServiceFollowing ? ` ${serviceFollowsFlag}` : ''} ${code}`,
  ].join('; ');
  if (script.includes("'")) throw new Error('the bootstrap script must not hold a single quote');
  return script;
}

/**
 * The root part of the admin line. `$1` is the pairing script, `$2` the account; `h` is the account's own idea of its home (`sudo -H` sets
 * it), where its launcher lives — and an account without a usable home stops the line before anything is paired. Messages are plain ASCII
 * with no apostrophe (the whole line sits in single quotes) and short: the line plus its text must fit one Telegram message.
 */
function renderAdminScript(): string {
  const script = [
    'set -eu',
    'f() { echo "charness-runner: $*" >&2; exit 1; }',
    'a=$2',
    '[ "$(id -u)" = 0 ] || f "run this line with sudo"',
    `case $a in ""|-*|*[!${accountNameChars}]*) f "$a is not an account name";; esac`,
    'u=$(id -u "$a" 2>/dev/null) || f "no account $a here: create a standard user, or end the line with the right name"',
    '[ "$u" != 0 ] || f "$a is root: use a standard user"',
    `case $(uname -s) in Darwin) g="${macAdminGroup}";; Linux) g="${linuxAdminGroups.join(' ')}";; *) f "only macOS and Linux are supported";; esac`,
    'for x in $(id -Gn "$a"); do case " $g " in *" $x "*) f "$a is an admin account: the agents code would run with its rights";; esac; done',
    'h=$(sudo -u "$a" -H sh -c "cd&&pwd")',
    'sudo -u "$a" -H sh -c "$1"',
    `"$h/${launcherPathInHome}" service install --system --user "$a"`,
  ].join('; ');
  if (script.includes("'")) throw new Error('the admin script must not hold a single quote');
  return script;
}

/** @description The command to paste on the runner machine, as the account that will run jobs, for the pairing `payload`. */
export function buildBootstrapLine(payload: PairCodePayload): string {
  return `sh -c '${renderPairingScript(payload, false)}'`;
}

/**
 * @description The command to paste in an ADMIN account's terminal on the runner machine: it checks `account`, pairs it, and installs its
 * always-on service. `account` is the line's last word, so the operator can change it by hand.
 */
export function buildAdminBootstrapLine(payload: PairCodePayload, account: string = defaultRunnerAccount): string {
  if (!checkIsAccountName(account)) throw new Error('the runner account must be a plain account name');
  return `sudo sh -c '${renderAdminScript()}' sh '${renderPairingScript(payload, true)}' ${account}`;
}
