// DOM field-format helpers — copied VERBATIM from the original (source 2045-2072).
// Used by the CIF island's input/blur delegation for its raw data-bind inputs
// (the CIF renders innerHTML, so it relies on delegation exactly like the original,
// rather than React controlled inputs).
import { validators } from "../lib/validators.js";

function classifyFieldValidation(path) {
  if (!path) return null;
  if (/email/i.test(path)) return "email";
  if (/phone|mobile|telephone/i.test(path)) return "phone";
  if (/passport_number/i.test(path)) return "passport";
  return null;
}

export function sanitizeMobileField(field) {
  if (!/mobile/i.test(field.dataset.bind || "")) return;
  const digitsOnly = field.value.replace(/\D/g, "").slice(0, 10);
  if (digitsOnly !== field.value) field.value = digitsOnly;
}

export function validateFieldFormat(field) {
  const kind = classifyFieldValidation(field.dataset.bind);
  if (!kind) return;
  const msg = validators[kind](field.value);

  const cifWrap = field.closest(".cifx-field");
  const stdWrap = field.closest(".field");

  if (cifWrap) {
    cifWrap.classList.toggle("invalid", Boolean(msg) && Boolean(field.value));
    let err = cifWrap.querySelector(".cifx-err");
    if (!err) {
      err = document.createElement("small");
      err.className = "cifx-err";
      cifWrap.appendChild(err);
    }
    err.textContent = field.value ? msg : "";
  } else if (stdWrap) {
    stdWrap.classList.toggle("invalid", Boolean(msg) && Boolean(field.value));
    const err = stdWrap.querySelector(".error");
    if (err) err.textContent = field.value ? msg : "";
  }
}
