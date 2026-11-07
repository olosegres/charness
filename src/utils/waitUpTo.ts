/**
 * @description Wait for a task, but never longer than a budget. `true` when the task finished inside the budget (a
 * failure inside it is rethrown), `false` when the budget ended first — the task is NOT cancelled, it runs on, and a
 * failure of it after the budget is swallowed here (the race already holds a handler on it), so the caller that gave
 * up on it never meets it again as an unhandled rejection.
 */
export async function waitUpTo(task: Promise<void>, budgetMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), budgetMs); });
  try {
    return await Promise.race([task.then(() => true), budget]);
  } finally {
    clearTimeout(timer);
  }
}
