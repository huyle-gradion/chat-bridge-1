import path from 'node:path';
import { runNoCyclesGuard } from './no-cycles.js';
import { checkContractBoundaries } from './contract-boundary.js';
import { scanPlainLanguage } from './plain-language.js';
import { scanForSecretsAndPii } from './secret-scan.js';

async function main() {
  console.log('=======================================================');
  console.log(' Chat Bridge Architectural & Quality Guard Suite       ');
  console.log('=======================================================\n');

  let hasError = false;

  // 1. Circular Dependency Guard
  console.log('1. Checking for circular dependencies across packages...');
  const cycleResult = runNoCyclesGuard();
  if (cycleResult.hasCycle) {
    hasError = true;
    console.error('   FAIL: Circular dependencies detected:');
    for (const cycle of cycleResult.cycles) {
      console.error('     ' + cycle.map((f) => path.relative(process.cwd(), f)).join(' -> '));
    }
  } else {
    console.log('   PASS: Zero circular dependencies.');
  }

  // 2. Contract Boundary & Engine Isolation Guard
  console.log('\n2. Verifying contract boundaries & engine isolation...');
  const boundaryResult = checkContractBoundaries();
  if (!boundaryResult.passed) {
    hasError = true;
    console.error('   FAIL: Contract boundary violations:');
    for (const v of boundaryResult.violations) {
      console.error(`     [${v.rule}] ${v.file}: imported "${v.importedSpecifier}"`);
      console.error(`     Remediation: ${v.explanation}`);
    }
  } else {
    console.log('   PASS: Engine, sources, sinks, and types are cleanly decoupled.');
  }

  // 3. Plain Language UI Linter
  console.log('\n3. Scanning user-facing UI for banned technical jargon...');
  const languageResult = scanPlainLanguage();
  if (!languageResult.passed) {
    hasError = true;
    console.error('   FAIL: Banned jargon terms detected in UI:');
    for (const v of languageResult.violations) {
      console.error(`     ${v.file}:${v.line} -> "${v.word}" (Use: ${v.recommendedAlternative})`);
    }
  } else {
    console.log('   PASS: Zero internal jargon in user-facing UI.');
  }

  // 4. Secret & Zero-PII Sanitization Guard
  console.log('\n4. Scanning for leaked credentials and customer PII...');
  const secretResult = scanForSecretsAndPii();
  if (!secretResult.passed) {
    hasError = true;
    console.error('   FAIL: Secrets or real PII detected:');
    for (const v of secretResult.violations) {
      console.error(`     ${v.file}:${v.line} [${v.type}]: "${v.matchedText}"`);
    }
  } else {
    console.log('   PASS: Zero secrets and zero PII.');
  }

  console.log('\n=======================================================');
  if (hasError) {
    console.error(' FAILED: Guard checks failed. Please fix violations above. ');
    console.error('=======================================================\n');
    process.exit(1);
  } else {
    console.log(' SUCCESS: All architectural guards passed. ');
    console.log('=======================================================\n');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Guard runner failed unexpectedly:', err);
  process.exit(1);
});

