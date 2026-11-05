import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface SecretViolation {
  file: string;
  line: number;
  type: string;
  matchedText: string;
  explanation: string;
}

export interface SecretScanResult {
  passed: boolean;
  violations: SecretViolation[];
}

const PERMITTED_TEST_PHONES = new Set([
  '+84901234567',
  '+84987654321',
  '+84900000001',
  '+84900000002',
  '+1234567890',
  '+15550000001',
  '+15550000002',
]);

export function scanForSecretsAndPii(rootDir: string = process.cwd()): SecretScanResult {
  const violations: SecretViolation[] = [];

  function traverse(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === '.git' ||
          entry.name === '.gemini'
        ) {
          continue;
        }
        traverse(fullPath);
      } else if (entry.isFile()) {
        const relPath = path.relative(rootDir, fullPath);

        // Skip binary files, lockfiles, guard definitions, and documentation/ADRs that discuss formats
        if (
          relPath.endsWith('.lock') ||
          relPath.endsWith('pnpm-lock.yaml') ||
          relPath.startsWith('docs/') ||
          relPath.startsWith('guards/') ||
          relPath.endsWith('.md')
        ) {
          continue;
        }

        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;

          // Check 1: Private Key Headers
          if (line.includes('BEGIN') && line.includes('PRIVATE KEY')) {
            violations.push({
              file: relPath,
              line: i + 1,
              type: 'PRIVATE_KEY',
              matchedText: line.trim(),
              explanation: 'Private cryptographic keys must never be committed to source control.',
            });
          }

          // Check 2: Live Secret Tokens (Slack, GitHub, AWS, etc.)
          if (/(?:ghp_[a-zA-Z0-9]{36}|xox[baprs]-[0-9a-zA-Z]{10,48}|AKIA[0-9A-Z]{16})/.test(line)) {
            violations.push({
              file: relPath,
              line: i + 1,
              type: 'API_TOKEN',
              matchedText: line.trim(),
              explanation: 'Live API tokens detected. Use mock credentials or local environment variables.',
            });
          }

          // Check 3: Real Phone Numbers (Vietnam E.164 pattern: +84 followed by 9 digits)
          const phoneRegex = /\+84[3|5|7|8|9][0-9]{8}\b/g;
          let match: RegExpExecArray | null;
          while ((match = phoneRegex.exec(line)) !== null) {
            const phone = match[0];
            if (!PERMITTED_TEST_PHONES.has(phone)) {
              violations.push({
                file: relPath,
                line: i + 1,
                type: 'PII_PHONE_NUMBER',
                matchedText: phone,
                explanation: `Real customer phone number detected (${phone}). Only designated synthetic test numbers are allowed in repo (spec Section 14).`,
              });
            }
          }
        }
      }
    }
  }

  traverse(rootDir);

  return {
    passed: violations.length === 0,
    violations,
  };
}

// CLI entry point
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('[Guard] Scanning workspace for leaked secrets and customer PII...');
  const result = scanForSecretsAndPii();

  if (!result.passed) {
    console.error('FAIL: Leaked secrets or customer PII detected:');
    for (const v of result.violations) {
      console.error(`  ${v.file}:${v.line} [${v.type}]`);
      console.error(`    Found: "${v.matchedText}"`);
      console.error(`    Remediation: ${v.explanation}`);
    }
    process.exit(1);
  } else {
    console.log('PASS: Zero secrets or PII detected. Privacy sandbox preserved.');
    process.exit(0);
  }
}
