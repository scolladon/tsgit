## log

### hotShares

| frame | self |
| --- | --- |
| exists | 0.21 |
| lookupPackIndex | 0.13 |
| parseRequiredFields | 0.1 |
| checkContainment | 0.09 |
| readSlice | 0.05 |
| collectDeltaChain | 0.04 |
| commitDateWalk | 0.04 |
| log | 0.04 |
| resolveObject$1 | 0.03 |
| <anonymous> | 0.03 |
| enqueueCommit | 0.02 |
| resolvePackChain | 0.02 |
| walkCommitsByDate | 0.02 |
| finalize$3 | 0.02 |
| readObject | 0.02 |
| parseHeader$1 | 0.02 |
| parseObject | 0.02 |
| removeNode | 0.01 |
| hashHex | 0.01 |
| readEntryHeaderWithChunk | 0.01 |
| looseObjectPath | 0.01 |
| addToHead | 0.01 |

## status

### hotShares

| frame | self |
| --- | --- |
| lstat | 0.22 |
| resolveForMode | 0.15 |
| checkContainment | 0.11 |
| visitEntry | 0.1 |
| validateWorkingTreePath | 0.1 |
| <anonymous> | 0.07 |
| walkInternal$1 | 0.03 |
| basename | 0.03 |
| compareWorkingTreeDelta | 0.02 |
| isContainedIn | 0.02 |
| loadAndParse$1 | 0.02 |
| guard | 0.02 |
| parseIndex | 0.01 |
| runFs | 0.01 |
| joinPath | 0.01 |
| walkInternal | 0.01 |
| sourcesForPath | 0.01 |
| parseTreeContent | 0.01 |
| mapStat | 0.01 |
| loadCappedUtf8 | 0.01 |

## pack-read

### hotShares

| frame | self |
| --- | --- |
| <anonymous> | 0.98 |
| entryOffsets | 0.02 |

## describe

### hotShares

| frame | self |
| --- | --- |
| resolveDirect | 0.25 |
| inflate | 0.25 |
| buildNameMap | 0.25 |
| <anonymous> | 0.25 |

## name-rev

### hotShares

| frame | self |
| --- | --- |
| findFirstValuelessEntry | 0.5 |
| <anonymous> | 0.5 |

## rev-parse

### hotShares

| frame | self |
| --- | --- |

## cat-file

### hotShares

| frame | self |
| --- | --- |

## show

### hotShares

| frame | self |
| --- | --- |
| walkInternal | 0.21 |
| parseTreeContent | 0.19 |
| checkContainment | 0.14 |
| <anonymous> | 0.11 |
| walkTree | 0.07 |
| flattenTree | 0.07 |
| diffTrees$1 | 0.04 |
| collectDeltaChain | 0.02 |
| readEntryHeaderWithChunk | 0.02 |
| lookupPackIndex | 0.02 |
| compareBytes | 0.02 |
| readVariableLengthInt | 0.01 |
| decode$1 | 0.01 |
| readSlice | 0.01 |
| pathContainsNormalized | 0.01 |
| exists | 0.01 |

## diff

### hotShares

| frame | self |
| --- | --- |
| findFirstValuelessEntry | 0.2 |
| evaluate | 0.2 |
| checkContainment | 0.2 |
| collectDeltaChain | 0.2 |
| <anonymous> | 0.2 |

## blame

### hotShares

| frame | self |
| --- | --- |
| checkContainment | 0.24 |
| parseTreeContent | 0.23 |
| walkInternal | 0.21 |
| walkTree | 0.1 |
| flattenTree | 0.09 |
| readSlice | 0.04 |
| collectDeltaChain | 0.03 |
| <anonymous> | 0.02 |
| readEntryHeaderWithChunk | 0.01 |

## commit

### hotShares

| frame | self |
| --- | --- |
| commit$1 | 0.22 |
| commitReflogMessage | 0.11 |
| runFs | 0.11 |
| repoPath | 0.11 |
| realpathForCreation | 0.11 |
| pathContainsNormalized | 0.11 |
| guard | 0.11 |
| check | 0.11 |

### setupShares

| frame | self |
| --- | --- |

_Shared object-write frames reached by both the scratch build and the measured command are attributed to `command`, never `setup`._

## add

### hotShares

| frame | self |
| --- | --- |
| check | 0.25 |
| stageFromStat | 0.13 |
| runFs | 0.13 |
| resolveForMode | 0.13 |
| openRepository | 0.13 |
| <anonymous> | 0.13 |
| pathContainsNormalized | 0.13 |

### setupShares

| frame | self |
| --- | --- |

_Shared object-write frames reached by both the scratch build and the measured command are attributed to `command`, never `setup`._

## merge

### hotShares

| frame | self |
| --- | --- |
| checkContainment | 0.22 |
| exists | 0.09 |
| guard | 0.07 |
| check | 0.07 |
| realpathForCreation | 0.05 |
| basename | 0.04 |
| from | 0.04 |
| mkdir | 0.03 |
| <anonymous> | 0.03 |
| resolveDirect | 0.02 |
| commit$1 | 0.02 |
| assertOperationalRepository | 0.02 |
| validateRefName | 0.02 |
| runFs | 0.02 |
| writeRegularFileStream | 0.01 |
| writeObject | 0.01 |
| tokenizeConfig | 0.01 |
| stripspace | 0.01 |
| streamLooseBlob | 0.01 |
| set | 0.01 |
| serializeAndHash | 0.01 |
| scanKey | 0.01 |
| sanitizeMessage | 0.01 |
| resolveRef | 0.01 |
| resolveCommitter | 0.01 |
| rename | 0.01 |
| readRawConfig | 0.01 |
| peelChain | 0.01 |
| parseLooseRef | 0.01 |
| materializeTree | 0.01 |
| mapStat | 0.01 |
| isKeyHead | 0.01 |
| inflate | 0.01 |
| hasDeclaredId | 0.01 |
| get | 0.01 |
| exceedsMaxIndexBytes | 0.01 |
| evict | 0.01 |
| buildTreeFromIndex | 0.01 |
| assertRepository | 0.01 |
| assertCoreConfigValid | 0.01 |
| applyCommitMessageHooks | 0.01 |
| applyAllEntries | 0.01 |
| appendUtf8 | 0.01 |
| appendReflog | 0.01 |
| throwIfBadChars | 0.01 |
| readConfig | 0.01 |
| pathContainsNormalized | 0.01 |
| dirname | 0.01 |

### setupShares

| frame | self |
| --- | --- |
| bootstrapRepository | 0.01 |

_Shared object-write frames reached by both the scratch build and the measured command are attributed to `command`, never `setup`._
