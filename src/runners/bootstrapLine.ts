import { linuxAdminGroups, macAdminGroup } from '../runnerUtility/adminCheck';
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
 * — and (3) runs the root step from the same root-owned copy (`rootServiceCli.js install <account> --bootstrap …`: Node built-ins only,
 * because the copy has no dependencies). The root step has the account pair itself from that copy (`sudo -u <account> -H node
 * …/runnerCli.js pair`: its files are the account's, never root's) and then installs the always-on service. EVERY step that runs as the
 * account goes through one runner with no terminal attached (a session of its own, no standard input, its output piped through the root
 * step with the control characters stripped), see `runnerUtility/adminService.ts` and `isolatedCommand.ts`: the account runs the agents'
 * code, and code it can change must not get the admin's terminal. The pairing code stays single use, 10 minutes, a secret; sudo logs the command line, so a code that
 * is neither used nor closed stays live in that log until it runs out: a refused line (no such account, an admin account) leaves it open ON
 * PURPOSE — the operator fixes the last word and pastes the same line again — and an already-paired account's line closes its own code (the
 * gate's `cancel`). Nothing creates an account. Run again for an account that is already paired, the line pairs nothing twice and installs
 * the service — that is its way to retry.
 *
 * What the admin line trusts: the charness host. The line is text the host made, and the program root runs from it is the one in the host's
 * own install, so whoever can change that install (its user, and the agents that run as that user) controls code that runs as root on the
 * runner machine — and what it installs outlasts the paste. The plain line trusts the host only with the runner account. Every place that
 * offers the line says so: the Telegram message (`runners.pairingAdminIntro`) and the CLI's text (`adminLineTrustSentence` in `runnersCli.ts`).
 */

const minNodeMajor = 22;
const minNodeMinor = 12;
const hubHostAlias = 'hub';
const privateKeyFoldWidth = 70;
const privateKeyHeader = '-----BEGIN OPENSSH PRIVATE KEY-----';
const privateKeyFooter = '-----END OPENSSH PRIVATE KEY-----';
const connectTimeoutSeconds = 20;
/** The marker line of a `bootstrap` answer as an extended regular expression: the marker, the request, optional `key=value` fields. */
const bootstrapMarkerPattern = `^${gateMarker} bootstrap( [a-z]+=[A-Za-z0-9._:@/-]*)*$`;
/**
 * The step line of the shell part, before Node starts (the runner utility's own steps are `runnerUtility/progress.ts`): `s checking the account` prints
 * `charness-runner: checking the account`. A function in the script, defined once, so each step costs a few characters of the Telegram message.
 */
const sayFunction = 's() { echo "charness-runner: $*"; }';
/** The same for a refusal: the line on stderr, then out. A function, defined once — three refusals of the fetch steps and the admin checks share it. */
const failFunction = 'f() { echo "charness-runner: $*" >&2; exit 1; }';
/** The test of a `node` program (`$1` is the program): exit status 0 when it is `minNodeMajor.minNodeMinor` or newer. */
function nodeVersionCheck(program: string): string {
  return `${program} -e "var v=process.versions.node.split(/[.]/);process.exit(v[0]>${minNodeMajor}||v[0]==${minNodeMajor}&&v[1]>=${minNodeMinor}?0:1)"`;
}

/** The `case` patterns of the paths inside people's homes and root's: a Node in one of them is never picked by the admin line (the same places as `homeFolders.ts`). */
export const adminLineHomePatterns: readonly string[] = ['/Users/*', '/home/*', '*/root/*'];
/** The places a system-wide Node is looked for after the `node` of sudo's own PATH (Homebrew on Apple Silicon and on Intel, the system's). */
const systemNodeCandidates: readonly string[] = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];

/**
 * The steps that choose the Node.js the admin line runs as root (and the runner's service will run under) into `$n`, or refuse. A Node qualifies
 * when it is outside every home folder (`/Users/<name>`, `/home/<name>`, root's own: a path with a `root` folder; judged on its REAL path — a link in `/usr/local/bin` into somebody's `~/.nvm` is a
 * home Node too), the account can run it (`sudo -u "$a" test -x`: nothing of the account's is executed by the shell) and it is new enough. Root runs a program from a home only if it is the admin's, and the service would then stop working the day that home is
 * closed (`chmod 700`) or the version manager moves on; the account's own home is no place for a program root runs either. The candidates are
 * sudo's own `node` first, then {@link systemNodeCandidates}. `homePatterns` (`case` patterns) and `systemCandidates` are parameters for the test that runs these steps for real.
 */
