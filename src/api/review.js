// ─────────────────────────────────────────────────────────────────────────
// Review + Success — copied VERBATIM from the original widget. Both are
// innerHTML islands (renderReview → qs("#stepReview"), renderSuccess →
// qs("#stepSuccess")). reviewCard / getSectionProgress / declarationsComplete
// are the verbatim helpers they use.
//
// NOTE ON submitApplication: in the original source, submitApplication() is
// CALLED (handleClick "submit-application" and nextStep on step 5) but is NEVER
// DEFINED — a latent bug in the original (clicking Submit would throw a
// ReferenceError). To avoid changing behaviour by inventing a submit flow, it is
// preserved here as a no-op. Wire a real CRM submit here if/when the original
// intent is confirmed.
// ─────────────────────────────────────────────────────────────────────────
import { applicationData } from "../store/runtime.js";
import { qs } from "../lib/dom.js";
import { getByPath, escapeHtml, formatCurrency, formatDateTime } from "../lib/utils.js";
import { getCustomerName, getSelectedServiceNames } from "../core/derive.js";
import { cifDestinationInstances, cifInstanceData, cifIsInstanceSaved } from "../core/cif.js";

export async function submitApplication() {
  // Not implemented in the original source (see note above). No-op preserved.
  console.warn("[Winny] submitApplication() was never implemented in the original widget.");
}

    // ── reviewCard (source 14355-14363) ──
    function reviewCard(title, rows, editStep) {
      return `<article class="review-card">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:6px">
          <h3>${escapeHtml(title)}</h3>
          <button class="btn" type="button" data-action="edit-step" data-step="${editStep}">Edit</button>
        </div>
        ${rows.map(([key, value]) => `<div class="review-row"><span>${escapeHtml(key)}</span><strong>${escapeHtml(String(value || "Pending"))}</strong></div>`).join("")}
      </article>`;
    }

    // ── getSectionProgress (source 14365-14369) ──
    function getSectionProgress(fields) {
      const total  = fields.length || 1;
      const filled = fields.filter(([, path, type]) => type === "checkbox" ? Boolean(getByPath(applicationData, path)) : String(getByPath(applicationData, path) ?? "").trim()).length;
      return Math.round((filled / total) * 100);
    }

    // ── declarationsComplete (source 14394-14400) ──
    function declarationsComplete() {
      const travellers = applicationData.deal.travellers;
      const instances = cifDestinationInstances();
      return Boolean(travellers.length && instances.length && instances.every(instance =>
        travellers.every(traveller => cifIsInstanceSaved(traveller.id, instance.id))
      ));
    }

    // ── renderReview (source 7821-7849) ──
     function renderReview() {
      qs("#stepReview").innerHTML = `
        <div class="review-grid">
          ${reviewCard("Customer Information", [["Name",getCustomerName()],["Email",applicationData.customer.email],["Mobile",applicationData.customer.mobile],["Nationality",applicationData.customer.nationality]], 1)}
          ${reviewCard("Deal Information",     [["Deal",applicationData.deal.dealName||"Pending CRM creation"],["Destination",applicationData.deal.destination],["Services",getSelectedServiceNames()],["Travellers",applicationData.deal.travellers.length]], 1)}
          ${reviewCard("Payment Information",  [["Status",applicationData.payment.status],["Method",applicationData.payment.method],["Total",formatCurrency(applicationData.payment.grandTotal)],["Paid At",applicationData.payment.paidAt?formatDateTime(applicationData.payment.paidAt):""]], 1)}
          ${reviewCard("Questionnaire Summary",[["Purpose",applicationData.questionnaire.purpose],["Countries",applicationData.questionnaire.countriesText],["Funds",applicationData.questionnaire.fundsReady],["Refusal",applicationData.questionnaire.immigrationRefusal]], 2)}
          ${(() => {
            const primaryId = (applicationData.deal.travellers.find(t => t.type === "Primary Applicant") || applicationData.deal.travellers[0] || {}).id;
            const instances = cifDestinationInstances();
            const ukInstance = instances.find(instance => instance.type === "uk");
            const p1 = ukInstance ? ((cifInstanceData(primaryId, ukInstance.id).f1) || {}) : {};
            const totalCifs = instances.length * applicationData.deal.travellers.length;
            const savedCifs = instances.reduce((sum, instance) => sum + applicationData.deal.travellers.filter(t => cifIsInstanceSaved(t.id, instance.id)).length, 0);
            return reviewCard("CIF Summary", [
              ["Destination forms", `${savedCifs} of ${totalCifs} saved`],
              ["Passport", p1.Passport_number_or_travel_document_reference_number || "—"],
              ["Employment", p1.What_is_your_employment_status || "—"],
              ["City", (p1.Your_current_residence_address || {}).district_city || "—"],
              ["Declarations", declarationsComplete() ? "Complete" : "Pending"]
            ], 4);
          })()}
        </div>
        <div class="wizard-panel" style="margin-top:16px">
          <div class="panel-body" style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap">
            <button class="btn primary" type="button" data-action="submit-application">Submit Application</button>
          </div>
        </div>`;
    }

    // ── renderSuccess (source 7851-7864) ──
    function renderSuccess() {
      qs("#stepSuccess").innerHTML = `
        <section class="success-screen">
          <div class="success-icon">✓</div>
          <h2>Application Submitted</h2>
          <p>Your case has been submitted to the Winny Global case team. A case officer will review the file and contact the customer within 24 hours.</p>
          <div class="review-card" style="max-width:520px;margin:0 auto;text-align:left">
            <div class="review-row"><span>Application Number</span><strong>${escapeHtml(applicationData.applicationId || "Pending")}</strong></div>
            <div class="review-row"><span>Submitted</span><strong>${applicationData.stepStatus.submitted ? formatDateTime(applicationData.review.submittedAt) : "Pending"}</strong></div>
            <div class="review-row"><span>Next Step</span><strong>Case officer review</strong></div>
            <div class="review-row"><span>Contact</span><strong>support@winnyglobal.com</strong></div>
          </div>
        </section>`;
    }

export { renderReview, renderSuccess, reviewCard, getSectionProgress, declarationsComplete };
