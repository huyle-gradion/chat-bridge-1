// Preloaded into the process being measured. On exit it writes that process's
// peak memory and CPU time to the file named by BENCH_PROBE_OUT.
import fs from 'node:fs';

const out = process.env.BENCH_PROBE_OUT;
if (out) {
  process.on('exit', () => {
    const usage = process.resourceUsage();
    fs.writeFileSync(
      out,
      JSON.stringify({
        maxRssKb: usage.maxRSS,
        cpuMs: (usage.userCPUTime + usage.systemCPUTime) / 1000,
      }),
    );
  });
}
