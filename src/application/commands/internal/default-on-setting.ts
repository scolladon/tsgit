import { type LocatedConfigEntry, parseGitBoolean } from '../../primitives/config-read.js';

/** A boolean setting git defaults on — an `advice.*` key among them; a malformed value reads as on. */
export const enabledByDefault = (entry: LocatedConfigEntry | undefined): boolean => {
  if (entry === undefined) return true;
  const parsed = parseGitBoolean(entry.value);
  return !parsed.ok || parsed.value;
};
