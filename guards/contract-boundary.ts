import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getSourceFiles, extractImportSpecifiers } from './no-cycles.js';

export interface Violation {
  file: string;
  importedSpecifier: string;
  rule: string;
  explanation: string;
}

export interface ContractBoundaryResult {
  passed: boolean;
  violations: Violation[];
}

export function checkContractBoundaries(rootPath: string = process.cwd()): ContractBoundaryResult {
  const packagesDir = path.join(rootPath, 'packages');
  const files = getSourceFiles(packagesDir);
  const violations: Violation[] = [];

  for (const file of files) {
    const relPath = path.relative(rootPath, file);
    const content = fs.readFileSync(file, 'utf-8');
    const specifiers = extractImportSpecifiers(content);

    for (const specifier of specifiers) {
      // Rule 1: Engine must never import concrete sources or concrete sinks
      if (relPath.startsWith('packages/engine/')) {
        if (
          specifier.includes('source-') ||
          specifier.includes('sink-') ||
          specifier.includes('/sources/') ||
          specifier.includes('/sinks/')
        ) {
          violations.push({
            file: relPath,
            importedSpecifier: specifier,
            rule: 'ENGINE_ISOLATION',
            explanation:
              'The Engine reaches sources and sinks ONLY through contracts in @chat-bridge/types. It must not import concrete sources or sinks directly.',
          });
        }
      }

      // Rule 2: Sources must never import Sinks
      if (relPath.startsWith('packages/sources/')) {
        if (
          specifier.includes('sink-') ||
          specifier.includes('/sinks/')
        ) {
          violations.push({
            file: relPath,
            importedSpecifier: specifier,
            rule: 'SOURCE_SINK_SEPARATION',
            explanation: 'Sources and Sinks must never communicate directly or import each other.',
          });
        }
      }

      // Rule 3: Sinks must never import Sources
      if (relPath.startsWith('packages/sinks/')) {
        if (
          specifier.includes('source-') ||
          specifier.includes('/sources/')
        ) {
          violations.push({
            file: relPath,
            importedSpecifier: specifier,
            rule: 'SINK_SOURCE_SEPARATION',
            explanation: 'Sources and Sinks must never communicate directly or import each other.',
          });
        }
      }

      // Rule 4: @chat-bridge/types must have zero runtime dependencies outside itself
      if (relPath.startsWith('packages/types/')) {
        const isTestFile = relPath.endsWith('.test.ts') || relPath.endsWith('.spec.ts');
        if (isTestFile) {
          // In test files, vitest and testing utilities are permitted
          if (specifier === 'vitest' || specifier.startsWith('.')) {
            continue;
          }
        }
        if (
          !specifier.startsWith('.') &&
          !specifier.startsWith('node:')
        ) {
          violations.push({
            file: relPath,
            importedSpecifier: specifier,
            rule: 'TYPES_ZERO_DEPENDENCY',
            explanation: '@chat-bridge/types has an inviolable invariant: zero external runtime dependencies.',
          });
        }
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

// CLI entry point
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('[Guard] Verifying architectural contract boundaries and engine isolation...');
  const result = checkContractBoundaries();

  if (!result.passed) {
    console.error('❌ Contract boundary violations found:');
    for (const v of result.violations) {
      console.error(`  [${v.rule}] ${v.file}`);
      console.error(`    Imported: "${v.importedSpecifier}"`);
      console.error(`    Remediation: ${v.explanation}`);
    }
    process.exit(1);
  } else {
    console.log('✅ Contract boundaries strictly preserved: Engine, Sources, Sinks, and Types are decoupled.');
    process.exit(0);
  }
}
