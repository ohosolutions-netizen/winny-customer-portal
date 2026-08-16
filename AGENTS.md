# AGENTS.md

**Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) before editing.** It is the full guide
to this codebase; this file is the 30-second version.

This is a **faithful React port of a single-file Zoho Creator widget**. Large blocks
of logic are copied **verbatim** from the original — don't "modernize" them.

## The rules that will trip you up
1. **Two kinds of code:** *logic* (`config/ lib/ core/ api/`) is verbatim from the
   original — edit it as source of truth; *view* (`components/ store/ hooks/`) is the
   only fresh React.
2. **Never reassign `applicationData` or `packageCatalog`** — they're stable
   singletons mutated in place (`replaceApplicationData(...)`).
3. **Logic re-renders via `requestRender()`** and calls `toast/showLoader/openModal`
   from `lib/ui.js` (a bridge to the shell) — not local component state.
4. **4 sections are "islands"** (Questionnaire, CIF, Documents, Review/Success):
   verbatim `renderX()` HTML injected via `innerHTML`, inline handlers exposed on
   `window`. To edit them, change the verbatim `renderX`/handlers in
   `core/questionnaire.js`, `core/cif.js`, `api/documents.js`, `api/review.js` — and
   if you add a new inline handler, register it in that island's host component
   (`components/*/{Questionnaire,CIF,Documents,Review}.jsx`) handler array.
5. **Don't change Zoho endpoint/connection/form/field strings** (`config/config.js`,
   `api/`) — they match live Zoho and are verified.
6. **`src/styles/portal.css` is byte-for-byte the original** — don't restyle.

## Build
```bash
npm install && npm run dev      # localhost (Zoho calls only complete inside Creator)
npm run build && npm run pack   # → winny-portal-widget.zip for Creator upload
```

## Change map, data model, endpoints, known issues, local testing
→ all in [`ARCHITECTURE.md`](./ARCHITECTURE.md) (§10 change recipes, §4 data model,
§9 endpoints, §13 known issues incl. the unimplemented `submitApplication`, §14 seeding).
