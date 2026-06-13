# Changelog

## [3.0.0](https://github.com/scolladon/tsgit/compare/v2.0.1...v3.0.0) (2026-06-13)


### ⚠ BREAKING CHANGES

* **status:** correlate staged/unstaged per path with diff endpoints ([#140](https://github.com/scolladon/tsgit/issues/140))
* standardise the commit-ish parameter on `rev` (rev/from-to/ref vocabulary) ([#137](https://github.com/scolladon/tsgit/issues/137))
* **merge:** run/continue/abort namespace, fastForward enum, internal reflog channel ([#136](https://github.com/scolladon/tsgit/issues/136))
* **snapshot:** stop leaking snapshot wiring from the public barrel ([#133](https://github.com/scolladon/tsgit/issues/133))
* **status:** type-changed/mode-changed kinds + unmerged paths ([#128](https://github.com/scolladon/tsgit/issues/128))
* **status:** real index-vs-HEAD staged column (Changes to be committed) ([#127](https://github.com/scolladon/tsgit/issues/127))
* **show,diff:** structured output only — drop cosmetic rendering surface ([#126](https://github.com/scolladon/tsgit/issues/126))

### Features

* **blame:** line-by-line authorship via reverse-diff history walk ([#130](https://github.com/scolladon/tsgit/issues/130)) ([5e542d6](https://github.com/scolladon/tsgit/commit/5e542d68c4e142260c54a98faec09b3e33b871b5))
* **config:** exact subsection identity and raw section-name addressing ([#168](https://github.com/scolladon/tsgit/issues/168)) ([c67bcc2](https://github.com/scolladon/tsgit/commit/c67bcc244af8efd7dabc667410c6f91d90525822))
* **config:** git-faithful quoted-value (un)escaping in the config reader and writer ([#162](https://github.com/scolladon/tsgit/issues/162)) ([3356c5f](https://github.com/scolladon/tsgit/commit/3356c5f13c29822b48201ea5235d148c86f0a9b5))
* **config:** span-aware line surgery for multi-line entries ([#166](https://github.com/scolladon/tsgit/issues/166)) ([586affe](https://github.com/scolladon/tsgit/commit/586affeea5c1171fe7b4eb17dccc58966fb2c215))
* **config:** subsection-name (un)escaping in section headers ([#164](https://github.com/scolladon/tsgit/issues/164)) ([3a5605c](https://github.com/scolladon/tsgit/commit/3a5605c17f403bafef52c8d46ecb63844bf55a59))
* **config:** valueless keys parse as git NULL entries ([#165](https://github.com/scolladon/tsgit/issues/165)) ([0452ce7](https://github.com/scolladon/tsgit/commit/0452ce79e2223867250ecde41ed69fea7601387d))
* conflict-marker size + per-operation conflict labels ([#161](https://github.com/scolladon/tsgit/issues/161)) ([1c96a0c](https://github.com/scolladon/tsgit/commit/1c96a0c7a77ea1b1c2b04d1b1306c038c7100af4))
* converge log/diff onto the read model (log defaults to git date order) ([#142](https://github.com/scolladon/tsgit/issues/142)) ([9e8f183](https://github.com/scolladon/tsgit/commit/9e8f1833c487aada2354564a50039b18d918eb65))
* custom merge drivers (.gitattributes merge=&lt;driver&gt;) ([#159](https://github.com/scolladon/tsgit/issues/159)) ([eac30e5](https://github.com/scolladon/tsgit/commit/eac30e58100ca3da901615557e48e3ab898b7498))
* **describe:** byte-faithful candidate selection (git early-termination) ([#145](https://github.com/scolladon/tsgit/issues/145)) ([a86d101](https://github.com/scolladon/tsgit/commit/a86d101d3d88bc0e74789439b28c9690f40f9f3f))
* **describe:** nearest-tag distance (git describe), structured-output only ([#123](https://github.com/scolladon/tsgit/issues/123)) ([bb22dcb](https://github.com/scolladon/tsgit/commit/bb22dcbc166daedca76912467aa210eaf236ace9))
* **diff:** recursive tree-diff for the shared patch path ([#121](https://github.com/scolladon/tsgit/issues/121)) ([4492407](https://github.com/scolladon/tsgit/commit/4492407b9a8343cafc5b0fd5a3ecf84edda9b319))
* **hooks:** hook coverage parity — prepare-commit-msg, post-commit, post-merge, post-checkout, pre-rebase, post-rewrite ([#158](https://github.com/scolladon/tsgit/issues/158)) ([e9a15c7](https://github.com/scolladon/tsgit/commit/e9a15c7d8481a97639591e9dceec0a7f7de4e586))
* **merge:** add/add content merge + distinct-types rename ([#163](https://github.com/scolladon/tsgit/issues/163)) ([b59717f](https://github.com/scolladon/tsgit/commit/b59717f6fb6b9f360728236c105aea3e41f67efd))
* **merge:** distinct types with a base — per-side renames, symlink pairs, mode-aware conflict writes ([#167](https://github.com/scolladon/tsgit/issues/167)) ([bb7b607](https://github.com/scolladon/tsgit/commit/bb7b607e377aded96b63b6e38be9c4bd62095520))
* **merge:** materialise non-conflict outcomes to the working tree + index ([#156](https://github.com/scolladon/tsgit/issues/156)) ([d346826](https://github.com/scolladon/tsgit/commit/d346826a3c11535a5915627d30613870a69961d0))
* **merge:** union built-in merge driver via per-region content merge ([#160](https://github.com/scolladon/tsgit/issues/160)) ([c886c7a](https://github.com/scolladon/tsgit/commit/c886c7abe43dbdfb6d6d3646787fe249d72317bc))
* **name-rev:** name a commit by the nearest containing ref (+ describe --contains) ([#150](https://github.com/scolladon/tsgit/issues/150)) ([7b8a65c](https://github.com/scolladon/tsgit/commit/7b8a65cdd351aca40c0f75081bb55e6f2c9cf6dd))
* **range-diff:** compare two commit ranges (structured range-diff) ([#148](https://github.com/scolladon/tsgit/issues/148)) ([11605d1](https://github.com/scolladon/tsgit/commit/11605d1f2c557e03109c6ad9f8e0e2afea6e9b5d))
* **read-model:** readFileAt(rev, path) ([#135](https://github.com/scolladon/tsgit/issues/135)) ([6334215](https://github.com/scolladon/tsgit/commit/63342156095a85e2543d835edfbdbef716905c61))
* **read-model:** walkCommitsByDate + foldSubject (23.4b) ([#134](https://github.com/scolladon/tsgit/issues/134)) ([9ebe48b](https://github.com/scolladon/tsgit/commit/9ebe48bdd024571cfee47bb18a0ae0914fc57610))
* **shortlog:** per-author commit summary ([#147](https://github.com/scolladon/tsgit/issues/147)) ([d79b75a](https://github.com/scolladon/tsgit/commit/d79b75a0c71beefe028f33518ccd08becd3083f8))
* **show,diff:** structured output only — drop cosmetic rendering surface ([#126](https://github.com/scolladon/tsgit/issues/126)) ([240cc89](https://github.com/scolladon/tsgit/commit/240cc89ee9f11a10a696eb77d3015a0b716741aa))
* **show:** formatted object output for commit/tag/tree/blob ([#118](https://github.com/scolladon/tsgit/issues/118)) ([9ca696a](https://github.com/scolladon/tsgit/commit/9ca696a63fbb51211b2b8e6d3b66774de746509b))
* **show:** v2 flags (pretty, stat, combined diff, date modes, rev:path) ([#122](https://github.com/scolladon/tsgit/issues/122)) ([a2e8722](https://github.com/scolladon/tsgit/commit/a2e8722e453a527fc49a034511e64caea8fe03dd))
* **status:** carry conflicted-path worktree mode on UnmergedEntry ([#146](https://github.com/scolladon/tsgit/issues/146)) ([6c432ad](https://github.com/scolladon/tsgit/commit/6c432ad9ee26507bfb901e85c39ab125b1b901ac))
* **status:** correlate staged/unstaged per path with diff endpoints ([#140](https://github.com/scolladon/tsgit/issues/140)) ([ace3785](https://github.com/scolladon/tsgit/commit/ace3785bebca44b171064c16613efd63968d1438))
* **status:** real index-vs-HEAD staged column (Changes to be committed) ([#127](https://github.com/scolladon/tsgit/issues/127)) ([4e9f943](https://github.com/scolladon/tsgit/commit/4e9f9433ee9f89f57d0648fe3bb883248d8b82dd))
* **status:** type-changed/mode-changed kinds + unmerged paths ([#128](https://github.com/scolladon/tsgit/issues/128)) ([33fa9f4](https://github.com/scolladon/tsgit/commit/33fa9f4fddc397f8f76f01209e8d7c9c21610fd1))
* **submodule:** network write side — add / update (+ sync --recursive) ([#155](https://github.com/scolladon/tsgit/issues/155)) ([79a9d6e](https://github.com/scolladon/tsgit/commit/79a9d6e37a407d7365babda81b3ce3454bfa850f))
* **submodule:** write side (local) — init/sync/deinit ([#153](https://github.com/scolladon/tsgit/issues/153)) ([dfd397b](https://github.com/scolladon/tsgit/commit/dfd397b133ca5aaf87da071bb1768ee80213c202))
* **whatchanged:** log walk with raw structured changes ([#149](https://github.com/scolladon/tsgit/issues/149)) ([30466f5](https://github.com/scolladon/tsgit/commit/30466f56cb6342abf935786ffc428dd7bf9aa753))
* **worktree:** add / list / move / remove (linked working trees over one gitdir) ([#157](https://github.com/scolladon/tsgit/issues/157)) ([b3c53ef](https://github.com/scolladon/tsgit/commit/b3c53efa0298b66f425341c9acf6b36a6b2670b0))


### Documentation

* **backlog:** add 23.1b for deferred show v2 flags ([#120](https://github.com/scolladon/tsgit/issues/120)) ([f9a1302](https://github.com/scolladon/tsgit/commit/f9a1302040e65ea6e2e7e2aa53f91a7ef827a625))
* **backlog:** reorder Phase 26 so refactoring precedes the perf pass ([#154](https://github.com/scolladon/tsgit/issues/154)) ([6adba12](https://github.com/scolladon/tsgit/commit/6adba128c25bd01537a6e849b3c9812b8212f71e))
* **backlog:** sub-itemize 23.4 API-foundation program; renumber inspection tail ([#132](https://github.com/scolladon/tsgit/issues/132)) ([dd50478](https://github.com/scolladon/tsgit/commit/dd50478e94494aad0a72d926a3225b5e31b5c08b))
* **backlog:** track 23.2b — status staged column (describe --dirty follow-up) ([#124](https://github.com/scolladon/tsgit/issues/124)) ([6285019](https://github.com/scolladon/tsgit/commit/628501938f003856c5a26ddea00e7828dfe13c57))
* **backlog:** track 23.7 (name-rev / describe --contains); multi-arg non-goal ([#125](https://github.com/scolladon/tsgit/issues/125)) ([010cdce](https://github.com/scolladon/tsgit/commit/010cdce1483c30871f7f01f4f2bcb30becc354b4))
* **workflow:** add promote-workflow design-session brief ([aceb5aa](https://github.com/scolladon/tsgit/commit/aceb5aa41b28548e9706eb95cc63a12a503de18a))
* **workflow:** add spelling check to review fix-batch gate ([f38dd6c](https://github.com/scolladon/tsgit/commit/f38dd6c4865cf5bc4021d5af69973693de80f82f))
* **workflow:** gate PR creation on scoped mutation triage ([044a925](https://github.com/scolladon/tsgit/commit/044a9254ea60667f2dd0f37882ff6271f2547c00))
* **workflow:** model-matched delegation, parallel 4-dim reviews, non-blocking mutation ([5d9b915](https://github.com/scolladon/tsgit/commit/5d9b9150db7bfd821c5e70dbcc8e1dc4f265d468))


### Refactor

* consolidate the date-ordered commit priority-queue ([#131](https://github.com/scolladon/tsgit/issues/131)) ([4640a2f](https://github.com/scolladon/tsgit/commit/4640a2fe23fcb635f02d88810622aa9eca902c57))
* **merge:** run/continue/abort namespace, fastForward enum, internal reflog channel ([#136](https://github.com/scolladon/tsgit/issues/136)) ([7f761e4](https://github.com/scolladon/tsgit/commit/7f761e4c49ccfd70e7218fb643852d73665e456f))
* **snapshot:** stop leaking snapshot wiring from the public barrel ([#133](https://github.com/scolladon/tsgit/issues/133)) ([914c15c](https://github.com/scolladon/tsgit/commit/914c15c96a66d6dd4b935144af5c64f0f8552d06))
* standardise the commit-ish parameter on `rev` (rev/from-to/ref vocabulary) ([#137](https://github.com/scolladon/tsgit/issues/137)) ([0339612](https://github.com/scolladon/tsgit/commit/033961228e0f545e7cdeaa30c0c9093c261dd486))

## [2.0.1](https://github.com/scolladon/tsgit/compare/v2.0.0...v2.0.1) (2026-06-02)


### Documentation

* **backlog:** define 26.6 competitor benchmark comparison ([#116](https://github.com/scolladon/tsgit/issues/116)) ([706a7ea](https://github.com/scolladon/tsgit/commit/706a7eab136cfead5893a66f9b38592be4a3fd71))

## [2.0.0](https://github.com/scolladon/tsgit/compare/v1.3.0...v2.0.0) (2026-06-02)


### ⚠ BREAKING CHANGES

* **runbook:** v2.0.0 ships the merged-but-unreleased API breaks from v1.3.0..HEAD — mergeBase(commits, opts) is array-only (was bidirectional); the CRUD porcelain (remote/branch/tag/sparseCheckout) is namespace-only (the callable discriminator form is removed).

### Features

* cherry-pick (single + range) ([#99](https://github.com/scolladon/tsgit/issues/99)) ([2e01738](https://github.com/scolladon/tsgit/commit/2e01738c21549294138a015c6571412a54cccd8b))
* config porcelain on repo.* (nested namespace, all four scopes, quote-on-write) ([#87](https://github.com/scolladon/tsgit/issues/87)) ([c232f23](https://github.com/scolladon/tsgit/commit/c232f238a1b7b45c9513b09b4c11c78aa6da430b))
* CRUD-family porcelain ([#89](https://github.com/scolladon/tsgit/issues/89)) ([9a90ab4](https://github.com/scolladon/tsgit/commit/9a90ab4cb721b838a890f5a77e7c3479246c6296))
* diff patch-text output (`diff({ format: 'patch' })`) ([#84](https://github.com/scolladon/tsgit/issues/84)) ([f667840](https://github.com/scolladon/tsgit/commit/f6678401f5a103a69747c81239b1d8e42a0d1fff))
* faithful commit-message stripspace normalization ([#93](https://github.com/scolladon/tsgit/issues/93)) ([0361668](https://github.com/scolladon/tsgit/commit/03616689bbf3be151314a6e06c6bab85248aa8d0))
* git-faithfulness interop harness for write porcelain (mv/add/rm/reset) ([#95](https://github.com/scolladon/tsgit/issues/95)) ([7fb8264](https://github.com/scolladon/tsgit/commit/7fb82649a6fb68d81b8cceca4c5bc7f14dd59120))
* merge state machine — abortMerge / continueMerge ([#85](https://github.com/scolladon/tsgit/issues/85)) ([d4131f5](https://github.com/scolladon/tsgit/commit/d4131f54a374ee39ca2bf8e6f44683cb82187567))
* multi-base mergeBase (`--all`, `--octopus`) ([#88](https://github.com/scolladon/tsgit/issues/88)) ([2a54c19](https://github.com/scolladon/tsgit/commit/2a54c194d20e487299ae6cb39f4dd9d427927f3b))
* mv — atomic rename in index + working tree ([#92](https://github.com/scolladon/tsgit/issues/92)) ([17d0a0a](https://github.com/scolladon/tsgit/commit/17d0a0a2d47a63b71911f67321ff03b99d311720))
* pull — fetch + merge porcelain on repo.* ([#91](https://github.com/scolladon/tsgit/issues/91)) ([1332bd8](https://github.com/scolladon/tsgit/commit/1332bd85efd7c4fa871887b296b911cf8119ca3f))
* rebase --interactive (pick/reword/edit/squash/fixup/drop) ([#109](https://github.com/scolladon/tsgit/issues/109)) ([4f01b60](https://github.com/scolladon/tsgit/commit/4f01b60c3839129c8379754d6a5641763f00dc98))
* rebase (non-interactive) ([#108](https://github.com/scolladon/tsgit/issues/108)) ([2e17819](https://github.com/scolladon/tsgit/commit/2e17819fa268541ed3a8df9f5f9bd9c4baffb816))
* remote CRUD porcelain (`add`/`remove`/`rename`/`setUrl`/`show`) ([#86](https://github.com/scolladon/tsgit/issues/86)) ([ab51e0a](https://github.com/scolladon/tsgit/commit/ab51e0ae6e735a5ac71d80ffca00536344426a27))
* revert (single + range) ([#103](https://github.com/scolladon/tsgit/issues/103)) ([457a0eb](https://github.com/scolladon/tsgit/commit/457a0eb088ade168afacbb1a9fa6bc3ef2b4e547))
* **rm:** git-faithful safety valve + mutualized working-tree comparison ([#97](https://github.com/scolladon/tsgit/issues/97)) ([5fa805d](https://github.com/scolladon/tsgit/commit/5fa805d68a50423791ca6aca789752cf4579f84b))
* **snapshot:** snapshot+join engine ([#81](https://github.com/scolladon/tsgit/issues/81)) ([7d04c08](https://github.com/scolladon/tsgit/commit/7d04c089682535e6e529012cf6e5f39009a922d2))
* standalone primitives (hashBlob, isIgnored, index CRUD) ([#83](https://github.com/scolladon/tsgit/issues/83)) ([8576b94](https://github.com/scolladon/tsgit/commit/8576b942ce1a2c1419eaa911d6c563f36664b31c))
* stash (push/pop/list/drop/apply) ([#98](https://github.com/scolladon/tsgit/issues/98)) ([b4faece](https://github.com/scolladon/tsgit/commit/b4faecebdd0a5ceaccedcf647ca9c55e0d6d07dd))
* **tooling:** namespace-aware browser-surface audit ([#90](https://github.com/scolladon/tsgit/issues/90)) ([1dbd41e](https://github.com/scolladon/tsgit/commit/1dbd41ed8c9aa556f99cd2b0b660d4ae661dfa72))


### Bug Fixes

* **cherry-pick:** git-faithful abort reflog + close merge-no-mainline mutation gap ([#105](https://github.com/scolladon/tsgit/issues/105)) ([ff55741](https://github.com/scolladon/tsgit/commit/ff5574175ef542904173706bd492bb4482e1b1a5))
* **ref:** skip the no-op abort reflog, document git-faithfulness directive ([#106](https://github.com/scolladon/tsgit/issues/106)) ([16e4542](https://github.com/scolladon/tsgit/commit/16e4542a7c4131e36c3960345165dec12a1c9a8d))


### Documentation

* **backlog:** track cherry-pick abort-reflog + mutation follow-ups as 22.2a ([#104](https://github.com/scolladon/tsgit/issues/104)) ([d04c767](https://github.com/scolladon/tsgit/commit/d04c7677f5c0a4be43e11671ca833788e7fd341d))
* **backlog:** track custom merge drivers as 24.8 ([#101](https://github.com/scolladon/tsgit/issues/101)) ([9eadfb3](https://github.com/scolladon/tsgit/commit/9eadfb331c0b95e5205d5ff7c46419d8ff27a5b3))
* **backlog:** track magic-literal sweep as 26.5 ([#102](https://github.com/scolladon/tsgit/issues/102)) ([9719e58](https://github.com/scolladon/tsgit/commit/9719e58a3aaa8425a42945b3325a330f66675270))
* keep walkTree/walkWorkingTree public; snapshot surface is additive ([#113](https://github.com/scolladon/tsgit/issues/113)) ([2abcc10](https://github.com/scolladon/tsgit/commit/2abcc108939363f942cbd9157c2b4f14bcf23fcd))
* **runbook:** document release-cut footer handling ([0e6af67](https://github.com/scolladon/tsgit/commit/0e6af67f0162b97589deb496c8aa13272e318d88))
* use TypeScript LSP tool instead of Serena in workflow ([a7e54c4](https://github.com/scolladon/tsgit/commit/a7e54c4e9dc61e5be73417ad7dda10e62a1fbe82))
* **workflow:** architecture-refactor phase + --delete-branch merge ([#100](https://github.com/scolladon/tsgit/issues/100)) ([c7880df](https://github.com/scolladon/tsgit/commit/c7880dfbd2fffc6b4f982f62348ad48f3732a8b8))


### Refactor

* **commit-message:** unify the first-line projection into subjectLine ([#111](https://github.com/scolladon/tsgit/issues/111)) ([436d434](https://github.com/scolladon/tsgit/commit/436d43468976f34cd680fd293ddefc98dedc590c))
* **history-rewrite:** centralise commit-read + symbolic-HEAD helpers ([#110](https://github.com/scolladon/tsgit/issues/110)) ([2b42211](https://github.com/scolladon/tsgit/commit/2b42211a469aeec8802622eb8987f825e6687327))

## [1.3.0](https://github.com/scolladon/tsgit/compare/v1.2.0...v1.3.0) (2026-05-25)


### Features

* empty-AAA-section gate + sweep ([#71](https://github.com/scolladon/tsgit/issues/71)) ([62dc683](https://github.com/scolladon/tsgit/commit/62dc683712b066948c106b6dfe3e5ca921ff6e45))
* **harness:** E2E parity (Node x Browser x Memory) ([#76](https://github.com/scolladon/tsgit/issues/76)) ([75a0cde](https://github.com/scolladon/tsgit/commit/75a0cde6fada0cbe5eb6874f8821bba473580fb0))
* **harness:** GWT describe/it split + cancel-on-merge CI ([#72](https://github.com/scolladon/tsgit/issues/72)) ([0d97d5c](https://github.com/scolladon/tsgit/commit/0d97d5c1d5b6a4f7584fd6ad330545934fa6ffcc))
* **harness:** integration-test usefulness audit ([#75](https://github.com/scolladon/tsgit/issues/75)) ([91dfcc6](https://github.com/scolladon/tsgit/commit/91dfcc674ca8fd0bb818b6b9869b1700cf7919b4))
* **harness:** interop suite harness + GIT_* env isolation ([#79](https://github.com/scolladon/tsgit/issues/79)) ([4911c0d](https://github.com/scolladon/tsgit/commit/4911c0df5c6e8312e9bcb96d0816578cab7974f1))
* **harness:** Playwright surface coverage audit ([#77](https://github.com/scolladon/tsgit/issues/77)) ([288caf5](https://github.com/scolladon/tsgit/commit/288caf5203cbe3958c8506f5ce1d7ba38c68343a))
* **harness:** property-based tests for parsers ([#78](https://github.com/scolladon/tsgit/issues/78)) ([69fb435](https://github.com/scolladon/tsgit/commit/69fb4351ae8be2166b13781d5a10382611e054a8))
* **harness:** runtime parity matrix (Deno + Bun + Cloudflare Workers) ([#80](https://github.com/scolladon/tsgit/issues/80)) ([a0470f7](https://github.com/scolladon/tsgit/commit/a0470f702de0cddd731bde08e628b50f0098871b))
* **harness:** scanner support for skipIf/runIf two-stage call shapes ([#74](https://github.com/scolladon/tsgit/issues/74)) ([9b109c1](https://github.com/scolladon/tsgit/commit/9b109c1fecccf317fc4b017127fe6bedf849b26c))
* **harness:** unit-test expressiveness lint ([#70](https://github.com/scolladon/tsgit/issues/70)) ([4db24d2](https://github.com/scolladon/tsgit/commit/4db24d241d8025ef0c5d149b809565903e92e138))
* **mutation:** mutation pyramid ([#67](https://github.com/scolladon/tsgit/issues/67)) ([b511d7f](https://github.com/scolladon/tsgit/commit/b511d7f482753b4595bd7010f7188a401b0179b6))
* **scripts:** testing-pyramid audit ([#69](https://github.com/scolladon/tsgit/issues/69)) ([36975ef](https://github.com/scolladon/tsgit/commit/36975ef0687e2240cf6357cc8564285dcdb93804))

## [1.2.0](https://github.com/scolladon/tsgit/compare/v1.1.0...v1.2.0) (2026-05-23)


### Features

* cat-file --batch equivalent ([#63](https://github.com/scolladon/tsgit/issues/63)) ([272c00d](https://github.com/scolladon/tsgit/commit/272c00daa77fc0cc1bfde4a0d71c2c8104c98e37))
* git hooks — pre-commit, commit-msg, pre-push ([#57](https://github.com/scolladon/tsgit/issues/57)) ([c85927a](https://github.com/scolladon/tsgit/commit/c85927affc72730784b3bd1b60ed521ec1a7a90a))
* partial clone — --filter + lazy-fetch on read ([#61](https://github.com/scolladon/tsgit/issues/61)) ([2ad72af](https://github.com/scolladon/tsgit/commit/2ad72aff9f22f4732aa04006bdc990db38e3a0d4))
* reflog — .git/logs writers, @{N}/@{date} revparse, and the reflog command ([#54](https://github.com/scolladon/tsgit/issues/54)) ([b3cea6d](https://github.com/scolladon/tsgit/commit/b3cea6dfd73642464be4e0d007e3fc9c28c6c1b7))
* sparse checkout (Phase 17.3) ([#58](https://github.com/scolladon/tsgit/issues/58)) ([38f345e](https://github.com/scolladon/tsgit/commit/38f345eeb1d72ffff61db5c816f27955b00af8f1))
* sparse-checkout awareness in reset / merge (17.3a) ([#59](https://github.com/scolladon/tsgit/issues/59)) ([066ba21](https://github.com/scolladon/tsgit/commit/066ba21718d15bafc8bdc81289fe1418ffffb14d))
* submodule walk (17.5) ([#62](https://github.com/scolladon/tsgit/issues/62)) ([cfacf2b](https://github.com/scolladon/tsgit/commit/cfacf2b154c8e4b945ac86b48ec5bd4532ebe8c5))


### Bug Fixes

* harden compileGlob against ReDoS (17.3b) ([#60](https://github.com/scolladon/tsgit/issues/60)) ([aef8dc2](https://github.com/scolladon/tsgit/commit/aef8dc253528a7513ca6ec9da7bbb55fff48f07b))


### Documentation

* **adr:** 091 abandon isomorphic-git compatibility shim ([#64](https://github.com/scolladon/tsgit/issues/64)) ([6160086](https://github.com/scolladon/tsgit/commit/6160086c89ee215b875d7a4f3780d28e87af2787))
* audience-first doc restructure ([#65](https://github.com/scolladon/tsgit/issues/65)) ([5cb6a6b](https://github.com/scolladon/tsgit/commit/5cb6a6ba9e98cae2fcd7a6d8e65626a5abe9b4a9))
* **backlog:** add documentation-polish task (18.2) ([#56](https://github.com/scolladon/tsgit/issues/56)) ([acb9c62](https://github.com/scolladon/tsgit/commit/acb9c62410770df1ad21f17a99e062338322a22d))

## [1.1.0](https://github.com/scolladon/tsgit/compare/v1.0.0...v1.1.0) (2026-05-21)


### Features

* **add:** bulk-mode add --all walks the working tree (§14.1) ([#39](https://github.com/scolladon/tsgit/issues/39)) ([8cd131f](https://github.com/scolladon/tsgit/commit/8cd131f1206e8533dbb63eedc8f78a20d9a60838))
* **bench:** clone:small-repo scenario vs isomorphic-git (Phase 12.4) ([#29](https://github.com/scolladon/tsgit/issues/29)) ([7e41388](https://github.com/scolladon/tsgit/commit/7e413881902fd6346edf2eec96109c1f136799dc))
* **checkout:** materialize working tree + index on switch & path-restore (Phase 13.1) ([#30](https://github.com/scolladon/tsgit/issues/30)) ([62336f3](https://github.com/scolladon/tsgit/commit/62336f3b89c7f2bc1d54876ce9c4ffe53b7022e2))
* **checkout:** path-restore source: 'index' uses staged content ([#34](https://github.com/scolladon/tsgit/issues/34)) ([2af0f1e](https://github.com/scolladon/tsgit/commit/2af0f1ecfe511a9d91e0129edfe683039b9da2c1))
* clone smart-HTTP pack fetch ([#26](https://github.com/scolladon/tsgit/issues/26)) ([22f0594](https://github.com/scolladon/tsgit/commit/22f0594a8c62fa19e53d9e2be0993985fc50d7d7))
* **fetch:** real upload-pack-driven fetch + shallow + prune ([#27](https://github.com/scolladon/tsgit/issues/27)) ([d7ecbac](https://github.com/scolladon/tsgit/commit/d7ecbac4302b2e3911e67b378c8acf0b53644b83))
* **gitignore:** real .gitignore evaluation + status untracked (§14.3) ([#41](https://github.com/scolladon/tsgit/issues/41)) ([49a147e](https://github.com/scolladon/tsgit/commit/49a147e01f56fd0231f21f20f4f4c0817c7d9b10))
* **merge:** clean-merge three-way tree walk ([#36](https://github.com/scolladon/tsgit/issues/36)) ([af6de38](https://github.com/scolladon/tsgit/commit/af6de38608353eb7d12ad4b83d137940fa9f5c56))
* **merge:** persist conflict state for three-way merges ([#38](https://github.com/scolladon/tsgit/issues/38)) ([5ecd61a](https://github.com/scolladon/tsgit/commit/5ecd61a99e087de5c16669944486c28eb9e87cf9))
* **pathspec:** globs across add/rm/checkout ([#42](https://github.com/scolladon/tsgit/issues/42)) ([963a72b](https://github.com/scolladon/tsgit/commit/963a72b9d86dfc622e6905a5ffa30066a7d6153a))
* **push:** receive-pack negotiation + pack send + force-with-lease (Phase 12.3) ([#28](https://github.com/scolladon/tsgit/issues/28)) ([a191a35](https://github.com/scolladon/tsgit/commit/a191a353129d43ab8400c6cd240c16a61183e28a))
* **read-object:** bounded-size reads + parallel-capped merge blob fetch ([#37](https://github.com/scolladon/tsgit/issues/37)) ([3ca03a7](https://github.com/scolladon/tsgit/commit/3ca03a7a1820ee89b2b3e4bc3e902fb2c098b4e8))
* **reset:** hard mode materialises index and working tree ([#32](https://github.com/scolladon/tsgit/issues/32)) ([b620a0a](https://github.com/scolladon/tsgit/commit/b620a0a522134196e0110aafad0e02110ae8e523))
* **reset:** mixed mode rebuilds index from target tree (Phase 13.2) ([#31](https://github.com/scolladon/tsgit/issues/31)) ([f0039d3](https://github.com/scolladon/tsgit/commit/f0039d3e3e2ad620884fffe63456097fff995032))
* **windows:** full windows support ([e9e82e6](https://github.com/scolladon/tsgit/commit/e9e82e61a2d5c9dcbb4c16b2ae3db1a0e52d9ba8))


### Bug Fixes

* **checkout:** acquire index lock before readIndex — close TOCTOU (Phase 13.5) ([#33](https://github.com/scolladon/tsgit/issues/33)) ([26889c0](https://github.com/scolladon/tsgit/commit/26889c00eb8a27d2f9c4122959108344fba62f24))
* **index-parser:** reject unsafe paths at parse time ([#35](https://github.com/scolladon/tsgit/issues/35)) ([f298989](https://github.com/scolladon/tsgit/commit/f2989894531927bb83707d7895932f8665f6f077))
* **windows:** strip extended-length prefix in normalizeForCompare ([#46](https://github.com/scolladon/tsgit/issues/46)) ([e5aad39](https://github.com/scolladon/tsgit/commit/e5aad397b99122e0011cee87c609ae435e3abec9))


### Documentation

* **backlog:** close Phase 11 — v1.0.0 shipped ([#23](https://github.com/scolladon/tsgit/issues/23)) ([7986929](https://github.com/scolladon/tsgit/commit/7986929d68325fa1d7489f9f2498de817e65d96d))
* **backlog:** correct stale 5.2/13.4 markers, clarify 11.2 ([#47](https://github.com/scolladon/tsgit/issues/47)) ([5da3b52](https://github.com/scolladon/tsgit/commit/5da3b52a7d462844fdde72543943049c4a5d3e47))
* **claude-md:** codify the 8-step 'apply the workflow' sequence ([#24](https://github.com/scolladon/tsgit/issues/24)) ([f575041](https://github.com/scolladon/tsgit/commit/f5750411ee0066f26ea81346be28aa1bc985976c))
* **claude-md:** tick BACKLOG inside the PR's own commits, not after merge ([#25](https://github.com/scolladon/tsgit/issues/25)) ([1c23aae](https://github.com/scolladon/tsgit/commit/1c23aae81c6737bf6cfe4ba6bbdc903d77f00584))


### Refactor

* perf, secu, architectures and tests ([#45](https://github.com/scolladon/tsgit/issues/45)) ([478e8a3](https://github.com/scolladon/tsgit/commit/478e8a3eec953619f1f75446e72a944b29985e50))

## [1.0.0](https://github.com/scolladon/tsgit/compare/v0.9.0...v1.0.0) (2026-05-17)


### ⚠ BREAKING CHANGES

* drops the re-exports of @internal RuntimeFallback and RepositoryLayoutInput from src/index.{node,browser,default}.ts. The runtime fallback shape was never user-facing — shims build it internally — but consumers importing these types from a public entry point must switch to importing OpenRepositoryOptions / Repository alone (or pin to 0.x).

### Features

* add complete engineering harness ([85d3e1b](https://github.com/scolladon/tsgit/commit/85d3e1ba2d3e1cf7109e4b0ae0c8212c363e2837))
* add phase 10 — repository facade ([c31fb69](https://github.com/scolladon/tsgit/commit/c31fb6970fbe9b58d1c3101f414b5a5ebc0b9671))
* add phase 4 — ports and adapters (hexagonal boundary) ([0a58115](https://github.com/scolladon/tsgit/commit/0a58115c4be5ab26618dbef6defc10d392c38edf))
* **commands:** add phase 9 — tier 1 commands ([588b85d](https://github.com/scolladon/tsgit/commit/588b85d602ee6bc1d57ab8b9428a208629e0e304))
* **domain:** add Phase 1 domain object model ([748e613](https://github.com/scolladon/tsgit/commit/748e6135ed83b3e28cc899ed4deeab9fd931fcba))
* **domain:** add Phase 2 object storage layer ([b4d8e84](https://github.com/scolladon/tsgit/commit/b4d8e84ff1abcaa0cc7abe8e1a2985e2c67e716d))
* **domain:** add Phase 3 — refs and git index ([0796851](https://github.com/scolladon/tsgit/commit/07968510527de836d2b410914928aec5c0155109))
* **domain:** add phase 5 — diff and merge ([27fdef6](https://github.com/scolladon/tsgit/commit/27fdef6cac6ba5b511be654ddafa56e12eca32d3))
* **operators:** add phase 6 — operators ([9ffed36](https://github.com/scolladon/tsgit/commit/9ffed36c92015d78eede93a0f9e5cc78831dd385))
* phase 11 — polish & launch ([eaa48a3](https://github.com/scolladon/tsgit/commit/eaa48a39ccabdac1fe0b8217d142fedd39ae9e1d))
* **primitives:** phase 7 — tier 2 building blocks ([a70e442](https://github.com/scolladon/tsgit/commit/a70e4429fb88392e6cf0708d66ed58efcb7e8faf))
* **transport:** add phase 8 — smart HTTP and middleware ([cae5035](https://github.com/scolladon/tsgit/commit/cae503560b718f5fb788f25483672219f37ad5c6))


### Bug Fixes

* **examples:** correct tree/file mode mapping in try-on-self demo ([7663e68](https://github.com/scolladon/tsgit/commit/7663e6822df9228ec67038e080dd8fa6707e7a57))


### Documentation

* add domain object model design ([6367f61](https://github.com/scolladon/tsgit/commit/6367f61e5f8123877b060e47c89590896e9f192f))
* add Phase 1 implementation plan ([47efc18](https://github.com/scolladon/tsgit/commit/47efc18d1a020aecda6f7d5b2b6d65c592f93301))
* add Phase 10 facade design ([e98baed](https://github.com/scolladon/tsgit/commit/e98baedd7eeb363898b7278c0625d953870c270c))
* add Phase 10 facade implementation plan ([26ae925](https://github.com/scolladon/tsgit/commit/26ae92534b2feca23d59377e7da7b25780d55a0e))
* add Phase 11 launch design ([e815059](https://github.com/scolladon/tsgit/commit/e815059f6378a20bd2d291f1d266094a1bf3771b))
* add Phase 11 launch implementation plan ([2bddba4](https://github.com/scolladon/tsgit/commit/2bddba43d198e6c3b09d7696f10a955382326b84))
* add Phase 2 implementation plan ([1be2d1f](https://github.com/scolladon/tsgit/commit/1be2d1f8b57964bd951f1ff38d10eeeb9f7dba09))
* add Phase 2 object storage design and error extension ADR ([eb92935](https://github.com/scolladon/tsgit/commit/eb9293541a6bf889775da21c5644b788d6a5226d))
* add Phase 3 implementation plan ([2f7d638](https://github.com/scolladon/tsgit/commit/2f7d6388c1b65182863fd3744d1eb5c24258690f))
* add Phase 3 refs and index design document ([72f13c2](https://github.com/scolladon/tsgit/commit/72f13c2645a08deebe31e5c007a4b806159cfb2a))
* add Phase 4 implementation plan ([eacd4e6](https://github.com/scolladon/tsgit/commit/eacd4e61d14bddeb1272fd622246a5262602e703))
* add Phase 4 ports and adapters design document ([b701881](https://github.com/scolladon/tsgit/commit/b701881dba6ba76512da51fd0a1fbf9cb14d556e))
* add Phase 6 operators design document ([ee19f4a](https://github.com/scolladon/tsgit/commit/ee19f4a274e32b3d6f9c9c2dca34706268b7613a))
* add Phase 6 operators implementation plan ([88644e4](https://github.com/scolladon/tsgit/commit/88644e41d3f0c99bd664745b79f23faadc999238))
* add Phase 7 primitives design document ([735451c](https://github.com/scolladon/tsgit/commit/735451c87aaa3ce1125b446b18a588394aca5247))
* add Phase 7 primitives implementation plan ([cda556b](https://github.com/scolladon/tsgit/commit/cda556bee69f858f15e70faa00e829ed1484421a))
* add Phase 8 transport design document ([5effa63](https://github.com/scolladon/tsgit/commit/5effa63b6a9f07b8420f1c071120303ba687d10b))
* add Phase 8 transport implementation plan ([68b7814](https://github.com/scolladon/tsgit/commit/68b7814ace69a494e585bfd8688f05c118a4f1d1))
* add Phase 9 commands design ([727691a](https://github.com/scolladon/tsgit/commit/727691a37599144a256cc89a7e0e6c4296063844))
* add Phase 9 commands implementation plan ([8f3af36](https://github.com/scolladon/tsgit/commit/8f3af367c62d83f3a7301534981207511927bb80))
* add v1 backlog ([56067cf](https://github.com/scolladon/tsgit/commit/56067cf554e2b9e7c792d71676bd330fd070d392))
* **backlog:** add post-v1 work items for Phase 12–17 + Phase 11 admin tail ([1a7cded](https://github.com/scolladon/tsgit/commit/1a7cded39c4037549480f0265cae83fb987b97d7))
* document mandatory development workflow in CLAUDE.md ([4afbf62](https://github.com/scolladon/tsgit/commit/4afbf62b0802edd9f8a72bca3e081ecae8d37e22))
