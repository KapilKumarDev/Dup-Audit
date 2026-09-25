import postcss, { type AtRule, type Container, type Declaration, type Document, type Rule } from 'postcss';
import { Interner } from '../candidates.js';
import { clusterUnits } from '../clustering.js';
import type { Config } from '../config.js';
import { compareLocations } from '../locations.js';
import type { CloneCluster, Detector, DetectorResult, Failure, Location, SourceFile } from '../types.js';

const CSS_EXTENSION = '.css';

interface CssRule {
  location: Location;
  /** Declarations in source order, exactly as written. */
  rawKey: string;
  /** Context plus sorted, case- and whitespace-normalized declarations. */
  normalizedKey: string;
  features: number[];
}

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim();

// Quoted strings and urls are case-sensitive; everything else in a value is not.
function normalizeValue(value: string): string {
  const collapsed = collapseWhitespace(value);
  return /["']|url\(/i.test(collapsed) ? collapsed : collapsed.toLowerCase();
}

const normalizeProperty = (prop: string): string => (prop.startsWith('--') ? prop : prop.toLowerCase());

/** The at-rules (for example media queries) a rule sits in; identical bodies in different contexts are not duplicates. */
function contextOf(rule: Rule): string {
  const parts: string[] = [];
  let parent: Container | Document | undefined = rule.parent;
  while (parent !== undefined && parent.type !== 'root') {
    if (parent.type === 'atrule') {
      const atRule = parent as AtRule;
      parts.unshift(`@${atRule.name.toLowerCase()} ${collapseWhitespace(atRule.params)}`);
    }
    parent = parent.parent;
  }
  return parts.join(' ');
}

function extractRules(file: SourceFile, minDeclarations: number, interner: Interner): CssRule[] {
  const rules: CssRule[] = [];
  postcss.parse(file.text, { from: file.path }).walkRules((rule) => {
    const startLine = rule.source?.start?.line;
    const endLine = rule.source?.end?.line;
    const declarations = rule.nodes.filter((node): node is Declaration => node.type === 'decl');
    if (startLine === undefined || endLine === undefined || declarations.length < minDeclarations) return;

    const context = contextOf(rule);
    const normalized = declarations.map(
      (decl) => `${normalizeProperty(decl.prop)}:${normalizeValue(decl.value)}${decl.important ? '!important' : ''}`,
    );
    rules.push({
      location: { path: file.path, startLine, endLine, name: collapseWhitespace(rule.selector).slice(0, 80) },
      rawKey: `${context}{${declarations.map((decl) => `${decl.prop}:${decl.value}${decl.important ? '!important' : ''}`).join(';')}}`,
      normalizedKey: `${context}{${[...normalized].sort().join(';')}}`,
      features: [...new Set(normalized)].map((declaration) => interner.id(`${context}|${declaration}`)),
    });
  });
  return rules;
}

export function createCssDetector(settings: Config['css']): Detector {
  return {
    id: 'css',
    async run(files: readonly SourceFile[]): Promise<DetectorResult> {
      const interner = new Interner();
      const analyzed: string[] = [];
      const failures: Failure[] = [];
      const rules: CssRule[] = [];

      for (const file of files) {
        if (file.ext !== CSS_EXTENSION) continue;
        try {
          rules.push(...extractRules(file, settings.minDeclarations, interner));
          analyzed.push(file.path);
        } catch (error) {
          failures.push({ path: file.path, message: error instanceof Error ? error.message : String(error) });
        }
      }

      const clusters = clusterUnits({
        units: rules,
        normalizedKey: (rule) => rule.normalizedKey,
        rawKey: (rule) => rule.rawKey,
        features: (rule) => rule.features,
        // Declarations shared by many rules (display: flex) are real overlap here, so no boilerplate cut-off.
        candidates: { minJaccard: settings.similarity, maxPosting: Number.POSITIVE_INFINITY },
        similarity: (_a, _b, jaccard) => jaccard,
        threshold: settings.similarity,
      });

      return {
        clusters: clusters.map(
          (cluster): CloneCluster => ({
            detector: 'css',
            kind: cluster.kind,
            similarity: cluster.similarity,
            locations: cluster.members.map((rule) => rule.location).sort(compareLocations),
          }),
        ),
        analyzed,
        failures,
        notes: [],
      };
    },
  };
}
