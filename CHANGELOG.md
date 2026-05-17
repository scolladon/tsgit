# Changelog

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
