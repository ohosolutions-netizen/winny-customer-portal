// Field validation — copied VERBATIM from the original widget.
// The pure pieces live here; the DOM-touching validateFieldFormat / mobile
// sanitize behaviour is applied in hooks/useBind.js against the same rules.

export function isBirthDateField(path) {
  return /date_of_birth|dob$/i.test(path || "");
}

export function classifyFieldValidation(path) {
  if (!path) return null;
  if (/email/i.test(path)) return "email";
  if (/phone|mobile|telephone/i.test(path)) return "phone";
  if (/passport_number/i.test(path)) return "passport";
  return null;
}

export const validators = {
  required(value) { return String(value ?? "").trim() ? "" : "Required"; },
  email(value)    { return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim()) ? "" : "Enter a valid email"; },
  phone(value)    { return !value || /^[+()\-\s0-9]{7,18}$/.test(String(value).trim()) ? "" : "Enter a valid phone number"; },
  passport(value) { return !value || /^[A-Z0-9]{6,12}$/i.test(String(value).trim()) ? "" : "Enter a valid passport number"; },
  date(value)     { return !value || !Number.isNaN(Date.parse(value)) ? "" : "Enter a valid date"; }
};
