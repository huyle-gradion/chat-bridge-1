// Compares two bench results and fails when the change is slower or heavier than allowed.
// Usage: pnpm bench:compare bench/results/main.json bench/results/pr.json [maxRegressionPercent]
import fs from 'node:fs';

interface Report {
  label: string;
  commit: string;
  medians: Record<string, number>;
}

const [basePath, headPath, limitArg] = process.argv.slice(2);
if (!basePath || !headPath) {
  console.error('Usage: compare.ts <base.json> <head.json> [maxRegressionPercent]');
  process.exit(2);
}

const maxRegression = Number(limitArg ?? 15);
const base = JSON.parse(fs.readFileSync(basePath, 'utf-8')) as Report;
const head = JSON.parse(fs.readFileSync(headPath, 'utf-8')) as Report;

const rows: string[] = [];
let failed = false;
for (const [metric, baseValue] of Object.entries(base.medians)) {
  const headValue = head.medians[metric];
  if (headValue === undefined) continue;
  const change = baseValue === 0 ? 0 : ((headValue - baseValue) / baseValue) * 100;
  const verdict = change > maxRegression ? 'worse' : 'ok';
  if (verdict === 'worse') failed = true;
  rows.push(`| ${metric} | ${baseValue} | ${headValue} | ${change >= 0 ? '+' : ''}${change.toFixed(1)}% | ${verdict} |`);
}

console.log(`Bench: ${base.label} (${base.commit}) vs ${head.label} (${head.commit}), medians of runs, limit +${maxRegression}%\n`);
console.log('| Metric | Base | Head | Change | Verdict |');
console.log('|---|---|---|---|---|');
console.log(rows.join('\n'));
process.exit(failed ? 1 : 0);
