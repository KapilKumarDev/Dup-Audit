# dup-audit

A deterministic, non-AI duplicate-code auditor for TypeScript, JavaScript, CSS,
and (via token matching) PL/pgSQL. Built to run unattended in CI: every run
verifies its own code coverage and gates on a duplication budget.

## What it finds

| Detector    | Catches                                                          | Method |
|-------------|-------------------------------------------------------------------|--------|
| `structure` | Type-1/2/3 clones in functions and methods (TS/TSX/JS/JSX)         | TypeScript compiler AST, normalized, confirmed with Zhang-Shasha tree edit distance |
| `css`       | Duplicate or near-duplicate CSS rules, any declaration order       | PostCSS, normalized declaration sets, Jaccard similarity |
| `tokens`    | Verbatim duplication in any configured extension (incl. `.sql`)    | jscpd |

Type-4 (same behavior, different code) is not attempted — this is undecidable
in general and no static tool covers it reliably.

## Why these thresholds

Defaults are chosen from published clone-detection practice, not guesses:

- **Minimum unit size** (40 AST nodes / 5 lines): the literature's common
  floor for "meaningful" clones is ~50 tokens or 6 lines (used by CCFinderX,
  Deckard, iClones, NiCad, and the TGMM parse-tree study); going much lower
  produces boilerplate noise (getters, constant blocks).
- **Structural similarity (0.85)**: NiCad and SourcererCC use a 70-80%
  similarity floor for Type-3 (near-miss) clones in large corpora; this tool
  defaults higher (0.85) to bias toward precision, since a missed clone costs
  less than a wrong flag in an unattended CI gate. Lower it in
  `dup-audit.config.json` (`structure.similarity`) if you want the
  research-standard recall/precision balance instead.
- **CSS declaration normalization**: SonarQube's community forum documents a
  real false positive where reordering identical CSS/entity fields defeated
  naive duplication detection — this tool normalizes declaration order,
  case, and whitespace specifically to avoid that gap.
- **Exclusions** (tests, `.min.*`, `.d.ts`, generated files, getters/setters
  below the size floor): the same forum thread and general practice flag
  entity/DTO classes and accessor boilerplate as the most common false
  positive class in real-world use; this tool's size floor and ignore list
  target exactly that.

None of this guarantees zero false positives — no tool can, since some
identical-looking code is intentionally identical (see Limitations). It's
tuned to keep them rare, and `calibrate` measures where you actually land.

## Install

```bash
npm install
npm run build
```

## Usage

```bash
# Audit (writes reports, exits 1 if a gate fails)
node dist/src/cli.js /path/to/repo

# One-time calibration: injects known mutated clones to measure recall,
# and samples real clusters into a checklist for a human precision review
node dist/src/cli.js calibrate /path/to/repo --samples 200
```

Both commands require the target to be a git repository (file listing and
`.gitignore` handling go through `git ls-files`) and write into
`<root>/.dup-audit/` by default (`--out` to change it):

- `report.json` — full machine-readable report
- `report.sarif` — for GitHub code scanning / most CI dashboards
- `calibration.json` / `precision-sample.md` — from `calibrate`

Exit codes: `0` gates passed, `1` a gate failed, `2` the tool itself errored
(bad config, not a git repo, etc.) — so CI can tell "found problems" apart
from "couldn't run".

## Configuration

Drop a `dup-audit.config.json` in the root (or pass `--config`). Every key is
optional and validated; unknown keys are rejected so a typo can't silently
disable a check. See `src/config.ts` for the full schema and defaults —
worth reading before tuning, since `gates.minCoveragePercent` and
`gates.maxDuplicationPercent` are what CI actually enforces.

## Calibrating for your codebase

`calibrate` is the one manual step, done once (and again if you change
thresholds):

1. It samples real functions, mutates each one five ways (unmodified copy,
   renamed locals, changed literals, inserted statement, deleted statement),
   and reports what fraction of each mutation type the `structure` detector
   still catches (recall).
2. It also writes `precision-sample.md`: a random sample of clusters found in
   your *unmodified* code, each with a checkbox. Reviewing that once gives
   you a measured precision number for your codebase (true duplicates ÷
   reviewed).

On a ~175k-line real-world TypeScript/CSS corpus used to validate this tool,
recall was 94-100% for copy/rename/literal/insert-statement mutations and
~60-65% for statement-deletion mutations — expected, since removing a
statement is a larger structural edit and some deletions correctly drop
below the similarity threshold rather than being missed. Your own numbers
will differ; that's the point of running `calibrate` on your code rather
than trusting a number from someone else's.

## Coverage

Coverage is lines actually examined by at least one detector, divided by
total lines in tracked-and-not-ignored files with a configured extension —
computed and gated every run, not asserted. A file that fails to parse (a
malformed CSS rule, for instance) counts as uncovered and is listed in
`report.failures`, never silently dropped.

## Limitations (read before trusting a "clean" report)

- **Type-4 clones** (different code, same behavior) are out of scope for any
  static, non-AI tool.
- **Intentionally identical code** (generated code you haven't excluded,
  parallel entity/DTO classes with the same fields, license headers) will be
  flagged. The size floor and ignore list filter the common cases; anything
  left over needs human judgment, which is exactly what the precision
  sample is for.
- **PL/pgSQL** only gets token-level matching (via jscpd), not structural
  near-miss detection — there was no dependency access in this environment
  to add a Postgres-aware AST pass. At ~2% of a typical mixed codebase this
  usually doesn't threaten the 90% coverage gate, but check your own numbers.
- **Oversized functions** (over `structure.maxTedNodes`, default 500 AST
  nodes) are matched exactly only; near-miss comparison is skipped for them
  and this is reported in `report.notes` rather than silently skipped.

## Development

```bash
npm test           # type-checks and runs the full test suite (node --test)
```

70 tests cover the tree edit distance algorithm (including a brute-force
cross-check on random trees), clustering, every detector, coverage
accounting, config validation, the merge/de-duplication logic, and the CLI's
exit codes end-to-end.
