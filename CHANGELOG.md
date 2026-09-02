# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.2.1](https://github.com/MiniGod/agendo/compare/v0.2.0...v0.2.1) (2026-09-02)


### Bug Fixes

* **detection:** split "main agent busy" from "session still working" ([#44](https://github.com/MiniGod/agendo/issues/44)) ([#48](https://github.com/MiniGod/agendo/issues/48)) ([f568c90](https://github.com/MiniGod/agendo/commit/f568c9047d8780caee6b8810f3e2df8a0cff62ac)), closes [#47](https://github.com/MiniGod/agendo/issues/47) [#41](https://github.com/MiniGod/agendo/issues/41)
* **hooks:** bound the pre-push lint range at the merge-base with master ([#64](https://github.com/MiniGod/agendo/issues/64)) ([0480123](https://github.com/MiniGod/agendo/commit/0480123022f1fa5505ed6705fbdc6f7a219c02dc))
* **tmux:** address session options through a valid pane target ([#66](https://github.com/MiniGod/agendo/issues/66)) ([8dd89d3](https://github.com/MiniGod/agendo/commit/8dd89d3676f014034cda7e706d6205c78d8c3646)), closes [#45](https://github.com/MiniGod/agendo/issues/45) [#45](https://github.com/MiniGod/agendo/issues/45)
* **transcripts:** recover the intact record from a torn JSONL append ([#53](https://github.com/MiniGod/agendo/issues/53)) ([fcae55b](https://github.com/MiniGod/agendo/commit/fcae55b8352432bea7af49de05a4e650d0e07e67))


### Refactoring

* **ado:** split src/ado.ts into six modules ([#57](https://github.com/MiniGod/agendo/issues/57)) ([515c382](https://github.com/MiniGod/agendo/commit/515c382322c2a8bbb6f24b1265e84b1f15f0bdad)), closes [#54](https://github.com/MiniGod/agendo/issues/54) [#55](https://github.com/MiniGod/agendo/issues/55) [#56](https://github.com/MiniGod/agendo/issues/56)
* **cli:** split src/index.tsx and delete the last exemption ([#62](https://github.com/MiniGod/agendo/issues/62)) ([8b5dd9c](https://github.com/MiniGod/agendo/commit/8b5dd9c668ac41b36fafbad43bf99857238be5ef))
* **clone:** split src/clone.ts into src/clone/ and drop the ratchet to 555 ([#60](https://github.com/MiniGod/agendo/issues/60)) ([4bbcb4b](https://github.com/MiniGod/agendo/commit/4bbcb4bc35c98a9b88c36b860691a1868cc718f9)), closes [#54](https://github.com/MiniGod/agendo/issues/54) [#55](https://github.com/MiniGod/agendo/issues/55) [#56](https://github.com/MiniGod/agendo/issues/56) [#57](https://github.com/MiniGod/agendo/issues/57) [#58](https://github.com/MiniGod/agendo/issues/58) [#59](https://github.com/MiniGod/agendo/issues/59)
* **launch:** split src/launch.ts into four modules ([#56](https://github.com/MiniGod/agendo/issues/56)) ([d9ec46d](https://github.com/MiniGod/agendo/commit/d9ec46d17cf37b2f275218142565677583cbcf2a)), closes [#54](https://github.com/MiniGod/agendo/issues/54) [#55](https://github.com/MiniGod/agendo/issues/55) [#54](https://github.com/MiniGod/agendo/issues/54) [#55](https://github.com/MiniGod/agendo/issues/55)
* **sessions:** split src/sessions.ts into src/sessions/ ([#58](https://github.com/MiniGod/agendo/issues/58)) ([1294ecb](https://github.com/MiniGod/agendo/commit/1294ecbd9744400ce1f409d423c2507ff06f5397)), closes [#54](https://github.com/MiniGod/agendo/issues/54) [#55](https://github.com/MiniGod/agendo/issues/55) [#56](https://github.com/MiniGod/agendo/issues/56) [#57](https://github.com/MiniGod/agendo/issues/57)
* split App.tsx and index.tsx along their seams, and spend the ratchet ([#41](https://github.com/MiniGod/agendo/issues/41)) ([01257cf](https://github.com/MiniGod/agendo/commit/01257cf78ac5575b9bf24a328d0132412fb75fc7)), closes [#40](https://github.com/MiniGod/agendo/issues/40) [#39](https://github.com/MiniGod/agendo/issues/39) [#40](https://github.com/MiniGod/agendo/issues/40) [#39](https://github.com/MiniGod/agendo/issues/39)
* split format.ts, restore.ts and model.ts, landing the ratchet at 486 ([#61](https://github.com/MiniGod/agendo/issues/61)) ([9d9c1b7](https://github.com/MiniGod/agendo/commit/9d9c1b7d0cdc6a0d216f17ce9d330c9a0a0d7443)), closes [#54](https://github.com/MiniGod/agendo/issues/54) [#55](https://github.com/MiniGod/agendo/issues/55) [#56](https://github.com/MiniGod/agendo/issues/56) [#57](https://github.com/MiniGod/agendo/issues/57) [#58](https://github.com/MiniGod/agendo/issues/58) [#59](https://github.com/MiniGod/agendo/issues/59) [#60](https://github.com/MiniGod/agendo/issues/60) [#59](https://github.com/MiniGod/agendo/issues/59)
* **tmux:** split src/tmux.ts into src/tmux/ and delete its ratchet exemption ([#54](https://github.com/MiniGod/agendo/issues/54)) ([95843a1](https://github.com/MiniGod/agendo/commit/95843a1b2e5067014d791130fbc3e8bfaf609069))
* **ui:** split src/ui/App.tsx and drop its complexity exemption ([#55](https://github.com/MiniGod/agendo/issues/55)) ([2ed55f4](https://github.com/MiniGod/agendo/commit/2ed55f4fcdd346c501b8263d9e3c5e507a6f832e)), closes [#54](https://github.com/MiniGod/agendo/issues/54) [#54](https://github.com/MiniGod/agendo/issues/54)
* **wait:** split src/wait.ts into src/wait/ and drop the ratchet to 696 ([#59](https://github.com/MiniGod/agendo/issues/59)) ([6d3013d](https://github.com/MiniGod/agendo/commit/6d3013dab4b19b10ecdd22115ca92682ea812ca2)), closes [#54](https://github.com/MiniGod/agendo/issues/54) [#55](https://github.com/MiniGod/agendo/issues/55) [#56](https://github.com/MiniGod/agendo/issues/56) [#57](https://github.com/MiniGod/agendo/issues/57) [#58](https://github.com/MiniGod/agendo/issues/58)


### Documentation

* **cli:** say that close refuses a session whose subagent is running ([#67](https://github.com/MiniGod/agendo/issues/67)) ([72c12de](https://github.com/MiniGod/agendo/commit/72c12deff94a9da0734b84e74a73044491087d53)), closes [#44](https://github.com/MiniGod/agendo/issues/44) [#44](https://github.com/MiniGod/agendo/issues/44) [#45](https://github.com/MiniGod/agendo/issues/45)
* verify the README against the built binary and refresh the hero ([#45](https://github.com/MiniGod/agendo/issues/45)) ([45929bc](https://github.com/MiniGod/agendo/commit/45929bc2f6521a732bde612b6898e353eb0bac0b)), closes [#41](https://github.com/MiniGod/agendo/issues/41) [#54](https://github.com/MiniGod/agendo/issues/54) [#63](https://github.com/MiniGod/agendo/issues/63) [#64](https://github.com/MiniGod/agendo/issues/64) [#44](https://github.com/MiniGod/agendo/issues/44) [#48](https://github.com/MiniGod/agendo/issues/48) [#44](https://github.com/MiniGod/agendo/issues/44)

## [0.2.0](https://github.com/MiniGod/agendo/compare/v0.1.1...v0.2.0) (2026-08-20)


### Features

* add Codex CLI support ([#35](https://github.com/MiniGod/agendo/issues/35)) ([46105b3](https://github.com/MiniGod/agendo/commit/46105b3061b754bce3856ae796b1ee5d835b023e))
* **cli:** add `agendo close` to end a session without touching its worktree ([#28](https://github.com/MiniGod/agendo/issues/28)) ([4b42ce7](https://github.com/MiniGod/agendo/commit/4b42ce7fdcb12b624e0771ed98eb58a05bf68c1f))
* **cli:** emit full PR / work-item URLs and add `agendo open` ([#24](https://github.com/MiniGod/agendo/issues/24)) ([1550538](https://github.com/MiniGod/agendo/commit/15505387218e0c95e7b3d98132a36468247fd995))
* **cli:** forward allowlisted agent flags from `agendo launch` ([#11](https://github.com/MiniGod/agendo/issues/11)) ([d719a9b](https://github.com/MiniGod/agendo/commit/d719a9b15c8945715cff7b6f79a5368564150138))
* **cli:** scope list/status/wait to a path or repo ([#23](https://github.com/MiniGod/agendo/issues/23)) ([fe685c3](https://github.com/MiniGod/agendo/commit/fe685c3eab8ea52bcb0be124e03584bd52847bbe))
* **cli:** show how far a compacting session has got ([#34](https://github.com/MiniGod/agendo/issues/34)) ([5ca0416](https://github.com/MiniGod/agendo/commit/5ca04163bb55d91d4d062c0563c2b16d22073e0a)), closes [#33](https://github.com/MiniGod/agendo/issues/33) [#33](https://github.com/MiniGod/agendo/issues/33) [#33](https://github.com/MiniGod/agendo/issues/33)
* **cli:** show when a limited session's usage limit resets in `list` ([#22](https://github.com/MiniGod/agendo/issues/22)) ([c4c4641](https://github.com/MiniGod/agendo/commit/c4c464153b2a202c5d01034a17d4710809e7b977)), closes [#25](https://github.com/MiniGod/agendo/issues/25) [#25](https://github.com/MiniGod/agendo/issues/25) [#23](https://github.com/MiniGod/agendo/issues/23) [#30](https://github.com/MiniGod/agendo/issues/30) [#27](https://github.com/MiniGod/agendo/issues/27)
* **cli:** surface idle age and flag stalled sessions in list/status ([#26](https://github.com/MiniGod/agendo/issues/26)) ([3f3329d](https://github.com/MiniGod/agendo/commit/3f3329d486728720a2bcdfc284b796932c658ecb))
* clone a repo from a pasted URL and start a session in it ([#29](https://github.com/MiniGod/agendo/issues/29)) ([d882f43](https://github.com/MiniGod/agendo/commit/d882f43f9b5c8c4c8601b2cdcac8b24ae2630f12)), closes [#13](https://github.com/MiniGod/agendo/issues/13)
* detect Claude Workflow runs and surface them in the CLI ([#12](https://github.com/MiniGod/agendo/issues/12)) ([62c39ae](https://github.com/MiniGod/agendo/commit/62c39ae81e780731bc8ef228dd5abc17ccc06f9e))
* filter issues and PRs to repos inside the target directory ([#13](https://github.com/MiniGod/agendo/issues/13)) ([e90119a](https://github.com/MiniGod/agendo/commit/e90119a6d088a6dec1e88158d6010510f9fb58fa))
* make orchestrator mode a first-class citizen ([#15](https://github.com/MiniGod/agendo/issues/15)) ([8d3f582](https://github.com/MiniGod/agendo/commit/8d3f582495e606feb503c313418aca2c1b376bbb))
* **send:** answer claude's resume dialog instead of reporting it blocked ([#30](https://github.com/MiniGod/agendo/issues/30)) ([cdb059f](https://github.com/MiniGod/agendo/commit/cdb059f69884ac2016d8b591215dfecb11654a12)), closes [#19](https://github.com/MiniGod/agendo/issues/19) [#20](https://github.com/MiniGod/agendo/issues/20) [#21](https://github.com/MiniGod/agendo/issues/21) [#29](https://github.com/MiniGod/agendo/issues/29) [#25](https://github.com/MiniGod/agendo/issues/25) [#27](https://github.com/MiniGod/agendo/issues/27) [#25](https://github.com/MiniGod/agendo/issues/25) [#27](https://github.com/MiniGod/agendo/issues/27) [#27](https://github.com/MiniGod/agendo/issues/27) [#27](https://github.com/MiniGod/agendo/issues/27)
* **send:** deliver prompts over claude's messaging socket, falling back to tmux ([#31](https://github.com/MiniGod/agendo/issues/31)) ([27eff84](https://github.com/MiniGod/agendo/commit/27eff8419d7a3cfff3769499607c1431426f6e57)), closes [#38](https://github.com/MiniGod/agendo/issues/38) [#38](https://github.com/MiniGod/agendo/issues/38) [#38](https://github.com/MiniGod/agendo/issues/38) [#30](https://github.com/MiniGod/agendo/issues/30) [#30](https://github.com/MiniGod/agendo/issues/30) [#30](https://github.com/MiniGod/agendo/issues/30) [#30](https://github.com/MiniGod/agendo/issues/30) [#30](https://github.com/MiniGod/agendo/issues/30) [#30](https://github.com/MiniGod/agendo/issues/30) [#28](https://github.com/MiniGod/agendo/issues/28) [#28](https://github.com/MiniGod/agendo/issues/28) [#19](https://github.com/MiniGod/agendo/issues/19) [#30](https://github.com/MiniGod/agendo/issues/30) [#38](https://github.com/MiniGod/agendo/issues/38) [#25](https://github.com/MiniGod/agendo/issues/25) [#23](https://github.com/MiniGod/agendo/issues/23) [#26](https://github.com/MiniGod/agendo/issues/26) [#30](https://github.com/MiniGod/agendo/issues/30) [#29](https://github.com/MiniGod/agendo/issues/29) [#25](https://github.com/MiniGod/agendo/issues/25) [#27](https://github.com/MiniGod/agendo/issues/27) [#30](https://github.com/MiniGod/agendo/issues/30) [#23](https://github.com/MiniGod/agendo/issues/23) [#15](https://github.com/MiniGod/agendo/issues/15) [#30](https://github.com/MiniGod/agendo/issues/30) [#23](https://github.com/MiniGod/agendo/issues/23) [#23](https://github.com/MiniGod/agendo/issues/23) [#30](https://github.com/MiniGod/agendo/issues/30) [#15](https://github.com/MiniGod/agendo/issues/15) [#15](https://github.com/MiniGod/agendo/issues/15) [#28](https://github.com/MiniGod/agendo/issues/28) [#22](https://github.com/MiniGod/agendo/issues/22) [#24](https://github.com/MiniGod/agendo/issues/24) [#26](https://github.com/MiniGod/agendo/issues/26) [#32](https://github.com/MiniGod/agendo/issues/32) [#33](https://github.com/MiniGod/agendo/issues/33) [#34](https://github.com/MiniGod/agendo/issues/34) [#33](https://github.com/MiniGod/agendo/issues/33) [#34](https://github.com/MiniGod/agendo/issues/34) [#36](https://github.com/MiniGod/agendo/issues/36) [#38](https://github.com/MiniGod/agendo/issues/38) [#13](https://github.com/MiniGod/agendo/issues/13) [#38](https://github.com/MiniGod/agendo/issues/38) [#15](https://github.com/MiniGod/agendo/issues/15)
* **ui:** move a session to another Claude profile ([#19](https://github.com/MiniGod/agendo/issues/19)) ([2c5930b](https://github.com/MiniGod/agendo/commit/2c5930b98fe7fbcf5107e9569ec18322c0597055))
* **ui:** offer the scoped folder as a new-session repo even with no sessions ([#10](https://github.com/MiniGod/agendo/issues/10)) ([459d94c](https://github.com/MiniGod/agendo/commit/459d94c22219d48dd8bdefdec6b57cfbe4b2ce12)), closes [#8](https://github.com/MiniGod/agendo/issues/8) [#9](https://github.com/MiniGod/agendo/issues/9)
* **wait:** make `agendo wait` a usable notification primitive ([#25](https://github.com/MiniGod/agendo/issues/25)) ([df8b141](https://github.com/MiniGod/agendo/commit/df8b141700acdb03bc22e562cdb7912834dafccf))


### Bug Fixes

* **ado:** tolerate a 404 from the current-iteration endpoint ([#21](https://github.com/MiniGod/agendo/issues/21)) ([091bae9](https://github.com/MiniGod/agendo/commit/091bae92b305779e4b448d1e9fb6a3ca0d40c720)), closes [#18](https://github.com/MiniGod/agendo/issues/18) [#18](https://github.com/MiniGod/agendo/issues/18) [#18](https://github.com/MiniGod/agendo/issues/18) [#18](https://github.com/MiniGod/agendo/issues/18)
* **agents:** make resume discoverable and propagate the launcher's own invocation ([#38](https://github.com/MiniGod/agendo/issues/38)) ([8a423d6](https://github.com/MiniGod/agendo/commit/8a423d642c1d8051eaddd011efc458e950aae959))
* detect usage limit when a task panel sits above the input box ([#14](https://github.com/MiniGod/agendo/issues/14)) ([0546101](https://github.com/MiniGod/agendo/commit/054610128a7e4a5dc7bf1b0beca863b864d736a0))
* **detect:** read busy and compacting from the live status line ([#33](https://github.com/MiniGod/agendo/issues/33)) ([a485b9c](https://github.com/MiniGod/agendo/commit/a485b9c35861d8e2732af2804a061007c36e4b85)), closes [#30](https://github.com/MiniGod/agendo/issues/30) [#30](https://github.com/MiniGod/agendo/issues/30)
* **restore:** let q/Esc close a paused tab and re-pause it on agent exit ([#36](https://github.com/MiniGod/agendo/issues/36)) ([2e80f90](https://github.com/MiniGod/agendo/commit/2e80f90d61c5363e1422e7c1c58c3b14301d4b61))
* say what failed to parse, and auto-retry transient load failures ([#27](https://github.com/MiniGod/agendo/issues/27)) ([9685b0a](https://github.com/MiniGod/agendo/commit/9685b0a9ec5183906b29d1b845aaa9121103b1bd)), closes [#18](https://github.com/MiniGod/agendo/issues/18) [#18](https://github.com/MiniGod/agendo/issues/18) [#21](https://github.com/MiniGod/agendo/issues/21) [#21](https://github.com/MiniGod/agendo/issues/21) [#18](https://github.com/MiniGod/agendo/issues/18) [#21](https://github.com/MiniGod/agendo/issues/21)
* **tmux:** address managed windows through their host session ([#47](https://github.com/MiniGod/agendo/issues/47)) ([b91dcae](https://github.com/MiniGod/agendo/commit/b91dcae33f8be82404defa38bc7563a564e4fedd)), closes [#39](https://github.com/MiniGod/agendo/issues/39)
* **tmux:** don't read a greyed-out autocomplete suggestion as typed input ([#16](https://github.com/MiniGod/agendo/issues/16)) ([0eea318](https://github.com/MiniGod/agendo/commit/0eea31818cd1c25bd978c15026d86938be43647c))
* **ui:** let a user with zero sessions create their first one ([#20](https://github.com/MiniGod/agendo/issues/20)) ([cb8f47a](https://github.com/MiniGod/agendo/commit/cb8f47ac057bb3601c99c648e9d32b30fd0a5979)), closes [#13](https://github.com/MiniGod/agendo/issues/13) [#13](https://github.com/MiniGod/agendo/issues/13) [#13](https://github.com/MiniGod/agendo/issues/13)
* **wait:** never confirm exit from a single missed sighting ([#32](https://github.com/MiniGod/agendo/issues/32)) ([f694374](https://github.com/MiniGod/agendo/commit/f694374292fbb957a15350dc0e6324a078143e58)), closes [#15](https://github.com/MiniGod/agendo/issues/15)


### Documentation

* design for auto-recovering sessions that stop on an error ([#42](https://github.com/MiniGod/agendo/issues/42)) ([75e5f5d](https://github.com/MiniGod/agendo/commit/75e5f5d7de877c3dc8134e1d6eafb621ca3df578))
* document running agendo from a PR branch ([#17](https://github.com/MiniGod/agendo/issues/17)) ([65abd97](https://github.com/MiniGod/agendo/commit/65abd97176eac9264b21ebc9e104c8b56ce3e765))

## [0.1.1](https://github.com/MiniGod/agendo/compare/v0.1.0...v0.1.1) (2026-08-10)


### Features

* **cli:** add orchestration commands for finding, resuming, and awaiting sessions ([#4](https://github.com/MiniGod/agendo/issues/4)) ([24a55ef](https://github.com/MiniGod/agendo/commit/24a55efb6d46bd99700065390cec91fdd465428b))
* detect and auto-resume the session-limit dialog hands-off ([#8](https://github.com/MiniGod/agendo/issues/8)) ([28dd0ef](https://github.com/MiniGod/agendo/commit/28dd0ef8fdc79aef6e5409fb2ae08e0843b4fcd6)), closes [#5](https://github.com/MiniGod/agendo/issues/5)
* detect usage-limit state and optionally auto-resume sessions ([#5](https://github.com/MiniGod/agendo/issues/5)) ([14bde19](https://github.com/MiniGod/agendo/commit/14bde19cf5e1a2a8b104a9b77f66ff26cfb745b3))
* path-scoped launchers ([#2](https://github.com/MiniGod/agendo/issues/2)) ([b91e220](https://github.com/MiniGod/agendo/commit/b91e220375213f7a601ec747d9a19b57bdc91cbd))
* surface session task checklists and full final response ([#3](https://github.com/MiniGod/agendo/issues/3)) ([3be4f7f](https://github.com/MiniGod/agendo/commit/3be4f7f1e8795bebc2d4fce44d3b35458b46ee06))


### Bug Fixes

* don't misclassify a finished-turn summary as a busy session ([#6](https://github.com/MiniGod/agendo/issues/6)) ([7caf6f6](https://github.com/MiniGod/agendo/commit/7caf6f646fd6994943db054378a836f989cdfc7f))
* resolve 5 HIGH-severity bugs from the 2026-07-07 bug review ([#9](https://github.com/MiniGod/agendo/issues/9)) ([f50740a](https://github.com/MiniGod/agendo/commit/f50740a651dadc4333de890b4197a7dddd86037c)), closes [#8](https://github.com/MiniGod/agendo/issues/8) [#2](https://github.com/MiniGod/agendo/issues/2) [#7](https://github.com/MiniGod/agendo/issues/7) [#7](https://github.com/MiniGod/agendo/issues/7)
* **ui:** scope work-item and PR row keys by repo to fix duplicate React keys ([#7](https://github.com/MiniGod/agendo/issues/7)) ([549dc41](https://github.com/MiniGod/agendo/commit/549dc41404ff3518116c6d6564a3e7c454289c9e)), closes [#16](https://github.com/MiniGod/agendo/issues/16) [#16](https://github.com/MiniGod/agendo/issues/16) [#16](https://github.com/MiniGod/agendo/issues/16)

## 0.1.0 (2026-07-03)


### Features

* initial public release of agendo ([ab9856e](https://github.com/MiniGod/agendo/commit/ab9856e37fb3825bea616d17e62aa9a3d72106a5))
