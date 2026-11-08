# Build journal

Every gold idea from the self-improvement board, as Claude Code built it (or did not). Newest last. Each folder has the agent's own write-up, screenshots and a build.json with the verdict, lineage, cost and timings.

| # | Idea | Result | Summary |
|---|------|--------|---------|
| 0001 | [Lift Recipes Fed Back by Hit Rate](0001-lift-recipes-fed-back-by-hit-rate/README.md) | ✅ merged | The jury now writes a lift recipe for every idea: one change that would earn the next medal, tagged with one of the three criteria. Children get it as their task in the branch or cross prompt and stor |
| 0002 | [Jury Self-Doubt Retrial Queue](0002-jury-self-doubt-retrial-queue/README.md) | ✅ merged | I built a blind second judge for borderline verdicts, and it is committed on the branch. When a jury sum lands exactly on a medal line (9, 11 or 13), a second model scores the idea again without seein |
| 0003 | [Gold waits for the blind second judge before a build starts](0003-gold-waits-for-the-blind-second-judge-be/README.md) | ✅ merged | On a self-improvement board, a jury score of exactly 13 no longer starts a build at once. It now waits for the blind second judge. A new pure function, goldGate() in score.js, decides what happens nex |
| 0004 | [Placebo Trials for Recipes](0004-placebo-trials-for-recipes/README.md) | ✅ merged | I built placebo trials for lift recipes, and all 85 tests pass (81 before); the work is committed on the build branch. By lot, one in five breeds that would get a recipe gets the vague task "improve i |
| 0005 | [Diversity pressure: the autopilot notices a monoculture and breeds outside it](0005-diversity-pressure-the-autopilot-notices/README.md) | ✅ merged | The autopilot now measures how concentrated the board is: the share of the last 24 bred ideas that carry the jury's most common keyword. From 60% on it calls this a monoculture, takes at least one par |
