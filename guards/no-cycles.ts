import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface CycleCheckResult {
  hasCycle: boolean;
  cycles: string[][];
}

/**
 * Recursively retrieves all TypeScript source files under target directory.
 */
export function getSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === '.git'
      ) {
        continue;
      }
      files.push(...getSourceFiles(fullPath));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Extracts import/export module specifiers from a TypeScript file.
 */
export function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importRegex = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

/**
 * Resolves an import specifier to an absolute file path if it points to a local file.
 */
export function resolveLocalImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }

  const dir = path.dirname(fromFile);
  let resolvedBase = path.resolve(dir, specifier);

  // Strip .js / .mjs if importing compiled extension in ESM TS
  if (resolvedBase.endsWith('.js') || resolvedBase.endsWith('.mjs')) {
    resolvedBase = resolvedBase.slice(0, -3);
  }

  const candidates = [
    `${resolvedBase}.ts`,
    `${resolvedBase}.tsx`,
    path.join(resolvedBase, 'index.ts'),
    path.join(resolvedBase, 'index.tsx'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

/**
 * Builds dependency graph and detects cycles using DFS.
 */
export function detectCyclesInFiles(files: string[]): CycleCheckResult {
  const graph = new Map<string, string[]>();

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const specifiers = extractImportSpecifiers(content);
    const dependencies: string[] = [];

    for (const specifier of specifiers) {
      const resolved = resolveLocalImport(file, specifier);
      if (resolved && resolved !== file) {
        dependencies.push(resolved);
      }
    }

    graph.set(file, dependencies);
  }

  const visited = new Set<string>();
  const recursionStack: string[] = [];
  const cycles: string[][] = [];

  function dfs(node: string) {
    visited.add(node);
    recursionStack.push(node);

    const neighbors = graph.get(node) || [];
    for (const neighbor of neighbors) {
      const cycleStartIndex = recursionStack.indexOf(neighbor);
      if (cycleStartIndex !== -1) {
        // Cycle detected
        const cycle = [...recursionStack.slice(cycleStartIndex), neighbor];
        cycles.push(cycle);
      } else if (!visited.has(neighbor)) {
        dfs(neighbor);
      }
    }

    recursionStack.pop();
  }

  for (const file of files) {
    if (!visited.has(file)) {
      dfs(file);
    }
  }

  return {
    hasCycle: cycles.length > 0,
    cycles,
  };
}

export function runNoCyclesGuard(rootPath: string = process.cwd()): CycleCheckResult {
  const packagesDir = path.join(rootPath, 'packages');
  const files = getSourceFiles(packagesDir);
  return detectCyclesInFiles(files);
}

// CLI entry point
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('[Guard] Checking for circular dependencies across packages...');
  const result = runNoCyclesGuard();

  if (result.hasCycle) {
    console.error('FAIL: Circular dependencies detected:');
    for (const cycle of result.cycles) {
      console.error('  Cycle:', cycle.map((f) => path.relative(process.cwd(), f)).join(' -> '));
    }
    process.exit(1);
  } else {
    console.log('PASS: Zero circular dependencies detected.');
    process.exit(0);
  }
}

