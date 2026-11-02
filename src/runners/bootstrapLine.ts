import { linuxAdminGroups, macAdminGroup } from '../runnerUtility/adminCheck';
import { serviceFollowsFlag } from '../runnerUtility/pairArgs';
import { gateMarker, maxGateNoiseBytes } from './gateProtocol';
import { encodePairCode, type PairCodePayload } from './pairCode';

/**
 * @description The lines the operator runs on the runner machine. They are plain `sh` (a runner has nothing of charness yet): they
 * write the pairing's temporary key and the hub's host key into a private temp folder (removed on exit), download the hub's own
 * charness package through the gate's `bootstrap` request, unpack it, and hand over to the runner utility's `pair` step with the
 * pairing code and the id of the archive they downloaded (the hub announces it in the marker line; the first step checks the archive against it). What the hub's shell printed before the gate ran (a banner, a motd) is skipped: the answer opens with the marker line,
 * which `grep -b` finds among the first {@link maxGateNoiseBytes} bytes, and the archive is cut out from the byte after it.
 *
 * Contract with the runner utility: `runnerCli.js pair --bootstrap <unpacked folder> --archive <file> --package-id <id> <code>` is started with a package that has NO
 * `node_modules` yet, so it reaches its install step (`npm install --omit=dev --ignore-scripts` into its own app folder) using
 * Node's built-ins only.
 *
 * Every value in the line passed a strict pattern (`pairCode.ts`) that has no quote, space, `$`, backtick or backslash; the line
 * itself is wrapped in single quotes and so holds none.
 *
 * The PLAIN line ({@link buildBootstrapLine}) is run as the runner account itself: all of it is that account's.
 *
 * The ADMIN line ({@link buildAdminBootstrapLine}), `sudo sh -c '<script>' sh <account>`, is run from an admin account and does everything
 * for the account named by its last word. The runner account runs the agents' code, so ROOT never executes, reads through or writes into
 * anything that account can change. As root the script (1) checks the account (it exists; not root; not an admin; the OS is known),
 * (2) downloads the package into a folder of ITS OWN in `/tmp` — root-owned, readable by the account, extracted with `--no-same-owner`
 * — (3) has the account pair itself from that copy (`sudo -u <account> -H node …/runnerCli.js pair`: its files are the account's, never
 * root's), and (4) runs the root step from the same root-owned copy (`rootServiceCli.js install <account>`: Node built-ins only, because
 * the copy has no dependencies — it installs the always-on service, and touches the account's side only through `sudo -u`, see
 * `runnerUtility/adminService.ts`). The pairing code stays single use, 10 minutes, a secret; sudo logs the command line, so a code that
 * is neither used nor closed stays live in that log until it runs out: a refused line (no such account, an admin account) leaves it open ON
 * PURPOSE — the operator fixes the last word and pastes the same line again — and an already-paired account's line closes its own code (the
 * gate's `cancel`). Nothing creates an account. Run again for an account that is already paired, the line pairs nothing twice and installs
 * the service — that is its way to retry.
 *
 * What the admin line trusts: the charness host. The line is text the host made, and the program root runs from it is the one in the host's
 * own install, so whoever can change that install (its user, and the agents that run as that user) could have root on the runner machine for
 * the paste. The plain line trusts the host only with the runner account. The pairing message says so (`runners.pairingAdminIntro`).
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
const runnerCliInPackage = 'dist/runnerUtility/runnerCli.js';
const rootServiceCliInPackage = 'dist/runnerUtility/rootServiceCli.js';
/** Where the admin line's root-owned copy is made: a folder the account can read, which `$TMPDIR` (the admin's own, private) is not. */
const adminCopyBase = '/tmp';

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

/**
 * The steps that make the package ready in `$d/pkg` (and its archive in `$d/package.tgz`): `sh` that needs nothing of charness. `isForAccount`:
 * the copy is made by ROOT for an account to read — its folder is world-readable (the key files in it stay 0600), the archive and the
 * package are extracted readable, and without taking the owner from the archive, so root's copy stays root's.
 */
