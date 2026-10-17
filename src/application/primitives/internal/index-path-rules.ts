import {
  type IndexPathRules,
  posixIndexPathRules,
  windowsIndexPathRules,
} from '../../../domain/git-index/path-validator.js';

/** The index path rules of the git build a host emulates: git for Windows' when it says so, POSIX otherwise. */
export const indexPathRulesOf = (host: { readonly windowsPathSyntax?: boolean }): IndexPathRules =>
  host.windowsPathSyntax === true ? windowsIndexPathRules : posixIndexPathRules;
