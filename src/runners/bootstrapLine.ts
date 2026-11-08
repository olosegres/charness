import { linuxAdminGroups, macAdminGroup } from '../runnerUtility/adminCheck';
import { gateMarker, maxGateNoiseBytes } from './gateProtocol';
import { ensureNodeScriptRelativePath } from '../runnerUtility/managedNode';
import { ownNodeDirName, runnerStateDirName } from '../runnerUtility/runnerHome';
import { encodePairCode, type PairCodePayload } from './pairCode';

/**
 * @description THE line the operator runs on the runner machine: `sudo sh -c '<script>' sh <account>` (see {@link buildAdminBootstrapLine}). It is plain
 * `sh` (a runner has nothing of charness yet): it writes the pairing's temporary key and the hub's host key into a private temp folder (removed on exit),
 * downloads the hub's own charness package through the gate's `bootstrap` request, unpacks it, and hands over to the runner utility with the pairing code and
 * the id of the archive it downloaded (the hub announces it in the marker line; the first step checks the archive against it). What the hub's shell printed
 * before the gate ran (a banner, a motd) is skipped: the answer opens with the marker line, which `grep -b` finds among the first {@link maxGateNoiseBytes}
 * bytes, and the archive is cut out from the byte after it.
 *
 * Contract with the runner utility: `runnerCli.js pair --bootstrap <unpacked folder> --archive <file> --package-id <id> <code>` is started with a package that has NO
 * `node_modules` yet, so it reaches its install step (`npm ci --omit=dev --ignore-scripts` into its own app folder, against the lock the package carries) using
 * Node's built-ins only.
 *
 * Every value in the line passed a strict pattern (`pairCode.ts`) that has no quote, space, `$`, backtick or backslash; the line itself is wrapped in single
 * quotes and so holds none. The same script serves two ways of running it, chosen by who runs it — ONE line, so the Telegram message holds one (together two
 * would not fit 4096 characters) and the operator changes one word, not a whole line:
 *
 *   as ROOT (`sudo …`, the way it is offered) it does everything for the account named by its last word. The runner account runs the agents' code, so ROOT
 *   never executes, reads through or writes into anything that account can change. As root the script (1) checks the account (it exists; not root; not an
 *   admin; the OS is known), (2) downloads the package into a folder of ITS OWN in `/tmp` — root-owned, readable by the account, extracted with
 *   `--no-same-owner` — (3) has the package's `remoteRun/ensureNode.sh` install the runner its own Node.js into a folder only root can write
 *   (`/usr/local/lib/charness-runner/node`; checked again for what root requires of it — outside every home, the account can run it and cannot write it) and
 *   (4) runs the root step with that Node from the same root-owned copy (`rootServiceCli.js install <account> --bootstrap …`: Node built-ins only,
 *   because the copy has no dependencies). The root step has the account pair itself from that copy (`sudo -u <account> -H node
 *   …/runnerCli.js pair`: its files are the account's, never root's) and then installs the always-on service. EVERY step that runs as the
 *   account goes through one runner with no terminal attached (a session of its own, no standard input, its output piped through the root
 *   step with the control characters stripped), see `runnerUtility/adminService.ts` and `isolatedCommand.ts`: the account runs the agents'
 *   code, and code it can change must not get the admin's terminal. Run again for an account that is already paired, the line pairs nothing twice and
 *   installs the service — that is its way to retry.
 *
 *   as a NON-ROOT user (the same line without its leading `sudo`, from the runner account's own terminal) it pairs THAT account, for a person without
 *   admin rights: everything is the account's — the temp folder (`$TMPDIR`, private), the runner's own Node.js, which `ensureNode.sh own` puts in
 *   `~/.charness-runner/node` before the pairing runs under it, and the pairing itself (`runnerCli.js pair`). No service is installed (the pairing prints the
 *   «keep it running» help for the account to follow). The last word must be the name of the account that runs it: the line pairs the account you are in, and
 *   a main account with a leftover `runner` at the end is refused instead of paired by mistake. Nothing judges that account (it is the account the person
 *   chose to be in; only root's way — another account — is checked for admin rights).
 *
 * A machine needs no Node.js of its own for either way: only `curl` or `wget`, `tar`, and a way to reach nodejs.org. The pairing code stays single use, 10
 * minutes, a secret; sudo logs the command line, so a code that is neither used nor closed stays live in that log until it runs out: a refused line (no such
 * account, an admin account) leaves it open ON PURPOSE — the operator fixes the last word and pastes the same line again — and an already-paired account's
 * line closes its own code (the gate's `cancel`). Nothing creates an account.
 *
 * What the root way trusts: the charness host. The line is text the host made, and the program root runs from it is the one in the host's own install, so
 * whoever can change that install (its user, and the agents that run as that user) controls code that runs as root on the runner machine — and what it installs
 * outlasts the paste. The non-root way trusts the host only with the runner account. Every place that offers the line says so: the Telegram message
 * (`runners.pairingIntro`) and the CLI's text (`adminLineTrustSentence` in `runnersCli.ts`).
 */

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
/** The same for a refusal: the line on stderr, then out. A function, defined once — the refusals of the fetch steps and the checks share it. */
const failFunction = 'f() { s "$*" >&2; exit 1; }';
// The Node install both lines run from their copy of the package (`ensureNodeScriptRelativePath`; see the script's own head): it puts the runner's OWN Node.js in
// place — the official build from nodejs.org, checksum checked — and prints the real path of the `node` the pairing runs under. Kept out of the pasted line: a
// Telegram message holds 4096 characters.
/** Where the Node of the account's own way goes, as the shell spells it: inside the account's state folder. */
const ownNodeBaseInShell = `"$HOME/${runnerStateDirName}/${ownNodeDirName}"`;

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
 * The steps that make the package ready in `$d/pkg` (and its archive in `$d/package.tgz`): `sh` that needs nothing of charness. `$r` is `1` when ROOT makes the
 * copy for an account to read — its folder is made world-readable once the package is downloaded (the key files in it stay 0600), the archive and the package
 * are extracted readable — and `0` for a non-root user's own copy, which stays private. `$b` is the folder the copy is made in. The copy never takes the owner from the archive, so root's copy
 * stays root's.
 */
