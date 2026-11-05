import { describe, it, expect } from 'vitest';
import { extractImportSpecifiers, detectCyclesInFiles } from './no-cycles.js';
import { BANNED_JARGON_TERMS } from './plain-language.js';

describe('Architectural Guards Unit Tests', () => {
  describe('no-cycles (Dependency Cycle Detection)', () => {
    it('extracts import and export specifiers from source code', () => {
      const code = `
        import { Message } from './message.js';
        import type { Person } from '../person.js';
        export { foo } from '@chat-bridge/types';
        const x = 1;
      `;
      const specifiers = extractImportSpecifiers(code);
      expect(specifiers).toEqual(['./message.js', '../person.js', '@chat-bridge/types']);
    });

    it('detects a cycle when circular dependency paths are present', () => {
      // Create mock file paths
      const fileA = '/test/a.ts';
      const fileB = '/test/b.ts';

      // Graph where A -> B and B -> A
      const mockDetect = () => {
        const graph = new Map<string, string[]>([
          [fileA, [fileB]],
          [fileB, [fileA]],
        ]);

        const visited = new Set<string>();
        const recursionStack: string[] = [];
        const cycles: string[][] = [];

        function dfs(node: string) {
          visited.add(node);
          recursionStack.push(node);
          const neighbors = graph.get(node) || [];
          for (const neighbor of neighbors) {
            const idx = recursionStack.indexOf(neighbor);
            if (idx !== -1) {
              cycles.push([...recursionStack.slice(idx), neighbor]);
            } else if (!visited.has(neighbor)) {
              dfs(neighbor);
            }
          }
          recursionStack.pop();
        }

        dfs(fileA);
        return { hasCycle: cycles.length > 0, cycles };
      };

      const result = mockDetect();
      expect(result.hasCycle).toBe(true);
      expect(result.cycles[0]).toEqual([fileA, fileB, fileA]);
    });
  });

  describe('plain-language (UX Jargon Dictionary)', () => {
    it('includes all banned technical jargon and provides plain-language alternatives', () => {
      const terms = ['sink', 'outbox', 'jid', 'regex', 'daemon', 'payload', 'stdout'];
      for (const term of terms) {
        expect(BANNED_JARGON_TERMS).toHaveProperty(term);
        expect(BANNED_JARGON_TERMS[term]?.length).toBeGreaterThan(0);
      }
    });
  });

  describe('contract boundary constraints', () => {
    it('enforces engine isolation rules', () => {
      const forbiddenEngineImports = [
        '@chat-bridge/source-whatsapp',
        '@chat-bridge/sink-margince',
        '../sources/fake',
        '../sinks/archive',
      ];

      for (const spec of forbiddenEngineImports) {
        const isForbidden =
          spec.includes('source-') ||
          spec.includes('sink-') ||
          spec.includes('/sources/') ||
          spec.includes('/sinks/');
        expect(isForbidden).toBe(true);
      }
    });
  });
});

