/**
 * @description How long the hub must have been refusing a runner's key, without ever saying «this runner is not paired», before the runner takes
 * the refusal for a removal worth killing its jobs for. A refused key alone is also what a hub with a locked home folder, a changed file mode or an
 * edited sshd setting looks like, and those last hours (a night, until someone unlocks the volume); killing a long run for them is the
 * wrong mistake. A hub that removes an ONLINE runner stops its jobs itself over the link (`runners/runnerRemoval.ts`), and a hub that can
 * answer says so (`identity`), so this only covers a machine that was off when it was removed.
 *
 * The one source of the delay: the runner's link loop (`runnerUtility/linkLoop.ts`) waits this long, and the texts that tell the operator what
 * a removal of an offline machine leaves behind (`/runners`) name the same number of hours.
 */

const msPerHour = 60 * 60 * 1000;

export const unconfirmedRemovalStopAfterHours = 12;

export const unconfirmedRemovalStopAfterMs = unconfirmedRemovalStopAfterHours * msPerHour;