function renderFetchSteps(payload: PairCodePayload): string[] {
  const sshOptions = [
    '-T', '-F /dev/null', '-i "$d/key"',
    '-o BatchMode=yes', '-o IdentitiesOnly=yes', '-o IdentityAgent=none',
    '-o StrictHostKeyChecking=yes', '-o UserKnownHostsFile="$d/kh"', '-o GlobalKnownHostsFile=/dev/null',
    `-o HostKeyAlias=${hubHostAlias}`, `-o ConnectTimeout=${connectTimeoutSeconds}`,
    `-p ${payload.port}`,
  ].join(' ');
  return [
    'umask 077',
    'd=$(mktemp -d "$b/charness-runner.XXXXXXXX")',
    'trap "rm -rf \\"$d\\"" EXIT',
    'trap "exit 1" INT TERM',
    `{ printf "%s\\n" "${privateKeyHeader}"; printf "%s" "${getPrivateKeyBody(payload.privateKey)}" | fold -w ${privateKeyFoldWidth}; printf "\\n%s\\n" "${privateKeyFooter}"; } > "$d/key"`,
    `printf "%s %s\\n" ${hubHostAlias} "${payload.hostKey}" > "$d/kh"`,
    's "downloading the package from the hub"',
    `ssh ${sshOptions} ${payload.user}@${payload.host} bootstrap > "$d/answer" || f "the hub refused or did not answer: expired or used line? see the ssh message above"`,
    `hit=$(head -c ${maxGateNoiseBytes} "$d/answer" | LC_ALL=C grep -a -b -o -E -e "${bootstrapMarkerPattern}" | head -n 1)`,
    '[ -n "$hit" ] || f "no package from the hub: expired or used line?"',
    'o=${hit%%:*}; t=${hit#*:}',
    '[ "$r" = 0 ] || { chmod 755 "$d"; umask 022; }',
    'tail -c +$((o + ${#t} + 2)) "$d/answer" > "$d/package.tgz"',
    'mkdir "$d/pkg"',
    'tar --no-same-owner -xzf "$d/package.tgz" -C "$d/pkg"',
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

/**
 * The script (see the head of the file for its two ways). `$1` is the account. Messages are plain ASCII with no apostrophe (the whole line sits in single
 * quotes) and short: the line plus its text must fit one Telegram message.
 */
function renderScript(payload: PairCodePayload): string {
  // Root's way: another account is named, and root checks it before anything is fetched or runs as it.
  const asRootChecks = [
    'r=1',
    `b=${adminCopyBase}`,
    'i=$(id -u "$a" 2>/dev/null) || f "no account $a here: create a standard user or fix the last word"',
    '[ "$i" != 0 ] || f "$a is root: use a standard user"',
    `case $(uname -s) in Darwin) g="${macAdminGroup}";; Linux) g="${linuxAdminGroups.join(' ')}";; *) f "only macOS and Linux";; esac`,
    'gs=$(id -Gn "$a") || f "no groups for $a"',
    'for x in $gs; do case " $g " in *" $x "*) f "$a is an admin: the agents code runs with its rights";; esac; done',
  ];
  // The account's own way: nobody else is involved, so the only question is whether it IS the account named.
  const asAccountChecks = [
    'r=0',
    'b=${TMPDIR:-/tmp}',
    '[ "$a" = "$(id -un)" ] || f "you are not $a: run the line as $a or with sudo"',
  ];
  const checks = [
    sayFunction,
    failFunction,
    'a=$1',
    's "checking the account $a"',
    `case $a in ""|-*|*[!${accountNameChars}]*) f "$a is not an account name";; esac`,
    `if [ "$(id -u)" = 0 ]; then ${asRootChecks.join('; ')}; else ${asAccountChecks.join('; ')}; fi`,
  ];
  const nodeScript = `"$d/pkg/${ensureNodeScriptRelativePath}"`;
  const asRootStep = `n=$(sh ${nodeScript} root "$a"); "$n" "$d/pkg/${rootServiceCliInPackage}" install "$a" "$@"`;
  const asAccountStep = `n=$(sh ${nodeScript} own ${ownNodeBaseInShell}); "$n" "$d/pkg/${runnerCliInPackage}" pair "$@"`;
  const steps = [
    ...renderFetchSteps(payload),
    // The account is saved in `$a`: the pairing's arguments are the one list both steps are handed.
    `set -- ${renderPairArguments(encodePairCode(payload))}`,
    `if [ "$r" = 1 ]; then ${asRootStep}; else ${asAccountStep}; fi`,
  ];
  return checkScriptHasNoQuote(['set -eu', ...checks, ...steps].join('; '), 'pairing');
}

/**
 * @description The command to paste on the runner machine: `sudo sh -c '<script>' sh <account>`. In an ADMIN account's terminal it pairs `account` and installs its
 * always-on service; without its leading `sudo`, in the terminal of `account` itself, it pairs that account only (see the head of the file). `account` is the
 * line's last word, so the operator can change it by hand.
 */
export function buildAdminBootstrapLine(payload: PairCodePayload, account: string = defaultRunnerAccount): string {
  if (!checkIsAccountName(account)) throw new Error('the runner account must be a plain account name');
  return `sudo sh -c '${renderScript(payload)}' sh ${account}`;
}
