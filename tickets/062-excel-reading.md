# 062 — Excel reading: departments live in .xlsx, not .csv

**Packages:** `apps/worker`, `deploy/` · **Depends on:** 057 · **Allowed deps:** `exceljs` (worker)

## Context
The second file-format debt from 057. `sheet.read@v1` learns `.xlsx` — same contract
(header + rows + truncated), same row cap, same containment — via `exceljs` (MIT,
self-hostable, no network). One honest simplification, stated in the tool description: the
FIRST worksheet is the sheet; multi-sheet workbooks expose their sheet names in an additive
optional output field so the agent can say "this workbook has 4 sheets, I read the first".
Formulas read as their last-computed VALUES (what a human sees in the cell), never formula
text — agents reason about data, not spreadsheet programming.

## Scope
1. `sheet.read@v1` accepts `.xlsx`: first worksheet → `{header, rows, truncated}` with the
   existing `SHEET_ROW_CAP`; cell values stringified the way a person reads them (numbers
   plain, dates as ISO, formula cells as their cached result, empty cells as "").
2. Additive optional output field `sheets: string[]` (workbook's worksheet names, `.xlsx`
   only) so multi-sheet workbooks are visible rather than silently flattened.
3. Input size cap BEFORE parsing (the 057 byte-cap doctrine: an oversized workbook refuses
   typed, never OOMs); corrupt/password-protected workbooks refuse typed via the same path.
4. `sheet.append` stays CSV-only — appending to `.xlsx` is a rewrite-the-file operation, not
   an append, and rewriting workbooks is out of scope (typed refusal names this).
5. Fixture: a small committed `.xlsx` (built once, bytes committed) with quoted strings,
   numbers, a date, a formula, and a second worksheet; `deploy/demo-docs/` gains a fabricated
   `.xlsx` invoice register.
6. Tests: value coercion (string/number/date/formula-result/empty), row cap + truncated,
   `sheets` field, corrupt + oversized refusals, append-to-xlsx typed refusal, containment
   unchanged.

## Out of scope
Writing/rewriting workbooks, .xls (legacy binary), multi-sheet selection input (backlog note
if an agent ever needs sheet 2 — additive `sheet?` input later), styles/merged-cell geometry.

## Acceptance criteria
- [ ] `sheet.read` on the fixture returns coerced values matching what a person sees in the
      cells, with cap + truncated + `sheets` (tested per coercion case).
- [ ] Oversized, corrupt, and append-to-xlsx are three distinct typed refusals (tested).
- [ ] `deploy/demo-docs/` ships a fabricated .xlsx register; the demo drill still passes.
- [ ] `pnpm test` and `pnpm build` green.
