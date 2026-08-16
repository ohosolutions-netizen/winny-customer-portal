# Winny Customer Portal — Architecture & Editing Guide

> Read this **before changing any code**. This project is a *faithful port* of a
> single-file Zoho Creator widget. It intentionally keeps large blocks of the
> original logic **verbatim**, and uses some patterns that look unusual but are
> deliberate. Editing it like a normal from-scratch React app will break fidelity.

---

## 0. The 7 rules an editing agent must follow

1. **Two kinds of code live here.** *Logic* (in `config/`, `lib/`, `core/`, `api/`)
   is copied verbatim from the original widget — treat it as source of truth, don't
   "modernize" it. *View* (in `components/`, `store/`, `hooks/`) is the only part
   written fresh as React.
2. **Never reassign `applicationData` or `packageCatalog`.** They are stable
   singletons mutated *in place*. Use `replaceApplicationData(newObj)` to swap
   contents. (Why: ES-module imports must stay referentially stable.)
3. **Logic never re-renders React directly.** It calls `requestRender()` (the UI
   bridge). It also calls `toast()`, `showLoader()`, `openModal()` etc. from
   `lib/ui.js` — those are thin pass-throughs the React shell wires up. Don't
   replace them with local component state.
4. **Four steps are "islands."** Questionnaire, CIF, Documents, and Review/Success
   are rendered as raw HTML strings (the original's `renderX()` functions) injected
   via `innerHTML`, with their inline `on*` handlers exposed on `window`. Do **not**
   rewrite these into JSX unless you fully re-port their logic — see §6.
5. **Exact Zoho endpoints are load-bearing.** Connection names, form link names,
   report names, module names, and Deluge `Request_Type` strings in
   `config/config.js` and the `api/` layer must not change. See §9.
6. **`src/styles/portal.css` is byte-for-byte the original.** Don't restyle. Add
   new styles in a separate file if ever needed.
7. **When you add logic, prefer editing the verbatim module** (so the mapping to
   the original stays clear) over adding parallel logic in a component.

---

## 1. What this project is

A React port of the **Winny Global Customer Portal**, originally one 14,497-line
HTML file that runs as a **Zoho Creator widget** (an iframe inside Zoho Creator).
It guides a customer through a visa/immigration application:

**Dashboard** → 6-step **wizard**:
1. **Deal** (customer details, travellers, services/basket, agreement, payment)
2. **Questionnaire** (6-section case questions)
3. **Documents** (upload checklist)
4. **CIF** — Customer Information Form (schema-driven, per destination country:
   UK / USA / Australia / Schengen)
5. **Review**
6. **Submit / Success**

It talks live to **Zoho CRM**, **Zoho Creator**, and **Zoho Payments**, mostly
through a **Deluge bridge**: the widget writes a record to the `Portal_CRM_Request`
Creator form, a Deluge workflow processes it server-side, and the widget polls the
record for the result.

**Runtime reality:** the Zoho SDKs (`ZOHO.CREATOR.*`, `ZOHO.CRM.*`, `ZPayments`)
only respond inside the real Creator iframe. On localhost the app boots and renders
fully, but any *save/fetch/payment* call fires and then can't complete. That's
expected — deploy the widget to test data flows.

---

## 2. The core porting model

The original was imperative vanilla JS: one global mutable `applicationData` object,
`renderX()` functions that build HTML strings and assign them to `innerHTML`, and
global event delegation (`data-action` clicks, `data-bind` inputs). The port keeps
the **logic verbatim** and rebuilds only the **view + event layer** in React.

### The only two behaviour-identical adaptations

Everything else is copied unchanged. These two are mechanical and load-bearing:

| Original pattern | Port | Why |
|---|---|---|
| `applicationData = blankApplication()` (6 sites) | `replaceApplicationData(blankApplication())` — clears keys + `Object.assign` | ES imports must point at a stable object |
| `packageCatalog = mapped` (1 site) | `packageCatalog.length = 0; packageCatalog.push(...mapped)` | same, for the exported array |
| `renderDashboard()` / `renderAll()` / `renderDeal()` … inside logic | `requestRender()` | React re-renders from the mutated model |
| `qs("#autoSaveState").textContent = …` | `setAutoSaveLabel(…)` (UI bridge) | no direct DOM in logic |
| `toast/showLoader/openModal/…` | same names, imported from `lib/ui.js` | bridge to the React shell |

If you see `replaceApplicationData`, `requestRender`, or a `lib/ui.js` call in
"verbatim" code, that's one of these adaptations — leave it.

---

## 3. Directory map

Each logic module notes the **original source line range** it was extracted from,
so you can diff against the source file if needed.

```
winny-portal-react/
  index.html                 App shell; loads the 2 Zoho CDN SDKs (zpayments.js, widgetsdk-min.js)
  vite.config.js             Vite + react + vite-plugin-singlefile (inlines to one dist/index.html)
  plugin-manifest.json       Zoho Creator widget manifest (CSP domains, widget location)
  scripts/pack-widget.mjs    Bundles dist → winny-portal-widget.zip for Creator upload

  src/
    main.jsx                 React root (no StrictMode — avoids double-running boot)
    App.jsx                  <AppStore> + <Shell>: TopNav, Loader, Toasts, Modal,
                             Dashboard | Wizard (by state.activeView), PayConfirmedScreen, Bootstrapper

    app/bootstrap.js         Boot sequence = original init(): loadDraft → initZoho →
                             getLoggedInEmail → loadDynamicProducts → loadPortalCustomerData → autosave timer

    styles/portal.css        VERBATIM original <style> (source 11-1165). Do not edit.

    config/
      config.js              VERBATIM data (source 1285-1923): CONFIG (endpoints/connections/
                             form links), steps, journeyStages, packageCatalog, COUNTRIES,
                             UK_CIF_COUNTRIES, CIF_TYPE_DEFINITIONS, SCHENGEN_* schema.

    lib/                     framework-agnostic primitives
      utils.js               getByPath/setByPath/mergeDeep/escapeHtml/format*/uid/
                             makeApplicationId/safeJsonParse/parseJsonMaybe  (VERBATIM)
      validators.js          email/phone/passport/date rules + classify + isBirthDateField (VERBATIM, src 2035-2079)
      dom.js                 qs / qsa (VERBATIM)
      ui.js                  UI BRIDGE. toast/showLoader/hideLoader/openModal/openConfirmModal/
                             closeModal/confirmModalOk/markAutoSavePending/setAutoSaveLabel/
                             requestRender/fail. registerUi() lets the shell inject real impls.

    store/
      runtime.js             The mutable singletons: applicationData (VERBATIM blankApplication,
                             src 1925-1997), state (src 2000-2030), replaceApplicationData().
      AppStore.jsx           React context/provider. Holds version (bump = re-render),
                             loader/toasts/modal/autosave UI state, and registers the UI bridge.

    hooks/
      useBind.js             data-bind equivalent for React controlled inputs: commitField
                             (handleInput body), blurField (validation), bindInput/bindCheckbox,
                             fieldErrors map.

    core/                    VERBATIM logic, grouped by domain (sync/compute + a few async)
      derive.js              payment math, progress/stage, application-card assembly, getters
                             (src 9517-9608, 2880-2906, 2311-2449, 13775-13823, 7243-7259, 14402-14409)
      drafts.js              localStorage draft/index/hidden, autosave, start/open/remove app
                             (src 2455-2478, 9612-9988)
      navigation.js          showDashboard/showWizard/goToDashboard/showStep/nextStep/previousStep
                             (REWRITTEN for React from src 7921-7992 — behaviour-identical)
      deal.js                deal sync actions: travellers, coordinators, goal/basket/addons,
                             country map, setUSAAddons, isPaymentConfirmed, resetDraft
                             (src 2801-2879, 9246-9515, 8255-8262, 10373-10395, 14372-14392)
      catalog.js             product catalog helpers: goal defs, card theme/icon/badge, desc parse
                             (src 14043-14073, 14155-14219)
      questionnaire.js       ISLAND render + all q* handlers + validateQuestionnaireForCreator
                             (src 2936-4040, 8598-9036) + readOnlyCountryList (src 13858)
      cif.js                 ISLAND render + entire CIF engine (~5,150 lines): renderCIF/renderUKCIF/
                             cifRenderGeneric, field/subform builders, metadata fetch, validators
                             (cifValidateUsForm1 ~1,280 lines), payload builders, saveCIFData +
                             UK 3-form chaining, completeCIF, cms* dropdown, UK/Schengen schema
                             (src 4041-7241, 9101-9243, 11367-13008, 13909-14038)
      fieldFormat.js         validateFieldFormat / sanitizeMobileField for the CIF island's raw
                             inputs (VERBATIM src 2045-2072)

    api/                     VERBATIM Zoho transport + async domain flows
      zoho.js                transport core: CRM v8 REST via invokeUrl, CRM SDK fallback,
                             Payments REST, response utils, initZoho, getLoggedInEmail
                             (src 13009-13037, 2111-2135, 13681-13760, 13248-13266)
      portal.js              submitPortalCrmRequest (3-transport ladder), pollCreatorRecord,
                             loadPortalCustomerData, CRM lookups, hydrate (src 10557-10729, 9992-10355, 13270-13677)
      products.js            loadDynamicProducts / Products_Report + "Get Products" bridge (src 13040-13236)
      deal.js                async deal: saveDealDetails/saveDealData, openZPayWidget,
                             createZohoPaymentLink, fetchAgreement, goDealSubStep, validateDealSubStep,
                             showPaymentConfirmedScreen/goToQuestionnaire (src 7994-8592, 10397-10544)
      questionnaire.js       submitQuestionnaire + saveQuestionnaire (exact payload) (src 9038-9098, 10733-11360)
      documents.js           ISLAND: checklist load, upload (2-step + FILE.uploadFile), preview
                             + Deluge base64 fallback (src 7261-7817)
      review.js              ISLANDS: renderReview + renderSuccess + reviewCard + declarationsComplete;
                             submitApplication (see §13) (src 7821-7864, 14355-14400)

    components/              React view
      shell/    TopNav, Loader, Toasts, Modal, PayConfirmedScreen
      dashboard/ Dashboard, ApplicationList
      wizard/   Wizard (header/stepper/footer + step switch)
      deal/     DealStep + DetailsPane/ServicesPane/TermsPane/PaymentPane + TravellerList,
                CountryTravellerMap, CoordinatorSection      ← real JSX
      fields/   Field/SelectField/TextareaField, MultiSelectCountry
      questionnaire/ Questionnaire.jsx   ← island host
      cif/           CIF.jsx             ← island host
      documents/     Documents.jsx       ← island host
      review/        Review.jsx          ← island host
      success/       Success.jsx         ← island host
```

---

## 4. Runtime data model

Two module-level singletons in `store/runtime.js`, mutated in place:

- **`applicationData`** — the whole application. Shape (from `blankApplication()`):
  ```
  applicationId, currentStep,
  customer: { firstName, lastName, email, mobile, nationality, coordinator, mailing* },
  deal: { crmDealId, crmContactId, dealName, dealSavedToCRM, destination, goal,
          travellers[], selectedServices[], serviceBasket[], selectedAddons[],
          termsAccepted, signature, usaDateBooking, premiumVisaInterview,
          agreementHtml, agreementTemplateName },
  payment: { status, method, baseCost, taxes, addons, grandTotal, paymentMode,
             payableNow, paidAmount, balanceAmount, crmBalanceAmount, paymentLink*, paidAt },
  questionnaire: { applyingCountries, purpose[], finance{travId:…}, ties{}, childrenInfo{},
                   history{}, … creatorRecordId },
  cifData: { travId: { instances: { instanceId: { f1, f2, f3, f4 } } } },
  cifRecords: { travId: { instanceId: … } },
  stepStatus: { dealCompleted, questionnaireCompleted, cifCompleted, submitted },
  crmSync: { loggedInEmail, requestId, applicationIds[], … },
  lastSavedAt
  ```
  Paths are addressed as strings by `getByPath`/`setByPath` (e.g.
  `"deal.travellers.0.firstName"`, `"cifData.t1.instances.united-kingdom-uk.f1.<field>"`).

- **`state`** — transient UI state (never persisted): `activeView` ("dashboard"|"wizard"),
  `dealSubStep`, `activeCifTraveller/Instance/Stage/Category`, `documents{…}`,
  `pendingPackageId`, `pendingAssignedTo`, `payConfirmed`, `portalApplications`, etc.

`applicationData` is what gets saved to `localStorage` (key `CONFIG.localStorageKey`
= `"winnyApplication"`) and to the per-user drafts index.

---

## 5. How rendering & re-rendering works

- `AppStore.jsx` holds a `version` number; `bump()` increments it → React re-renders
  the subtree. On mount it registers the real UI-bridge implementations
  (`registerUi({...})`) so `lib/ui.js`'s `requestRender()` == `bump()`, `toast()`
  pushes a toast, `showLoader()` toggles the overlay, etc.
- **Logic mutates `applicationData` then calls `requestRender()`.** Components read
  straight from the (now-mutated) `applicationData` on the next render. There is no
  Redux/immutable-update pattern — mutation + bump, exactly like the original's
  "mutate then renderAll()".
- Components subscribe by calling `useApp()` (reads `version`).

**Focus preservation:** React reconciliation preserves input focus across a
controlled re-render (unlike the original's `innerHTML` rebuild), so JSX inputs can
`requestRender()` on every keystroke — this makes side panels (pricing, country map)
update live. Islands avoid re-render on keystroke by using raw DOM inputs (see §7).

---

## 6. The "island" pattern (Questionnaire, CIF, Documents, Review, Success)

These sections were too DOM-imperative to safely rewrite as JSX (section show/hide
navigation, hundreds of inline handlers, dependent-block toggles, subforms). They
are ported **verbatim** and hosted inside a thin React component:

- The verbatim `renderX()` builds an HTML string. Two hosting styles exist:
  - **Return HTML → inject**: Questionnaire — `renderQuestionnaireHTML()` returns a
    string; the component sets `ref.innerHTML`.
  - **Write to element by id**: CIF/Documents/Review/Success — `renderCIF()` etc.
    still do `qs("#stepCIF").innerHTML = …`, and the component just renders
    `<section id="stepCIF">` for them to target. (Cleanest — engine stays 100% verbatim.)
- The component exposes the inline handlers on `window` (e.g. `window.cifSetYesNo`,
  `window.qTogMulti`, `window.loadDocumentChecklist`) so the original
  `onclick="cifSetYesNo(...)"` attributes work.
- **Re-render inside an island** happens by the handlers calling the render fn again
  (CIF: `renderCIF()`; Questionnaire: `rerenderQuestionnaire()` which the component
  registers). This is NOT React's `requestRender` — it re-injects that island's HTML.
- **Raw `data-bind` inputs** (CIF text fields) are handled by input/blur delegation
  attached to the island container in the component, mirroring the original global
  `handleInput`/`handleFieldBlur` (see `components/cif/CIF.jsx`). They intentionally
  do **not** trigger a React re-render (keeps focus, matches original).

### Editing an island
- To change *fields/labels/logic*: edit the verbatim `renderX`/handlers in
  `core/questionnaire.js`, `core/cif.js`, `api/documents.js`, or `api/review.js`.
- If you add a **new inline handler name**, you MUST add it to that island component's
  `*_HANDLERS` array (or it won't be on `window` and the click will silently no-op).
- Keep handlers calling the island's own render fn to refresh; don't reach for React.

---

## 7. Field binding

Two mechanisms, by area:

- **JSX areas (deal step, dashboard):** `hooks/useBind.js`.
  - `<Field label path type … />`, `<SelectField>`, `<TextareaField>` (in
    `components/fields/Field.jsx`) render controlled inputs via `bindInput(path)` /
    `bindCheckbox(path)`.
  - `commitField` reproduces the original `handleInput` (DOB future-clamp, mobile
    digit-strip to 10, `setByPath`, `cifMarkInstanceDirtyFromPath`,
    `recalculatePayment`, autosave) then `requestRender()`.
  - `blurField` runs email/phone/passport validation into a `fieldErrors[path]` map;
    the `Field` reads it to show the `.invalid` class + `.error` text.
  - `MultiSelectCountry.jsx` is the JSX rewrite of the country dropdown (deal
    destination), with the cif-reset side effects preserved.
- **Islands (CIF):** raw `data-bind` inputs + delegation in `CIF.jsx`
  (`sanitizeMobileField`, `validateFieldFormat` from `core/fieldFormat.js`). The CIF
  also uses the original `cms*` dropdown functions (in `core/cif.js`, exposed on window).

---

## 8. Navigation & the wizard

- `state.activeView` = `"dashboard"` | `"wizard"` picks the top-level view in
  `App.jsx`. `applicationData.currentStep` (1–6) picks the wizard step in `Wizard.jsx`.
- `core/navigation.js`: `showDashboard`, `showWizard`, `goToDashboard`, `showStep`,
  `nextStep`, `previousStep`. `showStep` enforces `isStepLocked` (a step is locked
  until the prior stepStatus is met), triggers `loadDocumentChecklist(true)` on step 3,
  saves the draft, and `requestRender()`s.
- The wizard footer's Prev/Next and the stepper buttons call these. `nextStep`
  branches per step (deal sub-steps → `goDealSubStep`; step 2 → `submitQuestionnaire`;
  step 4 → `completeCIF`; step 5 → `submitApplication`).

---

## 9. API / endpoints reference (do not change these strings)

All in `config/config.js` (`CONFIG`) + the `api/` layer.

**Bases / connections**
- CRM v8 REST: `https://www.zohoapis.com/crm/v8` via `ZOHO.CREATOR.API.invokeUrl`,
  `connectionName: "zohocrm_connection11"`.
- CRM SDK fallback: `ZOHO.CRM.API.*` (searchRecord/getRecord/getRelatedRecords/…).
- Payments REST: `https://payments.zoho.in/api/v1`, `connectionName: "zohopayments_connection"`.
- Creator app: owner `hpatel_winnyedu`, app `hiren-patel`, report `Portal_CRM_Request_Report`.

**The Deluge bridge** (`api/portal.js` → `submitPortalCrmRequest` + `pollCreatorRecord`):
writes a `Portal_CRM_Request` record with a `Request_Type`, polls until `Status`
leaves Pending/Processing. Request types used:
`"Save Deal"`, `"Payment Complete"`, `"Sync Application Details"`,
`"Create Payment Session"`, `"Check Payment Status"`, `"Get Applications"`,
`"Get Application Details"`, `"Get Products"`, `"Get Document Checklist"`,
`"Upload Document"`, `"Get Document View URL"`, `"Create Applications"`.

**Direct Creator forms** (`CONFIG.creator.formLinkNames` / `reportLinkNames`):
questionnaire `Visitor_Visa_Questionnaire_Sales1`; CIF `UK_CIF_1/2/3`,
`Schengen_Visitor_visa`, `Australia_Customer_Information[_2/3/4]`, `Us_Form_1..4`,
saved via `ZOHO.CREATOR.DATA.addRecords` / `updateRecordById` with exact field link names.

**Payments widget** (`api/deal.js` → `openZPayWidget`): creates a payment session via
the bridge, then `new ZPayments(...).requestPaymentMethod(...)`.

> The exact field link names in `saveQuestionnaire` (`api/questionnaire.js`) and the
> CIF payload builders (`core/cif.js`) match live Zoho forms and were verified. Do
> not rename map keys/values without confirming against the actual Creator form.

---

## 10. Change recipes ("I want to … → edit …")

| Goal | Where |
|---|---|
| Change styling / spacing / colors | `src/styles/portal.css` (was byte-identical; edit here if you must) |
| Add/rename a CONFIG endpoint, connection, form/report link | `src/config/config.js` (`CONFIG`) |
| Change the product catalog fallback or mapping | `config/config.js` (`packageCatalog`) + `api/products.js` (`mapCreatorProductToCatalogItem`) |
| Add a field to the **Deal** step | the relevant `components/deal/*Pane.jsx` (JSX) using `<Field path=…>` |
| Change **traveller** fields | `components/deal/TravellerList.jsx` |
| Change **goal tiles / package cards / basket** | `components/deal/ServicesPane.jsx` + `core/catalog.js` |
| Change the **agreement** text/templates | `api/deal.js` → `fetchAgreement` |
| Change **payment** flow / amounts / modes | `core/derive.js` (payment math) + `api/deal.js` (`openZPayWidget`, `completePayment`) |
| Change **deal save** payload / CRM sync | `api/deal.js` (`saveDealDetails`, `saveDealData`) + `api/portal.js` (`submitPortalCrmRequest` payload) |
| Change a **Questionnaire** question/section/logic | `core/questionnaire.js` (`renderQuestionnaireHTML` + `q*` handlers). New inline handler → also add to `Questionnaire.jsx` `Q_HANDLERS`. |
| Change **Questionnaire → Creator** mapping (choice values, slots) | `api/questionnaire.js` (`saveQuestionnaire`) |
| Change a **CIF** field/section/validation (any country) | `core/cif.js`. UK uses the hardcoded `CIF_UK_SECTIONS`; generic countries use fetched metadata + `SCHENGEN_*`/`cifGeneric*`. New inline handler → also add to `CIF.jsx` `CIF_HANDLERS`. |
| Change **CIF save / record chaining** | `core/cif.js` (`saveCIFData`, `saveUKCIFForTraveller`, `cifBuildFormPayload`, `cifChainLinks`) |
| Change **Documents** checklist/upload/preview | `api/documents.js`. New inline handler → also `Documents.jsx` `DOC_HANDLERS`. |
| Change **Review** cards or **Success** screen | `api/review.js` (`renderReview` / `renderSuccess`) |
| Change **dashboard** cards / application list | `components/dashboard/Dashboard.jsx`, `ApplicationList.jsx` + `core/derive.js` (card assembly), `core/drafts.js` |
| Change **step gating / navigation** | `core/navigation.js` (`isStepLocked` is in `core/derive.js`) |
| Add a global toast/loader/modal call from logic | import from `lib/ui.js` |
| Wire the missing **submit** | `api/review.js` `submitApplication` (see §13) |

---

## 11. Build, config, deploy

```bash
npm install
npm run dev      # http://localhost:5173 (renders fully; Zoho calls won't complete off-Creator)
npm run build    # → dist/index.html (single self-contained file, JS+CSS inlined)
npm run pack     # → winny-portal-widget.zip  (plugin-manifest.json + widget/index.html)
```

- **Before a production build**, set `paymentsAccountId` and `paymentsApiKey` in
  `config/config.js` (blank in the repo — scrubbed). Other CONFIG values are the
  verified production values.
- Upload `winny-portal-widget.zip` as a widget in the Creator app
  (`hpatel_winnyedu / hiren-patel`). The two Zoho SDK `<script>` tags in `index.html`
  load from Zoho's CDN and stay external.
- `plugin-manifest.json` declares the CSP domains the widget may reach.

---

## 12. Invariants — do not break these

- `applicationData` and `packageCatalog` references never change (mutate in place).
- No direct DOM writes from logic modules except inside the islands' own `renderX`;
  logic reaches the shell only via `lib/ui.js`.
- Island inline-handler names must be mirrored in the host component's handler array.
- `portal.css` unchanged; classes/ids in JSX and island HTML must match its selectors.
- Zoho endpoint/connection/form/field strings unchanged unless verified against Zoho.
- `main.jsx` intentionally omits `React.StrictMode` (StrictMode double-invokes effects
  and would run the Zoho boot twice).
- Circular imports exist between `core/` and `api/` modules by design; they're safe
  because every cross-reference is a function called at runtime, not at module load.

---

## 13. Known issues / limitations

- **`submitApplication` was never implemented in the original.** It's *called*
  (the Review "Submit Application" button and `nextStep` on step 5) but had no
  definition in the source — a latent bug. It's preserved as a **no-op** in
  `api/review.js`. To make Submit work, implement it there (likely: set
  `stepStatus.submitted`, `review.submittedAt`, save, `showStep(6)`, and/or a
  Deluge `Request_Type` if the backend expects one — confirm the intended flow first).
- **Off-Creator**, saves/fetches/payments/CIF-metadata/uploads can't complete
  (SDK only responds inside the widget). The UK CIF renders fully from its hardcoded
  schema; generic (Schengen/USA/Australia) CIF forms need live Creator field metadata.
- A few original `data-action`s (`select-package`, `create-payment-link`,
  `complete-payment`, `select-choice`, `open-accordion`, `reset-draft`) are wired in
  logic but were **never rendered** in the UI (dead in the original). They're ported
  but unused.

---

## 14. Testing locally (seed a state to reach a step)

Steps are gated (`isStepLocked`). To view a later step without doing the whole flow,
seed a draft in the browser console and reload, then open it from the dashboard:

```js
localStorage.setItem("winnyApplication", JSON.stringify({
  applicationId: "WG-2026-0001", currentStep: 4,
  customer: { firstName: "Asha", lastName: "Patel", email: "a@b.com", mobile: "9812300000", nationality: "Indian" },
  deal: { crmDealId: "DEAL1", dealSavedToCRM: true, destination: "United Kingdom",
    travellers: [{ id: "t1", type: "Primary Applicant", firstName: "Asha", lastName: "Patel", countries: ["United Kingdom"] }],
    selectedServices: [], serviceBasket: [], selectedAddons: [], termsAccepted: true, signature: "Asha Patel" },
  payment: { status: "Paid", grandTotal: 12000, paidAmount: 12000 },
  questionnaire: { applyingCountries: "United Kingdom" },
  stepStatus: { dealCompleted: true, questionnaireCompleted: true, cifCompleted: false, submitted: false },
  lastSavedAt: new Date().toISOString()
}));
// reload, then click the matching journey card (steps 1–4) or a stepper button.
```

Set `stepStatus.cifCompleted` / `.submitted` and `currentStep` to reach Review (5) /
Success (6). Use a UK `destination` to exercise the CIF without Creator metadata.

---

## 15. Source traceability

Every verbatim module's header comment cites the original line ranges. The original
single file is not in this repo; if you have it, you can diff any module against those
ranges to confirm fidelity. The mapping is also summarized per-file in §3.
