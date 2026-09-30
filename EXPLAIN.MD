# Dup-Audit — What It Is and How It Works

**Dup-Audit** is a deterministic, non-AI code-duplication auditor for TypeScript,
JavaScript, CSS, and (at the token level only) PL/pgSQL and other configured file
types. It is built to run unattended in CI: every run measures its own code
coverage and gates the build on a duplication budget, so a passing run means
something concrete, not "no errors were thrown."

It does **not** use AI/LLM inference anywhere in the pipeline. Every flag is
produced by a fixed algorithm (AST diffing, tree edit distance, token hashing,
or set similarity) against a fixed, documented threshold, so results are
reproducible run-to-run on the same code.

---

## 1. What kind of duplication it detects

There are four independent detectors. Three own a different notion of
"duplicate," each with its own mechanism for confirming it; the fourth,
`deadcode`, asks a related but distinct question — not "is this copied?" but
"does anything alive actually reach this?"

| # | Detector | What it flags | Languages / files | Confirmation method |
|---|----------|----------------|--------------------|----------------------|
| 1 | **`structure`** | Duplicate or near-duplicate **functions, methods, constructors, and accessors** — Type‑1 (exact), Type‑2 (renamed/relabeled), and Type‑3 (near-miss, edited) clones | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` | TypeScript compiler AST → normalized tree → Zhang–Shasha tree edit distance |
| 2 | **`css`** | Duplicate or near-duplicate **CSS rule bodies**, regardless of declaration order, casing, or whitespace | `.css` | PostCSS parse → normalized declaration set → Jaccard similarity |
| 3 | **`tokens`** | **Verbatim (Type‑1) duplication** in raw token sequences, in any file extension the config lists (this is how `.sql` / PL/pgSQL is covered, since there's no dedicated SQL AST pass) | Any configured extension | `jscpd` token-sequence matching |
| 4 | **`deadcode`** | **Files and exports that are never really used** — unreachable from any real entry point, even when some other, equally unreachable file still imports them | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` | Whole-program import graph → reachability (mark-and-sweep) from configured entry points |

`deadcode` isn't a *duplication* detector like the other three — it doesn't
compare code against other code, it asks "does anything alive actually reach
this?" It's covered in full in **section 2.4**, since it's the newest and
most involved piece of the tool.

**Type‑4 clones** (different code, same runtime behavior) are explicitly **out
of scope**. The tool's own documentation is direct about this: detecting
"different code that does the same thing" is undecidable in general, and no
static analysis tool covers it reliably, so it isn't attempted.

### Clone classification ("kind")

Every flagged cluster is labeled with one of three kinds, based on how the
members compare to each other:

| Kind | Meaning | How it's decided |
|------|---------|-------------------|
| `identical` | Same content apart from whitespace/comments | All members hash to the same **raw** key (exact text-level match) |
| `normalized` | Same after normalization — renamed locals/changed literals (code), or reordered/recased declarations (CSS) | Members share the same **normalized** key but differ in raw form |
| `near-miss` | Copied, then edited | Members don't share a normalized key, but a precise similarity check (tree edit distance or Jaccard) still clears the configured threshold |

---

## 2. How each detector actually flags something

### 2.1 `structure` — function/method-level clones

1. **Unit extraction** — the TypeScript compiler parses each file into an AST.
   "Units" are the outermost function-like declarations: function
   declarations, class methods, constructors, get/set accessors, and named
   arrow/function expressions assigned to a variable or property. Inline
   callbacks stay nested inside their parent unit rather than being extracted
   separately.
