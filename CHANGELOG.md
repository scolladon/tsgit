# Changelog

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
