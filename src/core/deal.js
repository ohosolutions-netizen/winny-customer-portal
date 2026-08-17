// ─────────────────────────────────────────────────────────────────────────
// Deal step — synchronous actions & derive, copied VERBATIM from the original.
// Mechanical changes only: renderDeal()/renderAuthorisationList()/
// renderCountryTravellerMap()/renderCIF() → requestRender(); the reset-draft
// reassignment → replaceApplicationData(...). openConfirmModal/showDashboard
// are imported.
// ─────────────────────────────────────────────────────────────────────────
import { CONFIG, packageCatalog } from "../config/config.js";
import { applicationData, state, blankApplication, replaceApplicationData } from "../store/runtime.js";
import { getByPath, setByPath, uid } from "../lib/utils.js";
import { toast, markAutoSavePending, requestRender, openConfirmModal, fail } from "../lib/ui.js";
import { recalculatePayment, isFullyPaidStatus, deriveTravellerRelationship, isDealSaved } from "./derive.js";
import { saveDraft } from "./drafts.js";
import { showDashboard } from "./navigation.js";
import { GOAL_DEFS, countriesMatch, getAddonProducts, getGoalCountries, getGoalDefinition, getProductCountries } from "./catalog.js";

    // ── destination ↔ traveller country mapping ──
    function getDestinationCountries() {
      return (applicationData.deal.destination || "").split(",").map(s => s.trim()).filter(Boolean);
    }

    // Strips any country from a traveller's list that's no longer in the
    // destination selection. Deliberately does NOT auto-add newly selected
    // destination countries to every traveller — the whole point of this UI
    // is that the person explicitly ticks who is going where.
    function reconcileTravellerCountries() {
      const dest = getDestinationCountries();
      applicationData.deal.travellers.forEach((t) => {
        if (!Array.isArray(t.countries)) t.countries = [];
        t.countries = t.countries.filter((c) => dest.includes(c));
      });
    }

    function applyTravellerCrmIds(raw) {
      if (!raw) return;
      let pairs;
      try { pairs = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { console.warn("[Winny] Could not parse CRM_Traveller_IDs:", raw); return; }
      if (!Array.isArray(pairs) && pairs && typeof pairs === "object") {
        pairs = Object.entries(pairs).map(([localId, crmId]) => ({ localId, crmId }));
      }
      if (!Array.isArray(pairs)) return;
      pairs.forEach((pair) => {
        const localId = pair.local_id || pair.localId || pair.traveller_id || pair.travellerId;
        const crmId   = pair.crm_id || pair.crmId || pair.crm_traveller_id || pair.crmTravellerId;
        if (!localId || !crmId) return;
        const t = applicationData.deal.travellers.find((x) => x.id === localId);
        if (t) t.crmId = String(crmId);
      });
      saveDraft(false);
    }
    function toggleTravellerCountry(travId, country, checked) {
      const t = applicationData.deal.travellers.find((x) => x.id === travId);
      if (!t) return;
      if (!Array.isArray(t.countries)) t.countries = [];
      if (checked) { if (!t.countries.includes(country)) t.countries.push(country); }
      else { t.countries = t.countries.filter((c) => c !== country); }
      if (state.pendingPackageId && state.activeGoal) {
        const activeGoal = GOAL_DEFS.find(goal => goal.key === state.activeGoal);
        if (activeGoal?.countryMode !== "none") {
          state.pendingAssignedTo = getAssignedTravellerIdsForGoal(state.activeGoal, state.pendingPackageId);
        }
      }
      markAutoSavePending();
    }

    // ── travellers ──
    const DEFAULT_FAMILY_ID = "family-1";

    function createTraveller(familyId = DEFAULT_FAMILY_ID) {
      return {
        id: uid("traveller"),
        familyId,
        type: "Additional Traveller",
        firstName: "",
        lastName: "",
        dob: "",
        relationship: "",
        nationality: applicationData.customer.nationality || "",
        email: "",
        mobile: "",
        countries: [],
        crmId: ""
      };
    }

    function getGoalCountrySelection(goalKey) {
      if (!applicationData.deal.serviceCountries || typeof applicationData.deal.serviceCountries !== "object") {
        applicationData.deal.serviceCountries = {};
      }
      if (!Array.isArray(applicationData.deal.serviceCountries[goalKey])) {
        const allowed = new Set(getGoalCountries(goalKey));
        applicationData.deal.serviceCountries[goalKey] = getDestinationCountries().filter(country => allowed.has(country));
      }
      return applicationData.deal.serviceCountries[goalKey];
    }

    function getPackageDestinationCountries(goalKey, packageId) {
      const selectedCountries = getGoalCountrySelection(goalKey);
      const pkg = packageCatalog.find(product => product.id === packageId);
      if (!pkg) return selectedCountries;
      const supportedCountries = getProductCountries(pkg);
      if (!supportedCountries.length) return selectedCountries;
      return selectedCountries.filter(selectedCountry =>
        supportedCountries.some(supportedCountry => countriesMatch(selectedCountry, supportedCountry))
      );
    }

    function getAssignedTravellerIdsForGoal(goalKey, packageId = null) {
      const selectedCountries = packageId
        ? getPackageDestinationCountries(goalKey, packageId)
        : getGoalCountrySelection(goalKey);
      return applicationData.deal.travellers
        .filter(traveller => selectedCountries.some(country => (traveller.countries || []).includes(country)))
        .map(traveller => traveller.id);
    }

    function syncDestinationFromServiceCountries() {
      const selections = applicationData.deal.serviceCountries || {};
      const basketCountries = (applicationData.deal.serviceBasket || []).flatMap(item => item.destinations || []);
      const countries = [...new Set([...Object.values(selections).flat(), ...basketCountries].filter(Boolean))];
      applicationData.deal.destination = countries.join(", ");
      applicationData.stepStatus.cifCompleted = false;
      state.activeCifInstance = null;
      state.activeCifStage = null;
      reconcileTravellerCountries();
    }

    function toggleGoalCountry(goalKey, country) {
      const goal = GOAL_DEFS.find(item => item.key === goalKey);
      if (!goal || goal.countryMode === "none") return;
      const selected = getGoalCountrySelection(goalKey);
      if (goal.countryMode === "multiple") {
        applicationData.deal.serviceCountries[goalKey] = selected.includes(country)
          ? selected.filter(item => item !== country)
          : [...selected, country];
      } else {
        applicationData.deal.serviceCountries[goalKey] = selected.includes(country) ? [] : [country];
      }
      state.pendingPackageId = null;
      state.pendingAssignedTo = [];
      syncDestinationFromServiceCountries();
      markAutoSavePending();
      requestRender();
    }

    function addTraveller(familyId = DEFAULT_FAMILY_ID) {
      if (!isDealSaved()) { toast("Save the Deal first, then add travellers."); return; }
      applicationData.deal.travellers.push(createTraveller(familyId));
      requestRender();
      markAutoSavePending();
    }

    function addFamilyGroup() {
      if (!isDealSaved()) { toast("Save the Deal first, then add a family group."); return; }
      applicationData.deal.travellers.push(createTraveller(uid("family")));
      requestRender();
      markAutoSavePending();
    }

    function removeTraveller(id) {
      applicationData.deal.travellers = applicationData.deal.travellers.filter((t) => t.id !== id);
      requestRender();
      markAutoSavePending();
    }

    // ── coordinator ──
    function addCoordinator() {
      applicationData.customer.coordinator = {
        id:           uid("coord"),
        name:         "",
        mobile:       "",
        email:        "",
        relationship: "",
        assignedTo:   applicationData.deal.travellers.map((t) => t.id), // default: all
        authorised:   false
      };
      requestRender();
      markAutoSavePending();
    }

    function removeCoordinator() {
      applicationData.customer.coordinator = null;
      requestRender();
      markAutoSavePending();
    }

    function toggleCoordAssign(travellerId, checked) {
      const coord = applicationData.customer.coordinator;
      if (!coord) return;
      if (!coord.assignedTo) coord.assignedTo = [];
      if (checked) { if (!coord.assignedTo.includes(travellerId)) coord.assignedTo.push(travellerId); }
      else { coord.assignedTo = coord.assignedTo.filter((id) => id !== travellerId); }
      requestRender();
      markAutoSavePending();
    }

    function toggleCoordAuth(checked) {
      const coord = applicationData.customer.coordinator;
      if (!coord) return;
      coord.authorised = checked;
      requestRender();
      markAutoSavePending();
    }

    // ── services: goal / package / basket / addons ──
    function blockPaidServiceChange() {
  if (!isFullyPaidStatus(applicationData.payment.status)) {
    return false;
  }
  toast(
    "Payment is already complete. Services cannot be changed for this application."
  );

  return true;
}
function togglePackage(id) {
  if (blockPaidServiceChange()) return;

  const exists = applicationData.deal.selectedServices.includes(id);
      applicationData.deal.selectedServices = exists ? applicationData.deal.selectedServices.filter((s) => s !== id) : [...applicationData.deal.selectedServices, id];
      recalculatePayment();
      requestRender();
      markAutoSavePending();
    }

    // ─── GOAL TILE ACTIONS ────────────────────────────────────────────────────

    function getSelectedServiceTypeKey() {
      const direct = getGoalDefinition(applicationData.deal.serviceTypeKey || applicationData.deal.goal);
      if (direct) return direct.key;
      const firstBasketProduct = packageCatalog.find(product =>
        (applicationData.deal.serviceBasket || []).some(item => item.pkgId === product.id)
      );
      return firstBasketProduct
        ? (GOAL_DEFS.find(goal => goal.filter(firstBasketProduct))?.key || "")
        : "";
    }

    function setGoal(goalKey) {
      const goal = GOAL_DEFS.find(item => item.key === goalKey);
      if (!goal) return;
      const selectedGoalKey = getSelectedServiceTypeKey();
      const hasBasketServices = (applicationData.deal.serviceBasket || []).length > 0;
      const hasSelectedAddons = (applicationData.deal.selectedAddons || []).length > 0;
      if (selectedGoalKey && selectedGoalKey !== goalKey) {
        return fail("Deselect the current service type before choosing another one.");
      }
      if (selectedGoalKey === goalKey) {
        if ((hasBasketServices || hasSelectedAddons) && blockPaidServiceChange()) {
          return;
        }
        if (hasBasketServices || hasSelectedAddons) {
          applicationData.deal.serviceBasket = [];
          applicationData.deal.selectedServices = [];
          applicationData.deal.selectedAddons = [];
          recalculatePayment();
          toast(`${goal.label} and its unpaid basket items were removed.`);
        }
        applicationData.deal.serviceCountries = {};
        applicationData.deal.serviceTypeKey = "";
        applicationData.deal.goal = "";
        syncDestinationFromServiceCountries();
        state.activeGoal = null;
        state.pendingPackageId = null;
        state.pendingAssignedTo = [];
        markAutoSavePending();
        requestRender();
        return;
      }

      applicationData.deal.serviceCountries = {};
      applicationData.deal.serviceTypeKey = goalKey;
      applicationData.deal.goal = goal.label;
      syncDestinationFromServiceCountries();
      state.activeGoal = goalKey;
      getGoalCountrySelection(goalKey);
      state.pendingPackageId  = null;
      state.pendingAssignedTo = [];
      markAutoSavePending();
      requestRender();
    }

    function closeGoal() {
      state.activeGoal        = null;
      state.pendingPackageId  = null;
      state.pendingAssignedTo = [];
      requestRender();
    }

    function selectPendingPackage(id) {
      if (state.pendingPackageId === id) {
        // Deselect — clear
        state.pendingPackageId  = null;
        state.pendingAssignedTo = [];
      } else {
        state.pendingPackageId  = id;
        const activeGoal = GOAL_DEFS.find(goal => goal.key === state.activeGoal);
        // Country-based services reuse the single traveller ↔ country assignment.
        // Coaching has no destination, so it keeps the direct package picker.
        state.pendingAssignedTo = activeGoal?.countryMode === "none"
          ? applicationData.deal.travellers.map(t => t.id)
          : getAssignedTravellerIdsForGoal(state.activeGoal, id);
      }
      requestRender();
    }

    function toggleAssignTraveller(travellerId) {
      if (!state.pendingAssignedTo) state.pendingAssignedTo = [];
      const idx = state.pendingAssignedTo.indexOf(travellerId);
      if (idx >= 0) state.pendingAssignedTo.splice(idx, 1);
      else state.pendingAssignedTo.push(travellerId);
      requestRender();
    }

    function addPendingToBasket() {
      const pkg = packageCatalog.find(p => p.id === state.pendingPackageId);
      if (!pkg) return fail("Select a package first.");
      const assigned = state.pendingAssignedTo || [];
      const activeGoal = GOAL_DEFS.find(goal => goal.key === state.activeGoal);
      if (!assigned.length) {
        return fail(activeGoal?.countryMode === "none"
          ? "Select at least one traveller before adding this package."
          : "Assign at least one traveller to a selected destination before adding this package.");
      }
      if (!state.activeGoal || getSelectedServiceTypeKey() !== state.activeGoal) {
        return fail("Select one service type before adding product packages.");
      }

      if (!applicationData.deal.serviceBasket) applicationData.deal.serviceBasket = [];

      const travNames = assigned.map(id => {
        const t = applicationData.deal.travellers.find(t => t.id === id);
        return t ? `${t.firstName || ""} ${t.lastName || ""}`.trim() || t.type : id;
      }).join(", ");

      applicationData.deal.serviceBasket.push({
        id:         uid("bi"),
        pkgId:      pkg.id,
        name:       pkg.name,
        applicants: travNames,
        assignedTo: [...assigned],
        price:      pkg.price,
        total:      pkg.price * assigned.length,
        destinations: state.activeGoal ? getPackageDestinationCountries(state.activeGoal, pkg.id) : []
      });

      // Keep selectedServices in sync (for Deluge payload)
      if (!applicationData.deal.selectedServices.includes(pkg.id)) {
        applicationData.deal.selectedServices.push(pkg.id);
      }

      state.pendingPackageId  = null;
      state.pendingAssignedTo = [];

      syncDestinationFromServiceCountries();

      recalculatePayment();
      requestRender();
      markAutoSavePending();
      toast(`${pkg.name} added to basket ✓`);
    }

    function removeBasketItem(itemId) {
  if (blockPaidServiceChange()) return;
  if (!applicationData.deal.serviceBasket) return;
      const item = applicationData.deal.serviceBasket.find(i => i.id === itemId);
      applicationData.deal.serviceBasket = applicationData.deal.serviceBasket.filter(i => i.id !== itemId);
      // Remove from selectedServices if no other basket item uses the same pkg
      if (item) {
        const stillUsed = applicationData.deal.serviceBasket.some(i => i.pkgId === item.pkgId);
        if (!stillUsed) {
          applicationData.deal.selectedServices = applicationData.deal.selectedServices.filter(id => id !== item.pkgId);
        }
      }
      syncDestinationFromServiceCountries();
      recalculatePayment();
      requestRender();
      markAutoSavePending();
    }

    function toggleAddon(addonId) {
  if (blockPaidServiceChange()) return;
  if (!applicationData.deal.selectedAddons) applicationData.deal.selectedAddons = [];
      const idx = applicationData.deal.selectedAddons.indexOf(addonId);
      if (idx >= 0) applicationData.deal.selectedAddons.splice(idx, 1);
      else applicationData.deal.selectedAddons.push(addonId);
      // Keep selectedServices in sync
      if (idx >= 0) {
        applicationData.deal.selectedServices = applicationData.deal.selectedServices.filter(id => id !== addonId);
      } else {
        if (!applicationData.deal.selectedServices.includes(addonId)) applicationData.deal.selectedServices.push(addonId);
      }
      recalculatePayment();
      requestRender();
      markAutoSavePending();
    }

    // ── USA agreement addons ──
    function setUSAAddons(field, checked) {
      applicationData.deal[field] = checked;
      // Clear cached agreement HTML so it reloads with correct template
      applicationData.deal.agreementHtml = "";
      applicationData.deal.agreementTemplateName = "";
      markAutoSavePending();
      requestRender();
    }

    // ── ensure primary traveller / payment-confirmed / reset ──
    function ensurePrimaryTravellerFromCustomer() {
      const readField = (bind) => {
        const el = document.querySelector(`[data-bind="${bind}"]`);
        return el ? el.value.trim() : (getByPath(applicationData, bind) || "");
      };
      let primary = applicationData.deal.travellers.find((traveller) => traveller.type === "Primary Applicant");
      if (!primary) {
        primary = {
          id: uid("traveller"),
          familyId: DEFAULT_FAMILY_ID,
          type: "Primary Applicant",
          dob: "",
          relationship: "Self",
          nationality: "",
          countries: []
        };
        applicationData.deal.travellers.unshift(primary);
      }
      primary.firstName = primary.firstName || readField("customer.firstName");
      primary.lastName = primary.lastName || readField("customer.lastName");
      primary.email = primary.email || readField("customer.email");
      primary.mobile = primary.mobile || readField("customer.mobile");
      primary.nationality = primary.nationality || readField("customer.nationality") || "";
    }

    function isPaymentConfirmed() {
      return isFullyPaidStatus(applicationData.payment.status) && applicationData.stepStatus.dealCompleted;
    }

   // Reset to blank — clears localStorage and reloads a fresh application
    function resetDraft() {
  openConfirmModal("Reset Application?", "Reset and clear all saved data? This cannot be undone.", () => {
    try { localStorage.removeItem(CONFIG.localStorageKey); } catch(e) {}
    replaceApplicationData(blankApplication());
    state.dealSubStep = 1;
    state.activeCifCategory = null;
    state.activeCifTraveller = null;
      state.activeCifInstance = null;
      state.activeCifStage = null;
    state.cifAutofilledIds = new Set();
    state.cifSavedTravellerIds = new Set();
    state.cifSaving = null;
    showDashboard();
    toast("Draft cleared. Starting fresh.");
  });
}

export {
  getDestinationCountries, reconcileTravellerCountries, getGoalCountrySelection, getPackageDestinationCountries, getAssignedTravellerIdsForGoal,
  syncDestinationFromServiceCountries, toggleGoalCountry, applyTravellerCrmIds,
  toggleTravellerCountry, addTraveller, addFamilyGroup, removeTraveller, addCoordinator,
  removeCoordinator, toggleCoordAssign, toggleCoordAuth, blockPaidServiceChange,
  togglePackage, getSelectedServiceTypeKey, setGoal, closeGoal, selectPendingPackage, toggleAssignTraveller,
  addPendingToBasket, removeBasketItem, toggleAddon, setUSAAddons,
  ensurePrimaryTravellerFromCustomer, isPaymentConfirmed, resetDraft
};
