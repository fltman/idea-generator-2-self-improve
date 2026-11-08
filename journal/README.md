# The build journal

This folder is the record of Idea Generator 2 improving itself.

Each gold idea from the self-improvement board gets a numbered folder, `NNNN-slug/`, which holds:

- **README.md**, written by the Claude Code agent that built it. It covers why the jury picked the idea, what was built, how it was verified, what was left out, and a line or two for the film.
- **Screenshots**: `01-before.png` from before any change, then `02-after.png` and any later steps, taken with `tools/shoot.ts` against a copy of the live boards.
- **build.json**, written by the builder: the idea, the jury's scores and reason, the idea's lineage on the board, the status, branch, cost, timings, the tail of the test run, and the agent's one-line `filmLine`.

[INDEX.md](INDEX.md) lists every build in order. Failed and declined builds are kept too: their code stays on its `build/NNNN-slug` branch, but their write-up lands here.

The agent's full transcript (every tool call, as `claude -p --output-format stream-json`) is saved locally in `data/builds/NNNN-slug/transcript.jsonl`. It is not committed, because it can contain anything the agent read.
