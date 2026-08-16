import React, { useEffect } from "react";
import { applicationData } from "../../store/runtime.js";
import { formatCurrency } from "../../lib/utils.js";
import { setUSAAddons } from "../../core/deal.js";
import { fetchAgreement } from "../../api/deal.js";
import { bindCheckbox } from "../../hooks/useBind.js";
import { Field } from "../fields/Field.jsx";

// Reproduces renderDealPane() sub-step 3 (source 2624-2717) + renderDeal's
// auto-load of the agreement when the Terms page opens (source 2534-2544).
export default function TermsPane() {
  const dest = (applicationData.deal.destination || "").toLowerCase();
  const isUSA = dest.includes("united states") || dest.includes("usa") || dest.includes("us,") || dest === "us";
  const hasUSADate = applicationData.deal.usaDateBooking;
  const hasPremium = applicationData.deal.premiumVisaInterview;
  let templateName = "";
  let templateLabel = "";
  if (isUSA && hasPremium && hasUSADate) { templateName = "USA SA - Premium Interview - Date Booking.zdoc"; templateLabel = "USA Premium Interview + Date Booking Agreement"; }
  else if (isUSA && hasUSADate) { templateName = "USA Service Agreement- USA Date Booking.zdoc"; templateLabel = "USA Service Agreement – Date Booking"; }
  else if (isUSA) { templateName = "USA Visitor Visa Agreement_Non refundable.docx"; templateLabel = "USA Visitor Visa Agreement (Non-Refundable)"; }
  else { templateName = "Non USA Service Agreement..zdoc"; templateLabel = "Service Agreement"; }
  applicationData.deal.agreementTemplateName = templateName;

  const agHtml = applicationData.deal.agreementHtml || "";
  const agLoaded = agHtml.length > 0;

  useEffect(() => {
    if (!applicationData.deal.agreementHtml) fetchAgreement();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="wizard-panel">
      <div className="panel-head">
        <div><h3>Terms &amp; Conditions</h3><p>Read the agreement below, then sign and accept to continue.</p></div>
        <div style={{ textAlign: "right", fontSize: 13, fontWeight: 900, color: "var(--navy)" }}>Total: {formatCurrency(applicationData.payment.grandTotal)}</div>
      </div>
      <div className="panel-body">
        {isUSA ? (
          <>
            <div className="notice blue" style={{ marginBottom: 14 }}>
              <strong>🇺🇸 USA Services</strong>
              <span>Select any additional USA services included in your package — this determines the correct agreement document.</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
              <label className="check-row" style={{ cursor: "pointer" }}>
                <input type="checkbox" id="chk-usa-date-booking" checked={!!hasUSADate} onChange={(e) => setUSAAddons("usaDateBooking", e.target.checked)} />
                <span><strong>USA Priority Date Booking</strong> — Visa appointment date booking service</span>
              </label>
              <label className="check-row" style={{ cursor: "pointer" }}>
                <input type="checkbox" id="chk-premium-interview" checked={!!hasPremium} onChange={(e) => setUSAAddons("premiumVisaInterview", e.target.checked)} />
                <span><strong>Premium Visa Interview Training</strong> — Mock interview preparation sessions</span>
              </label>
            </div>
          </>
        ) : null}

        <div style={{ border: "1.5px solid var(--line)", borderRadius: 14, overflow: "hidden", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", background: "#fafbff", borderBottom: "1px solid var(--line)" }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 900, color: "var(--navy)" }}>📜 {templateLabel}</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>Template: {templateName}</div>
            </div>
          </div>
          {agLoaded ? (
            <div id="agreement-content" style={{ maxHeight: 480, overflowY: "auto", padding: "24px 28px", background: "#fff", fontSize: 13.5, lineHeight: 1.75, color: "var(--ink)" }} dangerouslySetInnerHTML={{ __html: agHtml }} />
          ) : (
            <div id="agreement-content" style={{ minHeight: 180, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 32, background: "#fafbff", color: "var(--muted)", textAlign: "center" }}>
              <div style={{ fontSize: 32 }}>📄</div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Loading your agreement...</div>
              <div style={{ fontSize: 12 }}>The agreement is being personalised with your application details</div>
            </div>
          )}
        </div>

        <div className="notice amber" style={{ marginBottom: 14 }}>
          <strong>⚠️ Important</strong>
          <span>By accepting below, you confirm you have read and understood the full agreement above. This covers selected services, listed travellers, pricing, refund terms, and document responsibilities.</span>
        </div>
        <label className="check-row" style={{ marginBottom: 14 }}>
          <input type="checkbox" {...bindCheckbox("deal.termsAccepted")} />
          <span>I have read and accept the <strong>{templateLabel}</strong> and all Winny Global service terms for this application.</span>
        </label>
        <div className="form-grid" style={{ marginTop: 4 }}>
          <Field label="Type Full Legal Name (Signature)" path="deal.signature" type="text" placeholder="e.g. Rohit Sharma" required />
        </div>
      </div>
    </section>
  );
}
