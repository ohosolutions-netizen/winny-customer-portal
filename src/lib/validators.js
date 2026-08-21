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
  if (/postal|zip|pincode|pin.?code/i.test(path)) return "postal";
  // Passport / document issue date — must be in the past
  if (/passport_issue_date|date_of_issue|issue_date_passport/i.test(path)) return "pastDate";
  // Passport / document expiry date — must be in the future
  if (/passport_expiry_date|date_of_expiry|expiration_date|expiry_date/i.test(path)) return "expiryDate";
  // Previous visit dates — must be in the past
  if (/most_recent_visit|second_recent_visit|visit_start_date|visit_end_date|date_you_arrived_in_the_uk/i.test(path)) return "pastDate";
  return null;
}

export const validators = {
  required(value) { return String(value ?? "").trim() ? "" : "Required"; },
  email(value)    { return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim()) ? "" : "Enter a valid email"; },
  phone(value)    { return !value || /^[+()\-\s0-9]{7,18}$/.test(String(value).trim()) ? "" : "Enter a valid phone number (digits, +, spaces, hyphens only — no letters)"; },
  passport(value) { return !value || /^[A-Z0-9]{6,12}$/i.test(String(value).trim()) ? "" : "Enter a valid passport number"; },
  postal(value)   {
    if (!value) return "";
    const trimmed = String(value).trim();
    // Allow only letters, digits, spaces, hyphens — all real postal code formats (India, UK, US, EU, AU).
    // Reject special characters (@, !, #, etc.) and lengths outside 2–12 chars.
    return /^[A-Z0-9][A-Z0-9 -]{1,11}$/i.test(trimmed)
      ? ""
      : "Enter a valid postal / ZIP code (letters, digits, spaces and hyphens only)";
  },
  date(value)     {
    if (!value) return "";
    const d = new Date(`${value}T00:00:00`);
    if (Number.isNaN(d.getTime())) return "Enter a valid date";
    const yr = d.getFullYear();
    if (yr < 1900 || yr > 2100) return "Enter a valid date";
    return "";
  },
  pastDate(value) {
    if (!value) return "";
    const d = new Date(`${value}T00:00:00`);
    if (Number.isNaN(d.getTime())) return "Enter a valid date";
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return d < today ? "" : "This date must be in the past";
  },
  expiryDate(value) {
    if (!value) return "";
    const d = new Date(`${value}T00:00:00`);
    if (Number.isNaN(d.getTime())) return "Enter a valid date";
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return d > today ? "" : "Passport expiry date must be in the future (passport has expired)";
  },
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
