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

  // Auto-sync once on mount if traveller CRM IDs are missing, or if the deal
  // has not yet been fully synced (applicationDetailsSynced not set — covers
  // deals loaded directly at the Terms step whose Payment_Amount is still 0).
  useEffect(() => {
    const anyMissingCrmId = (applicationData.deal.travellers || []).some(
      (t) => isAdultTraveller(t) && !t.crmId
    );
    const needsSync = anyMissingCrmId || !applicationData.crmSync.applicationDetailsSynced;
    if (needsSync && applicationData.deal.crmDealId
        && !applicationData.crmSync.applicationDetailsSyncInFlight) {
      applicationData.crmSync.applicationDetailsSyncInFlight = true;
      saveDealData({ syncOnly: true, silent: true })
        .then(() => {
          applicationData.crmSync.applicationDetailsSynced = true;
          requestRender();
        })
        .catch(() => {})
        .finally(() => { applicationData.crmSync.applicationDetailsSyncInFlight = false; });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-set the acceptor to the Primary Applicant for every requirement so the
  // "Choose adult acceptor" dropdown is not needed — every adult signs via OTP anyway.
  useEffect(() => {
    const reqs = getTermsRequirements();
    let changed = false;
    reqs.forEach((req) => {
      const record = getTermsAcceptance(req);
      if (!record.acceptorId && req.eligibleAdults.length > 0) {
        const primary = req.eligibleAdults.find((a) => a.type === "Primary Applicant") || req.eligibleAdults[0];
        setTermsAcceptor(req, primary.id);
        changed = true;
      }
    });
    for (const sf of getSignatureOnlyFamilies()) {
      const key = termsAcceptanceKey(sf.id, GENERIC_AGREEMENT_COUNTRY);
      const fakeReq = { key, familyId: sf.id, familyLabel: sf.label, country: GENERIC_AGREEMENT_COUNTRY };
      const record = getTermsAcceptance(fakeReq);
      if (!record.acceptorId) {
        const allT = applicationData.deal.travellers || [];
        const adults = allT.filter((t) => (t.familyId || "family-1") === sf.id && isAdultTraveller(t));
        const primary = adults.find((t) => t.type === "Primary Applicant") || adults[0];
        if (primary) { setTermsAcceptor(fakeReq, primary.id); changed = true; }
      }
    }
    if (changed) requestRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countriesKey]);

  // Restore termsAcceptances from agreementSigned when draft was lost after reload.
  // termsAcceptances lives only in localStorage; agreementSigned is saved to CRM.
  // If the primary applicant already signed (Step 4), Step 3 must have been complete too.
  useEffect(() => {
    const allTravellers = applicationData.deal.travellers || [];
    const reqs = getTermsRequirements();
    let changed = false;

    const autoRestore = (key, familyId, familyLabel, country) => {
      const existing = (applicationData.deal.termsAcceptances || {})[key] || {};
      if (existing.accepted) return;
      const primary = allTravellers.find(
        (t) => (t.familyId || "family-1") === familyId && t.type === "Primary Applicant"
      );
      if (!primary || !primary.agreementSigned) return;
      const fullName = `${primary.firstName || ""} ${primary.lastName || ""}`.trim();
      if (!applicationData.deal.termsAcceptances) applicationData.deal.termsAcceptances = {};
      applicationData.deal.termsAcceptances[key] = {
        ...existing,
        familyId, familyLabel, country,
        acceptorId: primary.id,
        acceptorName: fullName,
        signature: fullName,
        accepted: true,
        acceptedAt: primary.agreementSignedAt || new Date().toISOString(),
      };
      changed = true;
    };

    reqs.forEach((req) => autoRestore(req.key, req.familyId, req.familyLabel, req.country));
    for (const sf of getSignatureOnlyFamilies()) {
      autoRestore(termsAcceptanceKey(sf.id, GENERIC_AGREEMENT_COUNTRY), sf.id, sf.label, GENERIC_AGREEMENT_COUNTRY);
    }
    if (changed) requestRender();
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
          <p>Read each country agreement, sign, and each adult verifies via OTP.</p>
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
            <li><span>2</span><div><strong>Sign &amp; accept</strong><small>Type your name and confirm</small></div></li>
            <li><span>3</span><div><strong>OTP sign</strong><small>Each adult verifies via OTP</small></div></li>
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
          <span>Read and accept each country agreement (Steps 1–2), then every adult traveller in that family must individually sign via OTP (Step 3). Children/minors are excluded from OTP signing.</span>
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
                    ? (applicationData.deal.agreementHtml || "")
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
                            <div><strong>Full legal name (signature)</strong><small>Type your full name exactly as it appears on your ID.</small></div>
                          </div>
                          <label className="field" style={{ gridColumn: "1 / -1" }}>
                            <span>Full legal name (signature) <em>*</em></span>
                            <input
                              type="text"
                              value={record.signature || ""}
                              onChange={(event) => setTermsSignature(requirement, event.target.value)}
                              placeholder="Type your full legal name"
                            />
                          </label>

                          <label className={`check-row terms-accept-check${!String(record.signature || "").trim() ? " disabled" : ""}`}>
                            <input
                              type="checkbox"
                              checked={!!record.accepted}
                              disabled={!String(record.signature || "").trim()}
                              onChange={(event) => setTermsAccepted(requirement, event.target.checked)}
                            />
                            <span>
                              I, <strong>{record.acceptorName || "the primary applicant"}</strong>, have read and accept the <strong>{displayCountry} agreement</strong> for <strong>{family.label}</strong>.
                            </span>
                          </label>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>

              {(() => {
                const familyAdults = allTravellers.filter(
                  (t) => (t.familyId || "family-1") === family.id && isAdultTraveller(t)
                );
                if (!familyAdults.length) return null;

                const pendingRequirements = family.requirements.filter((req) => {
                  const rec = getTermsAcceptance(req);
                  return !(rec.acceptorId && rec.accepted && String(rec.signature || "").trim());
                });
                const allFamilyTermsComplete = pendingRequirements.length === 0;

                // Pass only this family's countries so each AgreementCard email
                // references only its own service, not the combined deal.
                const familyCountries = family.requirements
                  .filter((r) => !r._isGeneric)
                  .map((r) => r.country);

                return (
                  <div className="agreement-signing-section">
                    <div className="terms-action-heading agreement-signing-heading">
                      <span>Step 3</span>
                      <div>
                        <strong>Digital Agreement Signature</strong>
                        <small>
                          {familyAdults.length === 1
                            ? `${familyAdults[0].firstName || "The adult traveller"} verifies via OTP to digitally sign the agreement.`
                            : `Each adult traveller in ${family.label} must individually verify via OTP to digitally sign the agreement.`}
                        </small>
                      </div>
                    </div>
                    {!allFamilyTermsComplete ? (
                      <div className="notice amber agreement-otp-waiting">
                        {pendingRequirements.length === 1
                          ? `Complete Steps 1–2 for the ${pendingRequirements[0]._isGeneric ? "Service Agreement" : pendingRequirements[0].country} agreement above before signing.`
                          : `Complete Steps 1–2 for all country agreements first. Still pending: ${pendingRequirements.map((r) => r._isGeneric ? "Service Agreement" : r.country).join(", ")}.`}
                      </div>
                    ) : (
                      familyAdults.map((adult) => (
                        <AgreementCard
                          key={adult.id}
                          traveller={adult}
                          familyCountries={familyCountries}
                          travellerAgreementHtml={
                            // Primary applicant already sees their own name in Step 1's
                            // country agreement, so skip the duplicate preview here.
                            adult.type === "Primary Applicant"
                              ? ""
                              : (applicationData.deal.agreementHtmlByTraveller || {})[adult.id] || ""
                          }
                          onSigned={() => {
                            saveDraft(false);
                            saveDealData({ syncOnly: true, silent: true }).catch(() => {});
                            requestRender();
                          }}
                        />
                      ))
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
