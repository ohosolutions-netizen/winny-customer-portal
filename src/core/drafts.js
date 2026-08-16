// ─────────────────────────────────────────────────────────────────────────
// Draft / autosave / application lifecycle — copied VERBATIM from the original.
// Mechanical changes only:
//   • `applicationData = X`            → replaceApplicationData(X)
//   • renderDashboard()/renderAll()    → requestRender()
//   • qs("#autoSaveState").textContent → setAutoSaveLabel(...)
// showDashboard/showWizard/showStep and CRM hydrate calls are imported.
// ─────────────────────────────────────────────────────────────────────────
import { CONFIG } from "../config/config.js";
import { applicationData, state, blankApplication, replaceApplicationData } from "../store/runtime.js";
import { mergeDeep, makeApplicationId } from "../lib/utils.js";
import { toast, showLoader, hideLoader, openConfirmModal, requestRender, setAutoSaveLabel } from "../lib/ui.js";
import {
  hasApplicationInfo, hasMeaningfulApplicationContent, getApplicationCardKey,
  normalizeApplicationTitle, isFullyPaidStatus, getApplicationCards,
  recalculatePayment, syncCustomerToTraveller
} from "./derive.js";
import { showDashboard, showWizard, showStep } from "./navigation.js";
import {
  fetchApplicationDetailsViaPortalRequest, hydrateApplicationDetails,
  findDealById, hydrateDealFromCrm, findTravellersForDeal, hydrateTravellersFromCrm
} from "../api/portal.js";
import { hasZohoTransport } from "../api/zoho.js";

    // ── purgeEmptyLocalDrafts ──
    function purgeEmptyLocalDrafts() {
      const indexKey = getDraftIndexKey();
      let drafts;
      try { drafts = JSON.parse(localStorage.getItem(indexKey) || "{}"); } catch (e) { return; }
      let changed = false;
      Object.keys(drafts).forEach((key) => {
        const draft = drafts[key];
        if (!draft) { delete drafts[key]; changed = true; return; }
        const hasNamedTraveller = (draft.deal?.travellers || []).some((t) => String(t?.firstName || t?.lastName || "").trim());
        const meaningful = Boolean(
          draft.deal?.crmDealId || draft.deal?.dealSavedToCRM ||
          draft.deal?.dealName  || draft.deal?.destination ||
          (draft.deal?.selectedServices || []).length ||
draft.stepStatus?.dealCompleted || draft.stepStatus?.questionnaireCompleted ||
          draft.stepStatus?.cifCompleted || draft.stepStatus?.submitted ||
          hasNamedTraveller
        );
        if (!meaningful) { delete drafts[key]; changed = true; }
      });
      if (changed) {
        localStorage.setItem(indexKey, JSON.stringify(drafts));
        state.localApplicationDrafts = draftsToApplicationCards(drafts);
      }
    }

    // ── save / load / index ──
    function saveDraft(showToast) {
      applicationData.lastSavedAt = new Date().toISOString();
      try {
        if (hasApplicationInfo() && !applicationData.applicationId) applicationData.applicationId = makeApplicationId();
        localStorage.setItem(CONFIG.localStorageKey, JSON.stringify(applicationData));
        saveApplicationDraftToIndex();
        setAutoSaveLabel(`Saved ${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`);
        if (showToast) toast("Draft saved.");
      } catch (error) {
        console.error(error);
        toast("Could not save draft locally.");
      }
      requestRender();
    }

    function loadDraft() {
      try {
        const saved = JSON.parse(localStorage.getItem(CONFIG.localStorageKey) || "null");
        if (saved) replaceApplicationData(mergeDeep(blankApplication(), saved));
        purgeEmptyLocalDrafts();
        state.localApplicationDrafts = loadApplicationDraftIndex();
      } catch (error) {
        console.warn("Draft load failed", error);
      }
    }

    function getDraftIndexKey() {
  const email = String(
    applicationData.crmSync.loggedInEmail ||
    applicationData.customer.email ||
    "guest"
  ).trim().toLowerCase();

  return `${CONFIG.localStorageKey}:applications:${email || "guest"}`;
}

    function getCurrentApplicationStorageKey() {
      return applicationData.deal.crmDealId ? `deal:${applicationData.deal.crmDealId}` : `app:${applicationData.applicationId || "new"}`;
    }

    function saveApplicationDraftToIndex() {
  const savedDealId = String(
    applicationData.deal.crmDealId || ""
  ).trim();

  if (!savedDealId || !hasMeaningfulApplicationContent()) return;
      if (!applicationData.applicationId) applicationData.applicationId = makeApplicationId();
      const indexKey = getDraftIndexKey();
      const drafts = JSON.parse(localStorage.getItem(indexKey) || "{}");
const currentKey = getCurrentApplicationStorageKey();
const currentDealId = String(applicationData.deal.crmDealId || "");
const currentAppId = String(applicationData.applicationId || "");

// Remove an older local-storage entry for this same application.
// This prevents one application being stored under both app: and deal: keys.
Object.keys(drafts).forEach((key) => {
  if (key === currentKey) return;

  const draft = drafts[key];
  const draftDealId = String(draft?.deal?.crmDealId || "");
  const draftAppId = String(draft?.applicationId || "");

  const sameDeal =
    currentDealId &&
    draftDealId &&
    currentDealId === draftDealId;

  const sameApplication =
    currentAppId &&
    draftAppId &&
    currentAppId === draftAppId;

  if (sameDeal || sameApplication) {
    delete drafts[key];
  }
});

drafts[currentKey] = applicationData;
localStorage.setItem(indexKey, JSON.stringify(drafts));
      state.localApplicationDrafts = draftsToApplicationCards(drafts);
    }

    function loadApplicationDraftIndex() {
      try {
        const drafts = JSON.parse(localStorage.getItem(getDraftIndexKey()) || "{}");
        return draftsToApplicationCards(drafts);
      } catch (error) {
        console.warn("Application draft index load failed", error);
        return [];
      }
    }

    function loadStoredApplicationDraft(dealId, applicationId) {
      try {
        const drafts = JSON.parse(localStorage.getItem(getDraftIndexKey()) || "{}");
        if (dealId && drafts[`deal:${dealId}`]) return drafts[`deal:${dealId}`];
        if (applicationId && drafts[`app:${applicationId}`]) return drafts[`app:${applicationId}`];
        const currentTitle = normalizeApplicationTitle(applicationData.deal.dealName || "");
        const match = Object.values(drafts).find((draft) => {
          if (!draft) return false;
          if (dealId && String(draft?.deal?.crmDealId || "") === String(dealId)) return true;
          if (applicationId && String(draft?.applicationId || "") === String(applicationId)) return true;
          return currentTitle && normalizeApplicationTitle(draft?.deal?.dealName || "") === currentTitle;
        });
        if (match) return match;
      } catch (error) {
        console.warn("Stored application draft lookup failed", error);
      }
      return null;
    }

    function draftsToApplicationCards(drafts) {
      return Object.entries(drafts || {}).map(([localKey, draft]) => ({
        source: "local",
        localKey,
        dealId: draft?.deal?.crmDealId || "",
        applicationId: draft?.applicationId || "",
        title: draft?.deal?.dealName || `${[draft?.customer?.firstName, draft?.customer?.lastName].filter(Boolean).join(" ") || "Draft"} - Application`,
        destination: draft?.deal?.destination || "",
        serviceType: (draft?.deal?.serviceBasket || []).map((item) => item.name).filter(Boolean).join(", "),
        stage: draft?.stepStatus?.submitted ? "Submitted" : "In Progress",
        paymentStatus: draft?.payment?.status || "Pending",
        status: draft?.stepStatus?.submitted ? "Submitted" : "In Progress",
        lastSavedAt: draft?.lastSavedAt || ""
      }));
    }

    // ── hidden keys + hide/remove ──
    function getHiddenIndexKey() {
  const email = String(
    applicationData.crmSync.loggedInEmail ||
    applicationData.customer.email ||
    "guest"
  ).trim().toLowerCase();

  return `${CONFIG.localStorageKey}:hidden:${email || "guest"}`;
}
    function loadHiddenApplicationKeys() {
      try { return new Set(JSON.parse(localStorage.getItem(getHiddenIndexKey()) || "[]")); }
      catch (error) { return new Set(); }
    }
    function saveHiddenApplicationKeys(keys) {
      try { localStorage.setItem(getHiddenIndexKey(), JSON.stringify([...keys])); }
      catch (error) { console.warn("Could not save hidden application list", error); }
    }
    function isApplicationHidden(app) {
      const hidden = loadHiddenApplicationKeys();
      if (hidden.has(getApplicationCardKey(app))) return true;
      if (app.dealId && hidden.has(`deal:${app.dealId}`)) return true;
      if (app.applicationId && hidden.has(`app:${app.applicationId}`)) return true;
      if (app.localKey && hidden.has(app.localKey)) return true;
      return false;
    }
    function hideApplicationCard(app) {
      const hidden = loadHiddenApplicationKeys();
      hidden.add(getApplicationCardKey(app));
      if (app.dealId) hidden.add(`deal:${app.dealId}`);
      if (app.applicationId) hidden.add(`app:${app.applicationId}`);
      if (app.localKey) hidden.add(app.localKey);
      saveHiddenApplicationKeys(hidden);
      // Also drop the raw draft data so it doesn't linger in localStorage.
      const indexKey = getDraftIndexKey();
      try {
        const drafts = JSON.parse(localStorage.getItem(indexKey) || "{}");
        Object.keys(drafts).forEach((key) => {
          const draft = drafts[key];
          const draftDealId = draft?.deal?.crmDealId || "";
          const draftAppId = draft?.applicationId || "";
          if ((app.dealId && draftDealId === app.dealId) || (app.applicationId && draftAppId === app.applicationId) || key === app.localKey) {
            delete drafts[key];
          }
        });
        localStorage.setItem(indexKey, JSON.stringify(drafts));
        state.localApplicationDrafts = draftsToApplicationCards(drafts);
      } catch (error) {
        console.warn("Could not prune local draft for removed application", error);
      }
      // If the removed card is the application currently open in the wizard,
      // clear the active session too so it doesn't reappear via applicationCardFromCurrent().
      const currentDealId = String(
  applicationData.deal.crmDealId || ""
);

const currentAppId = String(
  applicationData.applicationId || ""
);

const retainedSync = mergeDeep(
  {},
  applicationData.crmSync || {}
);

const retainedPortalEmail = String(
  applicationData.crmSync.loggedInEmail ||
  applicationData.customer.email ||
  ""
).trim();

const removingCurrentApplication = Boolean(
  (app.dealId &&
    String(app.dealId) === currentDealId) ||
  (app.applicationId &&
    String(app.applicationId) === currentAppId)
);

if (removingCurrentApplication) {
  try {
    localStorage.removeItem(CONFIG.localStorageKey);
  } catch (e) {}

  replaceApplicationData(blankApplication());

  applicationData.crmSync = mergeDeep(
    applicationData.crmSync,
    retainedSync
  );

  applicationData.crmSync.loggedInEmail =
    retainedPortalEmail;

  if (retainedPortalEmail) {
    applicationData.customer.email =
      retainedPortalEmail;
  }

  state.dealSubStep = 1;
}
    }
    function confirmRemoveApplication(dealId, applicationId) {
      const app = getApplicationCards().find((card) =>
        (dealId && card.dealId === dealId) || (!dealId && applicationId && card.applicationId === applicationId)
      );
      if (!app) return;
      if (isFullyPaidStatus(app.paymentStatus)) { toast("This application is already paid and can't be removed from here."); return; }
      openConfirmModal(
        "Remove this application?",
        `"${app.title || "This application"}" will be removed from your list. This can't be undone from here.`,
        async () => {
  hideApplicationCard(app);

  const remainingApplications = getApplicationCards();
  const nextApplication = remainingApplications[0] || null;

  if (nextApplication) {
    await openApplication(
      nextApplication.dealId || "",
      nextApplication.applicationId || ""
    );

    // Return to the dashboard with the remaining application selected.
    showDashboard();
  } else {
      requestRender();
  }

  toast("Application removed.");
}
      );
    }

    function autoSave() {
      if (applicationData.stepStatus.submitted) return;
      saveDraft(false);
    }

    function startNewApplication() {
      saveDraft(false);
      const previousCustomer = mergeDeep({}, applicationData.customer || {});
      const previousSync = mergeDeep({}, applicationData.crmSync || {});
      const previousContactId = applicationData.deal.crmContactId || previousSync.crmContactId || "";
     replaceApplicationData(blankApplication());

// A new application must always begin unpaid.
applicationData.payment.status = "Pending";
applicationData.payment.method = "";
applicationData.payment.baseCost = 0;
applicationData.payment.taxes = 0;
applicationData.payment.addons = 0;
applicationData.payment.grandTotal = 0;
applicationData.payment.payableNow = 0;
applicationData.payment.paidAmount = 0;
applicationData.payment.balanceAmount = 0;
applicationData.payment.paymentLinkId = "";
applicationData.payment.paymentLinkUrl = "";
applicationData.payment.paidAt = "";

applicationData.stepStatus.dealCompleted = false;
applicationData.stepStatus.questionnaireCompleted = false;
applicationData.stepStatus.cifCompleted = false;
applicationData.stepStatus.submitted = false;

applicationData.customer = mergeDeep(
  applicationData.customer,
  previousCustomer
);
      applicationData.crmSync = mergeDeep(applicationData.crmSync, previousSync);
      applicationData.deal.crmContactId = previousContactId;
      applicationData.applicationId = makeApplicationId();
      applicationData.currentStep = 1;
      state.dealSubStep = 1;
      state.activeCifCategory = null;
      state.activeCifTraveller = null;
      state.activeCifInstance = null;
      state.activeCifStage = null;
      syncCustomerToTraveller();
      recalculatePayment();
      saveDraft(false);
      requestRender();
      showWizard();
      showStep(1);
      toast("Started a new application. Previous applications remain saved.");
    }

    // ── openApplication ──
    async function openApplication(dealId, applicationId) {
      saveDraft(false);
      const previousCustomer = mergeDeep({}, applicationData.customer || {});
      const previousSync = mergeDeep({}, applicationData.crmSync || {});
      const localDraft = loadStoredApplicationDraft(dealId, applicationId);
      replaceApplicationData(localDraft ? mergeDeep(blankApplication(), localDraft) : blankApplication());
      applicationData.customer = mergeDeep(applicationData.customer, previousCustomer);
      applicationData.crmSync = mergeDeep(applicationData.crmSync, previousSync);
      if (!applicationData.deal.crmContactId && previousSync.crmContactId) applicationData.deal.crmContactId = previousSync.crmContactId;
      if (applicationId && !applicationData.applicationId) applicationData.applicationId = applicationId;
      if (!applicationData.applicationId) applicationData.applicationId = makeApplicationId();
      if (dealId) {
        applicationData.deal.crmDealId = dealId;
        applicationData.deal.dealSavedToCRM = true;
      }

      if (dealId && hasZohoTransport()) {
  showLoader("Loading complete application details...");

  try {
    const details =
      await fetchApplicationDetailsViaPortalRequest(dealId);

    hydrateApplicationDetails(details);
  } catch (error) {
    console.warn(
      "[Winny] Complete application hydration failed:",
      error
    );

    /*
     * Preserve the previous direct lookup as a fallback for environments
     * where it happens to be available.
     */
    const deal = await findDealById(dealId);
    if (deal) hydrateDealFromCrm(deal);

    const travellers = await findTravellersForDeal(dealId);
    if (travellers.length) {
      hydrateTravellersFromCrm(travellers);
    }

    toast(
      error.message ||
      "Application details could not be completely refreshed."
    );
  } finally {
    hideLoader();
  }
}

      state.dealSubStep = 1;
      state.activeCifCategory = null;
      state.activeCifTraveller = null;
      state.activeCifInstance = null;
      state.activeCifStage = null;  
      if (applicationData.deal.selectedServices.length) recalculatePayment();
      saveDraft(false);
      requestRender();
      showWizard();
      showStep(applicationData.currentStep || 1);
    }

export {
  purgeEmptyLocalDrafts, saveDraft, loadDraft, getDraftIndexKey,
  getCurrentApplicationStorageKey, saveApplicationDraftToIndex,
  loadApplicationDraftIndex, loadStoredApplicationDraft, draftsToApplicationCards,
  getHiddenIndexKey, loadHiddenApplicationKeys, saveHiddenApplicationKeys,
  isApplicationHidden, hideApplicationCard, confirmRemoveApplication, autoSave,
  startNewApplication, openApplication
};
