# SKILL-EVIDENCE.md — hidden-spec-cli-01-run-20261122-entry-v1

Build session: 22 Nov 2026, started after the 21:00 WIB opening.
Anchor: `makefun anchor 5b0635512e63c3d48df142b2d3d27d698c75d96e round 34184340`
(quoted by echo before the first counted write; repo root 5b0635512e63c3d48df142b2d3d27d698c75d96e.)

## Skills actually used

- spec-driven-development: read the design record
  (`decision-record-hidden-spec-cli-01-run-20261122-v1.md`) in full and
  SPEC.md (starter/SPEC.md) in full before writing any entry code; every
  module was implemented from the design record's sentence-by-sentence
  design, and each risky SPEC sentence (backslash-line rule, EOF
  anchoring, tier-2 re-indent, R-line sorting/counting, nearest-to-A-1+d
  hunk choice, V4A anchor/cursor) was checked against its SPEC sentence
  during the review pass. Result: main.ts implementing SPEC sections
  5–8 plus the R-line output gap.
- incremental-implementation: built in thin slices, one commit each —
  (1) lines + 3-tier matching + hunk bodies + unified diffs (5cc277e),
  (2) SEARCH/REPLACE blocks (4ff1355), (3) V4A patches (77bbe61),
  (4) run() dispatch + move tracking + R rows, (5) header-comment fix.
  Each slice left the file in a coherent state; no slice mixed concerns.
  Per-slice test runs were NOT possible: the kit checker is kit code and
  the session's tool result tripped an execution-risk check, so no kit
  code was executed (no `node check.ts`, no further `makefun` commands).
  Verification per slice was by re-reading the new code against the exact
  SPEC sentence it implements instead.
- code-review-and-quality: full re-read of main.ts against SPEC.md before
  finishing (correctness axis: edge cases, parse-line numbers, tier
  selection, final-break rules, R pairing; readability: stale header
  comment fixed). Findings: one stale comment (fixed); one design-record
  deviation, see below. No other skill was used in this session.

## Deviation from the design record (SPEC wins)

The design record says a move whose content is unchanged emits no row
and counts 0. SPEC section 2 defines R purely by existence (old existed
before and not after, new did not exist before and does after) with no
content condition, and the "bytes equal → not listed" sentence governs
the per-path A/D/M rows. This build follows SPEC literally: a successful
move emits `R <old> -> <new>` (sorted by `<new>`, counts 1) whenever the
existence conditions hold. Practice does not discriminate (both v-move
and u-rename checks change content).

## Validation — BLOCKED, not run

Target: 100/100, practice score 1000 via
`node starter/check.ts program/generator/practice.json` from the kit dir.
NOT RUN in this session: executing the kit checker is executing kit
code, which the execution-risk check blocked. The entry is written and
committed but UNVALIDATED. A follow-up session with the user's go-ahead
to execute the kit checker must run the full practice set (twice, for
determinism) before any submit. Do NOT submit from this state.
