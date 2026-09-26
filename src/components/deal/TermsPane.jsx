import React, { useEffect } from "react";
import { applicationData } from "../../store/runtime.js";
import { formatCurrency } from "../../lib/utils.js";
import { requestRender } from "../../lib/ui.js";
import { setUSAAddons } from "../../core/deal.js";
import { saveDraft } from "../../core/drafts.js";
import {
  getTermsAcceptance,
  getTermsRequirements,
  setTermsAccepted,
  setTermsAcceptor,
  setTermsSignature,
  isAdultTraveller,
  getSignatureOnlyFamilies,
  GENERIC_AGREEMENT_COUNTRY,
  termsAcceptanceKey,
} from "../../core/terms.js";
import { fetchAgreement, saveDealData } from "../../api/deal.js";
import AgreementCard from "./AgreementCard.jsx";

function isUSACountry(country) {
  return /united states|^usa$|^us$/i.test(String(country || "").trim());
}

function agreementDetails(country, hasUSADate, hasPremium) {
  if (!isUSACountry(country)) {
    return { name: "Non USA Service Agreement..zdoc", label: `${country} Service Agreement` };
  }
  if (hasPremium && hasUSADate) {
    return { name: "USA SA - Premium Interview - Date Booking.zdoc", label: "USA Premium Interview + Date Booking Agreement" };
  }
  if (hasUSADate) {
    return { name: "USA Service Agreement- USA Date Booking.zdoc", label: "USA Service Agreement – Date Booking" };
  }
  return { name: "USA Visitor Visa Agreement_Non refundable.docx", label: "USA Visitor Visa Agreement (Non-Refundable)" };
}

