import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface JargonViolation {
  file: string;
  line: number;
  word: string;
  matchedText: string;
  recommendedAlternative: string;
}

export interface PlainLanguageResult {
  passed: boolean;
  violations: JargonViolation[];
}

export const BANNED_JARGON_TERMS: Record<string, string> = {
  sink: '"Where to send" or "Destination" (ADR 0007 / ADR 0027)',
  outbox: '"Waiting messages" (ADR 0007 / ADR 0027)',
  jid: '"Contact ID" or "Chat ID" (ADR 0007)',
  regex: '"Filter rule" or "Pattern" (ADR 0007)',
  daemon: '"Background service" (ADR 0007)',
  payload: '"Message details" or "Content" (ADR 0007)',
  stdout: '"Log output" (ADR 0007)',
};

/**
 * Checks a file or directory for banned technical jargon in user-facing files.
 */
export function scanPlainLanguage(targetDir: string = path.join(process.cwd(), 'packages')): PlainLanguageResult {
  const violations: JargonViolation[] = [];
  if (!fs.existsSync(targetDir)) return { passed: true, violations: [] };

  function traverse(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
          continue;
        }
        traverse(fullPath);
      } else if (entry.isFile()) {
        // We scan packages/ui, packages/i18n, and any front-end/locales files
        const relPath = path.relative(process.cwd(), fullPath);
        const isUserFacingFile =
          relPath.includes('/ui/') ||
          relPath.includes('/i18n/') ||
          relPath.includes('/locales/') ||
          relPath.endsWith('.html');

        if (isUserFacingFile && !relPath.endsWith('.test.ts') && !relPath.endsWith('.spec.ts')) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            for (const [term, replacement] of Object.entries(BANNED_JARGON_TERMS)) {
              // Match whole word, case-insensitive
              const regex = new RegExp(`\\b${term}\\b`, 'i');
              const match = regex.exec(line);
              if (match) {
                violations.push({
                  file: relPath,
                  line: i + 1,
                  word: term,
                  matchedText: line.trim(),
                  recommendedAlternative: replacement,
                });
              }
            }
          }
        }
      }
    }
  }

  traverse(targetDir);

  return {
    passed: violations.length === 0,
    violations,
  };
}

// CLI entry point
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('[Guard] Verifying user-facing UI and i18n dictionaries for plain language...');
  const result = scanPlainLanguage();

  if (!result.passed) {
    console.error('FAIL: Banned technical jargon detected in user-facing UI:');
    for (const v of result.violations) {
      console.error(`  ${v.file}:${v.line} [Flagged: "${v.word}"]`);
      console.error(`    Line: ${v.matchedText}`);
      console.error(`    Use instead: ${v.recommendedAlternative}`);
    }
    process.exit(1);
  } else {
    console.log('PASS: User-facing plain-language guard passed. Zero internal jargon in UI.');
    process.exit(0);
  }
}

