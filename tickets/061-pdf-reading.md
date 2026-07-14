# 061 — PDF reading: real invoices are PDFs

**Packages:** `apps/worker`, `deploy/` · **Depends on:** 057 · **Allowed deps:** `pdfjs-dist` (worker; was `pdf-parse`, whose wrapper is broken against its own bundled pdf.js — verified before implementation, so the batch uses Mozilla's maintained upstream directly)

## Context
057 shipped the file connector with an honest limitation: text-family files only, "real
invoices are PDFs" recorded as backlog. This ticket pays that debt. `docs.read@v1` learns to
extract TEXT from PDFs — same tool, same contract, same caps, same containment — because for
an agent a PDF is just another document it should be able to read, and for the operator
nothing about governance changes. Extraction is text-layer only: a scanned (image-only) PDF
yields no text, and the tool says so in a typed way instead of returning silence — OCR is a
different beast (heavier deps, model-adjacent failure modes) and stays out of scope, stated
plainly.

## Scope
1. `docs.read@v1` accepts `.pdf`: extract the text layer via `pdfjs-dist` (legacy Node build, text content only, no canvas), then apply
   the EXISTING byte cap + truncated flag on the extracted text. Output gains an additive
   optional field `note` used for exactly one case: a parseable PDF with no extractable text
   (`"no extractable text — likely a scanned/image-only PDF (OCR is out of scope)"`).
2. A corrupt/unparseable PDF is a typed refusal like any unreadable file, never a crash;
   the parser runs against the SIZE-CAPPED raw bytes (a 2 GiB PDF must not OOM the worker —
   read cap applies to the input file before parsing, refusing oversized PDFs typed).
3. `docs.list` is untouched (PDFs already listed — they're just files).
4. Fixture: a minimal hand-written single-page PDF with a known text string, committed under
   the worker test fixtures (bytes, not generated at test time); `deploy/demo-docs/` gains a
   small fabricated invoice PDF so the demo folder matches reality.
5. Tests: extraction returns the known string; empty-text PDF yields the typed note; corrupt
   bytes refuse typed; oversized file refuses typed; the cap + truncated flag applies to
   extracted text; containment rules unchanged (a `.pdf` traversal attempt still refused).

## Out of scope
OCR / image-only PDFs (stated in the tool's own output), PDF forms/tables structure
extraction, password-protected PDFs (typed refusal via the corrupt path), writing PDFs.

## Acceptance criteria
- [ ] `docs.read` on the fixture PDF returns its text with the standard cap + truncated flag;
      an image-only PDF returns empty text WITH the typed note; corrupt and oversized PDFs
      refuse typed.
- [ ] Containment and extension rules hold for `.pdf` exactly as for text files (tested).
- [ ] `deploy/demo-docs/` ships a fabricated PDF invoice; the demo drill still passes.
- [ ] `pnpm test` and `pnpm build` green.
