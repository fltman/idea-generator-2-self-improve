# Build journal

Every gold idea from the self-improvement board, as Claude Code built it (or did not). Newest last. Each folder has the agent's own write-up, screenshots and a build.json with the verdict, lineage, cost and timings.

| # | Idea | Result | Summary |
|---|------|--------|---------|
| 0001 | [Lift Recipes Fed Back by Hit Rate](0001-lift-recipes-fed-back-by-hit-rate/README.md) | ✅ merged | The jury now writes a lift recipe for every idea: one change that would earn the next medal, tagged with one of the three criteria. Children get it as their task in the branch or cross prompt and stor |
| 0002 | [Jury Self-Doubt Retrial Queue](0002-jury-self-doubt-retrial-queue/README.md) | ✅ merged | I built a blind second judge for borderline verdicts, and it is committed on the branch. When a jury sum lands exactly on a medal line (9, 11 or 13), a second model scores the idea again without seein |
| 0003 | [Gold waits for the blind second judge before a build starts](0003-gold-waits-for-the-blind-second-judge-be/README.md) | ✅ merged | On a self-improvement board, a jury score of exactly 13 no longer starts a build at once. It now waits for the blind second judge. A new pure function, goldGate() in score.js, decides what happens nex |
| 0004 | [Placebo Trials for Recipes](0004-placebo-trials-for-recipes/README.md) | ✅ merged | I built placebo trials for lift recipes, and all 85 tests pass (81 before); the work is committed on the build branch. By lot, one in five breeds that would get a recipe gets the vague task "improve i |
| 0005 | [Diversity pressure: the autopilot notices a monoculture and breeds outside it](0005-diversity-pressure-the-autopilot-notices/README.md) | ✅ merged | The autopilot now measures how concentrated the board is: the share of the last 24 bred ideas that carry the jury's most common keyword. From 60% on it calls this a monoculture, takes at least one par |
| 0006 | [Quarter Control Net-Lift Chip](0006-quarter-control-net-lift-chip/README.md) | ⏸ interrupted |  |
| 0007 | [Quarter Control Net-Lift Chip](0007-quarter-control-net-lift-chip/README.md) | ✅ merged | On every fourth recipe cross, the autopilot now crosses the same parents a second time with no task. That control sibling remembers the withheld recipe type and the parent's medal. Under the placebo t |
| 0008 | [Jury Re-Reads Recipe Against Child](0008-jury-re-reads-recipe-against-child/README.md) | ✅ merged | I built the recipe check and committed it on the build branch; all 97 tests pass, including 2 new ones. After the jury judges a child that was given a recipe, the judge model is shown the parent, the  |
| 0009 | [Blind Duel Verdict Judges Recipe Hits](0009-blind-duel-verdict-judges-recipe-hits/README.md) | ✅ merged | After the jury judges a recipe child, one extra call to the judge model compares child and parent as "Idea A"/"Idea B", in coin-flipped order with no recipe, scores or lineage. It picks a winner or a  |
