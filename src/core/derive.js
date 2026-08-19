// ─────────────────────────────────────────────────────────────────────────
// Synchronous derive/compute helpers — copied VERBATIM from the original.
// Payment math, progress/stage, application-card assembly, getters.
// The only mechanical change: setPaymentMode's renderDeal() → requestRender().
// ─────────────────────────────────────────────────────────────────────────
import { packageCatalog, journeyStages } from "../config/config.js";
import { applicationData, state } from "../store/runtime.js";
import { markAutoSavePending, requestRender } from "../lib/ui.js";
import { isApplicationHidden } from "./drafts.js";

    // ── getters ──
    function getSelectedServices()     { return packageCatalog.filter((pkg) => applicationData.deal.selectedServices.includes(pkg.id)); }
    function getSelectedServiceNames() {
      const basket = applicationData.deal.serviceBasket || [];
      const addons = (applicationData.deal.selectedAddons || []).map(id => { const p = packageCatalog.find(x => x.id === id); return p ? p.name : ""; }).filter(Boolean);
      const basketNames = [...new Set(basket.map(i => i.name))];
      return [...basketNames, ...addons].join(", ");
    }
    function getCustomerName()         { return `${applicationData.customer.firstName||""} ${applicationData.customer.lastName||""}`.trim(); }

    // ── payment calc ──
    function recalculatePayment() {
      // Sum from basket items (per-applicant pricing)
      const basket     = applicationData.deal.serviceBasket || [];
      const addonsIds  = applicationData.deal.selectedAddons || [];
      const addonItems = packageCatalog.filter(p => addonsIds.includes(p.id));

      const base   = basket.reduce((s, i) => s + i.total, 0);
      const addons = addonItems.reduce((s, a) => s + a.price, 0);
      const taxes  = Math.round((base + addons) * 0.18);

      applicationData.payment.baseCost   = base;
      applicationData.payment.addons     = addons;
      applicationData.payment.taxes      = taxes;
      applicationData.payment.grandTotal = base + addons + taxes;
      syncPaymentBreakdown();
    }

    function getPaymentMode() {
      return applicationData.payment.paymentMode === "Partial" ? "Partial" : "Full";
    }

    function syncPaymentBreakdown() {
  const total       = Number(applicationData.payment.grandTotal || 0);
  const alreadyPaid = Number(applicationData.payment.paidAmount || 0);
  const remaining   = Math.max(total - alreadyPaid, 0);
  if (getPaymentMode() !== "Partial") {
    applicationData.payment.paymentMode   = "Full";
    applicationData.payment.payableNow    = remaining;
    applicationData.payment.balanceAmount = 0;
    return;
  }
  let payable = Number(applicationData.payment.payableNow || 0);
  if (!Number.isFinite(payable) || payable <= 0) payable = Math.min(remaining, Math.max(1, Math.round(remaining * 0.25)));
  if (remaining > 0) payable = Math.min(payable, remaining);
  applicationData.payment.payableNow    = payable;
  applicationData.payment.balanceAmount = Math.max(remaining - payable, 0);
}

    function getPayableAmount() {
      syncPaymentBreakdown();
      // payableNow is now correctly computed for BOTH modes by
      // syncPaymentBreakdown() (remaining balance for Full, chosen amount
      // for Partial) — no need to branch on mode here anymore.
      return Number(applicationData.payment.payableNow || 0);
    }

    function getPaymentStatusAfterSuccess() {
  const total = Number(
    applicationData.payment.grandTotal || 0
  );

  const totalPaid = Number(
    applicationData.payment.paidAmount || 0
  );

  if (total <= 0 || totalPaid <= 0) {
    return "Pending";
  }

  return totalPaid >= total
    ? "Paid"
    : "Partially Paid";
}

    function isFullyPaidStatus(status) {
      return String(status || "").trim().toLowerCase() === "paid";
    }

    function setPaymentMode(mode) {
      applicationData.payment.paymentMode = mode === "Partial" ? "Partial" : "Full";
      syncPaymentBreakdown();
      requestRender();
      markAutoSavePending();
    }

    function updatePartialPayable(value) {
      applicationData.payment.paymentMode = "Partial";
      applicationData.payment.payableNow = Number(value || 0);
      syncPaymentBreakdown();
      markAutoSavePending();
    }

    function syncCustomerToTraveller() {
      // Only sync if deal is saved and primary traveller exists
      const primary = applicationData.deal.travellers[0];
      if (!primary || !applicationData.deal.dealSavedToCRM) return;
      if (!primary.firstName)   primary.firstName   = applicationData.customer.firstName;
      if (!primary.lastName)    primary.lastName    = applicationData.customer.lastName;
      if (!primary.email)       primary.email       = applicationData.customer.email;
      if (!primary.mobile)      primary.mobile      = applicationData.customer.mobile;
      if (!primary.nationality) primary.nationality = applicationData.customer.nationality;
    }

    // ── traveller relationship ──
    function deriveTravellerRelationship(traveller, travellers) {
  const type = String(traveller?.type || "").trim();

  if (type === "Primary Applicant") {
    return "Self";
  }

  if (type === "Spouse") {
    return "Spouse";
  }

  if (type === "Child") {
    const children = (travellers || []).filter(
      (item) => String(item?.type || "").trim() === "Child"
    );

    const childIndex = children.findIndex(
      (item) => item.id === traveller.id
    );

    if (childIndex >= 0 && childIndex < 3) {
      return `Child ${childIndex + 1}`;
    }
  }

  return "";
}

    // ── application cards ──
    function unhideCurrentApplication(app) {
      if (!app) return;
      const hidden = loadHiddenApplicationKeys();
      const keys = [
        getApplicationCardKey(app),
        app.dealId ? `deal:${app.dealId}` : null,
        app.applicationId ? `app:${app.applicationId}` : null
      ].filter(Boolean);
      let changed = false;
      keys.forEach((k) => { if (hidden.delete(k)) changed = true; });
      if (changed) saveHiddenApplicationKeys(hidden);
    }
    function getApplicationCards() {
      const byKey = new Map();
      const addApp = (app) => {
        if (!app) return;
        const key = getApplicationCardKey(app);
        const existing = byKey.get(key);
        byKey.set(key, existing ? mergeApplicationCard(existing, app) : app);
      };
      (state.portalApplications || []).forEach(addApp);
      (state.localApplicationDrafts || []).forEach(addApp);
      if (hasApplicationInfo() && !state.applicationSelectionLoading) {
  const currentCard = applicationCardFromCurrent();

  if (!isApplicationHidden(currentCard)) {
    addApp(currentCard);
  }
}

return [...byKey.values()]
  .filter((app) => !isApplicationHidden(app))
  .sort(
    (a, b) =>
      new Date(b.createdTime || b.lastSavedAt || 0) -
      new Date(a.createdTime || a.lastSavedAt || 0)
  );
    }

    function getApplicationCardKey(app) {
      if (app.dealId) return `deal:${app.dealId}`;
      const currentDealId = String(applicationData.deal.crmDealId || "");
      const currentAppId = String(applicationData.applicationId || "");
      const currentTitle = normalizeApplicationTitle(applicationData.deal.dealName || `${getCustomerName() || "Application"} - Application`);
      if (app.applicationId && currentAppId && app.applicationId === currentAppId && currentDealId) return `deal:${currentDealId}`;
      if (normalizeApplicationTitle(app.title) && normalizeApplicationTitle(app.title) === currentTitle && currentDealId) return `deal:${currentDealId}`;
      return app.applicationId ? `app:${app.applicationId}` : `draft:${app.localKey || normalizeApplicationTitle(app.title) || "new"}`;
    }

    function mergeApplicationCard(existing, incoming) {
      return {
        ...existing,
        ...incoming,
        dealId: incoming.dealId || existing.dealId || "",
        applicationId: existing.applicationId || incoming.applicationId || "",
        title: incoming.title || existing.title || "",
        destination: incoming.destination || existing.destination || "",
        serviceType: incoming.serviceType || existing.serviceType || "",
        stage: incoming.stage || existing.stage || "",
        stageIndex: Number.isInteger(Number(incoming.stageIndex))
          ? Math.max(0, Math.min(journeyStages.length - 1, Number(incoming.stageIndex)))
          : Number.isInteger(Number(existing.stageIndex))
            ? Math.max(0, Math.min(journeyStages.length - 1, Number(existing.stageIndex)))
            : 0,
        progressPercent: Number.isFinite(Number(incoming.progressPercent))
          ? Math.max(0, Math.min(100, Number(incoming.progressPercent)))
          : Number.isFinite(Number(existing.progressPercent))
            ? Math.max(0, Math.min(100, Number(existing.progressPercent)))
            : 0,
        paymentStatus: incoming.paymentStatus || existing.paymentStatus || "Pending",
        status: incoming.status || existing.status || "In Progress",
        lastSavedAt: incoming.lastSavedAt || existing.lastSavedAt || "",
        createdTime: incoming.createdTime || existing.createdTime || ""
      };
    }

    function normalizeApplicationTitle(value) {
      return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
    }

    function applicationCardFromCurrent() {
      return {
        source: "current",
        dealId: applicationData.deal.crmDealId || "",
        applicationId: applicationData.applicationId || "",
        title: applicationData.deal.dealName || `${getCustomerName() || "Application"} - Application`,
        destination: applicationData.deal.destination || "",
        serviceType: applicationData.deal.goal || getSelectedServiceNames() || "",
        stage: getCurrentStage(),
        stageIndex: getJourneyStageIndex(),
        progressPercent: getCompletionPercent(),
        paymentStatus: applicationData.payment.status || "Pending",
        status: applicationData.stepStatus.submitted ? "Submitted" : "In Progress",
        lastSavedAt: applicationData.lastSavedAt || ""
      };
    }

    function hasApplicationInfo() {
      const hasNamedTraveller = applicationData.deal.travellers.some((t) => String(t.firstName || t.lastName || "").trim());
      return Boolean(
        applicationData.deal.crmDealId || applicationData.deal.dealSavedToCRM ||
        applicationData.deal.dealName  || applicationData.deal.destination ||
applicationData.deal.selectedServices.length ||
applicationData.stepStatus.dealCompleted ||
        applicationData.stepStatus.questionnaireCompleted || applicationData.stepStatus.cifCompleted ||
        applicationData.stepStatus.submitted || hasNamedTraveller
      );
    }
    function hasMeaningfulApplicationContent() {
      const hasNamedTraveller = applicationData.deal.travellers.some((t) => String(t.firstName || t.lastName || "").trim());
      return Boolean(
        applicationData.deal.crmDealId || applicationData.deal.dealSavedToCRM ||
        applicationData.deal.dealName  || applicationData.deal.destination ||
applicationData.deal.selectedServices.length ||
applicationData.stepStatus.dealCompleted || applicationData.stepStatus.questionnaireCompleted ||
        applicationData.stepStatus.cifCompleted || applicationData.stepStatus.submitted ||
        hasNamedTraveller
      );
    }

    function isDealSaved() {
      return Boolean(applicationData.deal.dealSavedToCRM || applicationData.deal.crmDealId);
    }

    // ── progress / stage ──
    function getApplicationCompletionPercent(data) {
      const complete = [
        data?.stepStatus?.dealCompleted,
        data?.stepStatus?.questionnaireCompleted,
        data?.stepStatus?.cifCompleted,
        Number(data?.currentStep || 1) >= 5 && data?.stepStatus?.cifCompleted,
        data?.stepStatus?.submitted
      ].filter(Boolean).length;
      return Math.round((complete / 5) * 100);
    }

    function getCompletionPercent() {
      return getApplicationCompletionPercent(applicationData);
    }

    function getApplicationJourneyStageIndex(data) {
      if (data?.stepStatus?.submitted)              return 5;
      if (data?.stepStatus?.cifCompleted)           return 4;
      if (data?.stepStatus?.questionnaireCompleted) return 3;
      if (data?.stepStatus?.dealCompleted)          return 2;
      if (isFullyPaidStatus(data?.payment?.status)) return 1;
      return 0;
    }

    function getJourneyStageIndex() {
      return getApplicationJourneyStageIndex(applicationData);
    }

    function getApplicationStage(data) {
      return journeyStages[getApplicationJourneyStageIndex(data)] || journeyStages[0];
    }

    function getCurrentStage() { return getApplicationStage(applicationData); }

    function getStageNote() {
      if (applicationData.stepStatus.submitted)             return "Application submitted to the case team.";
      if (applicationData.stepStatus.cifCompleted)          return "Ready for final review.";
      if (applicationData.stepStatus.questionnaireCompleted)return "Complete the CIF form and upload your documents.";
      if (applicationData.stepStatus.dealCompleted)         return "Payment complete. Questionnaire is unlocked.";
      return "Start by filling in your details.";
    }

    function isStepLocked(step) {
      if (step <= 1) return false;
      if (step === 2) return !applicationData.stepStatus.dealCompleted;
      if (step === 3) return !applicationData.stepStatus.questionnaireCompleted; // Documents unlocks alongside CIF
      if (step === 4) return !applicationData.stepStatus.questionnaireCompleted;
      if (step === 5) return !applicationData.stepStatus.cifCompleted;
      if (step === 6) return !applicationData.stepStatus.submitted;
      return false;
    }

    function isStepDone(step) {
      if (step === 1) return applicationData.stepStatus.dealCompleted;
      if (step === 2) return applicationData.stepStatus.questionnaireCompleted;
      if (step === 3) return isDocumentChecklistClear();
      if (step === 4) return applicationData.stepStatus.cifCompleted;
      if (step === 5) return applicationData.stepStatus.submitted;
      if (step === 6) return applicationData.stepStatus.submitted;
      return false;
    }

    // ── documents (status meta / checklist clear) ──
    function documentStatusMeta(status) {
      const map = {
        "Collected":           { dot: "#0faa82", bg: "#e8f8f2", fg: "#077753" },
        "Not Collected":       { dot: "#0561f4", bg: "#eef4ff", fg: "#183d91" },
        "On Hold":             { dot: "#c026d3", bg: "#fbeaff", fg: "#7a1594" },
        "Not Required":        { dot: "#9aa1b0", bg: "#f0f2f6", fg: "#5b6072" },
        "Reviewed":            { dot: "#d99200", bg: "#fff8e5", fg: "#8a5700" },
        "Accepted":            { dot: "#0561f4", bg: "#eef4ff", fg: "#183d91" },
        "Correction Required": { dot: "#d94f68", bg: "#fff0f3", fg: "#a1233b" }
      };
      return map[status] || map["Not Collected"];
    }

    const DOCUMENT_READY_STATUSES = new Set(["Collected", "Not Required", "Reviewed", "Accepted"]);
    const MANDATORY_DOCUMENT_VALUES = new Set(["mandatory", "required", "yes", "true", "y", "1"]);
    const OPTIONAL_DOCUMENT_VALUES = new Set(["optional", "not mandatory", "not required", "no", "false", "n", "0"]);
    const STRENGTH_DOCUMENT_VALUES = new Set(["strength"]);

    function getDocumentRequirementValue(document) {
      return document?.documentRequirement ?? document?.document_requirement ?? document?.Document_Requirement ?? "";
    }

    function isMandatoryDocument(document) {
      if (typeof document?.isMandatory === "boolean") return document.isMandatory;
      if (typeof document?.mandatory === "boolean") return document.mandatory;

      const normalized = String(getDocumentRequirementValue(document)).trim().toLowerCase();
      if (MANDATORY_DOCUMENT_VALUES.has(normalized)) return true;
      if (OPTIONAL_DOCUMENT_VALUES.has(normalized) || STRENGTH_DOCUMENT_VALUES.has(normalized)) return false;

      // Preserve the legacy safe behaviour when an older Deluge response does
      // not yet include Document_Requirement: the document still blocks the
      // checklist rather than accidentally letting the customer continue.
      return true;
    }

    function isStrengthDocument(document) {
      const normalized = String(getDocumentRequirementValue(document)).trim().toLowerCase();
      return !isMandatoryDocument(document) && STRENGTH_DOCUMENT_VALUES.has(normalized);
    }

    function isDocumentReady(document) {
      // Uploading a file must not directly change Document_Status because that
      // field is controlled by the CRM Blueprint. A confirmed CRM file/source
      // reference is enough for portal checklist completion; CRM keeps its
      // existing blueprint status until an authorised transition changes it.
      return Boolean(document?.hasFile || document?.sourceRequestId || document?.source_request_id) ||
        DOCUMENT_READY_STATUSES.has(document?.status);
    }

    function isDocumentChecklistClear() {
      if (!state.documents.loaded || !state.documents.items.length) return false;
      return state.documents.items.filter(isMandatoryDocument).every(isDocumentReady);
    }

export {
  getSelectedServices, getSelectedServiceNames, getCustomerName,
  recalculatePayment, getPaymentMode, syncPaymentBreakdown, getPayableAmount,
  getPaymentStatusAfterSuccess, isFullyPaidStatus, setPaymentMode,
  updatePartialPayable, syncCustomerToTraveller, deriveTravellerRelationship,
  unhideCurrentApplication, getApplicationCards, getApplicationCardKey,
  mergeApplicationCard, normalizeApplicationTitle, applicationCardFromCurrent,
  hasApplicationInfo, hasMeaningfulApplicationContent, isDealSaved,
  getApplicationCompletionPercent, getApplicationJourneyStageIndex, getApplicationStage,
  getCompletionPercent, getJourneyStageIndex, getCurrentStage, getStageNote,
  isStepLocked, isStepDone, documentStatusMeta, isMandatoryDocument, isStrengthDocument,
  isDocumentReady, isDocumentChecklistClear
};
