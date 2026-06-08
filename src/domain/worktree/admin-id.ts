/**
 * Allocate the admin-directory id for a linked worktree under
 * `<commonDir>/worktrees/<id>/`. git derives the id from the worktree path's
 * last component and disambiguates a collision by appending the smallest free
 * integer (`shared`, `shared1`, `shared2`, …; `worktree.c`). Pure — no I/O.
 */

const CONTROL_CHAR_MAX = 0x1f;

const hasControlChar = (name: string): boolean => {
  for (const char of name) {
    if (char.charCodeAt(0) <= CONTROL_CHAR_MAX) return true;
  }
  return false;
};

/** Whether `name` is unsafe as a single on-disk admin-directory component. */
export const isUnsafeWorktreeId = (name: string): boolean =>
  name === '' ||
  name === '.' ||
  name === '..' ||
  name.includes('/') ||
  name.includes('\\') ||
  hasControlChar(name);

/**
 * The admin id for `basename`, disambiguated against `taken`. Returns `basename`
 * when free, else `basename` followed by the smallest positive integer not yet
 * taken.
 */
export const worktreeAdminId = (basename: string, taken: ReadonlySet<string>): string => {
  let candidate = basename;
  let counter = 0;
  while (taken.has(candidate)) {
    counter += 1;
    candidate = `${basename}${counter}`;
  }
  return candidate;
};
