# Winny Customer Portal — React

A faithful React port of the Winny Global Customer Portal Zoho Creator widget
(originally a single 14.5k-line HTML file). **No UI or logic changes** — the CSS
is copied byte-for-byte, and all field-level logic, validation, payload shapes
and Zoho API endpoints are preserved exactly.

## How the port is organised

The original was imperative vanilla JS: one global `applicationData` model mutated
in place, `renderX()` functions building HTML strings, and global `data-action` /
`data-bind` event delegation. The port keeps the **logic verbatim** and rewrites
only the **view + event layer** as React.

```
src/
  config/config.js     CONFIG, steps, catalogs, COUNTRY lists, CIF static data (VERBATIM)
  lib/
    utils.js           getByPath/setByPath/mergeDeep/escapeHtml/format* (VERBATIM)
    validators.js      email/phone/passport/date rules (VERBATIM)
    ui.js              bridge: toast/showLoader/openModal/requestRender → React shell
  api/
    zoho.js            transport core: CRM v8 REST + CRM SDK + Payments REST (VERBATIM)
  store/
    runtime.js         applicationData + state singletons (VERBATIM factory, in-place swap)
    AppStore.jsx       React context/provider; registers the UI bridge
  hooks/               useBind (data-bind equivalent)
  components/
    shell/             TopNav, Loader, Toasts, Modal (identical ids/classes)
    dashboard/ wizard/ deal/ questionnaire/ cif/ documents/ review/ success/
  app/bootstrap.js     boot sequence (mirrors original init())
  main.jsx, App.jsx
  styles/portal.css    the original <style> block, VERBATIM
```

### Key adaptations (behaviour-identical)

- The original reassigned `applicationData = …` in 6 places; those become
  `replaceApplicationData(…)` (clear + assign) so the imported binding stays stable
  across modules. Same for `packageCatalog` (mutated in place, never reassigned).
- DOM-driven helpers (`toast`, `showLoader`, `openModal`, `renderAll`) are routed
  through `lib/ui.js` so verbatim logic keeps calling them; the React shell registers
  the real implementations.

## Configuration

Before building for production, set your Zoho Payments credentials in
[`src/config/config.js`](src/config/config.js) — `paymentsAccountId` and
`paymentsApiKey` are intentionally left blank in this repo (scrubbed so no secret
is committed). Get the API key from Zoho Payments → Settings → Developer Space.
All other CONFIG values (CRM/Creator connection names, form link names, module
names) are the verified production values and need no change.

## Develop / build / deploy

```bash
npm install
npm run dev      # local dev at http://localhost:5173
npm run build    # → dist/index.html (single self-contained file)
npm run pack     # → winny-portal-widget.zip (Creator widget: plugin-manifest.json + widget/)
```

The two Zoho SDK `<script>` tags (`zpayments.js`, `widgetsdk-min.js`) stay external in
`index.html`, loaded from Zoho's CDN exactly as the original. The widget only reaches
live CRM/Creator/Payments data when hosted inside the Creator app
(`hpatel_winnyedu / hiren-patel`).

## Build status (phased)

- [x] Phase 1 — Scaffold + shared foundation (config, lib, transport, store, shell)
- [x] Phase 2 — Dashboard (application cards, drafts/autosave, portal + product loaders, navigation)
- [x] Phase 3 — Deal step (wizard step 1): travellers, services/basket, agreement, Zoho Payments, field validation
- [x] Phase 4 — Questionnaire (6-section engine, verified choice maps + fixed-slot payload, conditional sections)
- [x] Phase 5 — CIF engine (UK 3-form chain + generic Schengen/USA/Australia, schema-driven, record-ID chaining)
- [x] Phase 6 — Documents (checklist load, 2-step upload, preview + Deluge fallback)
- [x] Phase 7 — Review + Submit (review cards, CIF summary, success screen)
- [x] Phase 8 — Full-flow verification (all steps render, 0 boot errors, action coverage, byte-identical CONFIG + CSS, widget zip builds)

**All 8 phases complete.** The full journey (Dashboard → Deal → Questionnaire → Documents → CIF → Review → Submit) is ported and verified in-browser. Zoho-backed flows (saves, payments, metadata, uploads) run their exact original endpoints and only complete inside the Creator widget.
