// Field validation — copied VERBATIM from the original widget.
// The pure pieces live here; the DOM-touching validateFieldFormat / mobile
// sanitize behaviour is applied in hooks/useBind.js against the same rules.

export function isBirthDateField(path) {
  return /date[\s_.-]*of[\s_.-]*birth|birth[\s_.-]*date|dob(?:$|[\s_.\[-])/i.test(path || "");
}

export const MIN_BIRTH_YEAR = 1900;

export function birthDateInputBounds() {
  const today = new Date();
  const max = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return { min: `${MIN_BIRTH_YEAR}-01-01`, max };
}

export function classifyFieldValidation(path) {
  if (!path) return null;
  if (isBirthDateField(path)) return "birthDate";
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
  date(value)     { return !value || !Number.isNaN(Date.parse(value)) ? "" : "Enter a valid date"; },
  birthDate(value) {
    if (!value) return "";
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
    if (!match) return "Enter a valid date of birth with a four-digit year";
    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    if (year < MIN_BIRTH_YEAR) return `Date of birth must be from ${MIN_BIRTH_YEAR} onwards`;
    const birthDate = new Date(year, month - 1, day);
    if (
      Number.isNaN(birthDate.getTime()) ||
      birthDate.getFullYear() !== year ||
      birthDate.getMonth() !== month - 1 ||
      birthDate.getDate() !== day
    ) return "Enter a valid date of birth";
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return birthDate < today ? "" : "Date of birth cannot be today or a future date";
  }
};
