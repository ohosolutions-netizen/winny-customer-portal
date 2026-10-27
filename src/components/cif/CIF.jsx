import React, { useEffect, useRef } from "react";
import * as CifMod from "../../core/cif.js";
import { renderCIF, closeAllCmsDropdowns } from "../../core/cif.js";
import { applicationData } from "../../store/runtime.js";
import { setByPath } from "../../lib/utils.js";
import { markAutoSavePending, toast } from "../../lib/ui.js";
import { isBirthDateField, validators } from "../../lib/validators.js";
import { sanitizeMobileField, validateFieldFormat } from "../../core/fieldFormat.js";
import { cifMarkInstanceDirtyFromPath } from "../../core/cif.js";

// CIF is a self-contained imperative island (see core/cif.js). renderCIF() writes
// into qs("#stepCIF"), so this component just provides that container and drives
// the lifecycle: expose the inline cif*/cms* handlers (+ renderCIF for the
// setTimeout(renderCIF,0) select triggers) on window, run renderCIF() on mount,
// and delegate data-bind input/blur exactly like the original global handleInput
// / handleFieldBlur (the CIF's raw inputs are not React-controlled).
const CIF_HANDLERS = [
  "cifSwitchTraveller", "cifSwitchInstance", "cifSwitchStage", "cifSwitchCategory",
  "cifSwitchGenericCategory", "cifGoToCategoryOffset", "cifSetYesNo", "cifToggleMulti",
  "cifSchengenToggleMulti", "cifAddSubformRow", "cifRemoveSubformRow", "cifGenericAddRow",
  "cifGenericRemoveRow", "cifRetryMetadata", "cifSaveTraveller",
  "cmsToggle", "cmsSelect", "cmsRemove", "cmsClear", "cmsFilter",
  "cifSwitchFamilyUnit",
];

// Tracks the last toast message shown to deduplicate rapid-fire identical toasts
// (browser date pickers fire multiple input+change events per edit).
let _lastBirthDateToast = "";
let _lastBirthDateToastTimer = null;

function cifHandleInput(event) {
  const field = event.target.closest("[data-bind]");
  if (!field) return;
  const isBirthDate = field.type === "date" && (
    field.dataset.birthDate === "true" || isBirthDateField(field.dataset.bind)
  );
  if (field.type === "date" && field.value) {
    // Reject any date whose year is not exactly four digits (browser allows typing
    // arbitrary-length years into <input type="date">).
    const yearMatch = /^(\d+)-/.exec(field.value);
    if (yearMatch && yearMatch[1].length !== 4) {
      field.value = "";
      validateFieldFormat(field);
      if (event.type === "change") toast("Enter a valid date with a four-digit year");
      setByPath(applicationData, field.dataset.bind, "");
      cifMarkInstanceDirtyFromPath(field.dataset.bind);
      markAutoSavePending();
      return;
    }
    const dateValidator = isBirthDate ? validators.birthDate : validators.date;
    const dateError = dateValidator(field.value);
    validateFieldFormat(field);
    if (dateError && event.type === "change" && dateError !== _lastBirthDateToast) {
      _lastBirthDateToast = dateError;
      clearTimeout(_lastBirthDateToastTimer);
      _lastBirthDateToastTimer = setTimeout(() => { _lastBirthDateToast = ""; }, 3000);
      toast(dateError);
    }
  }
  // Passport expiry inline warning (matches HTML v9 checkPassportExpiry logic)
  if (field.dataset.expiryWarn === "true" && field.type === "date") {
    const warnEl = field.parentElement && field.parentElement.querySelector(".pp-expiry-warn");
    if (warnEl) {
      if (!field.value) {
        warnEl.style.display = "none";
        field.style.borderColor = "";
      } else {
        const expiry = new Date(field.value);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const sixMonths = new Date(today);
        sixMonths.setMonth(sixMonths.getMonth() + 6);
        field.style.borderColor = "";
        if (expiry <= today) {
          field.style.borderColor = "var(--red, #e53935)";
          warnEl.className = "pp-expiry-warn error";
          warnEl.style.display = "flex";
          warnEl.innerHTML = '<span class="wi">🚫</span><span><strong>Passport has already expired.</strong> A valid passport is required to apply for a visa. Please renew before proceeding.</span>';
        } else if (expiry < sixMonths) {
          const daysLeft = Math.floor((expiry - today) / (1000 * 60 * 60 * 24));
          const months = Math.floor(daysLeft / 30);
          const days = daysLeft % 30;
          const remaining = months > 0
            ? months + " month" + (months > 1 ? "s" : "") + (days > 0 ? " " + days + " day" + (days > 1 ? "s" : "") : "")
            : days + " day" + (days > 1 ? "s" : "");
          field.style.borderColor = "var(--amber, #f59e0b)";
          warnEl.className = "pp-expiry-warn warn";
          warnEl.style.display = "flex";
          warnEl.innerHTML = `<span class="wi">⚠️</span><span><strong>Passport expires in ${remaining}.</strong> Most countries require at least 6 months validity beyond your travel dates. We strongly recommend renewing your passport before applying.</span>`;
        } else {
          warnEl.style.display = "none";
          field.style.borderColor = "var(--teal, #26c6da)";
        }
      }
    }
  }
  if (field.type === "tel") sanitizeMobileField(field);
  if (/\.U_S_Social_Security_Number$/.test(field.dataset.bind || "")) {
    const digits = field.value.replace(/\D/g, "").slice(0, 9);
    const formatted = digits.length > 5
      ? `${digits.slice(0,3)}-${digits.slice(3,5)}-${digits.slice(5)}`
      : digits.length > 3
      ? `${digits.slice(0,3)}-${digits.slice(3)}`
      : digits;
    if (formatted !== field.value) field.value = formatted;
  }
  setByPath(applicationData, field.dataset.bind, field.type === "checkbox" ? field.checked : field.value);
  cifMarkInstanceDirtyFromPath(field.dataset.bind);
  markAutoSavePending();
}

function cifHandleBlur(event) {
  const field = event.target.closest("[data-bind]");
  if (field) validateFieldFormat(field);
}

export default function CIF() {
  const ref = useRef(null);

  useEffect(() => {
    CIF_HANDLERS.forEach((n) => { window[n] = CifMod[n]; });
    window.renderCIF = renderCIF; // for cifSelectField trigger: onchange="setTimeout(renderCIF,0)"

    renderCIF();

    const el = ref.current;
    el.addEventListener("input", cifHandleInput);
    el.addEventListener("change", cifHandleInput);
    el.addEventListener("focusout", cifHandleBlur);

    const onScroll = (e) => closeAllCmsDropdowns(e);
    const onDocClick = (e) => { if (!e.target.closest(".cms-wrap")) closeAllCmsDropdowns(e); };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    document.addEventListener("click", onDocClick);

    return () => {
      el.removeEventListener("input", cifHandleInput);
      el.removeEventListener("change", cifHandleInput);
      el.removeEventListener("focusout", cifHandleBlur);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("click", onDocClick);
    };
  }, []);

  return <section id="stepCIF" className="wizard-step active" ref={ref} />;
}