export function renderNodePickSteps(homePatterns: readonly string[] = adminLineHomePatterns, systemCandidates: readonly string[] = systemNodeCandidates): string[] {
  // Unquoted on purpose: no `node` on the PATH is no word at all (an empty one would be read as the current folder), and a path that a shell would split is no candidate.
  const candidates = ['$(command -v node)', ...systemCandidates].join(' ');
  return [
    'n=',
    `for c in ${candidates}; do r=$(readlink -f "$c" 2>&-) || continue; case $r in ${homePatterns.join('|')}) continue;; esac; sudo -u "$a" test -x "$r" || continue; ${nodeVersionCheck('"$r"')} || continue; n=$r; break; done`,
    `[ -n "$n" ] || f "no Node.js ${minNodeMajor}.${minNodeMinor}+ outside home folders: install one system-wide (macOS: brew install node), paste again"`,
  ];
}

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
    ...(isForAccount ? [] : [`command -v node >/dev/null 2>&1 && ${nodeVersionCheck('node')} || f "Node.js ${minNodeMajor}.${minNodeMinor} or newer is needed on this machine (https://nodejs.org)"`]),
    `{ printf "%s\\n" "${privateKeyHeader}"; printf "%s" "$b" | fold -w ${privateKeyFoldWidth}; printf "\\n%s\\n" "${privateKeyFooter}"; } > "$d/key"`,
    `printf "%s %s\\n" ${hubHostAlias} "$k" > "$d/kh"`,
    's "downloading the package from the hub"',
    `ssh ${sshOptions} "$u@$h" bootstrap > "$d/answer" || f "the hub refused or did not answer: expired or used line? see the ssh message above"`,
    `hit=$(head -c ${maxGateNoiseBytes} "$d/answer" | LC_ALL=C grep -a -b -o -E -e "${bootstrapMarkerPattern}" | head -n 1)`,
    '[ -n "$hit" ] || f "no package from the hub: expired or used line?"',
    'o=${hit%%:*}; t=${hit#*:}',
    ...(isForAccount ? ['umask 022'] : []),
    'tail -c +$((o + ${#t} + 2)) "$d/answer" > "$d/package.tgz"',
    'mkdir "$d/pkg"',
    `tar ${isForAccount ? '--no-same-owner ' : ''}-xzf "$d/package.tgz" -C "$d/pkg"`,
  ];
}

/** The arguments of a pairing from the unpacked package, for the pairing `code`: the folder, the archive and the id the hub announced for it. */
function renderPairArguments(code: string): string {
  return `--bootstrap "$d/pkg" --archive "$d/package.tgz" --package-id "\${t##*id=}" ${code}`;
}

function checkScriptHasNoQuote(script: string, what: string): string {
  if (script.includes("'")) throw new Error(`the ${what} script must not hold a single quote`);
  return script;
}

/** @description The command to paste on the runner machine, as the account that will run jobs, for the pairing `payload`. */
export function buildBootstrapLine(payload: PairCodePayload): string {
  const script = [...renderFetchSteps(payload, false), `node "$d/pkg/${runnerCliInPackage}" pair ${renderPairArguments(encodePairCode(payload))}`];
  return `sh -c '${checkScriptHasNoQuote(['set -eu', sayFunction, failFunction, ...script].join('; '), 'bootstrap')}'`;
}

/**
 * The admin script. `$1` is the account. Messages are plain ASCII with no apostrophe (the whole line sits in single quotes) and short: the
 * line plus its text must fit one Telegram message.
 */
function renderAdminScript(payload: PairCodePayload): string {
  const checks = [
    sayFunction,
    failFunction,
    'a=$1',
    '[ "$(id -u)" = 0 ] || f "run this line with sudo"',
    's "checking the account $a"',
    `case $a in ""|-*|*[!${accountNameChars}]*) f "$a is not an account name";; esac`,
    'i=$(id -u "$a" 2>/dev/null) || f "no account $a here: create a standard user or fix the last word"',
    '[ "$i" != 0 ] || f "$a is root: use a standard user"',
    `case $(uname -s) in Darwin) g="${macAdminGroup}";; Linux) g="${linuxAdminGroups.join(' ')}";; *) f "only macOS and Linux";; esac`,
    'gs=$(id -Gn "$a") || f "no groups for $a"',
    'for x in $gs; do case " $g " in *" $x "*) f "$a is an admin: the agents code runs with its rights";; esac; done',
  ];
  const steps = [
    ...renderNodePickSteps(),
    ...renderFetchSteps(payload, true),
    `"$n" "$d/pkg/${rootServiceCliInPackage}" install "$a" ${renderPairArguments(encodePairCode(payload))}`,
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
