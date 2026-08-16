// ─────────────────────────────────────────────────────────────────────────
// Field binding — the React equivalent of the original's data-bind + global
// handleInput / handleFieldBlur delegation. commitField reproduces handleInput
// verbatim (DOB future-clamp, mobile digit-strip/10-cap, setByPath, CIF dirty
// mark, recalculatePayment, autosave). Because React preserves focus across a
// controlled re-render (unlike the original's innerHTML rebuild), we can
// requestRender on every change — this makes the live side-panels (country map,
// authorisation list, pricing) update exactly as the original intended.
//
// Blur validation mirrors validateFieldFormat: same classify + validators rules,
// same messages; errors are stored per-path and read by the Field components so
// the .invalid / .error markup matches.
// ─────────────────────────────────────────────────────────────────────────
import { applicationData } from "../store/runtime.js";
import { getByPath, setByPath } from "../lib/utils.js";
import { requestRender, markAutoSavePending, toast } from "../lib/ui.js";
import { isBirthDateField, classifyFieldValidation, validators } from "../lib/validators.js";
import { recalculatePayment } from "../core/derive.js";
import { cifMarkInstanceDirtyFromPath } from "../core/cif.js";

// path -> error message (empty string clears). Mutated by blurField, read by fields.
export const fieldErrors = {};

export function commitField(path, el) {
  const isCheckbox = el.type === "checkbox";

  if (el.type === "date" && isBirthDateField(path) && el.value) {
    const birthDateError = validators.birthDate(el.value);
    if (birthDateError) toast(birthDateError);
  }
  if (el.type === "tel" && /mobile/i.test(path)) {
    const digitsOnly = el.value.replace(/\D/g, "").slice(0, 10);
    if (digitsOnly !== el.value) el.value = digitsOnly;
  }

  setByPath(applicationData, path, isCheckbox ? el.checked : el.value);
  cifMarkInstanceDirtyFromPath(path);
  recalculatePayment();
  markAutoSavePending();
  requestRender();
}

export function blurField(path, el) {
  const kind = classifyFieldValidation(path);
  if (!kind) return;
  const msg = validators[kind](el.value);
  fieldErrors[path] = el.value ? msg : "";
  requestRender();
}

// Props for a controlled text/email/tel/date/number input bound to `path`.
export function bindInput(path) {
  return {
    "data-bind": path,
    value: getByPath(applicationData, path) ?? "",
    onChange: (e) => commitField(path, e.target),
    onBlur: (e) => blurField(path, e.target),
  };
}

// Props for a controlled checkbox bound to `path`.
export function bindCheckbox(path) {
  return {
    "data-bind": path,
    checked: Boolean(getByPath(applicationData, path)),
    onChange: (e) => commitField(path, e.target),
  };
}