function normalizeCountryKey(country) {
  const key = String(country || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (["us", "usa", "unitedstates", "unitedstatesofamerica"].includes(key)) return "unitedstates";
  if (["uk", "gb", "greatbritain", "unitedkingdom"].includes(key)) return "unitedkingdom";
  return key;
}

function agreementForCountry(agreementMap, country, requirementCount) {
  if (agreementMap[country]) return agreementMap[country];
  const wantedKey = normalizeCountryKey(country);
  const matchedKey = Object.keys(agreementMap).find((key) => normalizeCountryKey(key) === wantedKey);
  if (matchedKey) return agreementMap[matchedKey];
  if (requirementCount === 1) return applicationData.deal.agreementHtml || "";
  return "";
}

export default function TermsPane() {
  const requirements = getTermsRequirements();
  const agreementMap = applicationData.deal.agreementHtmlByCountry || {};
  const hasUSADate = !!applicationData.deal.usaDateBooking;
  const hasPremium = !!applicationData.deal.premiumVisaInterview;
  const hasUSA = requirements.some((requirement) => isUSACountry(requirement.country));
  const countriesKey = [...new Set(requirements.map((requirement) => requirement.country))].join("|");
  const completedCount = requirements.filter((requirement) => {
    const record = getTermsAcceptance(requirement);
    return record.acceptorId && record.accepted && String(record.signature || "").trim();
  }).length;

  useEffect(() => {
    const missingAgreement = requirements.some((requirement) =>
      !agreementForCountry(agreementMap, requirement.country, requirements.length)
    );
    if (missingAgreement || !applicationData.deal.agreementHtml) fetchAgreement();
    // Agreement generation is synchronous; dependencies refresh country and USA variants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countriesKey, hasUSADate, hasPremium]);

  // Auto-sync once on mount if any primary applicant is missing their CRM ID.
  // Fires a single saveDealData call so AgreementCards can show the sign button
  // without the user needing to click "Re-sync now" manually.
  useEffect(() => {
    const primaryApplicants = (applicationData.deal.travellers || []).filter(
      (t) => t.type === "Primary Applicant"
    );
    const anyMissingCrmId = primaryApplicants.some((t) => !t.crmId);
    if (anyMissingCrmId && applicationData.deal.crmDealId
        && !applicationData.crmSync.applicationDetailsSyncInFlight) {
      saveDealData({ syncOnly: true, silent: true })
        .then(() => requestRender())
        .catch(() => {}); // AgreementCard shows the manual Re-sync button on failure
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const families = [];
  requirements.forEach((requirement) => {
    let family = families.find((item) => item.id === requirement.familyId);
    if (!family) {
      family = { id: requirement.familyId, label: requirement.familyLabel, requirements: [] };
      families.push(family);
    }
    family.requirements.push(requirement);
  });

  // Also include families with a Primary Applicant but no country requirements.
  // Give them a synthetic "Service Agreement" requirement so Steps 1–3 are visible.
  const allTravellers = applicationData.deal.travellers || [];
  for (const sigFamily of getSignatureOnlyFamilies()) {
    const members = allTravellers.filter((t) => (t.familyId || "family-1") === sigFamily.id);
    const eligibleAdults = members
      .filter((t) => isAdultTraveller(t))
      .map((t) => ({ id: t.id, name: `${t.firstName || ""} ${t.lastName || ""}`.trim() || t.type, type: t.type }));
    families.push({
      id: sigFamily.id,
      label: sigFamily.label,
      requirements: [{
        key: termsAcceptanceKey(sigFamily.id, GENERIC_AGREEMENT_COUNTRY),
        familyId: sigFamily.id,
        familyLabel: sigFamily.label,
        country: GENERIC_AGREEMENT_COUNTRY,
        travellers: members,
        eligibleAdults,
        _isGeneric: true,
      }],
    });
  }

  return (
    <section className="wizard-panel terms-panel">
      <div className="panel-head">
        <div>
          <h3>Terms &amp; Conditions</h3>
          <p>Choose one adult to accept each country agreement for every family.</p>
        </div>
        <div className="terms-total">Total: {formatCurrency(applicationData.payment.grandTotal)}</div>
      </div>

      <div className="panel-body">
        <div className="terms-overview">
          <div className="terms-overview-copy">
            <span className="terms-overview-kicker">How to complete this page</span>
            <h4>Complete one agreement for each family and country</h4>
            <p>Follow the same three steps in every country card below.</p>
          </div>
          <div className="terms-overview-progress">
            <strong>{completedCount} of {requirements.length}</strong>
            <span>agreements completed</span>
          </div>
          <ol className="terms-instructions">
            <li><span>1</span><div><strong>Read</strong><small>Review the country agreement</small></div></li>
            <li><span>2</span><div><strong>Choose</strong><small>Select one eligible adult</small></div></li>
            <li><span>3</span><div><strong>Sign &amp; accept</strong><small>Type the name and confirm</small></div></li>
          </ol>
        </div>

        {hasUSA ? (
          <div className="terms-usa-options">
            <div className="notice blue">
              <strong>🇺🇸 USA Services</strong>
              <span>Select additional USA services included in the package. These determine the USA agreement version.</span>
            </div>
            <label className="check-row">
              <input type="checkbox" checked={hasUSADate} onChange={(event) => setUSAAddons("usaDateBooking", event.target.checked)} />
              <span><strong>USA Priority Date Booking</strong> — Visa appointment date booking service</span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={hasPremium} onChange={(event) => setUSAAddons("premiumVisaInterview", event.target.checked)} />
              <span><strong>Premium Visa Interview Training</strong> — Mock interview preparation sessions</span>
            </label>
          </div>
        ) : null}

        <div className="notice amber terms-intro">
          <strong>⚠️ Separate acceptance is required</strong>
          <span>Each family must nominate one adult for every country they are applying to. The selected adult's signature is saved against that family and country.</span>
        </div>

        {!requirements.length ? (
          <div className="terms-empty">
            <span aria-hidden="true">📄</span>
            <strong>No country agreements are ready yet</strong>
            <p>Return to Services and assign travellers to the selected countries first.</p>
          </div>
        ) : null}

        <div className="terms-families">
          {families.map((family) => (
            <section className="terms-family" key={family.id}>
              <div className="terms-family-head">
                <div>
                  <span>Family agreement group</span>
                  <h4>{family.label}</h4>
                </div>
                <span className="terms-family-count">
                  {family.requirements.every((r) => r._isGeneric)
                    ? "Service Agreement"
                    : `${family.requirements.length} ${family.requirements.length === 1 ? "country" : "countries"}`}
                </span>
              </div>

              <div className="terms-country-list">
                {family.requirements.map((requirement) => {
                  const record = getTermsAcceptance(requirement);
                  const isGeneric = !!requirement._isGeneric;
                  const document = isGeneric
                    ? { label: "Service Agreement" }
                    : agreementDetails(requirement.country, hasUSADate, hasPremium);
                  const agreementHtml = isGeneric
                    ? (() => {
                        const byCountry = applicationData.deal.agreementHtmlByCountry || {};
                        const firstKey = Object.keys(byCountry)[0];
                        return (firstKey && byCountry[firstKey]) || applicationData.deal.agreementHtml || "";
                      })()
                    : agreementForCountry(agreementMap, requirement.country, requirements.length);
                  const displayCountry = isGeneric ? "Service Agreement" : requirement.country;
                  const complete = !!(record.acceptorId && record.accepted && String(record.signature || "").trim());
                  const applicantNames = requirement.travellers
                    .map((traveller) => `${traveller.firstName || ""} ${traveller.lastName || ""}`.trim())
                    .filter(Boolean)
                    .join(", ");

                  return (
                    <article className={`terms-country-card${complete ? " is-complete" : ""}`} key={requirement.key}>
                      <div className="terms-country-head">
                        <div>
                          <span className="terms-country-kicker">{isGeneric ? "Service agreement" : "Country-specific agreement"}</span>
                          <h5>{displayCountry}</h5>
                          <small>{document.label}</small>
                          {applicantNames ? <small className="terms-applicants">Applicants: {applicantNames}</small> : null}
                        </div>
                        <span className={`terms-status ${complete ? "complete" : "pending"}`}>
                          {complete ? "✓ Accepted" : "Pending"}
                        </span>
                      </div>

                      <div className="terms-document">
                        <div className="terms-document-head">
                          <span><b>Step 1</b> Read {isGeneric ? "Service Agreement" : `${displayCountry} agreement`}</span>
                          <small>{agreementHtml ? "✓ Agreement loaded" : "Preparing agreement…"}</small>
                        </div>
                        {agreementHtml ? (
                          <>
                            <div className="terms-document-guidance">Read the agreement below. Scroll inside the document to review all terms before signing.</div>
                            <div className="terms-document-content" dangerouslySetInnerHTML={{ __html: agreementHtml }} />
                          </>
                        ) : (
                          <div className="terms-document-loading">
                            <span>📄</span>
                            <strong>The agreement could not be displayed yet.</strong>
                            <small>Please retry. Your selections and traveller information will not be changed.</small>
                            <button className="btn secondary" type="button" onClick={() => fetchAgreement()}>Retry loading agreement</button>
                          </div>
                        )}
                      </div>

                      {!requirement.eligibleAdults.length ? (
                        <div className="terms-no-adult">
                          This family has no eligible adult. Return to Travellers and add an adult family member before continuing.
                        </div>
                      ) : (
                        <div className="terms-acceptance-fields">
                          <div className="terms-action-heading">
                            <span>Step 2</span>
                            <div><strong>Choose the adult acceptor</strong><small>One adult accepts for this family and country.</small></div>
                          </div>
                          <label className="field">
                            <span>Adult terms acceptor <em>*</em></span>
                            <select value={record.acceptorId || ""} onChange={(event) => setTermsAcceptor(requirement, event.target.value)}>
                              <option value="">— Select one adult —</option>
                              {requirement.eligibleAdults.map((adult) => (
                                <option value={adult.id} key={adult.id}>{adult.name} — {adult.type}</option>
                              ))}
                            </select>
                            <small>An adult in {family.label} accepts this agreement for all family members{isGeneric ? "" : ` applying to ${requirement.country}`}.</small>
                          </label>

                          <label className="field">
                            <span><b>Step 3</b> Full legal name (signature) <em>*</em></span>
                            <input
                              type="text"
                              value={record.signature || ""}
                              onChange={(event) => setTermsSignature(requirement, event.target.value)}
                              placeholder="Type the selected adult's full legal name"
                              disabled={!record.acceptorId}
                            />
                          </label>

                          <label className={`check-row terms-accept-check${!record.acceptorId || !String(record.signature || "").trim() ? " disabled" : ""}`}>
                            <input
                              type="checkbox"
                              checked={!!record.accepted}
                              disabled={!record.acceptorId || !String(record.signature || "").trim()}
                              onChange={(event) => setTermsAccepted(requirement, event.target.checked)}
                            />
                            <span>
                              I, <strong>{record.acceptorName || "the selected adult"}</strong>, have read and accept the <strong>{displayCountry} agreement</strong> for <strong>{family.label}</strong>.
                            </span>
                          </label>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>

              {(() => {
                const primaryApplicant = applicationData.deal.travellers.find(
                  (t) => (t.familyId || "family-1") === family.id && t.type === "Primary Applicant"
                );
                if (!primaryApplicant) return null;

                const allFamilyTermsComplete = family.requirements.every((req) => {
                  const rec = getTermsAcceptance(req);
                  return rec.acceptorId && rec.accepted && String(rec.signature || "").trim();
                });

                return (
                  <div className="agreement-signing-section">
                    <div className="terms-action-heading agreement-signing-heading">
                      <span>Step 4</span>
                      <div>
                        <strong>Digital Agreement Signature</strong>
                        <small>
                          {primaryApplicant.firstName || "Primary applicant"} verifies via OTP to digitally sign the agreement
                          {family.requirements[0]?.travellers?.some((t) => t.type === "Child") || family.requirements[0]?.travellers?.some((t) => t.type === "Dependent")
                            ? " (covers all family members including minors)"
                            : ""}
                          .
                        </small>
                      </div>
                    </div>
                    {!allFamilyTermsComplete ? (
                      <div className="notice amber agreement-otp-waiting">
                        Complete the country agreement(s) above before the digital signature step.
                      </div>
                    ) : (
                      <AgreementCard
                        traveller={primaryApplicant}
                        onSigned={() => { saveDraft(false); requestRender(); }}
                      />
                    )}
                  </div>
                );
              })()}
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
