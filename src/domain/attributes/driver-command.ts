/** The five placeholder values git substitutes into a merge-driver command. */
export interface DriverPlaceholders {
  /** `%O` — the ancestor (base) version's temp path. */
  readonly O: string;
  /** `%A` — the current (ours) version's temp path, also the output file. */
  readonly A: string;
  /** `%B` — the other (theirs) version's temp path. */
  readonly B: string;
  /** `%L` — the conflict-marker length. */
  readonly L: string;
  /** `%P` — the pathname the merged result is stored at. */
  readonly P: string;
}

const substituteOne = (code: string, values: DriverPlaceholders): string => {
  switch (code) {
    case 'O':
      return values.O;
    case 'A':
      return values.A;
    case 'B':
      return values.B;
    case 'L':
      return values.L;
    case 'P':
      return values.P;
    case '%':
      return '%';
    default:
      return `%${code}`; // unknown placeholder — emitted literally, git-lenient
  }
};

/**
 * Substitute `%O %A %B %L %P` and `%%` in a merge-driver command template.
 * Substitution is raw (no shell quoting — faithful to git); an unknown `%x`
 * and a dangling trailing `%` are emitted literally.
 */
export const substituteDriverPlaceholders = (
  template: string,
  values: DriverPlaceholders,
): string => {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i] as string;
    if (ch !== '%') {
      out += ch;
      i += 1;
      continue;
    }
    const next = template[i + 1];
    if (next === undefined) {
      out += '%';
      i += 1;
      continue;
    }
    out += substituteOne(next, values);
    i += 2;
  }
  return out;
};
