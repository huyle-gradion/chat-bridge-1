# Bench

Measures the built app in a separate process, 5 runs, medians:

| Metric | What |
|---|---|
| `startMs`, `startMaxRssMb` | `chat-bridge --version` from cold: time and peak memory |
| `import500Ms`, `import500CpuMs`, `import500MaxRssMb` | `chat-bridge run --fake` on 500 synthetic messages: time, CPU time, peak memory |

Run: `pnpm build && pnpm bench <label>`, which writes `bench/results/<label>.json` (not committed).

Compare: `pnpm bench:compare bench/results/main.json bench/results/pr.json 15` fails when any median is more than 15% worse.

`probe.mjs` is preloaded into the measured process and reports its own peak memory and CPU time on exit.

Not built yet: the PR-vs-main CI job, the nightly 2-hour leak run, and the weekly page in `docs/health/`.