2. **Normalization** — inside each unit, local names (parameters, variables,
   type parameters, and the function's own name for recursive self-reference)
   are renumbered in declaration order (`0, 1, 2, …`) rather than compared by
   text. This is what lets a renamed copy of a function still match. Property
   names, method names on objects, and JSX attribute names are **not**
   renumbered, since they aren't local references. Every node also keeps a
   **raw** label (its real text) alongside the **normalized** label, so the
   tool can tell "identical" apart from "renamed."
3. **Size filter** — a unit must clear both a minimum line count (default 5)
   and a minimum AST node count (default 40) to be considered. This exists
   specifically to keep boilerplate (trivial getters, one-line wrappers,
   constant blocks) out of the results.
4. **Exact grouping** — units are hashed on their normalized tree. Units that
   hash identically are grouped together immediately (no similarity math
   needed) and are sub-classified `identical` vs `normalized` by comparing
   their **raw** hashes.
5. **Candidate search for near-misses** — for units that don't already share a
   group, the tool builds 5-node "shingles" (sliding windows over the
   pre-order label sequence) and finds candidate pairs whose shingle sets
   overlap above a Jaccard floor (default `0.4`). Shingles that appear in an
   excessive number of units (default cap: 64) are treated as boilerplate and
   ignored, so common patterns don't create false candidate explosions.
6. **Precise confirmation** — each candidate pair is checked with a
   size-ratio upper bound first (cheap), then, if that doesn't rule it out,
   with **Zhang–Shasha tree edit distance** on the normalized trees. Similarity
   is `1 − (edit distance / max(size_a, size_b))`. A pair is only flagged if
   this similarity is **≥ 0.85** by default.
7. **Oversized-unit handling** — units above a node-count ceiling (default
   5,000 AST nodes) skip tree edit distance entirely and are matched by exact
   hash only; this is reported in `report.notes`, not silently dropped, so a
   "clean" report can't be hiding a skipped comparison.
8. **Clustering** — confirmed pairs are merged via union-find, so a chain of
   pairwise matches (A~B, B~C) becomes one reported cluster (A, B, C), not two
   overlapping ones.

### 2.2 `css` — rule-level clones

1. Each stylesheet is parsed with PostCSS; every rule with at least a minimum
   number of declarations (default 3) is extracted.
2. Declarations are **normalized**: property names and values are
   lower‑cased (except custom properties, which are case-sensitive, and
   quoted strings / `url()` values, which are preserved as written),
   whitespace is collapsed, and `!important` is retained as part of the
   value. The rule's **selector is not part of the comparison** — only the
   declaration set and its surrounding at-rule context (e.g. which
   `@media` block it's in) matter, so two differently-named selectors with
   the same declarations still match, while identical declarations inside
   different `@media` contexts do **not**.
3. Declarations are then **sorted**, so declaration order never defeats the
   match — this directly targets a documented real-world false-negative
   (SonarQube's community forum reports reordering alone defeating naive
   duplicate detection).
4. Rules are compared by Jaccard similarity over their normalized declaration
   sets; a pair is flagged at **≥ 0.85** similarity by default (same
   threshold field as `structure`, configured separately). There's no
   boilerplate cutoff here (unlike `structure`'s shingle cap) — a `display:
   flex` shared by many rules is treated as genuine overlap, not noise.

### 2.3 `tokens` — verbatim, cross-language matching

1. Runs `jscpd` (a widely used token-based clone detector) against every file
   whose extension is in `tokens.extensions` (`.ts`, `.tsx`, `.js`, `.jsx`,
   `.css`, `.scss`, `.less`, `.sql`, `.html`, `.htm` by default).
2. A match requires at least a minimum token count (default 60) **and**
   minimum line count (default 6) — both floors must be cleared.
3. Every result is reported as `kind: identical` at `similarity: 1`, since
   `jscpd` only reports verbatim token-sequence matches, not near-misses.
4. Files whose paths contain glob-special characters (e.g. Next.js's
   `[id].tsx` or `(group)/page.tsx`) are excluded from this detector and
   reported as uncovered by it, rather than silently mismatched against the
   wrong files.
5. **De-duplication against `structure`**: a token-level pair is dropped if
   its two sides already sit inside two different members of the *same*
   `structure` cluster — the structural finding already explains that
   duplication with more context, so it isn't reported twice.

### 2.4 `deadcode` — whole-program reachability, not "is it mentioned anywhere"

This detector exists to catch a specific, easy-to-miss problem: **code that
looks used but isn't, because the thing using it is itself dead.**

A shallow check ("does any other file import this one?") gets this wrong in
exactly the case that matters most. If `dead.ts` imports `helper.ts`, a
shallow check sees `helper.ts` is imported and calls it live — even though
`dead.ts` itself is never reached by anything the program actually runs. The
same failure shows up as **mutually recursive dead code**: two files that
import each other but that nothing else ever reaches. This is a documented,
named shortcoming of `ts-prune` (one of the older, now-archived TypeScript
dead-code tools) — its own maintainers note it "couldn't detect mutually
recursive dead code" — and it's the exact reason its ecosystem successor,
`knip`, and similar tools (`unimported`, `depcheck`) all moved to **whole-graph
reachability from real entry points** instead of local "is it referenced"
checks. `dup-audit`'s `deadcode` detector follows that same model.

**How it works, step by step:**

1. **Build the whole-program import graph.** Every `.ts`/`.tsx`/`.js`/`.jsx`
   (and their `m`/`c` variants) file is parsed, and every way one file can
   cause another to load is recorded as a directed edge: static
   `import`/`export … from`, CommonJS `require(...)`, dynamic `import(...)`,
   `export * as ns from`, `import x = require(...)`, `import('./x').T` type
   references, and re-exports (`export * from`, `export { x } from`).
   Specifiers are resolved by TypeScript's own module resolver over the
   project's `tsconfig.json` (`paths` aliases such as `@/lib/x`, `baseUrl`,
   `extends`), in its most permissive `Bundler` mode: extensionless imports,
   the NodeNext convention of writing `./foo.js` to mean `./foo.ts`, and
   directory `index` files.
2. **Resolve real entry points** — the files that are *run*, not just
   imported. An explicit `deadcode.entry` glob list replaces the automatic
   sources below, since it says exactly what runs. Otherwise every source is
   added together, because a missing entry point is what produces false
   positives while an extra one only hides a finding:
   `package.json`'s `main`/`module`/`browser`/`bin`/`exports` (mapped back
   from compiled output to source using the tsconfig `outDir`/`rootDir`, or
   `dist`/`build`/`lib`/`out` and `src/` by convention), any file named in a
   `package.json` script (`node scripts/seed.js`, `--config=tools/x.ts`), a
   conventional `index`/`main`/`cli` file in the root or `src/`, and the
   directory conventions of a framework listed in `package.json`
   (Next.js, Astro, SvelteKit, Remix/React Router, Gatsby, Storybook,
   Cypress, Knex). Independently of all that, files a tool loads by name are
   always live: `*.config.*`, `.*rc.*`, and anything under a dot-directory
   such as `.storybook/`, and so is any file such a config names outright
   (vitest's `setupFiles`; exact paths only, never globs). **All of this is reported in the run's notes,
   never silently assumed.** The exports of an entry file are never reported
   as unused, since whatever runs it (a framework, a package consumer)
   reads them, not another file. If no program entry resolves, the detector
   reports nothing and says so explicitly, rather than guessing and risking a
   codebase-wide false positive; tool config files alone don't count.
3. **Mark-and-sweep reachability**: a search over the graph,
   starting *only* from the resolved entry points. Every file the search
   reaches is live. This is the step that solves the "wired to a dead file"
   problem directly: `helper.ts` above is only reachable *through* `dead.ts`,
   and `dead.ts` is never reached from an entry point, so the search never
   visits either of them — both come out dead, correctly, regardless of how
   many files reference each other inside that unreachable pocket.
4. **File-level flag**: any parseable file the sweep didn't reach is a
   **dead file**.
5. **Export-level flag, restricted to live files only**: for every file the
   sweep *did* reach, the detector separately tracks which of its named
   exports are actually imported — but only by counting an import that
   itself originates from a live file. An import written inside a dead file
   never counts as "usage," even though the import statement is syntactically
   real — this is what keeps step 3's fix from being undone at the
   export-tracking stage. A `default` export, a barrel re-export
   (`export * from`), and a namespace import (`import * as ns`) are all
   handled: a namespace import conservatively marks *every* export of its
   target as used, since telling which property the code actually reads off
   `ns` would need full data-flow analysis, and this tool would rather miss
   a real dead export than falsely flag a live one.
6. **Confidence downgrade, not a guess**: static analysis can't resolve a
   *computed* reference — `require(pluginPath)`, `import(`./${name}`)`. When
   any such computed reference exists anywhere in the codebase, and a
   *literal* string elsewhere plausibly names a candidate dead file or export
   (matched against its path or basename, with a 4-character floor to avoid
   matching on short, generic names), the finding is downgraded from
   `dead-file`/`dead-export` to **`uncertain-file`/`uncertain-export`**.
   Uncertain findings are always reported, but **never count toward the
   gate** — the tool would rather ask a human to look than delete something
   it can't actually prove is unreachable. The same downgrade applies when
   a `.vue`/`.svelte`/`.html` file mentions the name: the graph can't read
   into those files, so their raw text is searched instead.

**What it deliberately does not promise:**

- **Test files as "usage."** By default, test files are removed from the
  audited file set before any detector runs (the same `ignore` list every
  other detector uses), so they can't serve as reachability roots. A
  production file exercised only by its own test suite, and never by any
  shipped entry point, is therefore still flagged — the tool's stance is
  that this needs a human look before deletion, the same as any other
  finding, rather than a silent exception. `deadcode.treatTestsAsEntry` is
  available for teams that deliberately keep test files in the audited set
  and want them to count as entry points, matching `knip`'s default
  behavior (a fix `knip` made over `ts-prune`, which "made no attempt to
  understand whether your test code was alive or dead").
- **Monorepos and auto-imports.** Only the root `package.json` and
  `tsconfig.json` are read, so a workspace package's own entry fields aren't
  seen and imports between workspace packages (`@org/pkg`) don't resolve;
  list those entries in `deadcode.entry`. Frameworks that auto-import
  (Nuxt composables, for instance) leave no import to follow. Framework
  conventions outside the built-in list need `deadcode.entry` or
  `deadcode.ignore`.
- **CSS/SQL reachability.** Only script files get graph-based reachability.
  A CSS rule that's never referenced by any class name in markup, or a SQL
  object nothing calls, is a *different*, much harder problem (it needs
  cross-referencing against markup/templates or a database's own dependency
  graph) and isn't attempted here — same "explicitly out of scope, not
  silently wrong" stance as Type‑4 clones.
- **Gating is opt-in.** `gates.deadCode.enabled` defaults to `false`, and
  even when enabled, only high-confidence (`dead-file`) findings count
  toward `gates.deadCode.maxFiles`. This mirrors the `baseline` feature's
  own adoption strategy: a brand-new, whole-codebase-scanning check should
  never silently break someone's CI the first time they upgrade.

---

## 3. Why these specific thresholds (the basis)

The defaults are stated as being drawn from published clone-detection
practice rather than picked arbitrarily:

- **Minimum unit size (40 AST nodes / 5 lines):** the common literature floor
  for a "meaningful" clone is roughly 50 tokens / 6 lines, referenced against
  tools such as CCFinderX, Deckard, iClones, NiCad, and the TGMM parse-tree
  study. Going lower mostly surfaces boilerplate (getters, constant blocks).
- **Structural similarity (0.85):** NiCad and SourcererCC typically use a
  70–80% floor for Type-3 clones on large corpora. This tool defaults higher
  to bias toward precision, on the reasoning that in an unattended CI gate a
  missed clone is cheaper than a wrong flag. It's configurable
  (`structure.similarity`) if a team wants the research-standard balance
  instead.
- **CSS declaration normalization:** targets a documented real failure mode
  (SonarQube community forum) where reordering identical declarations alone
  defeated naive duplicate detection.
- **Default exclusions** (tests, `.min.*`, `.d.ts`, generated files,
  small getters/setters): targets the most commonly reported false-positive
  class in real-world use — entity/DTO classes and accessor boilerplate.

The README is explicit that none of this guarantees zero false positives,
since some identical-looking code is *intentionally* identical (see
Limitations below); the thresholds are tuned to keep false positives rare,
and the `calibrate` command measures where a given codebase actually lands.

---

## 4. End-to-end pipeline (how a run is flagged, gated, and reported)

1. **Inventory** — the target must be a git repository; `git ls-files` (plus
   `.gitignore` and the tool's own `ignore` globs) determines the file set.
2. **Per-file detection** — each enabled detector (`tokens`, `structure`,
   `css`) runs independently over the relevant files and returns clusters,
   the files it actually analyzed, any parse failures, and notes.
3. **Coverage accounting** — coverage = lines in files actually examined by
   at least one detector ÷ total lines in tracked, non-ignored files with a
   configured extension. A file that fails to parse counts as **uncovered**
   and is listed under `report.failures`; it is never silently dropped from
   the denominator.
4. **Cross-detector de-duplication** — token-level pairs already explained by
   a structural cluster are dropped (see 2.3.5) so the same duplication isn't
   double-counted or double-reported.
5. **Baseline split (optional)** — if `baseline.enabled` is on, clusters
   already recorded in `<out>/baseline.json` (by content hash of the
   duplicated text per member, not by line number) are separated out. The
   full duplication percentage is still reported; only the **gate** is
   evaluated against clusters not in the baseline. This is the same pattern
   as SonarQube's "new code" gates or ESLint's `--diff` mode, for adopting
   the gate on a codebase with pre-existing debt.
6. **Duplicated-line counting** — for each cluster, every member after the
   first is counted (the "kept" copy isn't counted against itself), with
   overlapping spans in the same file merged so a line is never counted
   twice.
7. **Gating** — two independent gates:
   - **Coverage gate**: `coverage.percent >= gates.minCoveragePercent`
     (default 90%).
   - **Duplication gate**: `duplication.percent <= gates.maxDuplicationPercent`
     (default 5%), evaluated against the baseline-adjusted figure when a
     baseline is enabled.
8. **Output** — `report.json` (full machine-readable report), `report.sarif`
   (for GitHub code scanning / most CI dashboards), and a human-readable
   console summary listing the largest clusters first (ranked by lines that
   would be saved by keeping one copy).
9. **Exit codes** — `0` both gates passed, `1` a gate failed, `2` the tool
   itself couldn't run (bad config, not a git repo, etc.) — so CI can tell
   "found problems" apart from "couldn't run" on top.

### Optional commands

- **`calibrate`** — a one-time (or per-threshold-change) step: takes real
  sampled functions, mutates each one five ways (unmodified copy, renamed
  locals, changed literals, inserted statement, deleted statement), and
  reports what fraction of each mutation type `structure` still catches
  (recall). It also writes `precision-sample.md`, a random sample of
  real clusters with checkboxes, for a one-time human precision review.
- **`baseline`** — records every cluster currently found into
  `baseline.json`, so a team can turn the duplication gate on for an
  existing codebase without either raising the limit until it's meaningless
  or failing CI on day one for old debt. Re-running it is expected after
  deliberately accepting or fixing duplication.

---

## 5. Checklist — what triggers a flag, end to end

Use this as a quick "will this get flagged, and why" reference.

**Before anything is compared:**
- [ ] File is tracked by git and not excluded by `.gitignore` or the
      `ignore` config globs (`node_modules`, `dist`, `build`, `coverage`,
      `*.min.*`, `*.d.ts`, `*.generated.*`, `*.test.*`, `*.spec.*`,
      `__tests__/`, `__mocks__/` by default)
- [ ] File extension is one a relevant detector is configured to read
- [ ] File parses successfully (a parse failure = counted as **uncovered**,
      listed in `report.failures`, never silently skipped)

**For a function/method to be eligible for `structure` (Type‑1/2/3):**
- [ ] It's a function declaration, method, constructor, accessor, or a
      named arrow/function expression (inline callbacks don't count as
      their own unit)
- [ ] It meets the minimum line count (default 5) **and** minimum AST node
      count (default 40)
- [ ] It matches another eligible unit either:
  - [ ] exactly, after local-name normalization (→ `identical` or
        `normalized`), **or**
  - [ ] above the configured similarity threshold (default 0.85) via tree
        edit distance, after passing the cheap shingle/size pre-filters
        (→ `near-miss`)
- [ ] If the unit exceeds the max node ceiling (default 5,000), it's
      compared by exact match only — this is disclosed in `report.notes`,
      not hidden

**For a CSS rule to be eligible for `css`:**
- [ ] It has at least the minimum number of declarations (default 3)
- [ ] Its normalized, sorted declaration set matches another rule's,
      **within the same at-rule context** (e.g. same `@media` block)
- [ ] Similarity (Jaccard over normalized declarations) clears the
      threshold (default 0.85)

**For a `tokens` match:**
- [ ] File extension is in `tokens.extensions`
- [ ] File path has no glob-special characters (otherwise it's excluded and
      reported as uncovered by this detector)
- [ ] The matching span meets both the minimum token count (default 60) and
      minimum line count (default 6)
- [ ] The match is **not** already explained by a `structure` cluster
      covering the same two locations

**For a file or export to be eligible for `deadcode`:**
- [ ] It's a script file (`.ts`/`.tsx`/`.js`/`.jsx` and `m`/`c` variants) — CSS/SQL are out of scope for this detector
- [ ] It is not itself a resolved entry point (`package.json` fields or scripts, `deadcode.entry`, a conventional root/`src` `index`/`main`/`cli` file, or a framework convention — always listed in the run's notes) and not a tool-owned file (`*.config.*`, `.*rc.*`, dot-directories)
- [ ] No search from any entry point, over the whole import/require/dynamic-import/re-export graph, ever reaches it — reachability *through* another file only counts if that other file is itself reachable
- [ ] For an export specifically: no file that *is* reachable imports that name (by name, by namespace, or via a re-export)
- [ ] It is downgraded to `uncertain` rather than `dead` if a computed (`require(x)`, `import(`${x}`)`) reference exists anywhere and a literal string elsewhere plausibly names it — `uncertain` findings are reported but never gate the build

**Before trusting a "clean" (no-flags) report:**
- [ ] Confirm `gates.coverage` actually passed — a low-coverage run can be
      "clean" simply because little code was examined
- [ ] Remember Type‑4 clones (same behavior, different code) are never
      detected by this tool, by design
- [ ] Remember intentionally-identical code (unexcluded generated code,
      parallel DTO/entity classes, license headers) *will* still be
      flagged — the size floor and ignore list filter the common cases, but
      not all of them; this needs human judgment
- [ ] Remember PL/pgSQL only gets token-level (verbatim) matching, not
      structural near-miss detection
- [ ] Run `calibrate` at least once on your own codebase rather than
      trusting the README's example recall/precision numbers, which are
      specific to the corpus they were measured on

---

## 6. Feature checklist — implemented vs. left out

### Implemented

- [x] `structure` detector — Type-1/2/3 clone detection for TS/TSX/JS/JSX via AST + tree edit distance
- [x] `css` detector — duplicate/near-duplicate CSS rules via PostCSS + Jaccard similarity
- [x] `tokens` detector — verbatim token matching via jscpd (covers `.sql` and any other configured extension)
- [x] `deadcode` detector — whole-program import-graph reachability from real entry points; flags dead files and dead exports, including files only "used" by other dead files (mutually recursive or chained dead code), with computed/dynamic references downgraded to a non-gating `uncertain` finding rather than guessed away (see section 2.4)
- [x] Cross-detector de-duplication (a token match already explained by a `structure` cluster is dropped)
- [x] Coverage accounting (lines examined ÷ total lines, gated, with failures reported rather than hidden)
- [x] Duplication percentage + gate
- [x] Baseline mode (`dup-audit baseline`) to adopt the gate on an existing codebase without failing on pre-existing debt
- [x] Calibration mode (`dup-audit calibrate`) — mutation-based recall testing plus a precision sample for human review
- [x] JSON report + SARIF output (for GitHub code scanning / CI dashboards)
- [x] Config file with validation (unknown keys rejected outright, not ignored)
- [x] CLI with distinct exit codes (`0` passed, `1` gate failed, `2` tool error)
- [x] Test suite (83 tests per README: TED algorithm incl. brute-force cross-check, clustering, every detector, coverage, config validation, merge/de-dup logic, baseline fingerprinting, CLI exit codes)

### Explicitly left out (by design, not oversight)

- [ ] **Type-4 clone detection** (same behavior, different code) — undecidable in general; no static tool covers it reliably, so it isn't attempted
- [ ] **Structural/near-miss detection for PL/pgSQL** — only token-level matching via jscpd; no Postgres-aware AST pass (no dependency access in the build environment to add one)
- [ ] **Near-miss comparison for oversized functions** (> `structure.maxTedNodes`, default 5,000 AST nodes) — matched by exact hash only; tree edit distance is skipped for cost, and this is disclosed in `report.notes`
- [ ] **AI/LLM-based similarity detection** — deliberately excluded; every flag comes from deterministic hashing, tree edit distance, or Jaccard similarity against a fixed threshold, so results are reproducible run-to-run
- [ ] **Dead-code reachability for CSS or SQL** — `deadcode` covers script files only; a CSS rule never referenced by any markup, or an unused SQL object, needs a different kind of cross-referencing and isn't attempted
- [ ] **Test files as automatic entry points** — off by default (`deadcode.treatTestsAsEntry: false`), and only takes effect once test files are deliberately kept in the audited file set, since they're removed by the default `ignore` list before any detector runs
- [ ] **Precise namespace-import usage tracking** — `import * as ns` conservatively marks every export of its target as used, rather than analyzing which properties are actually read off `ns`; this trades some missed dead exports for zero false positives on that path

---

## 7. Configuration surface (all optional, all validated)

| Key | Default | Governs |
|-----|---------|---------|
| `detectors` | `["tokens","structure","css"]` | which detectors run |
| `ignore` | see checklist above | git pathspec globs excluded from the audit |
| `codeExtensions` | 15 extensions (ts/js family, css/scss/less, sql, html, vue, svelte) | denominator for the coverage gate |
| `gates.minCoveragePercent` | `90` | coverage gate |
| `gates.maxDuplicationPercent` | `5` | duplication gate |
| `tokens.extensions` / `minTokens` / `minLines` | see above | `tokens` detector |
| `structure.minNodes` / `minLines` / `similarity` / `maxTedNodes` / `candidateJaccard` / `maxPosting` | see above | `structure` detector |
| `css.minDeclarations` / `similarity` | `3` / `0.85` | `css` detector |
| `deadcode.entry` | `[]` (auto-detect) | glob patterns for the program's real entry points |
| `deadcode.ignore` | `[]` | extra globs this detector should never flag |
| `deadcode.treatTestsAsEntry` | `false` | also treat audited test-like files as entry points |
| `gates.deadCode.enabled` / `maxFiles` | `false` / `0` | opt-in gate on high-confidence `dead-file` count only |
| `baseline.enabled` | `false` | whether the duplication gate is evaluated against `baseline.json` only |

Unknown keys in `dup-audit.config.json` are rejected outright (not ignored),
specifically so a typo can't silently disable a check.