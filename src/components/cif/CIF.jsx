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
];

// Verbatim handleInput body (source 2179-2216), trimmed to the parts that apply
// to the CIF island's data-bind fields.
function cifHandleInput(event) {
  const field = event.target.closest("[data-bind]");
  if (!field) return;
  const isBirthDate = field.type === "date" && (
    field.dataset.birthDate === "true" || isBirthDateField(field.dataset.bind)
  );
  if (isBirthDate && field.value) {
    const birthDateError = validators.birthDate(field.value);
    validateFieldFormat(field);
    if (birthDateError) toast(birthDateError);
  }
  if (field.type === "tel") sanitizeMobileField(field);
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
