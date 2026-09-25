import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { countLines } from '../src/inventory.js';
import type { SourceFile } from '../src/types.js';

export function sourceFile(filePath: string, text: string): SourceFile {
  return { path: filePath, ext: path.extname(filePath).toLowerCase(), text, lines: countLines(text) };
}

/** Creates a git repository in a temp directory that is removed when the calling test file finishes. */
export function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'dup-audit-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  for (const [relativePath, text] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return root;
}

export const ORDER_TOTAL = `export function computeTotal(items: Item[], taxRate: number): number {
  let total = 0;
  for (const item of items) {
    if (item.quantity <= 0) {
      continue;
    }
    const price = item.price * item.quantity;
    total += price;
  }
  const tax = total * taxRate;
  return Math.round((total + tax) * 100) / 100;
}
`;

/** Same function as ORDER_TOTAL with every local renamed and a literal changed. */
export const ORDER_TOTAL_RENAMED = `export function sumUp(lines: Item[], rate: number): number {
  let sum = 0;
  for (const line of lines) {
    if (line.quantity <= 0) {
      continue;
    }
    const cost = line.price * line.quantity;
    sum += cost;
  }
  const levy = sum * rate;
  return Math.round((sum + levy) * 1000) / 1000;
}
`;

/** ORDER_TOTAL with one extra guard added, the way a copy is typically adapted. */
export const ORDER_TOTAL_MODIFIED = `export function computeTotalWithDiscount(items: Item[], taxRate: number): number {
  let total = 0;
  for (const item of items) {
    if (item.quantity <= 0) {
      continue;
    }
    if (item.disabled) {
      continue;
    }
    const price = item.price * item.quantity;
    total += price;
  }
  const tax = total * taxRate;
  return Math.round((total + tax) * 100) / 100;
}
`;

/** Comparable size to ORDER_TOTAL but unrelated behaviour. */
export const FORMAT_LABEL = `export function formatLabel(parts: string[], separator: string): string {
  const cleaned: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      continue;
    }
    cleaned.push(trimmed.toUpperCase());
  }
  if (cleaned.length > 3) {
    return cleaned.slice(0, 3).join(separator) + '...';
  }
  return cleaned.join(separator);
}
`;