function renderFetchSteps(payload: PairCodePayload, isForAccount: boolean): string[] {
  const sshOptions = [
    '-T', '-F /dev/null', '-i "$d/key"',
    '-o BatchMode=yes', '-o IdentitiesOnly=yes', '-o IdentityAgent=none',
    '-o StrictHostKeyChecking=yes', '-o UserKnownHostsFile="$d/kh"', '-o GlobalKnownHostsFile=/dev/null',
    `-o HostKeyAlias=${hubHostAlias}`, `-o ConnectTimeout=${connectTimeoutSeconds}`,
    '-p "$p"',
  ].join(' ');
  return [
    'umask 077',
    `d=$(mktemp -d "${isForAccount ? adminCopyBase : '${TMPDIR:-/tmp}'}/charness-runner.XXXXXXXX")`,
    ...(isForAccount ? ['chmod 755 "$d"'] : []),
    'trap "rm -rf \\"$d\\"" EXIT',
    'trap "exit 1" INT TERM',
    `u="${payload.user}"`,
    `h="${payload.host}"`,
    `p="${payload.port}"`,
    `k="${payload.hostKey}"`,
    `b="${getPrivateKeyBody(payload.privateKey)}"`,
    `command -v node >/dev/null 2>&1 && node -e "var v=process.versions.node.split(/[.]/);process.exit(v[0]>${minNodeMajor}||v[0]==${minNodeMajor}&&v[1]>=${minNodeMinor}?0:1)" || { echo "charness-runner: ${isForAccount ? `sudo finds no Node.js ${minNodeMajor}.${minNodeMinor} or newer on its PATH (install it system-wide)` : `Node.js ${minNodeMajor}.${minNodeMinor} or newer is needed on this machine (https://nodejs.org)`}" >&2; exit 1; }`,
    `{ printf "%s\\n" "${privateKeyHeader}"; printf "%s" "$b" | fold -w ${privateKeyFoldWidth}; printf "\\n%s\\n" "${privateKeyFooter}"; } > "$d/key"`,
    `printf "%s %s\\n" ${hubHostAlias} "$k" > "$d/kh"`,
    `ssh ${sshOptions} "$u@$h" bootstrap > "$d/answer" || { echo "charness-runner: the hub refused or did not answer (has the line expired or been used already? the ssh message above says which)" >&2; exit 1; }`,
    `hit=$(head -c ${maxGateNoiseBytes} "$d/answer" | LC_ALL=C grep -a -b -o -E -e "${bootstrapMarkerPattern}" | head -n 1)`,
    '[ -n "$hit" ] || { echo "charness-runner: the hub did not send the package (has the line expired or been used already?)" >&2; exit 1; }',
    'o=${hit%%:*}; t=${hit#*:}',
    ...(isForAccount ? ['umask 022'] : []),
    'tail -c +$((o + ${#t} + 2)) "$d/answer" > "$d/package.tgz"',
    'mkdir "$d/pkg"',
    `tar ${isForAccount ? '--no-same-owner ' : ''}-xzf "$d/package.tgz" -C "$d/pkg"`,
  ];
}

/** The `pair` command on the unpacked package, for the pairing `code`. */
function renderPairCommand(code: string, isServiceFollowing: boolean): string {
  return `"$d/pkg/${runnerCliInPackage}" pair --bootstrap "$d/pkg" --archive "$d/package.tgz" --package-id "\${t##*id=}"${isServiceFollowing ? ` ${serviceFollowsFlag}` : ''} ${code}`;
}

function checkScriptHasNoQuote(script: string, what: string): string {
  if (script.includes("'")) throw new Error(`the ${what} script must not hold a single quote`);
  return script;
}

/** @description The command to paste on the runner machine, as the account that will run jobs, for the pairing `payload`. */
export function buildBootstrapLine(payload: PairCodePayload): string {
  const script = [...renderFetchSteps(payload, false), `node ${renderPairCommand(encodePairCode(payload), false)}`];
  return `sh -c '${checkScriptHasNoQuote(['set -eu', ...script].join('; '), 'bootstrap')}'`;
}

/**
 * The admin script. `$1` is the account. Messages are plain ASCII with no apostrophe (the whole line sits in single quotes) and short: the
 * line plus its text must fit one Telegram message.
 */
function renderAdminScript(payload: PairCodePayload): string {
  const checks = [
    'f() { echo "charness-runner: $*" >&2; exit 1; }',
    'a=$1',
    '[ "$(id -u)" = 0 ] || f "run this line with sudo"',
    `case $a in ""|-*|*[!${accountNameChars}]*) f "$a is not an account name";; esac`,
    'i=$(id -u "$a" 2>/dev/null) || f "no account $a here: create a standard user or fix the last word"',
    '[ "$i" != 0 ] || f "$a is root: use a standard user"',
    `case $(uname -s) in Darwin) g="${macAdminGroup}";; Linux) g="${linuxAdminGroups.join(' ')}";; *) f "only macOS and Linux";; esac`,
    'gs=$(id -Gn "$a") || f "no groups for $a"',
    'for x in $gs; do case " $g " in *" $x "*) f "$a is an admin: the agents code runs with its rights";; esac; done',
  ];
  const steps = [
    ...renderFetchSteps(payload, true),
    'n=$(command -v node)',
    `sudo -u "$a" -H "$n" ${renderPairCommand(encodePairCode(payload), true)}`,
    `"$n" "$d/pkg/${rootServiceCliInPackage}" install "$a" || f "$a is paired, but has no service: fix the above and paste a fresh admin line"`,
  ];
  return checkScriptHasNoQuote(['set -eu', ...checks, ...steps].join('; '), 'admin');
}

/**
 * @description The command to paste in an ADMIN account's terminal on the runner machine: it checks `account`, pairs it, and installs its
 * always-on service. `account` is the line's last word, so the operator can change it by hand.
 */
export function buildAdminBootstrapLine(payload: PairCodePayload, account: string = defaultRunnerAccount): string {
  if (!checkIsAccountName(account)) throw new Error('the runner account must be a plain account name');
  return `sudo sh -c '${renderAdminScript(payload)}' sh ${account}`;
}
