/**
 * Named constants for every msg-id in the git fsck catalogue.
 * Pinned against git 2.54.0 `fsck-msgids.adoc` and cross-checked
 * behaviourally (zeroPaddedFilemode / treeNotSorted / missingSpaceBeforeEmail).
 */

// tree
export const MSG_BAD_FILEMODE = 'badFilemode' as const;
export const MSG_BAD_TREE = 'badTree' as const;
export const MSG_BAD_TREE_SHA1 = 'badTreeSha1' as const;
export const MSG_DUPLICATE_ENTRIES = 'duplicateEntries' as const;
export const MSG_EMPTY_NAME = 'emptyName' as const;
export const MSG_FULL_PATHNAME = 'fullPathname' as const;
export const MSG_HAS_DOT = 'hasDot' as const;
export const MSG_HAS_DOTDOT = 'hasDotdot' as const;
export const MSG_HAS_DOTGIT = 'hasDotgit' as const;
export const MSG_LARGE_PATHNAME = 'largePathname' as const;
export const MSG_NULL_SHA1 = 'nullSha1' as const;
export const MSG_TREE_NOT_SORTED = 'treeNotSorted' as const;
export const MSG_ZERO_PADDED_FILEMODE = 'zeroPaddedFilemode' as const;

// tree — special-file mode checks
export const MSG_GITATTRIBUTES_BLOB = 'gitattributesBlob' as const;
export const MSG_GITATTRIBUTES_SYMLINK = 'gitattributesSymlink' as const;
export const MSG_GITIGNORE_SYMLINK = 'gitignoreSymlink' as const;
export const MSG_GITMODULES_BLOB = 'gitmodulesBlob' as const;
export const MSG_GITMODULES_SYMLINK = 'gitmodulesSymlink' as const;
export const MSG_MAILMAP_SYMLINK = 'mailmapSymlink' as const;

// commit
export const MSG_BAD_DATE = 'badDate' as const;
export const MSG_BAD_DATE_OVERFLOW = 'badDateOverflow' as const;
export const MSG_BAD_EMAIL = 'badEmail' as const;
export const MSG_BAD_NAME = 'badName' as const;
export const MSG_BAD_OBJECT_SHA1 = 'badObjectSha1' as const;
export const MSG_BAD_PARENT_SHA1 = 'badParentSha1' as const;
export const MSG_BAD_TIMEZONE = 'badTimezone' as const;
export const MSG_BAD_TYPE = 'badType' as const;
export const MSG_MISSING_AUTHOR = 'missingAuthor' as const;
export const MSG_MISSING_COMMITTER = 'missingCommitter' as const;
export const MSG_MISSING_EMAIL = 'missingEmail' as const;
export const MSG_MISSING_NAME_BEFORE_EMAIL = 'missingNameBeforeEmail' as const;
export const MSG_MISSING_SPACE_BEFORE_DATE = 'missingSpaceBeforeDate' as const;
export const MSG_MISSING_SPACE_BEFORE_EMAIL = 'missingSpaceBeforeEmail' as const;
export const MSG_MISSING_TREE = 'missingTree' as const;
export const MSG_MULTIPLE_AUTHORS = 'multipleAuthors' as const;
export const MSG_NUL_IN_COMMIT = 'nulInCommit' as const;
export const MSG_NUL_IN_HEADER = 'nulInHeader' as const;
export const MSG_UNKNOWN_TYPE = 'unknownType' as const;
export const MSG_UNTERMINATED_HEADER = 'unterminatedHeader' as const;
export const MSG_ZERO_PADDED_DATE = 'zeroPaddedDate' as const;

// tag
export const MSG_BAD_GPGSIG = 'badGpgsig' as const;
export const MSG_BAD_TAG_NAME = 'badTagName' as const;
export const MSG_EXTRA_HEADER_ENTRY = 'extraHeaderEntry' as const;
export const MSG_MISSING_OBJECT = 'missingObject' as const;
export const MSG_MISSING_TAG = 'missingTag' as const;
export const MSG_MISSING_TAG_ENTRY = 'missingTagEntry' as const;
export const MSG_MISSING_TAGGER_ENTRY = 'missingTaggerEntry' as const;
export const MSG_MISSING_TYPE = 'missingType' as const;
export const MSG_MISSING_TYPE_ENTRY = 'missingTypeEntry' as const;

// blob — gitmodules
export const MSG_GITMODULES_LARGE = 'gitmodulesLarge' as const;
export const MSG_GITMODULES_MISSING = 'gitmodulesMissing' as const;
export const MSG_GITMODULES_NAME = 'gitmodulesName' as const;
export const MSG_GITMODULES_PARSE = 'gitmodulesParse' as const;
export const MSG_GITMODULES_PATH = 'gitmodulesPath' as const;
export const MSG_GITMODULES_UPDATE = 'gitmodulesUpdate' as const;
export const MSG_GITMODULES_URL = 'gitmodulesUrl' as const;

// blob — gitattributes
export const MSG_GITATTRIBUTES_LARGE = 'gitattributesLarge' as const;
export const MSG_GITATTRIBUTES_LINE_LENGTH = 'gitattributesLineLength' as const;
export const MSG_GITATTRIBUTES_MISSING = 'gitattributesMissing' as const;
