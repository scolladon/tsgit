const SEPARATOR = '/';
const CURRENT_DIRECTORY = '.';
const PARENT_DIRECTORY = '..';

/** A component `normalize_path_copy` drops: an empty one (a doubled `/`) or `.`. */
const isElided = (component: string): boolean =>
  component === '' || component === CURRENT_DIRECTORY;

/** Drop the last copied component and its separator: `a/b/` → `a/`. */
const upOne = (copied: string): string => {
  const withoutSeparator = copied.slice(0, -1);
  return withoutSeparator.slice(0, withoutSeparator.lastIndexOf(SEPARATOR) + 1);
};

/**
 * git's `normalize_path_copy` over a relative path: empty and `.` components
 * drop, `..` removes the component before it, and a separator that followed a
 * kept component stays (`a/b/..` → `a/`). `undefined` where a `..` climbs above
 * the path's start — git's `-1`.
 */
export const normalizePathCopy = (path: string): string | undefined => {
  const components = path.split(SEPARATOR);
  const last = components.length - 1;
  let copied = '';
  for (const [index, component] of components.entries()) {
    if (isElided(component)) continue;
    if (component === PARENT_DIRECTORY) {
      if (copied === '') return undefined;
      copied = upOne(copied);
      continue;
    }
    copied += index === last ? component : `${component}${SEPARATOR}`;
  }
  return copied;
};
