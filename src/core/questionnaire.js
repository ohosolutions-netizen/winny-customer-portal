// ─────────────────────────────────────────────────────────────────────────
// Questionnaire engine — copied VERBATIM from the original widget.
// This 6-section flow is intensely DOM-imperative (inline q* handlers, section
// show/hide navigation, dependent-block toggles). To preserve UI + logic exactly
// it is rendered as an "island": renderQuestionnaireHTML() returns the original's
// HTML, the <Questionnaire> component injects it and exposes the q* handlers on
// window, and rerenderQuestionnaire() re-injects (the two original
// renderQuestionnaire() self-calls). Mechanical changes only:
//   • the two `qs("#stepQuestionnaire").innerHTML = …; return;` → `return …;`
//   • the q* helpers' `rerenderQuestionnaire();` → `rerenderQuestionnaire();`
// ─────────────────────────────────────────────────────────────────────────
import { applicationData, state } from "../store/runtime.js";
import { escapeHtml, setByPath } from "../lib/utils.js";
import { markAutoSavePending, toast } from "../lib/ui.js";
import { saveDraft } from "./drafts.js";
import { sendQuestionnaireEmail } from "../api/deal.js";
import { submitQuestionnaire } from "../api/questionnaire.js";
import { SCHENGEN_COUNTRIES } from "../config/config.js";
import { isAdultTraveller } from "./terms.js";

// The component registers its re-inject callback here; the original called
// renderQuestionnaire() to rebuild #stepQuestionnaire in place.
let _rerender = () => {};
export function registerQuestionnaireRerender(fn) { _rerender = fn || (() => {}); }
export function rerenderQuestionnaire() { _rerender(); }

// ── deriveQuestionnaireUnits ───────────────────────────────────────────────
// Groups the deal's travellers into questionnaire units based on familyId.
//   Individual booking (1 traveller, no familyId)  → 1 unit
//   Family / Couple (all share the same familyId)   → 1 unit
//   Friends / Group / Corporate (each own familyId) → 1 unit per traveller
//   Two families in one booking                     → 1 unit per family
// Returns an ordered array of unit descriptors so the questionnaire step
// can show an overview and render each unit's form independently.
export function deriveQuestionnaireUnits() {
  const travellers = applicationData.deal.travellers || [];
  const familyMap = new Map();
  travellers.forEach((t) => {
    const fid = t.familyId || "family-1";
    if (!familyMap.has(fid)) familyMap.set(fid, []);
    familyMap.get(fid).push(t);
  });

  const isMulti = familyMap.size > 1;
  const units = [];
  let idx = 0;
  for (const [familyId, members] of familyMap) {
    const primary =
      members.find((t) => t.type === "Primary Applicant") || members[0] || {};
    const primaryName =
      `${primary.firstName || ""} ${primary.lastName || ""}`.trim() ||
      "Applicant";
    let label;
    if (!isMulti) {
      label =
        members.length === 1
          ? primaryName
          : `${primary.firstName || "Your"} Family`;
    } else {
      label = members.length > 1 ? `${primaryName} & Family` : primaryName;
    }
    const minorOnly = members.every((t) => !isAdultTraveller(t));
    units.push({
      familyId,
      label,
      primaryTraveller: primary,
      travellers: members,
      minorOnly,
      index: idx,
    });
    idx++;
  }
  return units;
}

// ── Per-unit shared-data helpers ───────────────────────────────────────────
// Trip-level fields (purpose, maritalStatus, travelDates, …) are stored flat
// in applicationData.questionnaire and always reflect the ACTIVE unit.
// On unit switch these helpers save/restore them so each unit keeps its own answers.
const UNIT_SHARED_KEYS = [
  "applyingCountries","purpose","purposeOther","functionType","maritalStatus",
  "arrangements","travelDates","inviter","inviterRelation","inviterStatus",
  "invitationLetter","multiAnswers",
];

function qSaveUnitSharedData(familyId) {
  if (!familyId) return;
  if (!applicationData.questionnaire.unitShared) applicationData.questionnaire.unitShared = {};
  const snap = {};
  UNIT_SHARED_KEYS.forEach((k) => {
    const v = applicationData.questionnaire[k];
    snap[k] = Array.isArray(v) ? [...v] : (v && typeof v === "object" ? { ...v } : v);
  });
  applicationData.questionnaire.unitShared[familyId] = snap;
}

function qLoadUnitSharedData(familyId) {
  if (!familyId) return;
  const snap = (applicationData.questionnaire.unitShared || {})[familyId] || {};
  UNIT_SHARED_KEYS.forEach((k) => {
    const def = (k === "purpose" || k === "inviter") ? [] : (k === "travelDates" || k === "multiAnswers") ? {} : "";
    applicationData.questionnaire[k] = snap[k] !== undefined ? snap[k] : def;
  });
}

// ── qState ─────────────────────────────────────────────────────────────────
    let qState = {
  currentSection:  0,
  completedSections: [],
  activeUnitIndex: 0,       // which unit is currently being filled
  activeTravellerIndex: 0,  // which traveller within the unit is currently being answered
  unitCompletions: {},      // { familyId: true } — units whose questionnaire was submitted
  viewMode: "auto",         // "auto" → overview for multi-unit, form for single-unit; "form" → force form
};

// ── Unit navigation handlers ───────────────────────────────────────────────
export function qStartUnit(idx) {
  const units = deriveQuestionnaireUnits();
  if (idx < 0 || idx >= units.length) return;

  // Save the active unit's shared trip-level data before switching
  const currentUnit = units[qState.activeUnitIndex];
  if (currentUnit && units.length > 1) qSaveUnitSharedData(currentUnit.familyId);

  qState.activeUnitIndex = idx;
  qState.activeTravellerIndex = 0;
  qState.viewMode = "form";
  qState.currentSection = 0;
  qState.completedSections = [];

  // Load the target unit's shared data (or defaults for a fresh unit)
  if (units.length > 1) qLoadUnitSharedData(units[idx].familyId);

  rerenderQuestionnaire();
}

export function qBackToOverview() {
  const units = deriveQuestionnaireUnits();
  const currentUnit = units[qState.activeUnitIndex];
  if (currentUnit && units.length > 1) qSaveUnitSharedData(currentUnit.familyId);
  qState.viewMode = "auto";
  rerenderQuestionnaire();
}

