# Dup-Audit

A deterministic, non-AI code auditor for TypeScript, JavaScript, CSS, and (via
token matching) PL/pgSQL: duplicate-code detection plus whole-program
dead-code reachability. Built to run unattended in CI: every run verifies its
own code coverage and gates on a duplication budget.

## What it finds

| Detector    | Catches                                                          | Method |
|-------------|-------------------------------------------------------------------|--------|
| `structure` | Type-1/2/3 clones in functions and methods (TS/TSX/JS/JSX)         | TypeScript compiler AST, normalized, confirmed with Zhang-Shasha tree edit distance |
| `css`       | Duplicate or near-duplicate CSS rules, any declaration order       | PostCSS, normalized declaration sets, Jaccard similarity |
| `tokens`    | Verbatim duplication in any configured extension (incl. `.sql`)    | jscpd |
| `deadcode`  | Files and exports unreachable from any real entry point (TS/TSX/JS/JSX) | Whole-program import graph, reachability from entry points (mark-and-sweep) |

`deadcode` isn't a duplication detector — it doesn't compare code against
other code, it asks "does anything alive actually reach this?" See
[Dead-code detection](#dead-code-detection) below.

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

## Dead-code detection

A shallow "does anything import this file?" check gets the interesting case
wrong: if `dead.ts` imports `helper.ts`, that check sees `helper.ts` is
imported and calls it live — even though `dead.ts` itself is never reached by
anything the program actually runs. The same failure shows up as **mutually
recursive dead code**: two files that import each other but that nothing else
ever reaches. This is a documented shortcoming of `ts-prune` ("couldn't
detect mutually recursive dead code"), and the reason its successor `knip`
(and `unimported`, `depcheck`) moved to whole-graph reachability from real
entry points instead. `deadcode` follows the same model:

1. Build the whole-program import graph: every `import`, `export … from`,
   `require(...)`, and dynamic `import(...)` becomes an edge, resolved by
   TypeScript's own module resolver over your `tsconfig.json` (`paths`
   aliases like `@/lib/x`, `baseUrl`, `extends`, extensionless imports,
   `.js`-written/`.ts`-compiled NodeNext style, directory `index` files).
2. Resolve real entry points — files that *run*, not just get imported. An
   explicit `deadcode.entry` glob list replaces the automatic sources;
   otherwise all of these are added together: `package.json`'s
   `main`/`module`/`browser`/`bin`/`exports` (mapped back from compiled
   output to source via the tsconfig `outDir`/`rootDir`), files named in
   `package.json` scripts, a conventional `index`/`main`/`cli` file in the
   root or `src/`, and the conventions of a framework listed in
   `package.json` (Next.js, Astro, SvelteKit, Remix/React Router, Gatsby,
   Storybook, Cypress, Knex). Files a tool loads by name (`*.config.*`,
   `.*rc.*`, anything under a dot-directory such as `.storybook/`) are always
   live, as is any file such a config names outright (`setupFiles`), and the exports of an entry file are never reported as unused.
   **The entry points are always in the run's notes.** A missing entry point
   is how live code gets flagged as dead, so nothing is assumed silently — if
   no program entry resolves, it reports nothing and says so.
3. Search from those entry points only, over the whole graph.
   A file only reachable *through* another unreachable file is still
   unreachable — this is what fixes the `dead.ts`/`helper.ts` case above.
4. Anything the search never reaches is a **dead file**. For files it does
   reach, any exported name that no *reachable* importer ever asks for is a
   **dead export** (an import written inside a dead file doesn't count as
   usage, which is what keeps step 3's fix from being undone here).
5. A computed reference (`require(pluginPath)`) can't be resolved
   statically. When one exists anywhere and a literal string elsewhere
   plausibly names a candidate, the finding is downgraded to
   `uncertain-file`/`uncertain-export` — always reported, never gated.

A `.vue`/`.svelte`/`.html` file can't be read into, so a file or export only
those mention by name is reported as `uncertain-*` rather than dead.

Known scope boundaries: only the root `package.json` and `tsconfig.json` are
read (monorepo workspace packages need their entries in `deadcode.entry`);
only script files get reachability (CSS/SQL aren't
attempted — a different, harder problem); and `import * as ns` conservatively marks
every export of its target as used rather than tracking which property is
actually read off `ns`, trading a few missed dead exports for zero false
positives on that path.

By default (`deadcode.treatTestsAsEntry: true`), test files count as entry
points too, gathered independently of the shared `ignore` list that removes
them for every other detector — this is what stops a function exported
purely so a test can import and exercise it directly from being flagged as
a dead export just because nothing shipped calls it. Set it to `false` for a
stricter analysis that only trusts real, shipped entry points.

Like `baseline`, the gate is opt-in (`gates.deadCode.enabled`, default
`false`) and only counts high-confidence `dead-file` findings — a brand-new,
whole-codebase-scanning check shouldn't break anyone's CI on the first
upgrade.

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

# Record every cluster found right now, so later audits can gate on new
# duplication only (see "Adopting the gate on an existing codebase" below)
node dist/src/cli.js baseline /path/to/repo

# Smallest duplicate to report, in lines (default 5). Works on all three
# commands and overrides tokens.minLines and structure.minLines from the config
# file; the CSS detector counts declarations (css.minDeclarations) instead.
node dist/src/cli.js /path/to/repo --min-lines 10
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
worth reading before tuning, since `gates.minCoveragePercent`,
`gates.maxDuplicationPercent`, and `gates.deadCode` are what CI actually
enforces. `deadcode.entry` (real entry points), `deadcode.ignore`, and
`deadcode.treatTestsAsEntry` are worth setting explicitly rather than relying
on auto-detection — see [Dead-code detection](#dead-code-detection).

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

## Adopting the gate on an existing codebase

Turning `gates.maxDuplicationPercent` on for a codebase that already has years of
accumulated duplication means either raising the limit until it's meaningless,
or failing CI on day one for debt nobody added this week. `baseline` is the
third option, the same one SonarQube's "new code" gates and ESLint's `--diff`
mode use: freeze what's already there, and only fail on what gets added after.

```bash
node dist/src/cli.js baseline /path/to/repo   # writes <out>/baseline.json
```

Then set `"baseline": { "enabled": true }` in `dup-audit.config.json`. From
then on, `report.duplication.percent` and `clusterCount` still describe the
whole codebase — nothing is hidden from the report — but the
`maxDuplicationPercent` gate is evaluated only against clusters not already in
`baseline.json`, reported separately under `report.duplication.baseline`. The
coverage gate is never affected: a baseline lowers the duplication bar, never
the "did every file get examined" bar.

A baseline entry is a hash of the duplicated text itself (per member, by
path), not of line numbers, so an unrelated edit earlier in a file doesn't
knock a cluster out of the baseline. Actually changing the duplicated code —
fixing one copy, or editing both so they're no longer alike — does, which is
what makes `newClusterCount` in the report a true count of duplication
introduced since the baseline was taken, not an artifact of line drift. Two
things follow from that: re-run `baseline` after intentionally accepting new
duplication (so it doesn't count against you twice) or after fixing some of
the baselined debt (so the file doesn't quietly protect code that no longer
matches it); and a cluster whose file was renamed or moved falls out of the
baseline and is reported as new, since it's now unmatchable by path.

## Coverage

Coverage is lines actually examined by at least one detector, divided by
total lines in tracked-and-not-ignored files with a configured extension —
computed and gated every run, not asserted. A file that a detector cannot
parse (a malformed CSS rule or a TS/JS syntax error, for instance) is not
counted as examined by that detector and is listed in `report.failures`, never
silently dropped. It stays uncovered unless another detector, such as the token
detector, examined its text.

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
- **Oversized functions** (over `structure.maxTedNodes`, default 5000 AST
  nodes) are matched exactly only; near-miss comparison is skipped for them
  and this is reported in `report.notes` rather than silently skipped.
  5000 was chosen empirically (see `README` history / commit notes) to cover
  large-but-real functions such as sizable React components without letting
  tree edit distance run on pathologically huge, likely-generated units;
  raise or lower `structure.maxTedNodes` per project via
  `dup-audit.config.json` if your codebase's real functions run larger or
  you need faster runs on very large repos.
- **Dead-code reachability is script-only.** CSS rules never referenced by
  any markup, or unused SQL objects, aren't attempted — that needs
  cross-referencing against markup/templates or a database's own dependency
  graph, a different problem from import-graph reachability.
- **Test files are entry points by default** (`deadcode.treatTestsAsEntry`),
  so code exercised only by a test suite and never by shipped code is *not*
  flagged. Set it to `false` for a stricter analysis; expect more findings
  that need a human look before deleting anything.
- **A wrong `deadcode.entry`** is the one way this detector can flag real,
  live code as dead — the resolved entry points are always in `report.notes`
  precisely so this is checkable, not something to find out from a bad gate
  failure.

## Development

```bash
npm test           # type-checks and runs the full test suite (node --test)
```

111 tests cover the tree edit distance algorithm (including a brute-force
cross-check on random trees), clustering, every detector, coverage
accounting, config validation, the merge/de-duplication logic, baseline
fingerprinting, and the CLI's exit codes end-to-end. `test/deadcode.test.ts`
adds coverage for the dead-code detector specifically: the transitive
dead-file case, mutual recursion, dead exports, barrel re-exports, and the
uncertain-confidence downgrade; `test/entrypoints.test.ts` covers entry-point
resolution (tool config files, tsconfig output mapping, scripts, framework
conventions) — run `npm test` for the current total.