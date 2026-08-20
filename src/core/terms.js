import { applicationData } from "../store/runtime.js";
import { markAutoSavePending, requestRender } from "../lib/ui.js";

const DEFAULT_FAMILY_ID = "family-1";

export function termsAcceptanceKey(familyId, country) {
  return `${encodeURIComponent(familyId || DEFAULT_FAMILY_ID)}::${encodeURIComponent(country || "")}`;
}

function travellerName(traveller) {
  return `${traveller.firstName || ""} ${traveller.lastName || ""}`.trim() || "Unnamed traveller";
}

export function isAdultTraveller(traveller, today = new Date()) {
  if (!traveller || String(traveller.type || "").toLowerCase() === "child") return false;
  const dob = new Date(`${traveller.dob || ""}T00:00:00`);
  if (Number.isNaN(dob.getTime())) return false;
  let age = today.getFullYear() - dob.getFullYear();
  const birthdayPending = today.getMonth() < dob.getMonth()
    || (today.getMonth() === dob.getMonth() && today.getDate() < dob.getDate());
  if (birthdayPending) age -= 1;
  return age >= 18;
}

export function getTermsRequirements() {
  const families = [];
  const familyMap = new Map();

  (applicationData.deal.travellers || []).forEach((traveller) => {
    const familyId = traveller.familyId || DEFAULT_FAMILY_ID;
    let family = familyMap.get(familyId);
    if (!family) {
      family = { id: familyId, label: `Family ${families.length + 1}`, members: [] };
      families.push(family);
      familyMap.set(familyId, family);
    }
    family.members.push(traveller);
  });

  return families.flatMap((family) => {
    const countries = [];
    family.members.forEach((traveller) => {
      (traveller.countries || []).forEach((country) => {
        if (country && !countries.includes(country)) countries.push(country);
      });
    });

    return countries.map((country) => {
      const countryTravellers = family.members.filter((traveller) =>
        (traveller.countries || []).includes(country)
      );
      // One adult accepts on behalf of the family-country group. The adult
      // belongs to the family but does not need to be one of the applicants
      // travelling to that particular country (for example, a parent can
      // accept the agreement for a minor child).
      const eligibleAdults = family.members
        .filter((traveller) => isAdultTraveller(traveller))
        .map((traveller) => ({
          id: traveller.id,
          name: travellerName(traveller),
          type: traveller.type || "Adult Traveller"
        }));
      return {
        key: termsAcceptanceKey(family.id, country),
        familyId: family.id,
        familyLabel: family.label,
        country,
        travellers: countryTravellers,
        eligibleAdults
      };
    });
  });
}

export function getTermsAcceptance(requirement) {
  const records = applicationData.deal.termsAcceptances || {};
  return records[requirement.key] || {
    familyId: requirement.familyId,
    familyLabel: requirement.familyLabel,
    country: requirement.country,
    acceptorId: "",
    acceptorName: "",
    accepted: false,
    signature: "",
    acceptedAt: ""
  };
}

function ensureAcceptance(requirement) {
  if (!applicationData.deal.termsAcceptances) applicationData.deal.termsAcceptances = {};
  if (!applicationData.deal.termsAcceptances[requirement.key]) {
    applicationData.deal.termsAcceptances[requirement.key] = getTermsAcceptance(requirement);
  }
  return applicationData.deal.termsAcceptances[requirement.key];
}

export function syncLegacyTermsState() {
  const requirements = getTermsRequirements();
  const records = requirements.map(getTermsAcceptance);
  const complete = requirements.length > 0 && records.every((record) =>
    record.acceptorId && record.accepted && String(record.signature || "").trim()
  );
  applicationData.deal.termsAccepted = complete;
  applicationData.deal.signature = complete
    ? [...new Set(records.map((record) => String(record.signature || "").trim()).filter(Boolean))].join("; ")
    : "";
  return complete;
}

function commitTermsChange() {
  syncLegacyTermsState();
  markAutoSavePending();
  requestRender();
}

export function setTermsAcceptor(requirement, acceptorId) {
  const record = ensureAcceptance(requirement);
  const adult = requirement.eligibleAdults.find((item) => item.id === acceptorId);
  record.acceptorId = adult?.id || "";
  record.acceptorName = adult?.name || "";
  record.accepted = false;
  record.signature = "";
  record.acceptedAt = "";
  commitTermsChange();
}

export function setTermsSignature(requirement, signature) {
  const record = ensureAcceptance(requirement);
  record.signature = signature;
  if (!String(signature || "").trim()) record.acceptedAt = "";
  commitTermsChange();
}

export function setTermsAccepted(requirement, accepted) {
  const record = ensureAcceptance(requirement);
  record.accepted = !!accepted;
  record.acceptedAt = accepted ? new Date().toISOString() : "";
  commitTermsChange();
}

export function validateTermsAcceptances() {
  const requirements = getTermsRequirements();
  if (!requirements.length) return "Assign at least one traveller to each selected country before accepting the terms.";

  for (const requirement of requirements) {
    if (!requirement.eligibleAdults.length) {
      return `${requirement.familyLabel} needs an adult family member before its ${requirement.country} agreement can be accepted.`;
    }
    const record = getTermsAcceptance(requirement);
    if (!record.acceptorId) return `Select an adult terms acceptor for ${requirement.familyLabel} — ${requirement.country}.`;
    if (!String(record.signature || "").trim()) return `Enter the signature for ${requirement.familyLabel} — ${requirement.country}.`;
    if (!record.accepted) return `Accept the ${requirement.country} agreement for ${requirement.familyLabel}.`;
  }
  syncLegacyTermsState();
  return "";
}