// ── Unit overview panel ────────────────────────────────────────────────────
function renderUnitOverviewHTML(units) {
  // Restore unit completions from persisted submittedUnits (survives page reload)
  const persistedUnits = applicationData.questionnaire.submittedUnits || {};
  Object.keys(persistedUnits).forEach((fid) => { qState.unitCompletions[fid] = true; });

  const allDone = units.every((u) => qState.unitCompletions[u.familyId]);
  const doneCount = units.filter((u) => qState.unitCompletions[u.familyId]).length;

  const rows = units.map((u) => {
    const done = qState.unitCompletions[u.familyId];
    const unitFillMode = u.travellers[0]?.qFillMode || "owner";

    const memberNames = u.travellers
      .map((t) => `${t.firstName || ""} ${t.lastName || ""}`.trim())
      .filter(Boolean)
      .join(", ");

    // Per-unit link state (read from first traveller in unit)
    const unitToken    = u.travellers[0]?.qToken || "";
    const unitLinkSent = u.travellers.some((t) => t.qLinkSent);
    const fid = escapeHtml(u.familyId);

    // Status indicator — left accent bar colour + badge
    const linkWaiting = !done && unitFillMode === "link" && unitLinkSent;
    const rowBg = done ? "background:#f0fdf4" : linkWaiting ? "background:#fffbeb" : "";
    const accentColor = done ? "var(--teal)" : linkWaiting ? "#f59e0b" : "var(--line)";
    const statusBadge = done
      ? `<span class="badge done" style="font-size:11px;white-space:nowrap">&#x2713; Submitted</span>`
      : linkWaiting
        ? `<span class="badge" style="font-size:11px;white-space:nowrap;background:#fff8e1;color:#b45309;border:1px solid #fde68a">&#x23F3; Awaiting traveller</span>`
        : `<span class="badge" style="font-size:11px;white-space:nowrap;opacity:.7">Pending</span>`;

    // Fill mode toggle (not shown for minor-only units)
    const fillModeToggle = u.minorOnly ? "" : `
      <div style="display:flex;align-items:center;gap:6px;margin-top:10px;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--muted);flex-shrink:0">Who fills:</span>
        <button
          class="btn${unitFillMode === "owner" ? " primary" : " ghost"}"
          type="button" style="font-size:12px;padding:3px 10px"
          onclick="qSetUnitFillMode('${fid}','owner')"
        >&#x270F;&#xFE0F; I fill it</button>
        <button
          class="btn${unitFillMode === "link" ? " primary" : " ghost"}"
          type="button" style="font-size:12px;padding:3px 10px"
          onclick="qSendLinkToTraveller('${fid}')"
        >&#x1F517; Send link to traveller</button>
      </div>`;

    // Link section — shown below the toggle when mode is "link"
    let linkSection = "";
    if (!u.minorOnly && unitFillMode === "link") {
      if (!unitToken) {
        // Token is generated immediately by qSendLinkToTraveller — this state is transient
        linkSection = "";
      } else if (!unitLinkSent) {
        const linkUrl = escapeHtml(qBuildLink(unitToken, u.primaryTraveller));
        const tEmail = escapeHtml(u.primaryTraveller?.email || "");
        linkSection = `
          <div style="margin-top:10px;padding:12px 14px;background:#f8fafc;border:1.5px dashed #60a5fa;border-radius:8px">
            <div style="font-size:13px;font-weight:600;margin-bottom:6px;color:#1e40af">&#x1F517; Private link ready — share it with the traveller</div>
            <div style="font-family:monospace;font-size:11px;background:#fff;border:1px solid var(--line);border-radius:6px;padding:8px 10px;word-break:break-all;color:var(--navy);margin-bottom:10px">${linkUrl}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              ${tEmail ? `<button class="btn primary" type="button" style="font-size:13px" onclick="qEmailLink('${fid}')">&#x2709;&#xFE0F; Send email to traveller</button>` : ""}
              <button class="btn${tEmail ? " ghost" : " primary"}" type="button" style="font-size:13px" onclick="qCopyLink('${fid}')">
                &#x1F4CB; Copy link
              </button>
              <button class="btn ghost" type="button" style="font-size:12px" onclick="qResetLink('${fid}')">
                &#x21BA; Regenerate
              </button>
            </div>
            ${tEmail ? `<div style="font-size:11px;color:var(--muted);margin-top:8px">Will send to: <strong>${tEmail}</strong></div>` : `<div style="font-size:11px;color:var(--muted);margin-top:8px">Copy and send this link via WhatsApp, email, or SMS.</div>`}
          </div>`;
      } else {
        const linkUrl = escapeHtml(qBuildLink(unitToken, u.primaryTraveller));
        const tEmail = escapeHtml(u.primaryTraveller?.email || "");
        linkSection = `
          <div style="margin-top:10px;padding:12px 14px;background:#fffbeb;border:1.5px solid #fde68a;border-radius:8px">
            <div style="font-size:13px;font-weight:600;margin-bottom:4px;color:#92400e">&#x23F3; Waiting for traveller to complete their questionnaire</div>
            <div style="font-family:monospace;font-size:11px;background:#fff;border:1px solid var(--line);border-radius:6px;padding:7px 10px;word-break:break-all;color:var(--muted);margin:8px 0">${linkUrl}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${tEmail ? `<button class="btn ghost" type="button" style="font-size:12px" onclick="qEmailLink('${fid}')">&#x2709;&#xFE0F; Resend email</button>` : ""}
              <button class="btn ghost" type="button" style="font-size:12px" onclick="qCopyLink('${fid}')">
                &#x1F4CB; Copy link again
              </button>
              <button class="btn ghost" type="button" style="font-size:12px;color:var(--red)" onclick="qResetLink('${fid}')">
                &#x21BA; Reset &amp; regenerate
              </button>
            </div>
          </div>`;
      }
    }

    const fillModeSection = u.minorOnly
      ? `<div style="font-size:12px;color:var(--muted);margin-top:8px">&#x1F9D2; Guardian / parent fills on behalf of the minor</div>`
      : fillModeToggle + linkSection;

    const actionBtn = done
      ? `<button class="btn ghost" type="button" style="white-space:nowrap" onclick="qStartUnit(${u.index})">Edit answers &#x2192;</button>`
      : unitFillMode === "link"
        ? ""
        : `<button class="btn primary" type="button" style="white-space:nowrap" onclick="qStartUnit(${u.index})">Fill questionnaire &#x2192;</button>`;

    return `
      <div style="display:flex;align-items:stretch;border:1.5px solid var(--line);border-radius:var(--radius);overflow:hidden;margin-bottom:10px;${rowBg}">
        <div style="width:4px;flex-shrink:0;background:${accentColor}"></div>
        <div style="flex:1;padding:14px 16px;min-width:0">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:10px;min-width:0">
              <div style="width:36px;height:36px;border-radius:50%;background:${done ? "var(--teal)" : "#e2e8f0"};color:${done ? "#fff" : "var(--navy)"};display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;flex-shrink:0">${escapeHtml((u.label[0] || "Q").toUpperCase())}</div>
              <div style="min-width:0">
                <div style="font-weight:700;font-size:14px;color:var(--navy)">${escapeHtml(u.label)}</div>
                <div style="font-size:12px;color:var(--muted);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(memberNames) || "—"}</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
              ${statusBadge}
              ${actionBtn}
            </div>
          </div>
          ${fillModeSection}
        </div>
      </div>`;
  }).join("");

  const progressBar = units.length > 1 ? `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px">
      <div style="flex:1;height:6px;background:var(--line);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${Math.round((doneCount / units.length) * 100)}%;background:var(--teal);border-radius:3px;transition:width .3s"></div>
      </div>
      <span style="font-size:12px;color:var(--muted);white-space:nowrap;flex-shrink:0">${doneCount} of ${units.length} completed</span>
    </div>` : "";

  return `
    <section class="wizard-panel">
      <div class="panel-head">
        <div>
          <h3>Visa Questionnaire</h3>
          <p>${units.length === 1
            ? "Complete the questionnaire for this application."
            : `Fill in the questionnaire for each group below. You can do them in any order.`}</p>
        </div>
        <button class="btn ghost" type="button" style="padding:6px 14px;font-size:13px" onclick="qGoToCommon()">&#x2190; Case details</button>
      </div>
      <div class="panel-body">
        ${progressBar}
        ${rows}
        ${allDone
          ? `<div style="margin-top:6px">
               <button class="btn primary" type="button" data-step-nav="3">
                 Continue to Document Checklist &#x2192;
               </button>
             </div>`
          : ""}
      </div>
    </section>`;
}

    // readOnlyCountryList — used by renderQuestionnaireHTML for the applying-for
    // countries display. Copied VERBATIM from the field builders (source 13858-13871).
    function readOnlyCountryList(label, countries) {
      const selected = (countries || []).map(c => String(c || "").trim()).filter(Boolean);
      const tagsHtml = selected.length
        ? selected.map(c => `<span class="cms-tag">${escapeHtml(c)}</span>`).join("")
        : `<span class="cms-placeholder">No country selected</span>`;

      return `<div class="field full" data-field="questionnaire.applyingCountries">
        <label>${escapeHtml(label)}</label>
        <div class="cms-wrap">
          <div class="cms-trigger readonly" aria-disabled="true">${tagsHtml}</div>
        </div>
        <small class="error"></small>
      </div>`;
    }

    // ── isQuestionnaireChild (source 2936-2965) ──
    function isQuestionnaireChild(traveller) {
  const type = String(traveller?.type || "").trim().toLowerCase();
  const relationship = String(traveller?.relationship || "").trim().toLowerCase();

  if (
    type === "child" ||
    type === "dependent child" ||
    relationship === "child" ||
    relationship === "son" ||
    relationship === "daughter"
  ) {
    return true;
  }

  if (type === "spouse" || type === "primary applicant") {
    return false;
  }

  if (!traveller?.dob) return false;

  const birthDate = new Date(traveller.dob);
  if (Number.isNaN(birthDate.getTime())) return false;

  const age = Math.floor(
    (Date.now() - birthDate.getTime()) /
    (365.25 * 24 * 60 * 60 * 1000)
  );

  return age < 18;
}

// ── Part A: Common questions (answered once per case) ─────────────────────
function renderCommonQuestionnaireHTML() {
  const c = applicationData.questionnaire.common || {};
  const deal = applicationData.deal;
  const customer = applicationData.customer;
  const isCorporate = String(deal.applicationType || "").toLowerCase() === "corporate";

  const bookingTypeLabel = {
    individual: "Individual",
    family: "Family",
    friends: "Friends / Group",
    corporate: "Corporate",
  }[String(deal.applicationType || "").toLowerCase()] || (deal.applicationType || "—");

  const payerLabel = {
    primary: "Primary applicant (I'll pay)",
    "someone-else": "Someone else pays",
    "per-group": "Each group pays separately",
  }[deal.payerMode || "primary"] || deal.payerMode || "—";

  const services = (deal.serviceBasket || []).map((s) => escapeHtml(s.name || "")).filter(Boolean);
  const servicesHtml = services.length
    ? services.map((s) => `<span class="cms-tag">${s}</span>`).join("")
    : `<span style="color:var(--muted)">—</span>`;

  const fullName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || "—";
  const destination = deal.destination || "—";
  const dateFrom = deal.travelDateFrom ? deal.travelDateFrom : "";
  const dateTo = deal.travelDateTo ? deal.travelDateTo : "";
  const travelDatesDisplay = dateFrom || dateTo
    ? `${dateFrom || "??"} → ${dateTo || "??"}`
    : "—";

  const corporateSection = isCorporate ? `
    <div class="q-blk">
      <div class="q-lbl">Company details <span class="q-req">Required</span></div>
      <div class="q-field-row">
        <div class="q-field">
          <label>Company name</label>
          <input type="text" placeholder="e.g. Acme Pvt Ltd"
            value="${escapeHtml(c.companyName || "")}"
            oninput="qSetCommonField('companyName',this.value)">
        </div>
        <div class="q-field">
          <label>GST / Registration number</label>
          <input type="text" placeholder="e.g. 27AAPFU0939F1ZV"
            value="${escapeHtml(c.gstNumber || "")}"
            oninput="qSetCommonField('gstNumber',this.value)">
        </div>
      </div>
    </div>` : "";

  return `
    <section class="wizard-panel">
      <div class="panel-head">
        <div>
          <h3>Case Questionnaire</h3>
          <p>Part A &mdash; Common details for this application (filled once).</p>
        </div>
        <span class="badge">Step 1 of 2</span>
      </div>
      <div class="panel-body">
        <div class="qn qn-blue">&#x1F4CB;
          These details apply to the whole case. Your information has been pre-filled
          from Step 1 &mdash; verify and complete any remaining fields, then continue
          to the individual questionnaires.
        </div>

        <div class="q-sec-card" style="margin-bottom:16px">
          <div class="q-sec-hd"><div class="q-sec-hd-row">
            <div class="q-sec-icon qsi-blue">&#x1F5C2;&#xFE0F;</div>
            <div class="q-sec-info">
              <div class="q-sec-title">Booking &amp; Your Details</div>
              <div class="q-sec-sub">Pre-filled from your application — read only</div>
            </div>
          </div></div>
          <div class="q-sec-body">
            <div class="q-blk" style="margin-bottom:0;border:none">
              <div class="q-field-row">
                <div class="q-field">
                  <label>Booking type</label>
                  <input type="text" value="${escapeHtml(bookingTypeLabel)}" readonly>
                </div>
                <div class="q-field">
                  <label>Full name</label>
                  <input type="text" value="${escapeHtml(fullName)}" readonly>
                </div>
              </div>
              <div class="q-field-row">
                <div class="q-field">
                  <label>Email address</label>
                  <input type="email" value="${escapeHtml(customer.email || "")}" readonly>
                </div>
                <div class="q-field">
                  <label>Mobile number</label>
                  <input type="tel" value="${escapeHtml(customer.mobile || "")}" readonly>
                </div>
              </div>
              <div class="q-field-row">
                <div class="q-field">
                  <label>Applying for country</label>
                  <input type="text" value="${escapeHtml(destination)}" readonly>
                </div>
                <div class="q-field">
                  <label>Approx. travel dates</label>
                  <input type="text" value="${escapeHtml(travelDatesDisplay)}" readonly>
                </div>
              </div>
              <div class="q-blk" style="margin-top:14px;margin-bottom:0;padding-bottom:0;border:none">
                <div class="q-lbl" style="margin-bottom:8px">Services being booked</div>
                <div class="cms-wrap"><div class="cms-trigger readonly" aria-disabled="true">${servicesHtml}</div></div>
              </div>
              <div class="q-field-row" style="margin-top:14px">
                <div class="q-field">
                  <label>Who is paying</label>
                  <input type="text" value="${escapeHtml(payerLabel)}" readonly>
                </div>
              </div>
            </div>
          </div>
        </div>

        ${corporateSection}

        <div class="q-sec-card" style="margin-bottom:16px">
          <div class="q-sec-hd"><div class="q-sec-hd-row">
            <div class="q-sec-icon qsi-blue">&#x1F4AC;</div>
            <div class="q-sec-info">
              <div class="q-sec-title">Additional Information</div>
              <div class="q-sec-sub">Optional note for your consultant</div>
            </div>
          </div></div>
          <div class="q-sec-body">
            <div class="q-blk" style="margin-bottom:0;border:none">
              <div class="q-lbl">Is there anything else you&rsquo;d like your consultant to know?</div>
              <div class="q-field-row single">
                <div class="q-field full">
                  <textarea rows="3" placeholder="Any special circumstances, previous application history, or notes for your consultant…"
                    oninput="qSetCommonField('consultantNotes',this.value)"
                    style="width:100%;resize:vertical">${escapeHtml(c.consultantNotes || "")}</textarea>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="q-sec-nav" style="justify-content:flex-end">
          <button class="btn-qnext" onclick="qSubmitCommon()">
            Continue to Individual Questionnaires &#x2192;
          </button>
        </div>
      </div>
    </section>`;
}

export function qSetCommonField(field, value) {
  if (!applicationData.questionnaire.common) applicationData.questionnaire.common = {};
  applicationData.questionnaire.common[field] = value;
  markAutoSavePending();
  rerenderQuestionnaire();
}

export function qSubmitCommon() {
  const c = applicationData.questionnaire.common || {};
  const isCorporate = String(applicationData.deal.applicationType || "").toLowerCase() === "corporate";
  if (isCorporate && !c.companyName) {
    toast("Please enter the company name before continuing.", "error");
    return;
  }
  applicationData.questionnaire.common.submitted = true;
  // Seed per-traveller qFillMode to "owner" if not already set (per-unit toggles in Part B handle overrides)
  (applicationData.deal.travellers || []).forEach((t) => {
    if (!t.qFillMode) t.qFillMode = "owner";
  });
  markAutoSavePending();
  rerenderQuestionnaire();
}

export function qGoToCommon() {
  if (applicationData.questionnaire.common) {
    applicationData.questionnaire.common.submitted = false;
  }
  rerenderQuestionnaire();
}

export function qSetUnitFillMode(familyId, mode) {
  const travellers = applicationData.deal.travellers || [];
  travellers.forEach((t) => {
    if ((t.familyId || "family-1") === familyId) {
      t.qFillMode = mode;
    }
  });
  markAutoSavePending();
  rerenderQuestionnaire();
}

export async function qSendLinkToTraveller(familyId) {
  const travellers = applicationData.deal.travellers || [];
  // Set mode to "link"
  travellers.forEach((t) => {
    if ((t.familyId || "family-1") === familyId) {
      t.qFillMode = "link";
    }
  });
  // Generate token immediately (skip the "Generate link" intermediate step)
  const token = qGenToken();
  travellers.forEach((t) => {
    if ((t.familyId || "family-1") === familyId) {
      t.qToken = token;
      t.qLinkSent = false;
      delete t.qCreatorRecordId;
    }
  });
  markAutoSavePending();
  rerenderQuestionnaire();
  // Auto-send email if traveller has an email address
  const primaryTraveller = travellers.find(
    (t) => (t.familyId || "family-1") === familyId
  );
  if (primaryTraveller?.email) {
    await qEmailLink(familyId);
  }
}

// ── Send-link helpers ──────────────────────────────────────────────────────
function qGenToken() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

export function qBuildLink(token, traveller) {
  const base = "https://creatorapp.zohopublic.in/hpatel_winnyedu/hiren-patel/form-perma/Visitor_Visa_Questionnaire_Sales1/DbxmEeJ6vGRwZ4hPGqgUYSwMqyfJAx5P7tG0rMuhKfrR1FKYFHMgqHjptzwzAqW0OfWyDjZVmhNzEUPw2x73Hb5faQszBmqfJ1m4";
  const clientName = traveller
    ? `${traveller.firstName || ""} ${traveller.lastName || ""}`.trim()
    : `${applicationData.customer?.firstName || ""} ${applicationData.customer?.lastName || ""}`.trim();
  const crmId = applicationData.deal?.crmDealId || "";
  const travellerType = traveller?.type || "";
  // All countries as array — each appended as separate param for multi-select pre-fill
  const countryList = Array.isArray(traveller?.countries)
    ? traveller.countries.filter(Boolean)
    : (typeof traveller?.countries === "string"
        ? traveller.countries.split(",").map(c => c.trim()).filter(Boolean)
        : []);
  // Convert yyyy-mm-dd → dd-MMM-yyyy to match Zoho Creator date field format
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const fmtDate = (iso) => {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}-${MONTHS[parseInt(m, 10) - 1]}-${y}`;
  };
  const dateFrom = fmtDate(applicationData.deal?.travelDateFrom || "");
  const dateTo   = fmtDate(applicationData.deal?.travelDateTo   || "");
  const params = new URLSearchParams({
    Q_Token: token,
    CRM_ID: crmId,
    Client_Name: clientName,
    Traveller_Type: travellerType,
    ...(dateFrom ? { Approx_Travel_Start_Date: dateFrom } : {}),
    ...(dateTo   ? { Approx_Travel_End_Date:   dateTo   } : {}),
  });
  // Append each country as a separate param — multi-select fields require repeated keys
  countryList.forEach(c => params.append("Applying_for_Country1", c));
  return `${base}?${params.toString()}`;
}

export function qGenerateLink(familyId) {
  const token = qGenToken();
  (applicationData.deal.travellers || []).forEach((t) => {
    if ((t.familyId || "family-1") === familyId) {
      t.qToken = token;
      t.qLinkSent = false;
      delete t.qCreatorRecordId;
    }
  });
  markAutoSavePending();
  rerenderQuestionnaire();
}

export function qCopyLink(familyId) {
  const traveller = (applicationData.deal.travellers || []).find(
    (t) => (t.familyId || "family-1") === familyId && t.qToken
  );
  if (!traveller) return;
  const url = qBuildLink(traveller.qToken, traveller);

  // Mark all unit travellers as link-sent
  (applicationData.deal.travellers || []).forEach((t) => {
    if ((t.familyId || "family-1") === familyId) t.qLinkSent = true;
  });
  markAutoSavePending();

  // Clipboard write with textarea fallback for cross-origin iframes
  const doFallback = () => {
    try {
      const el = document.createElement("textarea");
      el.value = url;
      el.style.cssText = "position:fixed;top:-9999px;left:-9999px";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      toast("Link copied to clipboard.", "ok");
    } catch (_) {
      toast("Could not copy automatically — select and copy the link manually.", "warn");
    }
    rerenderQuestionnaire();
  };

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(() => {
      toast("Link copied to clipboard.", "ok");
      rerenderQuestionnaire();
    }).catch(doFallback);
  } else {
    doFallback();
  }
}

export async function qEmailLink(familyId) {
  const traveller = (applicationData.deal.travellers || []).find(
    (t) => (t.familyId || "family-1") === familyId && t.qToken
  );
  if (!traveller) return;

  const toEmail = traveller.email || applicationData.customer?.email || "";
  if (!toEmail) {
    toast("No email address found for this traveller.", "error");
    return;
  }

  const url = qBuildLink(traveller.qToken, traveller);
  const name = `${traveller.firstName || ""} ${traveller.lastName || ""}`.trim() || "Traveller";

  try {
    toast("Sending email…", "info");
    await sendQuestionnaireEmail(toEmail, name, url);
    // Mark as sent
    (applicationData.deal.travellers || []).forEach((t) => {
      if ((t.familyId || "family-1") === familyId) t.qLinkSent = true;
    });
    markAutoSavePending();
    toast(`Questionnaire link sent to ${toEmail}`, "ok");
  } catch (_) {
    toast("Failed to send email. Please copy the link and share manually.", "error");
  }
  rerenderQuestionnaire();
}

export function qResetLink(familyId) {
  (applicationData.deal.travellers || []).forEach((t) => {
    if ((t.familyId || "family-1") === familyId) {
      t.qToken = "";
      t.qLinkSent = false;
    }
  });
  markAutoSavePending();
  rerenderQuestionnaire();
}

    // ── renderQuestionnaireHTML (source 2966-4040) — returns HTML ──
    function renderQuestionnaireHTML() {
  // Show Part A (common questions) until explicitly submitted
  if (!applicationData.questionnaire.common?.submitted) {
    return renderCommonQuestionnaireHTML();
  }

  /*
   * A submitted questionnaire is permanently read-only for portal customers.
   * Do not render its editable controls again.
   */
  if (applicationData.stepStatus.questionnaireCompleted) {
    const recordId =
      String(
        applicationData.questionnaire.creatorRecordId || ""
      ).trim();

    return `
      <section class="wizard-panel">
        <div class="panel-head">
          <div>
            <h3>Case Questionnaire</h3>
            <p>Your questionnaire has already been submitted.</p>
          </div>
          <span class="badge done">Submitted</span>
        </div>

        <div class="panel-body">
          <div class="notice teal">
            <strong>&#x2713; Questionnaire submitted</strong>
            <span>
              Your answers have been received and the questionnaire is now
              locked. Please contact your case officer if any information
              needs to be corrected.
            </span>
          </div>

          ${
            recordId
              ? `<div style="margin-top:12px;font-size:12px;color:var(--muted)">
                   Reference: ${escapeHtml(recordId)}
                 </div>`
              : ""
          }

          <div style="margin-top:18px">
            <button
              class="btn primary"
              type="button"
              data-step-nav="3"
            >
              Continue to Document Checklist
            </button>
          </div>
        </div>
      </section>`;

    return;
  }
  // ── Grouping logic: determine which questionnaire unit is active ──────────
  const _units = deriveQuestionnaireUnits();
  const _isMultiUnit = _units.length > 1;

  // Always show the unit overview first (single or multi-unit) so staff can choose fill or send-link per unit
  if (qState.viewMode !== "form") {
    return renderUnitOverviewHTML(_units);
  }

  // Clamp activeUnitIndex in case travellers changed
  if (qState.activeUnitIndex >= _units.length) qState.activeUnitIndex = 0;
  const _activeUnit = _units[Math.max(0, qState.activeUnitIndex)];
  const _activeUnitTravellers = _activeUnit ? _activeUnit.travellers : (applicationData.deal.travellers || []);

  // Keep applying-for-countries in sync with Step 1's destination — merge in
      // any destination country not already present, without clobbering manual
      // additions/removals the person made here. A one-time "seed only if empty"
      // check isn't enough: if destination changes (or wasn't set yet) after the
      // first render, it would never pick up new countries.
      const destCountries = (applicationData.deal.destination || "").split(",").map(s => s.trim()).filter(Boolean);
      const curCountries  = (applicationData.questionnaire.applyingCountries || "").split(",").map(s => s.trim()).filter(Boolean);
      const mergedCountries = [...new Set([...curCountries, ...destCountries])];
      if (mergedCountries.length && mergedCountries.join(", ") !== applicationData.questionnaire.applyingCountries) {
        applicationData.questionnaire.applyingCountries = mergedCountries.join(", ");
      }
            const adults = _activeUnitTravellers.filter(
        traveller => !isQuestionnaireChild(traveller)
      );

      const children = _activeUnitTravellers.filter(
        isQuestionnaireChild
      );
      const allTravellers = _activeUnitTravellers;
      const pas = allTravellers.filter(t => t.type === "Primary Applicant");
      const primaryTraveller = pas[0] || allTravellers[0] || {};
      const spouseTraveller = allTravellers.find(t => t.type === "Spouse");
      if (!applicationData.questionnaire.maritalStatus && spouseTraveller) {
        applicationData.questionnaire.maritalStatus = "married";
      }

      // Per-traveller: clamp and derive the traveller currently being answered for
      if (qState.activeTravellerIndex >= _activeUnitTravellers.length) qState.activeTravellerIndex = 0;
      const activeTraveller = _activeUnitTravellers[qState.activeTravellerIndex] || primaryTraveller;
      const isFirstTraveller = qState.activeTravellerIndex === 0;
      const isChildTraveller = isQuestionnaireChild(activeTraveller);
      const hasMoreTravellers = qState.activeTravellerIndex < _activeUnitTravellers.length - 1;
      const nextTraveller = hasMoreTravellers ? _activeUnitTravellers[qState.activeTravellerIndex + 1] : null;
      const activeTravellerName = `${activeTraveller.firstName||""} ${activeTraveller.lastName||""}`.trim() || "Traveller";

      const countries = (applicationData.questionnaire.applyingCountries || applicationData.deal.destination || "").split(",").map(s=>s.trim()).filter(Boolean);
      const isCanadaDest = countries.some(c => {
        const cl = c.toLowerCase();
        return cl === "canada";
      });
      const selectedPurposes = Array.isArray(
  applicationData.questionnaire.purpose
)
  ? applicationData.questionnaire.purpose
  : [];

const hasInviterPurpose = selectedPurposes.some((purpose) =>
  ["family", "friend", "family-func", "convocation", "business"].includes(purpose)
);

const needsFamilyInviterPerson =
  selectedPurposes.includes("family");

let sections;
if (isChildTraveller) {
  sections = ["sec-children", "sec-history"];
} else if (isFirstTraveller) {
  sections = [
    "sec-trip",
    ...(hasInviterPurpose ? ["sec-inviter"] : []),
    "sec-finance", "sec-occupation", "sec-assets", "sec-ties", "sec-history"
  ];
} else {
  sections = ["sec-finance", "sec-occupation", "sec-assets", "sec-ties", "sec-history"];
}
      const totalSec = sections.length;
      const sectionLabels = {"sec-trip":"Your Trip","sec-inviter":"Inviter / Host","sec-finance":"Finances","sec-occupation":"Occupation","sec-assets":"Assets & Investments","sec-ties":"Home Country Ties","sec-children":"Children","sec-history":"Travel History"};

      function qOptR(group, val, title, desc="") {
        const cur = applicationData.questionnaire[group] || "";
        const sel = cur === val ? "sel" : "";
        return `<div class="q-opt ${sel}" onclick="qSelOpt(this,'${group}','${val}')" data-group="${group}" data-val="${val}">
          <div class="q-radio"></div><div class="q-opt-body"><div class="q-opt-title">${escapeHtml(title)}</div>${desc?`<div class="q-opt-desc">${escapeHtml(desc)}</div>`:""}</div></div>`;
      }

      function qOptM(key, title, desc="") {
        const multiAnswers = applicationData.questionnaire.multiAnswers || {};
        const on = multiAnswers[key] ? "msel" : "";
        return `<div class="q-opt ${on}" onclick="qTogOpt(this,'${key}')" data-mkey="${key}">
          <div class="q-chk">&#x2713;</div><div class="q-opt-body"><div class="q-opt-title">${escapeHtml(title)}</div>${desc?`<div class="q-opt-desc">${escapeHtml(desc)}</div>`:""}</div></div>`;
      }
      function qOptMulti(group, val, title, desc="") {
        const arr = Array.isArray(applicationData.questionnaire[group]) ? applicationData.questionnaire[group] : [];
        const on = arr.includes(val) ? "msel" : "";
        return `<div class="q-opt ${on}" onclick="qTogMulti(this,'${group}','${val}')" data-group="${group}" data-val="${val}">
          <div class="q-chk">&#x2713;</div><div class="q-opt-body"><div class="q-opt-title">${escapeHtml(title)}</div>${desc?`<div class="q-opt-desc">${escapeHtml(desc)}</div>`:""}</div></div>`;
      }
      function qPurposeIncludes(val) {
        const arr = Array.isArray(applicationData.questionnaire.purpose) ? applicationData.questionnaire.purpose : [];
        return arr.includes(val);
      }

      function qFinOptR(travId, key, val, title, desc="") {
        const fin = (applicationData.questionnaire.finance || {})[travId] || {};
        const sel = fin[key] === val ? "sel" : "";
        return `<div class="q-opt ${sel}" onclick="qFinSel('${travId}','${key}','${val}',this)" data-group="${travId}-${key}" data-val="${val}">
          <div class="q-radio"></div><div class="q-opt-body"><div class="q-opt-title">${escapeHtml(title)}</div>${desc?`<div class="q-opt-desc">${escapeHtml(desc)}</div>`:""}</div></div>`;
      }
      function qFinFundingOpt(travId, val, title, desc="") {
  const fin = (applicationData.questionnaire.finance || {})[travId] || {};
  const selected = Array.isArray(fin.funding)
    ? fin.funding
    : (fin.funding ? [fin.funding] : []);

  const on = selected.includes(val) ? "msel" : "";

  return `<div class="q-opt ${on}" onclick="qFinTogFunding('${travId}','${val}',this)">
    <div class="q-chk">&#x2713;</div>
    <div class="q-opt-body">
      <div class="q-opt-title">${escapeHtml(title)}</div>
      ${desc ? `<div class="q-opt-desc">${escapeHtml(desc)}</div>` : ""}
    </div>
  </div>`;
}
      function qFinOptM(travId, key, title) {
        const fin = (applicationData.questionnaire.finance || {})[travId] || {};
        const on = (fin.multiAnswers || {})[key] ? "msel" : "";
        return `<div class="q-opt ${on}" onclick="qFinTogM('${travId}','${key}',this)" data-mkey="${travId}-${key}">
          <div class="q-chk">&#x2713;</div><div class="q-opt-body"><div class="q-opt-title">${escapeHtml(title)}</div></div></div>`;
      }

      function qHistOptR(travId, key, val, title, desc="") {
        const hist = (applicationData.questionnaire.history || {})[travId] || {};
        const sel = hist[key] === val ? "sel" : "";
        return `<div class="q-opt ${sel}" onclick="qHistSel('${travId}','${key}','${val}',this)" data-group="${travId}-${key}" data-val="${val}">
          <div class="q-radio"></div><div class="q-opt-body"><div class="q-opt-title">${escapeHtml(title)}</div>${desc?`<div class="q-opt-desc">${escapeHtml(desc)}</div>`:""}</div></div>`;
      }

      function avClass(t) {
        if (t.type === "Primary Applicant") return "pb-av-pa";
        if (t.type === "Spouse") return "pb-av-sp";
        return "pb-av-ch";
      }

      function initials(t) {
        return `${(t.firstName||"")[0]||""}${(t.lastName||"")[0]||""}`.toUpperCase() || "T";
      }

      function travellerLabel(t) {
        if (t.type === "Primary Applicant") return "Primary Applicant";
        if (t.type === "Spouse") return "Spouse";
        return t.type || "Traveller";
      }

      // Progress bar
      const done = qState.completedSections.filter((sectionId) =>
  sections.includes(sectionId)
).length;
      const pct = Math.round((done / totalSec) * 100);
      const curId = sections[qState.currentSection] || sections[0];
      const pillsHtml = sections.map((id,i) => {
        let cls = "locked";
        if (qState.completedSections.includes(id)) cls = "done";
        else if (i === qState.currentSection) cls = "active";
        else if (i < qState.currentSection) cls = "";
        return `<div class="qpill ${cls}" id="qpill-${id}">${escapeHtml(sectionLabels[id])}</div>`;
      }).join("");

      // Section 1 — Trip
      const questionnaireTravellerSlots = [];
      if (spouseTraveller) questionnaireTravellerSlots.push({ trav: spouseTraveller, relation: "Spouse" });
      children.slice(0, 3).forEach((child, i) => questionnaireTravellerSlots.push({ trav: child, relation: `Child ${i + 1}` }));
      allTravellers
        .filter(t =>
          t.id !== (primaryTraveller.id || "") &&
          (!spouseTraveller || t.id !== spouseTraveller.id) &&
          !children.slice(0, 3).some(child => child.id === t.id)
        )
        .forEach(t => {
          if (questionnaireTravellerSlots.length < 4) {
            questionnaireTravellerSlots.push({ trav: t, relation: t.relationship || t.type || "" });
          }
        });
      const companionCount = allTravellers.filter(t => t.id !== (primaryTraveller.id || "")).length;
      const totalPeopleTravellingValue = companionCount === 0 ? "None" : String(Math.min(companionCount, 4));
      const travellerReadonlyRows = questionnaireTravellerSlots.length
        ? questionnaireTravellerSlots.map((slot, i) => {
            const name = `${slot.trav.firstName || ""} ${slot.trav.lastName || ""}`.trim();
            return `<div class="q-field-row">
              <div class="q-field"><label>Traveller ${i + 1} Name</label><input type="text" value="${escapeHtml(name)}" readonly></div>
              <div class="q-field"><label>Traveller ${i + 1} Relation</label><input type="text" value="${escapeHtml(slot.relation)}" readonly></div>
            </div>`;
          }).join("")
        : `<div class="q-sub">No additional travellers were added in the application step.</div>`;

      // Auto-seed per-country travel dates from the deal's overall trip dates if not already set
      {
        const dealFrom = applicationData.deal.travelDateFrom || "";
        const dealTo   = applicationData.deal.travelDateTo   || "";
        if (dealFrom || dealTo) {
          if (!applicationData.questionnaire.travelDates) applicationData.questionnaire.travelDates = {};
          countries.forEach(c => {
            if (!applicationData.questionnaire.travelDates[c])
              applicationData.questionnaire.travelDates[c] = {};
            const td = applicationData.questionnaire.travelDates[c];
            if (!td.entry && dealFrom) td.entry = dealFrom;
            if (!td.exit  && dealTo)   td.exit  = dealTo;
          });
        }
      }

      const countryRows = countries.length
        ? countries.map(c => {
            const td = (applicationData.questionnaire.travelDates || {})[c] || {};
            return `<div class="ctt-row"><div class="ctt-ctry">${escapeHtml(c)}</div>
              <div><input type="date" value="${escapeHtml(td.entry||"")}" onchange="qSetTravelDate('${escapeHtml(c)}','entry',this.value)"></div>
              <div><input type="date" value="${escapeHtml(td.exit||"")}" onchange="qSetTravelDate('${escapeHtml(c)}','exit',this.value)"></div></div>`;
          }).join("")
        : `<div style="padding:12px;font-size:13px;color:var(--muted)">No destinations selected — go back to Step 1 and choose your destination countries.</div>`;

      const sec1 = `<div class="q-page ${curId==="sec-trip"?"active":""}" id="sec-trip">
        <div class="q-sec-card">
          <div class="q-sec-hd"><div class="q-sec-hd-row">
            <div class="q-sec-icon qsi-blue">&#x2708;&#xFE0F;</div>
            <div class="q-sec-info">
              <div class="q-sec-num">Section 1 of ${totalSec}</div>
              <div class="q-sec-title">Your Trip</div>
              <div class="q-sec-sub">Tell us about the purpose and plans for your visit</div>
            </div>
          </div>
          <div class="q-prefill-badge">&#x2705; Destination &amp; travellers pre-filled from your application</div></div>
          <div class="q-sec-body">

            <div class="q-blk">
              <div class="q-lbl">Which countries are you applying for? <span class="q-req">Required</span></div>
              <div class="q-sub">These should match the services you selected. This determines your document requirements.</div>
              ${readOnlyCountryList("Applying for countries *", countries)}
            </div>

            <div class="q-blk">
              <div class="q-lbl">Total number of people traveling with you? <span class="q-req">Required</span></div>
              <div class="q-sub">This is pre-filled from the travellers added in your application and cannot be changed here.</div>
              <div class="q-field-row single">
                <div class="q-field"><label>Total number of people traveling with you?</label><input type="text" value="${escapeHtml(totalPeopleTravellingValue)}" readonly></div>
              </div>
              ${travellerReadonlyRows}
            </div>

            <div class="q-blk">
              <div class="q-lbl">What is your marital status? <span class="q-req">Required</span></div>
              <div class="q-opts c3">
                ${qOptR("maritalStatus","single","Single (Never Married)","")}
                ${qOptR("maritalStatus","married","Married","")}
                ${qOptR("maritalStatus","divorced","Divorced","")}
                ${qOptR("maritalStatus","widowed","Widowed","")}
                ${qOptR("maritalStatus","separated","Separated","")}
              </div>
            </div>

            <div class="q-blk">
              <div class="q-lbl">What is the purpose of your visit? <span class="q-req">Required</span> <span style="font-size:12px;font-weight:400;color:var(--muted)">(select all that apply)</span></div>
              <div class="q-sub">Select all reasons that apply to your trip.</div>
              <div class="q-opts c2">
                ${qOptMulti("purpose","family","To meet Family Member / Relative","Visiting parents, siblings, children, or other family")}
                ${qOptMulti("purpose","family-func","To attend a family function","Wedding, birthday, anniversary, or similar celebration")}
                ${qOptMulti("purpose","tourism","Tourism","Sightseeing, leisure, or vacation travel")}
                ${qOptMulti("purpose","business","Business Visit","Conference, seminar, meeting, exhibition, or training")}
                ${qOptMulti("purpose","friend","To meet a Friend","Social visit to a friend")}
                ${qOptMulti("purpose","convocation","To attend Convocation","Graduation ceremony")}
                ${qOptMulti("purpose","transit","Transit","Passing through to reach another destination")}
                ${qOptMulti("purpose","medical","Medical Treatment","Seeking medical consultation or treatment")}
                ${qOptMulti("purpose","other","Other / Just exploring","")}
              </div>
              <div class="q-dep ${qPurposeIncludes("other")?"show":""}" id="dep-purpose-other">
                <div class="q-field-row single"><div class="q-field"><label>Please specify</label>
                  <input type="text" placeholder="Describe your purpose of visit"
                    value="${escapeHtml(applicationData.questionnaire.purposeOther||"")}"
                    oninput="qSetField('questionnaire.purposeOther',this.value)">
                </div></div>
              </div>
              <div class="q-dep ${qPurposeIncludes("family-func")?"show":""}" id="blk-function-type">
                <div class="q-sub">What type of function will you attend?</div>
                <div class="q-opts c2">
                  ${qOptR("functionType","wedding","Wedding","")}
                  ${qOptR("functionType","engagement","Engagement","")}
                  ${qOptR("functionType","reception","Reception","")}
                  ${qOptR("functionType","anniversary","Anniversary","")}
                  ${qOptR("functionType","birthday","Birthday","")}
                  ${qOptR("functionType","housewarming","Housewarming","")}
                </div>
              </div>
            </div>

            <div
  class="q-blk"
  id="blk-travel-arrangements"
  style="${
    Array.isArray(applicationData.questionnaire.purpose) &&
    applicationData.questionnaire.purpose.length
      ? ""
      : "display:none"
  }"
>
  <div class="q-lbl">Do you have specific travel plans or a pre-planned itinerary? <span class="q-req">Required</span></div>
              <div class="q-sub">Select "Yes" if you have booked your flights, hotels, or travel insurance.</div>
              <div class="qn qn-amber">&#x26A0;&#xFE0F; For Schengen / European countries, confirmed hotel, flight, and travel insurance are <strong>mandatory</strong> before submission.</div>
              <div class="q-opts c2">
                ${qOptR("arrangements","yes","Yes","")}
                ${qOptR("arrangements","no","No","")}
              </div>
            </div>

           <div
  class="q-blk ${
    ["yes", "no"].includes(applicationData.questionnaire.arrangements)
      ? ""
      : "hidden"
  }"
  style="margin-bottom:0;padding-bottom:0;border:none"
>
  <div class="q-lbl">
    ${
      applicationData.questionnaire.arrangements === "yes"
        ? "Intended travel dates for each country"
        : "When do you intend to travel?"
    }
  </div>

  <div class="q-sub">
    ${
      applicationData.questionnaire.arrangements === "yes"
        ? "Enter the intended entry and exit dates for each country."
        : "Enter your approximate entry and exit dates. You can update them later."
    }
  </div>
              <div class="ctt">
                <div class="ctt-hd"><div>Country</div><div>Approx Entry</div><div>Approx Exit</div></div>
                <div id="ctt-body">${countryRows}</div>
              </div>
            </div>

          </div>
        </div>
        <div class="q-sec-nav">
          <button class="btn-qback" style="visibility:hidden">&#x2190; Back</button>
          <button
  class="btn-qnext"
  onclick="qGoNext(
    'sec-trip',
    '${hasInviterPurpose ? "sec-inviter" : "sec-finance"}'
  )"
>
  Continue &mdash; ${hasInviterPurpose ? "Inviter" : "Finances"} &#x2192;
</button>
        </div>
      </div>`;

      // Section 2 — Inviter
      const sec2 = hasInviterPurpose
  ? `<div class="q-page ${curId==="sec-inviter"?"active":""}" id="sec-inviter">
        <div class="q-sec-card">
          <div class="q-sec-hd"><div class="q-sec-hd-row">
            <div class="q-sec-icon qsi-teal">&#x1F464;</div>
            <div class="q-sec-info">
              <div class="q-sec-num">Section 2 of ${totalSec}</div>
              <div class="q-sec-title">Who is inviting you?</div>
              <div class="q-sec-sub">Your host or inviter in the destination country</div>
            </div>
          </div></div>
          <div class="q-sec-body">
            <div class="qn qn-blue">&#x1F4A1; If travelling for tourism with no specific host, select "No one — travelling independently."</div>

            ${needsFamilyInviterPerson ? `
<div class="q-blk">
  <div class="q-lbl">Who is inviting you or who will you be staying with? <span class="q-req">Required</span> <span style="font-size:12px;font-weight:400;color:var(--muted)">(select all that apply)</span></div>
  <div class="q-opts c2">
    ${qOptMulti("inviter","father","Father","")}
    ${qOptMulti("inviter","mother","Mother","")}
    ${qOptMulti("inviter","brother","Brother","")}
    ${qOptMulti("inviter","sister","Sister","")}
    ${qOptMulti("inviter","son","Son","")}
    ${qOptMulti("inviter","daughter","Daughter","")}
    ${qOptMulti("inviter","uncle","Uncle","")}
    ${qOptMulti("inviter","aunt","Aunt","")}
    ${qOptMulti("inviter","cousin","Cousin","")}
    ${qOptMulti("inviter","grandson","Grandson","")}
    ${qOptMulti("inviter","granddaughter","Granddaughter","")}
    ${qOptMulti("inviter","husband","Husband","")}
    ${qOptMulti("inviter","wife","Wife","")}
    ${qOptMulti("inviter","grandparents","Grandparents","")}
  </div>
</div>` : ""}

            ${needsFamilyInviterPerson && applicationData.questionnaire.maritalStatus === "married" ? `<div class="q-blk">
              <div class="q-lbl">Is the inviter related to you directly, or through your spouse? <span class="q-req">Required</span></div>
              <div class="q-opts c2">
                ${qOptR("inviterRelation","direct","Directly related to me","")}
                ${qOptR("inviterRelation","spouse","Related to my spouse","")}
              </div>
            </div>` : ""}

            <div class="q-blk">
              <div class="q-lbl">What is your inviter's immigration status in the destination country? <span class="q-req">Required</span></div>
              <div class="q-sub">This determines what proof-of-status documents they need to provide.</div>
              <div class="q-opts c2">
                ${qOptR("inviterStatus","citizen","Citizen","They hold citizenship of the destination country")}
                ${qOptR("inviterStatus","pr","Permanent Resident (PR)","Holds a PR card, ILR, or equivalent")}
                ${qOptR("inviterStatus","work","Work Visa Holder","Valid work permit or work visa")}
                ${qOptR("inviterStatus","student","Student Visa Holder","Valid study permit or student visa")}
              </div>
            </div>

            <div class="q-blk">
              <div class="q-lbl">Do you have — or will you have — an invitation letter from your inviter? <span class="q-req">Required</span></div>
              <div class="q-opts c2">
                ${qOptR("invitationLetter","yes","Yes — I have one","")}
                ${qOptR("invitationLetter","will-get","I will arrange one before submission","")}
                ${qOptR("invitationLetter","no","No","")}
              </div>
              <div class="q-dep ${applicationData.questionnaire.invitationLetter === "will-get" ? "show":""}" id="dep-inv-letter">
                <div class="qn qn-teal">&#x1F4CB; A standard invitation letter template will be included in your document checklist.</div>
              </div>
            </div>
          </div>
        </div>
        <div class="q-sec-nav">
          <button class="btn-qback" onclick="qGoPrev('sec-inviter','sec-trip')">&#x2190; Back</button>
          <button class="btn-qnext" onclick="qGoNext('sec-inviter','sec-finance')">Continue — Finances &#x2192;</button>
        </div>
            </div>`
  : "";

      // Section 3 — Finances / Occupation / Assets (split into 3 sections per DOCX)
     const primaryFinanceTravellers =
  activeTraveller?.id ? [activeTraveller] : [];

// ── Helper: shared per-traveller derived values ────────────────────────────
function buildFinDerived(t) {
  const fin = (applicationData.questionnaire.finance || {})[t.id] || {};
  const financeAnswers = fin.multiAnswers || {};
  return {
    fin,
    financeAnswers,
    isBusiness: Boolean(financeAnswers["occ-business"]),
    isOtherOccupation: Boolean(financeAnswers["occ-other"]),
    shouldShowItr: ["occ-employed","occ-freelancer","occ-pensioner","occ-business"].some(k => Boolean(financeAnswers[k])),
    hasOtherAsset: Boolean(financeAnswers["asset-other"]),
    hasOtherInvestment: Boolean(financeAnswers["inv-other"]),
  };
}

// ── sec-finance: Funding & liquid funds only ───────────────────────────────
const finFundingBlocks = primaryFinanceTravellers.map(t => {
  const { fin } = buildFinDerived(t);
  return `<div class="person-block">
    <div class="person-block-hd">
      <div class="pb-av ${avClass(t)}">${escapeHtml(initials(t))}</div>
      <div class="pb-info"><div class="pb-name">${escapeHtml(`${t.firstName||""} ${t.lastName||""}`.trim())}</div>
      <div class="pb-role">${escapeHtml(travellerLabel(t))}</div></div>
    </div>
    <div class="q-blk">
      <div class="q-lbl">How will ${escapeHtml(t.firstName||"this applicant")} fund this trip? <span class="q-req">Required</span> <span style="font-size:12px;font-weight:400;color:var(--muted)">(select all that apply)</span></div>
      <div class="q-opts c2">
        ${qFinFundingOpt(t.id,"self","Self-funded","Paying from own income and savings")}
        ${qFinFundingOpt(t.id,"inviter","Inviter will fund","Host covers travel expenses")}
        ${qFinFundingOpt(t.id,"sponsor","Sponsor / Third party will pay","")}
      </div>
      <div class="q-dep ${(Array.isArray(fin.funding) ? fin.funding : [fin.funding]).includes("sponsor")?"show":""}" id="dep-${t.id}-sponsor">
        <div class="q-sub">Who is the financial sponsor? <span class="q-req">Required</span></div>
        <div class="q-opts">
          ${qFinOptR(t.id,"sponsorType","parent","Parent (Father / Mother)","")}
          ${qFinOptR(t.id,"sponsorType","spouse","Spouse (Husband / Wife)","")}
          ${qFinOptR(t.id,"sponsorType","sibling","Sibling (Brother / Sister)","")}
          ${qFinOptR(t.id,"sponsorType","extended","Extended Relative (Uncle, Aunt, Cousin)","")}
          ${qFinOptR(t.id,"sponsorType","employer","Current Employer","")}
          ${qFinOptR(t.id,"sponsorType","event","Event Organizers","")}
        </div>
      </div>
    </div>
    <div class="q-blk" style="margin-bottom:0;padding-bottom:0;border:none">
      <div class="q-lbl">How much liquid funds are available to support this trip? <span class="q-req">Required</span></div>
      <div class="q-opts c2">
        ${qFinOptR(t.id,"fundsRange","4-7l","₹4 – 7 Lakh","")}
        ${qFinOptR(t.id,"fundsRange","7-10l","₹7 – 10 Lakh","")}
        ${qFinOptR(t.id,"fundsRange","10-15l","₹10 – 15 Lakh","")}
        ${qFinOptR(t.id,"fundsRange","15-20l","₹15 – 20 Lakh","")}
        ${qFinOptR(t.id,"fundsRange","20l-plus","₹20 Lakh+","")}
      </div>
    </div>
  </div>`;
}).join("");

// ── sec-occupation: Occupation & ITR ──────────────────────────────────────
const finOccBlocks = primaryFinanceTravellers.map(t => {
  const { fin, financeAnswers, isBusiness, isOtherOccupation, shouldShowItr } = buildFinDerived(t);
  return `<div class="person-block">
    <div class="person-block-hd">
      <div class="pb-av ${avClass(t)}">${escapeHtml(initials(t))}</div>
      <div class="pb-info"><div class="pb-name">${escapeHtml(`${t.firstName||""} ${t.lastName||""}`.trim())}</div>
      <div class="pb-role">${escapeHtml(travellerLabel(t))}</div></div>
    </div>
    <div class="q-blk">
      <div class="q-lbl">What is ${escapeHtml(t.firstName||"their")} current occupation? <span class="q-req">Required</span> <span style="font-size:12px;font-weight:400;color:var(--muted)">(select all that apply)</span></div>
      <div class="q-opts c2">
        ${qFinOptM(t.id,"occ-employed","Employed (Job)")}
        ${qFinOptM(t.id,"occ-freelancer","Self-Employed / Freelancer")}
        ${qFinOptM(t.id,"occ-business","Business Owner")}
        ${qFinOptM(t.id,"occ-homemaker","Homemaker")}
        ${qFinOptM(t.id,"occ-pensioner","Retired with Pension")}
        ${qFinOptM(t.id,"occ-retired-nopension","Retired without Pension")}
        ${qFinOptM(t.id,"occ-student","Student")}
        ${qFinOptM(t.id,"occ-unemployed","Unemployed")}
        ${qFinOptM(t.id,"occ-other","Other")}
      </div>
      <div class="q-dep ${isBusiness?"show":""}" id="dep-${t.id}-biz">
        <div class="q-sub">What type of business? <span class="q-req">Required</span></div>
        <div class="q-opts">
          ${qFinOptR(t.id,"bizType","sole","Sole Proprietorship","Shop, agency, or single-owner")}
          ${qFinOptR(t.id,"bizType","partnership","Partnership Firm","")}
          ${qFinOptR(t.id,"bizType","pvtltd","Public, Private, or an LLP","Registered company")}
        </div>
      </div>
    </div>
    <div class="q-blk" id="dep-${t.id}-occ-other" style="${isOtherOccupation ? "" : "display:none"}">
      <div class="q-lbl">Please provide more information about ${escapeHtml(t.firstName||"their")} occupation <span class="q-req">Required</span></div>
      <div class="q-field-row single"><div class="q-field">
        <textarea rows="2" placeholder="e.g. job title, business type, day-to-day work"
          oninput="qFinSetField('${t.id}','moreInfo',this.value)">${escapeHtml(fin.moreInfo||"")}</textarea>
      </div></div>
    </div>
    <div class="q-blk" id="dep-${t.id}-itr" style="${shouldShowItr ? "" : "display:none"}">
      <div class="q-lbl">Do ${escapeHtml(t.firstName||"their")} ITRs from the last 2 years reflect their current occupation? <span class="q-req">Required</span></div>
      <div class="q-opts c2">
        ${qFinOptR(t.id,"itr","yes","Yes — ITR reflects current occupation","")}
        ${qFinOptR(t.id,"itr","notsure","Not sure","")}
        ${qFinOptR(t.id,"itr","no","No — ITR shows different occupation","e.g. recently changed jobs")}
        ${qFinOptR(t.id,"itr","nofile","Does not file an ITR","")}
      </div>
    </div>
  </div>`;
}).join("");

// Spouse occupation is now answered in their own per-traveller sec-occupation section.

// ── sec-assets: Property & investments ────────────────────────────────────
const finAssetBlocks = primaryFinanceTravellers.map(t => {
  const { fin, financeAnswers, hasOtherAsset, hasOtherInvestment } = buildFinDerived(t);
  return `<div class="person-block">
    <div class="person-block-hd">
      <div class="pb-av ${avClass(t)}">${escapeHtml(initials(t))}</div>
      <div class="pb-info"><div class="pb-name">${escapeHtml(`${t.firstName||""} ${t.lastName||""}`.trim())}</div>
      <div class="pb-role">${escapeHtml(travellerLabel(t))}</div></div>
    </div>
    <div class="q-blk">
      <div class="q-lbl">What types of property does ${escapeHtml(t.firstName||"this applicant")} own in India? <span class="q-req">Required</span> <span style="font-size:12px;font-weight:400;color:var(--muted)">(select all that apply)</span></div>
      <div class="q-opts c2">
        ${qFinOptM(t.id,"asset-house","House")}
        ${qFinOptM(t.id,"asset-shop","Shop")}
        ${qFinOptM(t.id,"asset-office","Office")}
        ${qFinOptM(t.id,"asset-building","Building")}
        ${qFinOptM(t.id,"asset-flat","Apartment")}
        ${qFinOptM(t.id,"asset-factory","Factory")}
        ${qFinOptM(t.id,"asset-shed","Shed")}
        ${qFinOptM(t.id,"asset-warehouse","Warehouse")}
        ${qFinOptM(t.id,"asset-plot","Plot")}
        ${qFinOptM(t.id,"asset-land","Land")}
        ${qFinOptM(t.id,"asset-none","None")}
        ${qFinOptM(t.id,"asset-other","Other")}
      </div>
      <div class="q-field-row single" id="dep-${t.id}-asset-other" style="margin-top:10px;${hasOtherAsset ? "" : "display:none"}">
        <div class="q-field"><label>Please describe the other property type <span class="q-req">Required</span></label>
          <input type="text" placeholder="Describe any property type not listed above"
            value="${escapeHtml(fin.otherAssetDesc||"")}"
            oninput="qFinSetField('${t.id}','otherAssetDesc',this.value)"></div>
      </div>
    </div>
    <div class="q-blk" style="margin-bottom:0;padding-bottom:0;border:none">
      <div class="q-lbl">What liquid investments does ${escapeHtml(t.firstName||"this applicant")} hold? <span class="q-req">Required</span> <span style="font-size:12px;font-weight:400;color:var(--muted)">(select all that apply)</span></div>
      <div class="q-opts c2">
        ${qFinOptM(t.id,"inv-stocks","Stock Market")}
        ${qFinOptM(t.id,"inv-bank","Bank Savings")}
        ${qFinOptM(t.id,"inv-fd","Fixed Deposits (FD)")}
        ${qFinOptM(t.id,"inv-mf","Mutual Funds")}
        ${qFinOptM(t.id,"inv-ppf","PPF (Public Provident Fund)")}
        ${qFinOptM(t.id,"inv-epf","EPF (Employee Provident Fund)")}
        ${qFinOptM(t.id,"inv-bonds","Bonds")}
        ${qFinOptM(t.id,"inv-gold","Gold")}
        ${qFinOptM(t.id,"inv-postal","Postal Certificate / Savings")}
        ${qFinOptM(t.id,"inv-none","I do not have any investments")}
        ${qFinOptM(t.id,"inv-other","Other")}
      </div>
      <div class="q-field-row single" id="dep-${t.id}-inv-other" style="margin-top:10px;${hasOtherInvestment ? "" : "display:none"}">
        <div class="q-field"><label>Please describe the other investment type <span class="q-req">Required</span></label>
          <input type="text" placeholder="Describe any investment type not listed above"
            value="${escapeHtml(fin.otherInvestment||"")}"
            oninput="qFinSetField('${t.id}','otherInvestment',this.value)"></div>
      </div>
    </div>
  </div>`;
}).join("");

      const secFinanceIdx  = sections.indexOf("sec-finance")  + 1;
      const secOccIdx      = sections.indexOf("sec-occupation") + 1;
      const secAssetsIdx   = sections.indexOf("sec-assets")    + 1;
      const nextAfterAssets = sections.includes("sec-ties") ? "sec-ties" : "sec-history";

      const sec3 = `<div class="q-page ${curId==="sec-finance"?"active":""}" id="sec-finance">
        <div class="q-sec-card">
          <div class="q-sec-hd"><div class="q-sec-hd-row">
            <div class="q-sec-icon qsi-amber">&#x1F4B0;</div>
            <div class="q-sec-info">
              <div class="q-sec-num">Section ${secFinanceIdx} of ${totalSec}</div>
              <div class="q-sec-title">Finances</div>
              <div class="q-sec-sub">How will this trip be funded and how much money is available?</div>
            </div>
          </div></div>
          <div class="q-sec-body">
            ${finFundingBlocks}
          </div>
        </div>
        <div class="q-sec-nav">
          <button class="btn-qback" onclick="qGoPrev('sec-finance','${hasInviterPurpose ? "sec-inviter" : "sec-trip"}')">&#x2190; Back</button>
          <button class="btn-qnext" onclick="qGoNext('sec-finance','sec-occupation')">Continue — Occupation &#x2192;</button>
        </div>
      </div>

      <div class="q-page ${curId==="sec-occupation"?"active":""}" id="sec-occupation">
        <div class="q-sec-card">
          <div class="q-sec-hd"><div class="q-sec-hd-row">
            <div class="q-sec-icon qsi-amber">&#x1F4BC;</div>
            <div class="q-sec-info">
              <div class="q-sec-num">Section ${secOccIdx} of ${totalSec}</div>
              <div class="q-sec-title">Occupation</div>
              <div class="q-sec-sub">What does each traveller currently do for work or study?</div>
            </div>
          </div></div>
          <div class="q-sec-body">
            ${finOccBlocks}
          </div>
        </div>
        <div class="q-sec-nav">
          <button class="btn-qback" onclick="qGoPrev('sec-occupation','sec-finance')">&#x2190; Back</button>
          <button class="btn-qnext" onclick="qGoNext('sec-occupation','sec-assets')">Continue — Assets &amp; Investments &#x2192;</button>
        </div>
      </div>

      <div class="q-page ${curId==="sec-assets"?"active":""}" id="sec-assets">
        <div class="q-sec-card">
          <div class="q-sec-hd"><div class="q-sec-hd-row">
            <div class="q-sec-icon qsi-amber">&#x1F3E0;</div>
            <div class="q-sec-info">
              <div class="q-sec-num">Section ${secAssetsIdx} of ${totalSec}</div>
              <div class="q-sec-title">Assets &amp; Investments</div>
              <div class="q-sec-sub">Property and investments in India show strong roots and intent to return</div>
            </div>
          </div></div>
          <div class="q-sec-body">
            <div class="qn qn-teal">&#x1F3C6; Every asset you declare counts in your favour — declare everything honestly.</div>
            ${finAssetBlocks}
          </div>
        </div>
        <div class="q-sec-nav">
          <button class="btn-qback" onclick="qGoPrev('sec-assets','sec-occupation')">&#x2190; Back</button>
          <button class="btn-qnext" onclick="qGoNext('sec-assets','${nextAfterAssets}')">Continue — Home Country Ties &#x2192;</button>
        </div>
      </div>`;

      // Section 4 — Ties to India (answered per-traveller)
      const tiesBlocks = [activeTraveller].filter(t => t?.id).map(pa => {
        const ties = (applicationData.questionnaire.ties || {})[pa.id] || {};
        function tieOptM(key, title, desc="") {
          const on = (ties.multiAnswers || {})[key] ? "msel" : "";
          return `<div class="q-opt ${on}" onclick="qTieTogM('${pa.id}','${key}',this)" data-mkey="${pa.id}-${key}">
            <div class="q-chk">&#x2713;</div><div class="q-opt-body"><div class="q-opt-title">${escapeHtml(title)}</div>${desc?`<div class="q-opt-desc">${escapeHtml(desc)}</div>`:""}</div></div>`;
        }
        return `<div class="person-block">
          <div class="person-block-hd">
            <div class="pb-av pb-av-pa">${escapeHtml(initials(pa))}</div>
            <div class="pb-info"><div class="pb-name">${escapeHtml(`${pa.firstName||""} ${pa.lastName||""}`.trim())}</div>
            <div class="pb-role">Principal Applicant</div></div>
          </div>
          <div class="q-blk" style="margin-bottom:0;padding-bottom:0;border:none">
            <div class="q-lbl">Does ${escapeHtml(pa.firstName||"this applicant")} hold any position or membership? <span class="q-req">Required</span> <span style="font-size:12px;font-weight:400;color:var(--muted)">(select all that apply)</span></div>
            <div class="q-sub">Every community role is evidence of strong ties to India — a key factor in demonstrating intent to return.</div>
            <div class="q-opts">
              ${tieOptM("housing","Position in Housing Society","Chairman, Secretary, Treasurer or committee member")}
              ${tieOptM("social","Social or community group","Samaj, cultural group, community association")}
              ${tieOptM("bizassoc","Business or trade association","Chamber of commerce, trade body")}
              ${tieOptM("coop","Credit or Co-operative society","")}
              ${tieOptM("vol","Voluntary position in Hospital, School, or NGO","")}
              ${tieOptM("religious","Religious group, trust, or temple","")}
              ${tieOptM("service","Service club","Lions Club, Rotary Club, Jaycees")}
              ${tieOptM("member","Active member (no formal position)","")}
              ${tieOptM("none","No position or membership","")}
            </div>
          </div>
        </div>`;
      }).join("");

      const nextAfterTies = "sec-history";
      const sec4 = `<div class="q-page ${curId==="sec-ties"?"active":""}" id="sec-ties">
        <div class="q-sec-card">
          <div class="q-sec-hd"><div class="q-sec-hd-row">
            <div class="q-sec-icon qsi-green">&#x1F1EE;&#x1F1F3;</div>
            <div class="q-sec-info">
              <div class="q-sec-num">Section 4 of ${totalSec}</div>
              <div class="q-sec-title">Your Ties to India</div>
              <div class="q-sec-sub">Strong ties to home are the foundation of a successful visitor visa</div>
            </div>
          </div></div>
          <div class="q-sec-body">
            <div class="qn qn-teal">&#x1F3C6; Every community role, position, and responsibility you hold in India is evidence that you have strong reasons to return.</div>
            ${tiesBlocks}
          </div>
        </div>
        <div class="q-sec-nav">
          <button class="btn-qback" onclick="qGoPrev('sec-ties','sec-assets')">&#x2190; Back</button>
          <button class="btn-qnext" onclick="qGoNext('sec-ties','${nextAfterTies}')">Continue &#x2192;</button>
        </div>
      </div>`;

      // Section 5 — Children (one child at a time in per-traveller model)
      const childSlots = isChildTraveller ? [activeTraveller] : [];
      const childBlocks = childSlots.map((ch,i) => {
        const chi = (applicationData.questionnaire.childrenInfo || {})[ch.id] || {};
        function chOptR(key, val, title) {
          const sel = chi[key] === val ? "sel" : "";
          return `<div class="q-opt ${sel}" onclick="qChiSel('${ch.id}','${key}','${val}',this)" data-group="${ch.id}-${key}" data-val="${val}">
            <div class="q-radio"></div><div class="q-opt-body"><div class="q-opt-title">${escapeHtml(title)}</div></div></div>`;
        }
        const age = ch.dob ? Math.floor((Date.now() - new Date(ch.dob)) / (365.25*24*3600*1000)) : "?";
        return `<div class="person-block">
          <div class="person-block-hd">
            <div class="pb-av pb-av-ch">C${i+1}</div>
            <div class="pb-info"><div class="pb-name">${escapeHtml(`${ch.firstName||""} ${ch.lastName||""}`.trim())}</div>
            <div class="pb-role">Child · Age ${age}</div></div>
          </div>
          <div class="q-blk" style="margin-bottom:0;padding-bottom:0;border:none">
            <div class="q-lbl">What is ${escapeHtml(ch.firstName||"this child")} currently doing? <span class="q-req">Required</span></div>
            <div class="q-opts c2">
              ${chOptR("doing","preschool","Pre-School / Nursery")}
              ${chOptR("doing","school","School Student")}
              ${chOptR("doing","college","College Student")}
              ${chOptR("doing","infant","Not enrolled (Infant)")}
            </div>
          </div>
        </div>`;
      }).join("");

      const sec5 = isChildTraveller ? `<div class="q-page ${curId==="sec-children"?"active":""}" id="sec-children">
        <div class="q-sec-card">
          <div class="q-sec-hd"><div class="q-sec-hd-row">
            <div class="q-sec-icon qsi-teal">&#x1F476;</div>
            <div class="q-sec-info">
              <div class="q-sec-num">Section 1 of ${totalSec}</div>
              <div class="q-sec-title">About ${escapeHtml(activeTraveller.firstName || "Child")}</div>
              <div class="q-sec-sub">A few details about this traveller</div>
            </div>
          </div>
          <div class="q-prefill-badge">&#x2705; Name and age pre-filled from your application</div></div>
          <div class="q-sec-body">
            ${childBlocks}
          </div>
        </div>
        <div class="q-sec-nav">
          <button class="btn-qback" onclick="qGoPrev('sec-children','sec-history')">&#x2190; Back</button>
          <button class="btn-qnext" onclick="qGoNext('sec-children','sec-history')">Continue — Travel History &#x2192;</button>
        </div>
      </div>` : "";

      // Section 6 — Travel History (per-traveller: only the active traveller)
      const histBlocks = [activeTraveller].filter(t => t?.id).map(t => {
        const hist = (applicationData.questionnaire.history || {})[t.id] || {};
        const age = t.dob ? Math.floor((Date.now() - new Date(t.dob)) / (365.25*24*3600*1000)) : 99;
        const isAdult = t.type === "Child" ? false : age >= 18;
        return `<div class="person-block">
          <div class="person-block-hd">
            <div class="pb-av ${avClass(t)}">${escapeHtml(initials(t))}</div>
            <div class="pb-info"><div class="pb-name">${escapeHtml(`${t.firstName||""} ${t.lastName||""}`.trim())}</div>
            <div class="pb-role">${escapeHtml(travellerLabel(t))}</div></div>
          </div>
          <div class="q-blk">
            <div class="q-lbl">Has ${escapeHtml(t.firstName||"this person")} ever visited any country internationally? <span class="q-req">Required</span></div>
            <div class="q-opts c2">
              ${qHistOptR(t.id,"prevTravel","yes","Yes — has travelled internationally","")}
              ${qHistOptR(t.id,"prevTravel","no","No — this is the first international trip","")}
            </div>
            <div class="q-dep ${hist.prevTravel==="yes"?"show":""}" id="dep-${t.id}-prevtravel">
              <div class="qn qn-teal">&#x2728; Previous international travel significantly strengthens the application. Visa copies and entry/exit stamps will be added to your checklist.</div>
            </div>
          </div>
          ${isCanadaDest ? `<div class="q-blk">
            <div class="q-lbl">Does ${escapeHtml(t.firstName||"this person")} currently hold a valid USA visa? <span class="q-req">Required</span></div>
            <div class="q-opts c2">
              ${qHistOptR(t.id,"usaVisa","yes","Yes","")}
              ${qHistOptR(t.id,"usaVisa","no","No","")}
            </div>
          </div>` : ""}
          <div class="q-blk">
            <div class="q-lbl">Has ${escapeHtml(t.firstName||"this person")} ever been refused a visa for any country? <span class="q-req">Required</span></div>
            <div class="q-opts c2">
              ${qHistOptR(t.id,"refusal","yes","Yes","")}
              ${qHistOptR(t.id,"refusal","no","No","")}
            </div>
            <div class="q-dep ${hist.refusal==="yes"?"show":""}" id="dep-${t.id}-refusal">
              <div class="qn qn-amber">&#x1F4A1; Please be honest — consulates can verify this. Your case officer will help you address it.</div>
              <div class="q-field-row single" style="margin-top:8px"><div class="q-field"><label>Which country, when, and reason given? <span class="q-req">Required</span></label>
                <input type="text" placeholder="e.g. UK visa refused in 2022 — insufficient funds"
                  value="${escapeHtml(hist.refusalDetail||"")}"
                  oninput="qHistSetField('${t.id}','refusalDetail',this.value)">
              </div></div>
            </div>
          </div>
          <div class="q-blk">
            <div class="q-lbl">Has ${escapeHtml(t.firstName||"this person")} ever had a criminal conviction, driving offence, outstanding proceedings, or court judgment? <span class="q-req">Required</span></div>
            <div class="q-sub">Include cautions, fixed penalty notices, and any outstanding civil proceedings.</div>
            <div class="q-opts c2">
              ${qHistOptR(t.id,"criminalRecord","yes","Yes","")}
              ${qHistOptR(t.id,"criminalRecord","no","No","")}
            </div>
            <div class="q-dep ${hist.criminalRecord==="yes"?"show":""}" id="dep-${t.id}-criminal">
              <div class="q-field-row single" style="margin-top:8px"><div class="q-field"><label>Please provide details <span class="q-req">Required</span></label>
                <textarea rows="2" placeholder="What happened, when, and outcome"
                  oninput="qHistSetField('${t.id}','criminalDetail',this.value)">${escapeHtml(hist.criminalDetail||"")}</textarea>
              </div></div>
            </div>
          </div>
                    <div class="q-blk" style="margin-bottom:0;padding-bottom:0;border:none">
            <div class="q-lbl">
              Has ${escapeHtml(t.firstName||"this person")} ever been refused entry at a border, deported, overstayed, or breached immigration conditions?
              <span class="q-req">Required</span>
            </div>
            <div class="q-opts c2">
              ${qHistOptR(t.id,"border","yes","Yes","")}
              ${qHistOptR(t.id,"border","no","No","")}
            </div>
            <div class="q-dep ${hist.border==="yes"?"show":""}" id="dep-${t.id}-border">
              <div class="q-field-row single" style="margin-top:8px">
                <div class="q-field">
                  <label>Country, approximate year, and details <span class="q-req">Required</span></label>
                  <textarea rows="2"
                    placeholder="Explain what happened, where, when, and the reason"
                    oninput="qHistSetField('${t.id}','borderDetail',this.value)">${escapeHtml(hist.borderDetail||"")}</textarea>
                </div>
              </div>
            </div>
          </div>
        </div>`;
      }).join("");

      const prevSec = isChildTraveller ? "sec-children" : "sec-ties";
      const nextTravellerName = nextTraveller
        ? `${nextTraveller.firstName||""} ${nextTraveller.lastName||""}`.trim() || (nextTraveller.type || "Next Person")
        : "";
      const lastSectionButton = hasMoreTravellers
        ? `<button class="btn-qnext" onclick="qAdvanceTraveller()">Continue — ${escapeHtml(nextTravellerName)} &#x2192;</button>`
        : `<button class="btn-qnext submit-q" onclick="qSubmitFinal()">&#x2713; Submit my profile &#x2192;</button>`;
      const sec6 = `<div class="q-page ${curId==="sec-history"?"active":""}" id="sec-history">
        <div class="q-sec-card">
          <div class="q-sec-hd"><div class="q-sec-hd-row">
            <div class="q-sec-icon qsi-purple">&#x1F6C2;</div>
            <div class="q-sec-info">
              <div class="q-sec-num">Section ${totalSec} of ${totalSec} — Almost there!</div>
              <div class="q-sec-title">Travel History</div>
              <div class="q-sec-sub">Previous travel experience is one of the strongest factors in your favour</div>
            </div>
          </div></div>
          <div class="q-sec-body">
            <div class="qn qn-blue">&#x1F3C6; Every country anyone in your group has previously visited builds credibility. Even one prior visa significantly strengthens the application.</div>
            ${histBlocks}
          </div>
        </div>
        <div class="q-sec-nav">
          <button class="btn-qback" onclick="qGoPrev('sec-history','${prevSec}')">&#x2190; Back</button>
          ${lastSectionButton}
        </div>
      </div>`;

      return `
        <section class="wizard-panel">
          <div class="panel-head">
            <div>
              <h3>Case Questionnaire${_isMultiUnit ? ` — ${escapeHtml(_activeUnit.label)}` : ""}</h3>
              <p>Your answers generate your personalised document checklist and prepare your application file.</p>
            </div>
            ${_isMultiUnit ? `<button class="btn" type="button" onclick="qBackToOverview()">&#x2190; All Questionnaires</button>` : ""}
          </div>
          <div class="panel-body">
            ${!isFirstTraveller ? `
            <div class="notice blue" style="margin-bottom:16px">
              <strong>&#x1F464; Answering for: ${escapeHtml(activeTravellerName)}</strong>
              <span>${escapeHtml(activeTraveller.type || "Traveller")} &mdash; traveller ${qState.activeTravellerIndex + 1} of ${_activeUnitTravellers.length}</span>
            </div>` : ""}
            ${_activeUnit && _activeUnit.minorOnly ? `
            <div class="notice amber" style="margin-bottom:16px">
              <strong>&#x1F9D2; Filling on behalf of a minor</strong>
              <span>This questionnaire is for <strong>${escapeHtml(_activeUnit.label)}</strong>, who is a minor.
              As their parent or guardian, please answer the questions on their behalf.</span>
            </div>` : ""}
            <div class="q-prog-wrap">
              <div class="q-prog-card">
                <div class="q-prog-top">
                  <div class="q-prog-label" id="qprog-label">Section 1 of ${totalSec}</div>
                  <div class="q-prog-pct" id="qprog-pct">${pct}% complete</div>
                </div>
                <div class="q-prog-bg"><div class="q-prog-fill" id="qprog-bar" style="width:${pct}%"></div></div>
                <div class="q-pills">${pillsHtml}</div>
              </div>
            </div>
            <div id="q-sections-container">
              ${sec1}${sec2}${sec3}${sec4}${sec5}${sec6}
            </div>
          </div>
        </section>`;
    }

    // ── q* field & navigation helpers (source 8598-8952) ──
    function qSelOpt(el, group, val) {
      // deselect siblings in same section scope
      const scope = el.closest(".q-blk, .q-dep");
      if (scope) scope.querySelectorAll(`.q-opt[data-group="${group}"]`).forEach(o => o.classList.remove("sel"));
      el.classList.add("sel");
      setByPath(applicationData, `questionnaire.${group}`, val);
qHandleDep(group, val);

// These answers control blocks that are conditionally included in the rendered
// questionnaire HTML, so changing either one must rebuild the island. Without
// this, validation sees the new value while the dependent field remains absent
// (or stale) in the current DOM.
if (group === "arrangements" || group === "maritalStatus") {
  rerenderQuestionnaire();
}

markAutoSavePending();
    }

    function qTogOpt(el, key) {
      el.classList.toggle("msel");
      if (!applicationData.questionnaire.multiAnswers) applicationData.questionnaire.multiAnswers = {};
      applicationData.questionnaire.multiAnswers[key] = el.classList.contains("msel");
      markAutoSavePending();
    }
    function qTogMulti(el, group, val) {
      let arr = Array.isArray(applicationData.questionnaire[group]) ? applicationData.questionnaire[group].slice() : [];
      const idx = arr.indexOf(val);
      if (idx >= 0) arr.splice(idx, 1); else arr.push(val);
      setByPath(applicationData, `questionnaire.${group}`, arr);
      el.classList.toggle("msel");
      qHandleMultiDep(group, arr);

if (group === "purpose") {
  rerenderQuestionnaire();
}

markAutoSavePending();
    }

    // Toggles dependent blocks for multi-select questionnaire fields — the
    // multi-select equivalent of qHandleDep (which only handles single-select).
   function qHandleMultiDep(group, arr) {
  if (group !== "purpose") return;

  const selectedPurposes = Array.isArray(arr) ? arr : [];

  const otherEl = document.getElementById("dep-purpose-other");
  if (otherEl) {
    otherEl.classList.toggle("show", selectedPurposes.includes("other"));
  }

  const funcEl = document.getElementById("blk-function-type");
  if (funcEl) {
    funcEl.classList.toggle(
      "show",
      selectedPurposes.includes("family-func")
    );
  }

  const arrangementsEl =
    document.getElementById("blk-travel-arrangements");

  if (arrangementsEl) {
    arrangementsEl.style.display =
      selectedPurposes.length ? "" : "none";
  }
}

    function qSetField(path, val) { setByPath(applicationData, path, val); markAutoSavePending(); }
    function qSetTravelDate(country, type, val) {
      if (!applicationData.questionnaire.travelDates) applicationData.questionnaire.travelDates = {};
      if (!applicationData.questionnaire.travelDates[country]) applicationData.questionnaire.travelDates[country] = {};
      applicationData.questionnaire.travelDates[country][type] = val;
      const gapMsg = qTravelDateGapMessage();
      if (gapMsg) toast(gapMsg);
      markAutoSavePending();
    }

    function qFinSel(travId, key, val, el) {
      if (!applicationData.questionnaire.finance) applicationData.questionnaire.finance = {};
      if (!applicationData.questionnaire.finance[travId]) applicationData.questionnaire.finance[travId] = {};
      applicationData.questionnaire.finance[travId][key] = val;
      const scope = el.closest(".q-blk, .q-dep");
      if (scope) scope.querySelectorAll(`.q-opt[data-group="${travId}-${key}"]`).forEach(o => o.classList.remove("sel"));
      el.classList.add("sel");
      if (key === "funding") {
        const dep = document.getElementById(`dep-${travId}-sponsor`);
        if (dep) dep.classList.toggle("show", val === "sponsor");
      }
      markAutoSavePending();
    }
    function qFinTogFunding(travId, val, el) {
  if (!applicationData.questionnaire.finance) {
    applicationData.questionnaire.finance = {};
  }

  if (!applicationData.questionnaire.finance[travId]) {
    applicationData.questionnaire.finance[travId] = {};
  }

  const fin = applicationData.questionnaire.finance[travId];

  let selected = Array.isArray(fin.funding)
    ? [...fin.funding]
    : (fin.funding ? [fin.funding] : []);

  if (selected.includes(val)) {
    selected = selected.filter(item => item !== val);
  } else {
    selected.push(val);
  }

  fin.funding = selected;
  el.classList.toggle("msel", selected.includes(val));

  const sponsorSection = document.getElementById(`dep-${travId}-sponsor`);

  if (sponsorSection) {
    sponsorSection.classList.toggle("show", selected.includes("sponsor"));
  }

  markAutoSavePending();
}
    function qFinTogM(travId, key, el) {
  if (!applicationData.questionnaire.finance) {
    applicationData.questionnaire.finance = {};
  }

  if (!applicationData.questionnaire.finance[travId]) {
    applicationData.questionnaire.finance[travId] = {};
  }

  if (!applicationData.questionnaire.finance[travId].multiAnswers) {
    applicationData.questionnaire.finance[travId].multiAnswers = {};
  }

  el.classList.toggle("msel");

  const selected = el.classList.contains("msel");
  const answers =
    applicationData.questionnaire.finance[travId].multiAnswers;

  answers[key] = selected;

  const exclusiveGroups = {
    "occ-unemployed": ["occ-employed", "occ-freelancer", "occ-business", "occ-homemaker", "occ-pensioner", "occ-retired-nopension", "occ-student", "occ-other"],
    "asset-none": ["asset-house", "asset-shop", "asset-office", "asset-building", "asset-flat", "asset-factory", "asset-shed", "asset-warehouse", "asset-plot", "asset-land", "asset-other"],
    "inv-none": ["inv-stocks", "inv-bank", "inv-fd", "inv-mf", "inv-ppf", "inv-epf", "inv-bonds", "inv-gold", "inv-postal", "inv-other"]
  };

  let clearedSelection = false;
  Object.entries(exclusiveGroups).forEach(([exclusiveKey, otherKeys]) => {
    if (!selected) return;
    const keysToClear = key === exclusiveKey
      ? otherKeys
      : (otherKeys.includes(key) ? [exclusiveKey] : []);
    keysToClear.forEach((keyToClear) => {
      clearedSelection = clearedSelection || Boolean(answers[keyToClear]);
      answers[keyToClear] = false;
      document.querySelector(`[data-mkey="${travId}-${keyToClear}"]`)?.classList.remove("msel");
    });
  });

  if (clearedSelection) {
    markAutoSavePending();
    rerenderQuestionnaire();
    return;
  }

  if (key === "occ-business") {
    const businessBlock =
      document.getElementById(`dep-${travId}-biz`);

    if (businessBlock) {
  businessBlock.style.display = selected ? "block" : "none";
}
  }

  if (key === "occ-other") {
    const otherOccupationBlock =
      document.getElementById(`dep-${travId}-occ-other`);

    if (otherOccupationBlock) {
      otherOccupationBlock.style.display = selected ? "" : "none";
    }
  }

  if (key.startsWith("occ-")) {
  const traveller =
    applicationData.deal.travellers.find(
      (item) => item.id === travId
    );

  const isSpouse =
    traveller?.type === "Spouse";

  const itrOccupationKeys = [
    "occ-employed",
    "occ-freelancer",
    "occ-pensioner",
    "occ-business",
    ...(isSpouse ? ["occ-other"] : [])
  ];

  const showItr =
    itrOccupationKeys.some(
      (occupationKey) => Boolean(answers[occupationKey])
    );

  const itrBlock =
    document.getElementById(`dep-${travId}-itr`);

  if (itrBlock) {
    itrBlock.style.display = showItr ? "" : "none";
  }
}

  if (key === "asset-other") {
    const otherAssetBlock =
      document.getElementById(`dep-${travId}-asset-other`);

    if (otherAssetBlock) {
      otherAssetBlock.style.display = selected ? "" : "none";
    }
  }

  if (key === "inv-other") {
    const otherInvestmentBlock =
      document.getElementById(`dep-${travId}-inv-other`);

    if (otherInvestmentBlock) {
      otherInvestmentBlock.style.display =
        selected ? "" : "none";
    }
  }

  markAutoSavePending();
}

    function qFinSetField(travId, key, val) {
      if (!applicationData.questionnaire.finance) applicationData.questionnaire.finance = {};
      if (!applicationData.questionnaire.finance[travId]) applicationData.questionnaire.finance[travId] = {};
      applicationData.questionnaire.finance[travId][key] = val;
      markAutoSavePending();
    }

    function qTieTogM(travId, key, el) {
      if (!applicationData.questionnaire.ties) applicationData.questionnaire.ties = {};
      if (!applicationData.questionnaire.ties[travId]) applicationData.questionnaire.ties[travId] = {};
      if (!applicationData.questionnaire.ties[travId].multiAnswers) applicationData.questionnaire.ties[travId].multiAnswers = {};
      el.classList.toggle("msel");
      const answers = applicationData.questionnaire.ties[travId].multiAnswers;
      const selected = el.classList.contains("msel");
      answers[key] = selected;
      if (selected && key === "none") {
        Object.keys(answers).filter(answerKey => answerKey !== "none").forEach((answerKey) => {
          answers[answerKey] = false;
          document.querySelector(`[data-mkey="${travId}-${answerKey}"]`)?.classList.remove("msel");
        });
      } else if (selected) {
        answers.none = false;
        document.querySelector(`[data-mkey="${travId}-none"]`)?.classList.remove("msel");
      }
      markAutoSavePending();
    }

    function qChiSel(travId, key, val, el) {
      if (!applicationData.questionnaire.childrenInfo) applicationData.questionnaire.childrenInfo = {};
      if (!applicationData.questionnaire.childrenInfo[travId]) applicationData.questionnaire.childrenInfo[travId] = {};
      applicationData.questionnaire.childrenInfo[travId][key] = val;
      const scope = el.closest(".q-blk");
      if (scope) scope.querySelectorAll(`.q-opt[data-group="${travId}-${key}"]`).forEach(o => o.classList.remove("sel"));
      el.classList.add("sel");
      markAutoSavePending();
    }

    function qHistSel(travId, key, val, el) {
      if (!applicationData.questionnaire.history) applicationData.questionnaire.history = {};
      if (!applicationData.questionnaire.history[travId]) applicationData.questionnaire.history[travId] = {};
      applicationData.questionnaire.history[travId][key] = val;
      const scope = el.closest(".q-blk");
      if (scope) scope.querySelectorAll(`.q-opt[data-group="${travId}-${key}"]`).forEach(o => o.classList.remove("sel"));
      el.classList.add("sel");
      // show/hide deps
      if (key === "refusal") {
        const dep = document.getElementById(`dep-${travId}-refusal`);
        if (dep) dep.classList.toggle("show", val === "yes");
      }
      if (key === "border") {
        const dep = document.getElementById(`dep-${travId}-border`);
        if (dep) dep.classList.toggle("show", val === "yes");
      }
      if (key === "prevTravel") {
        const dep = document.getElementById(`dep-${travId}-prevtravel`);
        if (dep) dep.classList.toggle("show", val === "yes");
      }
      if (key === "criminalRecord") {
        const dep = document.getElementById(`dep-${travId}-criminal`);
        if (dep) dep.classList.toggle("show", val === "yes");
      }
      markAutoSavePending();
    }

    function qHistSetField(travId, key, val) {
      if (!applicationData.questionnaire.history) applicationData.questionnaire.history = {};
      if (!applicationData.questionnaire.history[travId]) applicationData.questionnaire.history[travId] = {};
      applicationData.questionnaire.history[travId][key] = val;
      markAutoSavePending();
    }

    function qHandleDep(group, val) {
      const deps = {
        "purpose":         {"other": "dep-purpose-other", "family-func": "blk-function-type"},
        "invitationLetter":{"will-get":"dep-inv-letter"}
      };
      const map = deps[group];
      if (!map) return;
      // hide all deps for this group first
      Object.values(map).forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove("show"); });
      // show matching
      const showId = map[val];
      if (showId) { const el = document.getElementById(showId); if (el) el.classList.add("show"); }
    }

    function qGoNext(fromId, toId) {
      const validationError = validateQuestionnaireSection(fromId);
      if (validationError) {
        qState.validationSection = fromId;
        toast(validationError);
        return false;
      }
      if (!qState.completedSections.includes(fromId)) qState.completedSections.push(fromId);
      // update pill
      const pill = document.getElementById(`qpill-${fromId}`);
      if (pill) { pill.classList.remove("active","locked"); pill.classList.add("done"); }
      // show next
      document.querySelectorAll(".q-page").forEach(p => p.classList.remove("active"));
      const next = document.getElementById(toId);
      if (next) next.classList.add("active");
      const sections = qQuestionnaireSectionOrder().filter(id => document.getElementById(id));
      qState.currentSection = sections.indexOf(toId);
      // update next pill
      const nextPill = document.getElementById(`qpill-${toId}`);
      if (nextPill) { nextPill.classList.remove("locked"); nextPill.classList.add("active"); }
      // update progress
      const done = qState.completedSections.filter((sectionId) =>
  sections.includes(sectionId)
).length;
      const pct = Math.round((done / sections.length) * 100);
      const progBar = document.getElementById("qprog-bar");
      const progPct = document.getElementById("qprog-pct");
      const progLbl = document.getElementById("qprog-label");
      if (progBar) progBar.style.width = `${pct}%`;
      if (progPct) progPct.textContent = `${pct}% complete`;
      if (progLbl) progLbl.textContent = `Section ${qState.currentSection + 1} of ${sections.length}`;
      window.scrollTo(0, 0);
      saveDraft(false);
      return true;
    }

    function qGoPrev(fromId, toId) {
      document.querySelectorAll(".q-page").forEach(p => p.classList.remove("active"));
      const prev = document.getElementById(toId);
      if (prev) prev.classList.add("active");
      const sections = qQuestionnaireSectionOrder().filter(id => document.getElementById(id));
      qState.currentSection = sections.indexOf(toId);
      window.scrollTo(0, 0);
    }

    function qSubmitFinal() {
      if (!qState.completedSections.includes("sec-history")) qState.completedSections.push("sec-history");
      applicationData.questionnaire.countriesText = applicationData.questionnaire.applyingCountries || applicationData.deal.destination || "";

      const units = deriveQuestionnaireUnits();
      const activeUnit = units[qState.activeUnitIndex] || units[0];
      const familyId = (activeUnit && activeUnit.familyId) || "family-1";

      if (activeUnit) qSaveUnitSharedData(familyId);

      // Submit this unit's records immediately; submitQuestionnaire handles the
      // "all units done → step complete" check internally.
      submitQuestionnaire(familyId);
    }

    function qAdvanceTraveller() {
      const sections = qQuestionnaireSectionOrder();
      const lastSec = sections[sections.length - 1];
      const error = validateQuestionnaireSection(lastSec);
      if (error) { qState.validationSection = lastSec; toast(error); return; }
      if (!qState.completedSections.includes(lastSec)) qState.completedSections.push(lastSec);
      qState.activeTravellerIndex += 1;
      qState.currentSection = 0;
      qState.completedSections = [];
      rerenderQuestionnaire();
      window.scrollTo(0, 0);
      saveDraft(false);
    }

    function qIsBlank(value) {
      if (Array.isArray(value)) return value.length === 0;
      return value === undefined || value === null || String(value).trim() === "";
    }

    function qHasAnySelected(multiAnswers, keys) {
      return keys.some(key => Boolean((multiAnswers || {})[key]));
    }

    function qQuestionnaireCountries() {
      return (applicationData.questionnaire.applyingCountries || applicationData.deal.destination || "")
        .split(",").map(s => s.trim()).filter(Boolean);
    }

    function qIsCanadaSelected() {
      return qQuestionnaireCountries().some(country => country.toLowerCase() === "canada");
    }

    function qFirstTravelDate() {
      return Object.values(applicationData.questionnaire.travelDates || {}).find(d => d && d.entry)?.entry || "";
    }

    function qChildTravellers() {
  const units = deriveQuestionnaireUnits();
  const activeUnit = units[qState.activeUnitIndex] || units[0];
  const travellers = activeUnit ? activeUnit.travellers : applicationData.deal.travellers;
  return travellers.filter(isQuestionnaireChild).slice(0, 3);
}

    function qQuestionnaireSectionOrder() {
      const q = applicationData.questionnaire || {};
      const purposes = Array.isArray(q.purpose) ? q.purpose : [];
      const hasInviter = purposes.some(p => ["family","friend","family-func","convocation","business"].includes(p));
      const units = deriveQuestionnaireUnits();
      const activeUnit = units[qState.activeUnitIndex] || units[0];
      const travellers = activeUnit ? activeUnit.travellers : (applicationData.deal.travellers || []);
      const activeTrav = travellers[qState.activeTravellerIndex] || travellers[0];
      const isFirst = qState.activeTravellerIndex === 0;
      const isChild = activeTrav ? isQuestionnaireChild(activeTrav) : false;
      if (isChild) return ["sec-children", "sec-history"];
      if (isFirst) {
        return [
          "sec-trip",
          ...(hasInviter ? ["sec-inviter"] : []),
          "sec-finance", "sec-occupation", "sec-assets", "sec-ties", "sec-history"
        ];
      }
      return ["sec-finance", "sec-occupation", "sec-assets", "sec-ties", "sec-history"];
    }

    function qSelectedKeys(multiAnswers, keys) {
      return keys.filter(key => Boolean((multiAnswers || {})[key]));
    }

    function qHasExclusiveConflict(multiAnswers, exclusiveKey, otherKeys) {
      return Boolean((multiAnswers || {})[exclusiveKey]) && qSelectedKeys(multiAnswers, otherKeys).length > 0;
    }

    function qIsSchengenCountry(country) {
      const lower = String(country || "").trim().toLowerCase();
      return lower === "schengen" || SCHENGEN_COUNTRIES.has(lower);
    }

    function qTravelDateGapMessage() {
      const countries = qQuestionnaireCountries();
      const travelDates = applicationData.questionnaire.travelDates || {};
      for (let i = 0; i < countries.length - 1; i++) {
        // Only enforce continuous-dates between consecutive Schengen countries.
        if (!qIsSchengenCountry(countries[i]) || !qIsSchengenCountry(countries[i + 1])) continue;
        const exitStr = (travelDates[countries[i]] || {}).exit;
        const entryStr = (travelDates[countries[i + 1]] || {}).entry;
        if (!exitStr || !entryStr) continue;
        const exitDate = new Date(`${exitStr}T00:00:00`);
        const entryDate = new Date(`${entryStr}T00:00:00`);
        if (Number.isNaN(exitDate.getTime()) || Number.isNaN(entryDate.getTime())) continue;
        const gapDays = Math.round((entryDate - exitDate) / (1000 * 60 * 60 * 24));
        const nextDay = new Date(exitDate);
        nextDay.setDate(nextDay.getDate() + 1);
        const nextDayStr = nextDay.toISOString().split("T")[0];
        if (gapDays < 0) {
          return `Route ${i + 2} (${countries[i + 1]}) entry (${entryStr}) overlaps with route ${i + 1} (${countries[i]}) which exits on ${exitStr}. Route ${i + 2} must start on ${exitStr} or ${nextDayStr}.`;
        }
        if (gapDays > 1) {
          return `Gap of ${gapDays} days between route ${i + 1} exit (${exitStr}) and route ${i + 2} entry (${entryStr}). Next route must start on ${exitStr} or ${nextDayStr}.`;
        }
      }
      return "";
    }

    function qValidateTravelDates() {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      for (const country of qQuestionnaireCountries()) {
        const dates = (applicationData.questionnaire.travelDates || {})[country] || {};
        if (qIsBlank(dates.entry)) return `Please enter the intended entry date for ${country}.`;
        const entry = new Date(`${dates.entry}T00:00:00`);
        if (Number.isNaN(entry.getTime())) return `Please enter a valid entry date for ${country}.`;
        if (entry <= today) return `The intended entry date for ${country} must be after today.`;
        if (dates.exit) {
          const exit = new Date(`${dates.exit}T00:00:00`);
          if (Number.isNaN(exit.getTime())) return `Please enter a valid exit date for ${country}.`;
          if (exit <= entry) return `The exit date for ${country} must be after the entry date.`;
        }
      }
      const gapError = qTravelDateGapMessage();
      if (gapError) return gapError;
      return "";
    }

    function validateQuestionnaireSection(sectionId) {
      const q = applicationData.questionnaire || {};
      const units = deriveQuestionnaireUnits();
      const activeUnit = units[qState.activeUnitIndex] || units[0];
      const travellers = activeUnit ? activeUnit.travellers : (applicationData.deal.travellers || []);
      const primary = travellers.find(t => t.type === "Primary Applicant") || travellers[0];
      if (!primary) return "Add at least one traveller before submitting the questionnaire.";

      // Per-traveller: validate the active traveller's answers for personal sections
      const activeTrav = travellers[qState.activeTravellerIndex] || primary;
      const primaryFin = ((q.finance || {})[activeTrav.id]) || {};
      const primaryAnswers = primaryFin.multiAnswers || {};
      const primaryTies = (((q.ties || {})[activeTrav.id] || {}).multiAnswers) || {};
      const hasCanada = qIsCanadaSelected();
      const purposeArr = Array.isArray(q.purpose) ? q.purpose : [];

      const occupationKeys = ["occ-employed","occ-freelancer","occ-business","occ-homemaker","occ-pensioner","occ-retired-nopension","occ-student","occ-unemployed","occ-other"];
      const activeOccupationKeys = occupationKeys.filter(key => key !== "occ-unemployed");
      const assetKeys = ["asset-house","asset-shop","asset-office","asset-building","asset-flat","asset-factory","asset-shed","asset-warehouse","asset-plot","asset-land","asset-none","asset-other"];
      const ownedAssetKeys = assetKeys.filter(key => key !== "asset-none");
      const investmentKeys = ["inv-stocks","inv-bank","inv-fd","inv-mf","inv-ppf","inv-epf","inv-bonds","inv-gold","inv-postal","inv-none","inv-other"];
      const heldInvestmentKeys = investmentKeys.filter(key => key !== "inv-none");
      const tiesKeys = ["housing","social","bizassoc","coop","vol","religious","service","member","none"];
      const activeTiesKeys = tiesKeys.filter(key => key !== "none");

      if (sectionId === "sec-trip") {
        if (!qQuestionnaireCountries().length) return "Please select the country you are applying for.";
        if (qIsBlank(q.maritalStatus)) return "Marital Status is mandatory.";
        if (qIsBlank(q.purpose)) return "Please select the purpose of your visit.";
        if (purposeArr.includes("family-func") && qIsBlank(q.functionType)) return "Please provide the function type details for your visit.";
        if (purposeArr.includes("other") && qIsBlank(q.purposeOther)) return "Please describe your exact purpose of visit.";
        if (qIsBlank(q.arrangements)) return "Please confirm whether you have specific travel plans.";
        return qValidateTravelDates();
      }

      if (sectionId === "sec-inviter") {
        const inviterPurpose = purposeArr.some(purpose => ["family", "friend", "family-func", "convocation", "business"].includes(purpose));
        if (!inviterPurpose) return "";
        if (purposeArr.includes("family") && qIsBlank(q.inviter)) return "Who is inviting you is mandatory for a family visit.";
        if (qIsBlank(q.inviterStatus)) return "Inviter immigration status is mandatory for the selected purpose.";
        if (qIsBlank(q.invitationLetter)) return "Invitation letter answer is mandatory for the selected purpose.";
        if (purposeArr.includes("family") && q.maritalStatus === "married" && qIsBlank(q.inviterRelation)) return "Please indicate whether the family inviter is related directly or through your spouse.";
        return "";
      }

      if (sectionId === "sec-finance") {
        // Only validate what is shown on the Finances page (funding + liquid funds)
        const selectedFunding = Array.isArray(primaryFin.funding) ? primaryFin.funding : (primaryFin.funding ? [primaryFin.funding] : []);
        if (!selectedFunding.length) return "Trip funding is mandatory.";
        if (selectedFunding.includes("sponsor") && qIsBlank(primaryFin.sponsorType)) return "Financial sponsor is mandatory.";
        if (qIsBlank(primaryFin.fundsRange)) return "Available liquid funds is mandatory.";
        return "";
      }

      if (sectionId === "sec-occupation") {
        const tLabel = activeTrav.firstName || "This applicant";
        if (!qHasAnySelected(primaryAnswers, occupationKeys)) return `${tLabel}'s current occupation is mandatory.`;
        if (qHasExclusiveConflict(primaryAnswers, "occ-unemployed", activeOccupationKeys)) return "Unemployed cannot be selected together with another occupation.";
        if (primaryAnswers["occ-business"] && qIsBlank(primaryFin.bizType)) return "Business ownership type is mandatory.";
        if (primaryAnswers["occ-other"] && qIsBlank(primaryFin.moreInfo)) return "Please describe the other occupation.";
        if (["occ-employed","occ-freelancer","occ-pensioner","occ-business"].some(key => primaryAnswers[key]) && qIsBlank(primaryFin.itr)) return "Please answer the ITR question.";
        return "";
      }

      if (sectionId === "sec-assets") {
        if (!qHasAnySelected(primaryAnswers, assetKeys)) return "Immovable property selection is mandatory.";
        if (qHasExclusiveConflict(primaryAnswers, "asset-none", ownedAssetKeys)) return "None cannot be selected together with a property type.";
        if (primaryAnswers["asset-other"] && qIsBlank(primaryFin.otherAssetDesc)) return "Please describe the other property type.";
        if (!qHasAnySelected(primaryAnswers, investmentKeys)) return "Liquid investment selection is mandatory.";
        if (qHasExclusiveConflict(primaryAnswers, "inv-none", heldInvestmentKeys)) return "No investments cannot be selected together with an investment type.";
        if (primaryAnswers["inv-other"] && qIsBlank(primaryFin.otherInvestment)) return "Please describe the other investment type.";
        return "";
      }

      if (sectionId === "sec-ties") {
        if (!qHasAnySelected(primaryTies, tiesKeys)) return "Social, business or community ties selection is mandatory.";
        if (qHasExclusiveConflict(primaryTies, "none", activeTiesKeys)) return "No position or membership cannot be selected together with another community role.";
        return "";
      }

      if (sectionId === "sec-children") {
        const childInfo = ((q.childrenInfo || {})[activeTrav.id]) || {};
        if (qIsBlank(childInfo.doing)) return `${activeTrav.firstName || "Child"}'s current activity is mandatory.`;
        return "";
      }

      if (sectionId === "sec-history") {
        const history = ((q.history || {})[activeTrav.id]) || {};
        const label = activeTrav.firstName || "This traveller";
        if (qIsBlank(history.prevTravel)) return `${label}'s international travel history is mandatory.`;
        if (hasCanada && qIsBlank(history.usaVisa)) return `${label}'s USA visa answer is mandatory for Canada.`;
        if (qIsBlank(history.refusal)) return `${label}'s previous visa refusal answer is mandatory.`;
        if (history.refusal === "yes" && qIsBlank(history.refusalDetail)) return `${label}'s visa refusal details are mandatory.`;
        if (qIsBlank(history.criminalRecord)) return `${label}'s criminal history answer is mandatory.`;
        if (history.criminalRecord === "yes" && qIsBlank(history.criminalDetail)) return `${label}'s criminal history details are mandatory.`;
        if (qIsBlank(history.border)) return `${label}'s entry refusal or immigration breach answer is mandatory.`;
        if (history.border === "yes" && qIsBlank(history.borderDetail)) return `${label}'s immigration breach details are mandatory.`;
      }
      return "";
    }

    function showQuestionnaireValidationSection() {
      const sectionId = qState.validationSection;
      const sections = qQuestionnaireSectionOrder();
      const index = sections.indexOf(sectionId);
      if (index < 0) return;
      qState.currentSection = index;
      rerenderQuestionnaire();
      window.setTimeout(() => window.scrollTo(0, 0), 0);
    }


    // ── validateQuestionnaireForCreator (source 8953-9036) ──
    function validateQuestionnaireForCreator() {
      const units = deriveQuestionnaireUnits();
      const activeUnit = units[qState.activeUnitIndex] || units[0];
      const travellers = activeUnit ? activeUnit.travellers : (applicationData.deal.travellers || []);
      const savedIndex = qState.activeTravellerIndex;
      try {
        for (let i = 0; i < travellers.length; i++) {
          qState.activeTravellerIndex = i;
          for (const sectionId of qQuestionnaireSectionOrder()) {
            // Shared sections (trip/inviter) are only validated once (for first traveller)
            if (i > 0 && (sectionId === "sec-trip" || sectionId === "sec-inviter")) continue;
            const err = validateQuestionnaireSection(sectionId);
            if (err) { qState.validationSection = sectionId; return err; }
          }
        }
      } finally {
        qState.activeTravellerIndex = savedIndex;
      }
      qState.validationSection = null;
      return "";
    }

export {
  qState, isQuestionnaireChild, renderQuestionnaireHTML, validateQuestionnaireForCreator,
  qSelOpt, qTogOpt, qTogMulti, qHandleMultiDep, qSetField, qSetTravelDate,
  qFinSel, qFinTogFunding, qFinTogM, qFinSetField, qTieTogM, qChiSel, qHistSel,
  qHistSetField, qHandleDep, qGoNext, qGoPrev, qSubmitFinal, qAdvanceTraveller, qIsBlank,
  qHasAnySelected, qQuestionnaireCountries, qIsCanadaSelected, qFirstTravelDate, qChildTravellers,
  qQuestionnaireSectionOrder, validateQuestionnaireSection, showQuestionnaireValidationSection,
};
