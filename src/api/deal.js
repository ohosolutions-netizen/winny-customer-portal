// ─────────────────────────────────────────────────────────────────────────
// Deal step — async CRM save / agreement / Zoho Payments, copied VERBATIM.
// EXACT endpoints preserved: submitPortalCrmRequest("Save Deal" / "Payment
// Complete" / "Sync Application Details"), Zoho Payments paymentsRest, and the
// ZPayments checkout widget flow. Mechanical changes only:
//   • renderDeal()/renderDashboard() → requestRender()
//   • showPaymentConfirmedScreen()/goToQuestionnaire() use a state.payConfirmed
//     flag instead of #payConfirmedScreen innerHTML (component renders the card).
// ─────────────────────────────────────────────────────────────────────────
import { CONFIG, packageCatalog } from "../config/config.js";
import { applicationData, state } from "../store/runtime.js";
import { getByPath, escapeHtml, formatCurrency, makeApplicationId, uid } from "../lib/utils.js";
import { validators } from "../lib/validators.js";
import { toast, showLoader, hideLoader, openModal, requestRender, fail, markAutoSavePending } from "../lib/ui.js";
import {
  isDealSaved, getPayableAmount, getPaymentStatusAfterSuccess, isFullyPaidStatus,
  getCustomerName, getSelectedServiceNames, syncPaymentBreakdown, getPaymentMode
} from "../core/derive.js";
import { ensurePrimaryTravellerFromCustomer, applyTravellerCrmIds } from "../core/deal.js";
import { isAdultTraveller, validateTermsAcceptances } from "../core/terms.js";
import { saveDraft } from "../core/drafts.js";
import { showWizard, showStep } from "../core/navigation.js";
import { submitPortalCrmRequest, pollCreatorRecord, findTravellersForDeal, reconcileTravellerCrmRows } from "./portal.js";
import { paymentsRest } from "./zoho.js";

let zPayInstance = null;

    // ── deal sub-step navigation + validation ──
    async function goDealSubStep(step) {
  if (step > 1 && !isDealSaved()) {
    toast("Save the Deal first, then continue.");
    return;
  }

  if (
    step > state.dealSubStep &&
    !validateDealSubStep(state.dealSubStep)
  ) {
    return;
  }

  const targetStep = Math.max(1, Math.min(step, 4));

  /*
   * Save travellers and selected services when leaving Services.
   * The second condition supports older drafts that may already be
   * on the Terms step without having been synchronized.
   */
  const shouldSyncApplicationDetails =
    (targetStep === 3 && state.dealSubStep < 3) ||
    (
      targetStep === 4 &&
      state.dealSubStep < 4 &&
      !applicationData.crmSync.applicationDetailsSynced
    );

  if (shouldSyncApplicationDetails) {
    showLoader("Saving travellers and services to CRM...");

    try {
      await saveDealData({
        syncOnly: true
      });

      applicationData.crmSync.applicationDetailsSynced = true;
      applicationData.crmSync.lastError = "";
    } catch (error) {
      applicationData.crmSync.applicationDetailsSynced = false;
      applicationData.crmSync.lastError =
        error.message ||
        "Application detail synchronization failed.";

      saveDraft(false);

      toast(
        `Could not save travellers and services: ` +
        applicationData.crmSync.lastError
      );

      return;
    } finally {
      hideLoader();
    }
  }

  state.dealSubStep = targetStep;
      requestRender();
  saveDraft(false);
}

    function validateDealSubStep(step) {
      if (step === 1) {
        const required = [["customer.firstName","First name is required."],["customer.lastName","Last name is required."],["customer.email","Email is required."],["customer.mobile","Mobile is required."]];
        const missing  = required.find(([path]) => validators.required(getByPath(applicationData, path)));
        if (missing) return fail(missing[1]);
        if (validators.email(applicationData.customer.email)) return fail(validators.email(applicationData.customer.email));
        if (!isDealSaved()) return fail("Save the Deal first.");
        if (!applicationData.deal.travellers.every((t) => t.firstName && t.lastName)) return fail("Complete first and last name for every traveller.");
        if (!applicationData.deal.travellers.every((t) => String(t.dob || "").trim())) return fail("Enter the date of birth for every traveller.");
        const invalidTravellerBirthDate = applicationData.deal.travellers.find((t) => validators.birthDate(t.dob));
        if (invalidTravellerBirthDate) return fail(`Every traveller needs a valid date of birth from 1900 that is earlier than today. ${validators.birthDate(invalidTravellerBirthDate.dob)}`);
        if (!applicationData.deal.travellers.every((t) => String(t.mobile || "").trim())) return fail("Enter the mobile number for every traveller.");
        const invalidTravellerMobile = applicationData.deal.travellers.find((t) => validators.phone(t.mobile));
        if (invalidTravellerMobile) return fail("Enter a valid mobile number for every traveller.");
        const families = new Map();
        applicationData.deal.travellers.forEach((traveller) => {
          const familyId = traveller.familyId || "family-1";
          if (!families.has(familyId)) families.set(familyId, []);
          families.get(familyId).push(traveller);
        });
        const familyPrimaryTravellers = [];
        for (const [familyId, members] of families) {
          const primaryApplicants = members.filter((traveller) => traveller.type === "Primary Applicant");
          if (primaryApplicants.length !== 1) return fail(`${familyId === "family-1" ? "Family 1" : "Each family"} must have exactly one Primary Applicant.`);
          if (!isAdultTraveller(primaryApplicants[0])) return fail("A Primary Applicant must be at least 18 years old.");
          familyPrimaryTravellers.push(primaryApplicants[0]);
        }
        if (!familyPrimaryTravellers.every((traveller) => String(traveller.email || "").trim())) return fail("Enter the primary applicant email for every family.");
        if (familyPrimaryTravellers.some((traveller) => validators.email(traveller.email))) return fail("Enter a valid primary applicant email for every family.");
      }
      if (step === 2) {
        const hasBasket = (applicationData.deal.serviceBasket || []).length > 0 || (applicationData.deal.selectedAddons || []).length > 0;
        if (!hasBasket) return fail("Add at least one service to your basket before continuing.");
      }
      if (step === 3) {
        const termsError = validateTermsAcceptances();
        if (termsError) return fail(termsError);
      }
      return true;
    }

    // ── Zoho Payments widget ──
   async function openZPayWidget() {
      if (!validateDealSubStep(1) || !validateDealSubStep(2) || !validateDealSubStep(3)) return;

      if (!CONFIG.paymentsApiKey || !CONFIG.paymentsAccountId) {
        openModal(
          "Zoho Payments Setup Required",
          "Please set CONFIG.paymentsApiKey and CONFIG.paymentsAccountId in the widget config."
        );
        return;
      }

      showLoader("Creating payment session...");
      try {
        applicationData.applicationId = applicationData.applicationId || makeApplicationId();
        applicationData.deal.dealName = `${getCustomerName()} - ${getSelectedServiceNames() || "Application"}`;
        const payableAmount = getPayableAmount();
        if (payableAmount <= 0) return fail("Enter a valid payment amount.");


        // ── Create Payment Session via Deluge, then open ZPayments widget ────
        // payments_session_id is MANDATORY for requestPaymentMethod()
        // Deluge creates session server-side using API key in Authorization header
        console.log("[Winny] Creating payment session via Deluge bridge");

        const creatorRecordId = await submitPortalCrmRequest("Create Payment Session");
        if (!creatorRecordId) throw new Error("Failed to submit payment session request.");

        showLoader("Processing payment session...");
        const result = await pollCreatorRecord(creatorRecordId, 15, 2000);

        if (result.Status === "Failed") {
          throw new Error(result.Error_Message || "Deluge failed to create payment session.");
        }

        const sessionId = (result.CRM_Response || "").toString().trim();
        if (!sessionId) {
          throw new Error(result.Error_Message || "No payment session ID returned from Deluge.");
        }

        console.log("[Winny] Payment session ID:", sessionId);
        hideLoader();

        // Initialise ZPayments instance
        const zpConfig = {
          account_id:   CONFIG.paymentsAccountId,
          domain:       "IN",
          otherOptions: { api_key: CONFIG.paymentsApiKey }
        };
        zPayInstance = new window.ZPayments(zpConfig);

        const phone = applicationData.customer.mobile
          ? (applicationData.customer.mobile.startsWith("+")
              ? applicationData.customer.mobile
              : "+91" + applicationData.customer.mobile)
          : "";

        const payNowAmount = String(payableAmount);

        const options = {
          amount:              payNowAmount,
          currency_code:       "INR",
          currency_symbol:     "₹",
          payments_session_id: sessionId,
          description:         (applicationData.deal.dealName || "Winny Global Application").slice(0, 200),
          business:            "Winny Global",
          reference_number:    applicationData.applicationId || "",
          invoice_number:      applicationData.applicationId || "",
          address: {
            name:  getCustomerName(),
            email: applicationData.customer.email || "",
            phone: phone
          }
        };

        console.log("[Winny] Opening ZPayments widget:", JSON.stringify(options));
        const payResponse = await zPayInstance.requestPaymentMethod(options);

        // Payment successful
        console.log("[Winny] ZPayments response:", payResponse);
        applicationData.payment.paymentId  = payResponse.payment_id  || "";
        applicationData.payment.signature  = payResponse.signature   || "";
        applicationData.payment.paidAmount = (Number(applicationData.payment.paidAmount) || 0) + payableAmount;
        applicationData.payment.status     = getPaymentStatusAfterSuccess();
        applicationData.payment.method     = "Zoho Payments";
        applicationData.payment.paidAt     = new Date().toISOString();

        // Sync to CRM
        await saveDealData({ includeTravellers: true });
        applicationData.stepStatus.dealCompleted = isFullyPaidStatus(applicationData.payment.status);
        saveDraft(false);

        if (isFullyPaidStatus(applicationData.payment.status)) {
          showPaymentConfirmedScreen();
        } else {
          toast("Partial payment saved. Questionnaire will unlock once the CRM payment status is Paid.");
      requestRender();
        }


      } catch (err) {
        if (err?.code === "widget_closed") {
          toast("Payment cancelled — the window was closed.");
        } else {
          console.error("[Winny] ZPayments error:", err);
          toast(`Payment failed: ${err.message || "Please try again."}`);
        }
      } finally {
        if (zPayInstance) { try { await zPayInstance.close(); } catch(e) {} }
        hideLoader();
      }
    }

    // showPaymentConfirmedScreen()/goToQuestionnaire() — the original wrote the
    // confirmation card into #payConfirmedScreen and toggled its display. Here a
    // state flag drives the PayConfirmedScreen component (same behaviour/markup).
    function showPaymentConfirmedScreen() {
      state.payConfirmed = true;
      requestRender();
      window.scrollTo(0, 0);
    }

    function goToQuestionnaire() {
      state.payConfirmed = false;
      applicationData.currentStep = 2;
      showWizard();
      showStep(2);
    }

    // ── agreement HTML builder ──
    function fetchAgreement() {
      const c   = applicationData.customer;
      const d   = applicationData.deal;
      const p   = applicationData.payment;
      const appId = applicationData.applicationId || "—";

      const today = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });
      const fullName    = `${c.firstName || ""} ${c.lastName || ""}`.trim() || "Client";
      const street      = c.mailingStreet  || "—";
      const city        = c.mailingCity    || "—";
      const state       = c.mailingState   || "—";
      const zip         = c.mailingZip     || "—";
      const country     = c.mailingCountry || "India";
      const email       = c.email          || "—";
      const mobile      = c.mobile         || "—";
      const amount      = formatCurrency(p.grandTotal || 0);
      const serviceName = d.serviceNames || getSelectedServiceNames() || "Visitor Visa";
      const destination = d.destination  || "—";

      function numToWords(n) {
        const ones = ["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"];
        const tens = ["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
        if (n === 0) return "Zero";
        if (n < 20) return ones[n];
        if (n < 100) return tens[Math.floor(n/10)] + (n%10 ? " " + ones[n%10] : "");
        if (n < 1000) return ones[Math.floor(n/100)] + " Hundred" + (n%100 ? " " + numToWords(n%100) : "");
        if (n < 100000) return numToWords(Math.floor(n/1000)) + " Thousand" + (n%1000 ? " " + numToWords(n%1000) : "");
        if (n < 10000000) return numToWords(Math.floor(n/100000)) + " Lakh" + (n%100000 ? " " + numToWords(n%100000) : "");
        return numToWords(Math.floor(n/10000000)) + " Crore" + (n%10000000 ? " " + numToWords(n%10000000) : "");
      }
      const amountWords = numToWords(Math.round(p.grandTotal || 0)) + " Rupees Only";

      // Shared header builder
      function agrHeader(partyLabel) {
        return `<div style="font-family:Georgia,serif;font-size:13px;line-height:1.9;color:#111;max-width:100%">
<div style="text-align:center;margin-bottom:16px">
  <div style="font-size:15px;font-weight:700;letter-spacing:1px;text-transform:uppercase">Service Agreement</div>
</div>
<p style="margin:0 0 10px">This service agreement is made this day of <strong>${today}</strong> between<br>
<strong>Winny Immigration and Education Services Ltd.</strong><br>
103-104 ATP Arcade, Nr. National Handloom, Law Garden,<br>
Ahmedabad 380006, Gujarat, India<br>
<em>(Hereafter referred to as ${partyLabel})</em></p>
<p style="margin:0 0 10px"><strong>And,</strong></p>
<p style="margin:0 0 6px"><strong>Mr./Ms. ${escapeHtml(fullName)}</strong> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; APP ID: <strong>${escapeHtml(appId)}</strong><br>
Address: ${escapeHtml(street)}, ${escapeHtml(city)}, ${escapeHtml(state)}, ${escapeHtml(zip)}, ${escapeHtml(country)}<br>
Email: ${escapeHtml(email)} &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; (M): ${escapeHtml(mobile)}<br>
<em>(Hereafter referred as the Client)</em></p>
<hr style="border:0;border-top:1px solid #999;margin:14px 0">`;
      }

      function sigBlock() {
        return `<div style="display:flex;gap:40px;margin:12px 0 18px;font-size:12px">
<div>Client's Signature: _______________________</div>
<div>Spouse's Signature: _______________________</div>
</div>`;
      }

      function annexureA(partyLabel) {
        return `<hr style="border:0;border-top:2px solid #333;margin:22px 0 14px">
<div style="text-align:center;font-size:14px;font-weight:700;margin-bottom:12px">VISITOR VISA — ANNEXURE A</div>
<p style="margin:0 0 10px"><strong>Client Name:</strong> ${escapeHtml(fullName)}</p>
<table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:16px">
  <tr style="background:#f4f4f4"><th style="border:1px solid #ccc;padding:8px 10px;text-align:left;width:35%">Matter and scope of services</th><td style="border:1px solid #ccc;padding:8px 10px">Provide assistance in visitor visa application — <strong>${escapeHtml(serviceName)}</strong></td></tr>
  <tr><th style="border:1px solid #ccc;padding:8px 10px;text-align:left">Billing Method</th><td style="border:1px solid #ccc;padding:8px 10px">Flat fee – Single payment</td></tr>
  <tr style="background:#f4f4f4"><th style="border:1px solid #ccc;padding:8px 10px;text-align:left">Professional Fees</th><td style="border:1px solid #ccc;padding:8px 10px"><strong>${amount}</strong> (${escapeHtml(amountWords)}) + GST (as applicable) due upon signing the Service Agreement</td></tr>
  <tr><th style="border:1px solid #ccc;padding:8px 10px;text-align:left">Condition</th><td style="border:1px solid #ccc;padding:8px 10px"><strong>This payment is Non-Refundable.</strong></td></tr>
</table>
<p>This Annexure was signed on the day of <strong>${today}</strong>.</p>
<div style="display:flex;gap:40px;margin:12px 0 8px;font-size:12px">
  <div>DATE: ${today}<br><br>Client's Signature: _______________________</div>
  <div>Spouse's Signature: _______________________<br><br>Signature of ${partyLabel}: ___________________</div>
</div>
</div>`;
      }

      // Traveller assignments are the source of truth for country-specific terms.
      // Older drafts may only have the comma-separated destination, so retain it
      // as a fallback when no traveller-country assignment is available.
      const travellerDestinations = (d.travellers || [])
        .flatMap((traveller) => traveller.countries || [])
        .map((item) => String(item || "").trim())
        .filter(Boolean);
      const destinations = [...new Set(
        travellerDestinations.length
          ? travellerDestinations
          : (d.destination || "").split(",").map((item) => item.trim()).filter(Boolean)
      )];

      const hasUSADate = d.usaDateBooking;
      const hasPremium = d.premiumVisaInterview;

      // Classify each destination
      const usaCountries    = destinations.filter(c => /united states|^usa$/i.test(c));
      const nonUsaCountries = destinations.filter(c => !/united states|^usa$/i.test(c));

      // If no destinations set, fall back to full destination string for display
      const displayDest = destination || "—";

      const parts = [];  // one country-specific agreement per entry

      if (nonUsaCountries.length > 0) {
        // ── NON-USA SERVICE AGREEMENT ──────────────────────────────────────────
        nonUsaCountries.forEach((nonUsaDest) => {
        parts.push({ country: nonUsaDest, html: agrHeader("the Winny") + `
<p>WHEREAS the Winny and the Client wish to enter into a written agreement which contains the agreed upon terms and conditions upon which the Winny will provide professional services to the Client.</p>
<p>In consideration of the mutual covenants contained in this Agreement, the Winny and the Client agree as follows:</p>

<p><strong>Matter and Scope of Services</strong><br>As per Annexure "A" — <strong>${escapeHtml(serviceName)}</strong> for <strong>${escapeHtml(nonUsaDest)}</strong></p>

<p><strong>The Winny's Responsibilities and Commitments</strong></p>
<p>In consideration of the professional fees paid and the matter stated above, the Winny agrees to:</p>
<ul style="margin:0 0 10px;padding-left:20px">
  <li>Explain Visitor visa application process as per respective government website.</li>
  <li>Assist the Client in the process of the visitor visa application.</li>
  <li>Provide a checklist of required documents as per respective government website.</li>
  <li>Fill out visitor visa application forms.</li>
  <li>Act in the best interest of the Client and within the Winny's code of conduct and standard timeline.</li>
</ul>

<p><strong>The Client's Responsibilities and Commitments</strong></p>
<p><em>Documents:</em> Provide the Winny all information and documents in support of the application as requested. Provide all information and documents requested by the Visa Processing Authorities in a timely, accurate, honest and forthright manner. Provide all documents in English or accompanied by an English translation.</p>
<p><em>Disclosure:</em> The Client shall be aware of his/her responsibility for providing accurate information. The Client fully discloses all information related to any and all current or prior criminal charges and/or convictions. The Client immediately advises the Winny of any change in marital, family, or civil status, employment status, or change of physical address.</p>
${sigBlock()}
<p><strong>Billing Method</strong><br>The Client will be billed by flat fee. Receipt received on registered email will only be considered as proof of payment.</p>

<p><strong>Professional Fee Payment Terms &amp; Conditions</strong><br>As per Annexure "A". Professional fees are <strong>non-refundable</strong>. All statutory taxes and duties levied by Local, State or Central government are not included in the Professional Fee.</p>
${sigBlock()}
<p><strong>The Government and Other Fees</strong><br>Additional fees may include: application and biometrics fees for the Client and dependents, and visa facilitation fees. All Central or State government fees are required to be paid in the concerned country currency only.</p>

<p><strong>Disbursements</strong><br>The Client agrees to pay directly: government processing fees, translation and interpretation expenses, CA certificate, affidavits, notarization/true copy of documents, costs for medical tests and security clearance, and courier fees.</p>

<p><strong>Guarantees</strong><br>Visa approval or denial is solely the decision of the respective visa office. The Winny has not given any guarantee of visa approval.</p>
${sigBlock()}
<p><strong>Confidentiality</strong><br>All information and documentation collected by the Winny shall remain restricted to the staff and case officers assigned to the Client.</p>

<p><strong>Limitation</strong><br>This agreement is valid for the duration of 3 months from the date of signing. The Winny cannot hasten the processing time of the Client's visa application and is not responsible for any delays from the visa authority. The Winny's obligations are null and void if the Client knowingly provides any inaccurate, misleading or false material information.</p>
${sigBlock()}
<p><strong>Internal Complaint Procedure</strong><br>In the event of any dispute, contact: <strong>customercare@winnygroup.com</strong>. Any dispute shall be subject to Ahmedabad Jurisdiction only and referred to a sole arbitrator under the Arbitration and Conciliation Act 1996.</p>

<p><strong>Phone Calls</strong><br>Communication between the Client and the Winny would be through email and phone calls. Phone calls are recorded for quality and monitoring purposes.</p>

<p><strong>Force Majeure</strong><br>The Winny shall not be liable for any failure or delay caused by acts of God, flood, fire, earthquake, pandemic, war, government order, strikes, or other events beyond the Winny's reasonable control.</p>

<p><strong>Termination</strong><br>This Agreement is considered terminated upon completion of tasks identified under Section 1, or is valid for three months from the date the Client signed this agreement. The Winny has the right to terminate for non-payment, non-responsiveness, or disrespect toward employees.</p>

<p><strong>Miscellaneous</strong><br>This Agreement constitutes the entire agreement between the parties. Both parties have fully read this agreement and accept it in its entirety.</p>
${sigBlock()}
<div style="text-align:center;font-style:italic;color:#555;font-size:12.5px;margin:14px 0">
  <p>NOTE: Any questions or concerns about the terms of this agreement should be addressed to the Winny before signing.</p>
  <p><strong>નોંધ:</strong> આ કરારનામાની તમામ શરતો ને સંબંધિત કોઇ પણ પ્રશ્ન હોય તો સહી કરતા પહેલા સલાહ લેવા વિનંતી.<br>
  મેં ચૂકવેલ ફી કોઈપણ સજોગમાં પરત મળશે નહી તે મારી જાણમાં છે અને મને મંજુર છે.</p>
</div>
<p>This agreement was signed on <strong>${today}</strong></p>
<p>I am Aware that a Professional-consulting fee paid by the client is <strong>Non-Refundable</strong>.</p>
<div style="display:flex;gap:40px;margin:14px 0 6px;font-size:12px">
  <div>DATE: ${today}<br><br>Client's Signature: _______________________</div>
  <div>Spouse's Signature: _______________________<br><br>Signature of Winny: ___________________</div>
</div>` + annexureA("Winny") });

        });
      }

      if (usaCountries.length > 0) {
        // ── USA SERVICE AGREEMENT ──────────────────────────────────────────────
        // Scope line changes based on addons
        let usaScope = "Provide assistance in USA B1/B2 Visitor Visa application";
        let usaServices = `<ul style="margin:0 0 10px;padding-left:20px">
  <li>Explain USA B1/B2 application process as per respective government website.</li>
  <li>Assist the Client in the process of the USA B1/B2 application.</li>
  <li>Fill out USA DS-160 application form.</li>
  <li>Provide a checklist of required documents as per respective government website.</li>
  <li>Act in the best interest of the Client within the Company's code of conduct and standard timeline.</li>`;
        if (hasUSADate) {
          usaScope += " with Priority Date Booking";
          usaServices += `
  <li>Assist with USA Priority Visa Appointment Date Booking.</li>`;
        }
        if (hasPremium) {
          usaScope += " and Premium Interview Training";
          usaServices += `
  <li>Assist the client in Interview preparation by conducting a training session.</li>`;
        }
        usaServices += `
</ul>`;

        usaCountries.forEach((usaCountry) => {
        parts.push({ country: usaCountry, html: agrHeader("the Company") + `
<p>WHEREAS the Company provides services to individuals intending to travel to the United States for temporary visit purposes, including but not limited to tourism, attending convocations, visiting family or friends or for business.</p>
<p>WHEREAS the Client is seeking assistance for their visa application process.</p>

<p><strong>Matter and Scope of Services</strong><br>As per Annexure "A" — <strong>${escapeHtml(usaScope)}</strong></p>

<p><strong>Section 2: The Company's Responsibilities and Commitments</strong></p>
<p>In consideration of the professional fees paid and the matter stated above, the Company agrees to:</p>
${usaServices}
${sigBlock()}
<p><strong>Section 3: The Client's Responsibilities and Commitments</strong></p>
<p><em>Documents:</em> Provide the Company all information or documents in support of the application. Provide all information or documents requested by the Visa Processing Authorities in a timely, accurate, honest and forthright manner.</p>
<p><em>Disclosure:</em> The Client shall be aware of his/her responsibility for providing accurate information. The Client fully discloses all information related to any and all current or prior criminal charges and/or convictions. The Client immediately advises the Company of any change in marital, family, or civil status, employment status, or change of physical address.</p>

<p><strong>Section 4: Billing Method</strong><br>The Client will be billed by flat fee. Receipt received on registered email will only be considered as proof of payment.</p>
${sigBlock()}
<p><strong>Section 5: Professional Fee Payment Terms &amp; Conditions</strong><br>As per Annexure "A". Professional fees are <strong>non-refundable</strong>.</p>

<p><strong>Section 6: The Government and Other Fees</strong><br>Additional fees may include application and biometrics fees, and visa facilitation fees. All Central or State government fees are to be paid in the concerned country currency only.</p>

<p><strong>Section 7: Disbursements</strong><br>The Client agrees to pay directly: government processing fees, translation and interpretation expenses, CA certificate, affidavits, notarization, costs for medical tests and security clearance, and courier fees.</p>

<p><strong>Section 8: Refund Policy</strong><br>The Client acknowledges that <strong>all fees paid to the Company are non-refundable</strong>. If the visa application is refused by the relevant immigration authorities, the fees paid to the Company will not be refundable.</p>
${sigBlock()}
<p><strong>Section 9: Guarantees</strong><br>Visa approval or denial is solely the decision of the respective visa office. The Company has not given any guarantee of visa approval.</p>

<p><strong>Section 11: Confidentiality</strong><br>All information or documentation collected by the Company shall remain restricted to the staff and case officers assigned to the Client.</p>

<p><strong>Section 12: Limitation</strong><br>This agreement is valid for the duration of 3 months from the date of signing. The Company cannot hasten the processing time of the Client's visa application.</p>

<p><strong>Section 13: Internal Complaint Procedure</strong><br>In the event of any dispute, contact: <strong>customercare@winnygroup.com</strong>. Any dispute shall be subject to Ahmedabad Jurisdiction only.</p>

<p><strong>Section 18: Termination</strong><br>This Agreement is considered terminated upon completion of tasks identified under Section 1, or is valid for three months from the date the Client signed this agreement.</p>

<p><strong>Section 22: Final Provisions</strong><br>Both parties have fully read this agreement and accept it in its entirety.</p>
${sigBlock()}
<div style="text-align:center;font-style:italic;color:#555;font-size:12.5px;margin:14px 0">
  <p>NOTE: Any questions or concerns about the terms of this agreement should be addressed to the Company before signing.</p>
  <p><strong>નોંધ:</strong> આ કરારનામાની તમામ શરતો ને સંબંધિત કોઇ પણ પ્રશ્ન હોય તો સહી કરતા પહેલા સલાહ લેવા વિનંતી.<br>
  મેં ચૂકવેલ ફી કોઈપણ સજોગમાં પરત મળશે નહી તે મારી જાણમાં છે અને મને મંજુર છે.</p>
</div>
<p>This agreement was signed on <strong>${today}</strong></p>
<p>I am Aware that a Professional-consulting fee paid by the client is <strong>Non-Refundable</strong>.</p>
<div style="display:flex;gap:40px;margin:14px 0 6px;font-size:12px">
  <div>DATE: ${today}<br><br>Client's Signature: _______________________</div>
  <div>Spouse's Signature: _______________________<br><br>Signature of Company: ___________________</div>
</div>` + annexureA("Company") });
        });
      }

      // If no destinations matched at all, fallback to non-USA
      if (parts.length === 0) {
        parts.push({ country: displayDest, html: agrHeader("the Winny") + `
<p>Matter and Scope of Services: <strong>${escapeHtml(serviceName)}</strong> for <strong>${escapeHtml(displayDest)}</strong></p>
<p>Professional fees of <strong>${amount}</strong> are non-refundable as per Annexure A.</p>` + annexureA("Winny") });
      }

      // Join multiple agreements with a clear page-break divider
      const pageDivider = `
<div style="margin:36px 0;padding:18px;background:#f0f4f8;border-radius:8px;text-align:center;font-family:Arial,sans-serif;font-size:13px;font-weight:700;color:#555;letter-spacing:1px;border-top:2px solid #999;border-bottom:2px solid #999">
  ── ADDITIONAL SERVICE AGREEMENT ──
</div>`;

      applicationData.deal.agreementHtmlByCountry = Object.fromEntries(
        parts.map((part) => [part.country, part.html])
      );
      applicationData.deal.agreementHtml = parts.map((part) => part.html).join(pageDivider);
      saveDraft(false);
      requestRender();
      setTimeout(() => {
        const el = document.getElementById("agreement-content");
        if (el) el.scrollTop = 0;
      }, 100);
      const count = parts.length;
      toast(`Agreement${count > 1 ? "s" : ""} loaded ✓ (${count} document${count > 1 ? "s" : ""})`);
    }

    // ── payment ──
    async function completePayment() {
      if (!validateDealSubStep(1) || !validateDealSubStep(2) || !validateDealSubStep(3)) return;
      if (!applicationData.payment.method) return fail("Select a payment method.");
      showLoader("Saving payment & travellers to CRM...");
      try {
        const payableAmount = getPayableAmount();
        if (payableAmount <= 0) return fail("Enter a valid payment amount.");
        applicationData.payment.paidAmount = payableAmount;
        applicationData.payment.status = getPaymentStatusAfterSuccess();
        applicationData.payment.paidAt = new Date().toISOString();
        applicationData.applicationId  = applicationData.applicationId || makeApplicationId();
        applicationData.deal.dealName  = `${getCustomerName()} - ${getSelectedServiceNames() || "Application"}`;
        // saveDealData sends "Payment Complete" with existing CRM_Deal_ID
        // so Deluge updates the existing Deal instead of creating a duplicate
        await saveDealData({ includeTravellers: true });
        applicationData.stepStatus.dealCompleted = isFullyPaidStatus(applicationData.payment.status);
        if (applicationData.stepStatus.dealCompleted) applicationData.currentStep = 2;
        saveDraft(false);
        if (applicationData.stepStatus.dealCompleted) {
          toast("Payment & travellers saved to CRM ✓ Questionnaire unlocked.");
          showStep(2);
        } else {
          toast("Partial payment saved to CRM. Questionnaire will unlock once payment is fully Paid.");
      requestRender();
        }
      } catch (error) {
        console.error(error);
        applicationData.crmSync.lastError = error.message || "CRM save failed";
        toast(`CRM save failed: ${applicationData.crmSync.lastError}`);
      } finally {
        hideLoader();
      }
    }

    async function createZohoPaymentLink() {
      if (!validateDealSubStep(1) || !validateDealSubStep(2) || !validateDealSubStep(3)) return;
      if (!CONFIG.paymentsAccountId) {
        openModal("Zoho Payments Account ID Needed","Add your Zoho Payments account ID in CONFIG.paymentsAccountId before generating live payment links.");
        return;
      }
      showLoader("Creating Zoho payment link...");
      try {
        applicationData.payment.method    = "Zoho Payments";
        applicationData.applicationId     = applicationData.applicationId || makeApplicationId();
        applicationData.deal.dealName     = `${getCustomerName()} - ${getSelectedServiceNames() || "Application"}`;
        const payableAmount = getPayableAmount();
        if (payableAmount <= 0) return fail("Enter a valid payment amount.");
        const response = await paymentsRest("POST", `/paymentlinks?account_id=${encodeURIComponent(CONFIG.paymentsAccountId)}`, {
          amount: payableAmount,
          currency: "INR",
          email: applicationData.customer.email,
          phone: applicationData.customer.mobile,
          phone_country_code: "IN",
          reference_id: applicationData.applicationId,
          description: applicationData.deal.dealName.slice(0, 500),
          notify_customer: { email: true, sms: false },
          configurations: { allowed_payment_methods: ["upi","card","netbanking"] }
        });
        const link = response?.payment_link || response?.data?.payment_link || response?.data || response;
        applicationData.payment.paymentLinkId  = link?.payment_link_id || applicationData.payment.paymentLinkId;
        applicationData.payment.paymentLinkUrl = link?.url             || applicationData.payment.paymentLinkUrl;
        applicationData.payment.paidAmount     = link?.status === "paid" ? payableAmount : applicationData.payment.paidAmount;
        applicationData.payment.status         = link?.status === "paid" ? getPaymentStatusAfterSuccess() : "Payment Link Sent";
        await saveDealData({ includeTravellers: true });
        saveDraft(false);
      requestRender();
        if (applicationData.payment.paymentLinkUrl) {
          openModal("Payment Link Created", applicationData.payment.paymentLinkUrl);
        } else {
          toast("Payment link created, but no URL was returned.");
        }
      } catch (error) {
        console.error(error);
        toast(`Payment link failed: ${error.message || "Check Zoho Payments connection and account ID."}`);
      } finally {
        hideLoader();
      }
    }

    // ── save deal details / save deal data ──
    async function saveDealDetails() {
      if (state.savingDeal) return;

if (isDealSaved()) {
  toast("This application already has a CRM Deal.");
  return;
}
      const required = [["customer.firstName","First name is required."],["customer.lastName","Last name is required."],["customer.email","Email is required."],["customer.mobile","Mobile is required."]];
      const missing  = required.find(([path]) => validators.required(getByPath(applicationData, path)));
      if (missing) return fail(missing[1]);
      if (validators.email(applicationData.customer.email)) return fail(validators.email(applicationData.customer.email));

      state.savingDeal = true;
      showLoader("Creating Deal in CRM...");
      try {
        applicationData.applicationId = applicationData.applicationId || makeApplicationId();
        applicationData.deal.dealName = applicationData.deal.dealName || `${getCustomerName()} - Application`;
        ensurePrimaryTravellerFromCustomer();

        // Submit to Creator → Deluge workflow fires
        const creatorRecordId = await submitPortalCrmRequest("Save Deal");

        // Poll Creator record until Deluge finishes (Status ≠ "Processing"/"Pending")
        showLoader("Waiting for CRM to confirm...");
        const crmResult = await pollCreatorRecord(creatorRecordId);

        if (crmResult.Status === "Failed") {
          throw new Error(crmResult.Error_Message || "Deluge workflow failed.");
        }

        // Store IDs written back by Deluge
        if (crmResult.CRM_Deal_ID)    applicationData.deal.crmDealId    = crmResult.CRM_Deal_ID;
        if (crmResult.CRM_Contact_ID) applicationData.deal.crmContactId = crmResult.CRM_Contact_ID;
        if (crmResult.CRM_Traveller_IDs) {
          applicationData.crmSync.travellerIds = crmResult.CRM_Traveller_IDs;
          applyTravellerCrmIds(crmResult.CRM_Traveller_IDs);
        } else if (applicationData.deal.crmDealId) {
          const crmTravellerRows = await findTravellersForDeal(applicationData.deal.crmDealId);
          reconcileTravellerCrmRows(crmTravellerRows);
        }
        applicationData.crmSync.requestId  = creatorRecordId;
        applicationData.crmSync.lastSyncAt = new Date().toISOString();
        applicationData.deal.dealSavedToCRM = true;

        // Seed Primary Applicant from DOM inputs (not applicationData which may be mid-keystroke)
        if (applicationData.deal.travellers.length === 0) {
          // Read directly from the live input elements to get the final typed value
          const readField = (bind) => {
            const el = document.querySelector(`[data-bind="${bind}"]`);
            return el ? el.value.trim() : (getByPath(applicationData, bind) || "");
          };
       applicationData.deal.travellers.push({
            id:           uid("traveller"),
            familyId:     "family-1",
            type:         "Primary Applicant",
            firstName:    readField("customer.firstName"),
            lastName:     readField("customer.lastName"),
            dob:          "",
            relationship: "Self",
            nationality:  readField("customer.nationality") || "",
            email:        readField("customer.email"),
            mobile:       readField("customer.mobile"),
            countries:    []
          });
        }

        saveDraft(false);
      requestRender();
      requestRender();
        toast("Deal created in CRM ✓ You can now add travellers.");
      } catch (error) {
        console.error(error);
        applicationData.crmSync.lastError = error.message || "CRM save failed";
        // Still mark locally saved so UI unlocks — Deluge may retry
        applicationData.deal.dealSavedToCRM = true;
        saveDraft(false);
      requestRender();
        toast(`Deal save issue: ${applicationData.crmSync.lastError}. Travellers unlocked locally.`);
      } finally {
  state.savingDeal = false;
  hideLoader();
}
    }

    async function saveDealData(options = {}) {
  const { includeTravellers = true, syncOnly = false } = options;

  if (
    includeTravellers &&
    applicationData.deal.crmDealId &&
    applicationData.deal.travellers.some((traveller) => !traveller.crmId)
  ) {
    try {
      const crmTravellerRows = await findTravellersForDeal(applicationData.deal.crmDealId);
      reconcileTravellerCrmRows(crmTravellerRows);
    } catch (reconcileError) {
      console.warn("[Winny] Could not reconcile existing CRM travellers before sync:", reconcileError);
    }
  }

  const requestType = syncOnly
    ? "Sync Application Details"
    : includeTravellers
      ? "Payment Complete"
      : "Save Deal";

      const creatorRecordId = await submitPortalCrmRequest(requestType);

      // For "Payment Complete" poll for CRM IDs written back by Deluge
      // Both operations return the CRM IDs of the upserted travellers.
if (
  requestType === "Payment Complete" ||
  requestType === "Sync Application Details"
) {
  try {
    showLoader(
      syncOnly
        ? "CRM saving application details..."
        : "CRM processing payment..."
    );

    const crmResult = await pollCreatorRecord(creatorRecordId);

    if (crmResult.Status === "Failed") {
      throw new Error(
        crmResult.Error_Message ||
        `${requestType} failed.`
      );
    }

    if (crmResult.CRM_Deal_ID) {
      applicationData.deal.crmDealId = crmResult.CRM_Deal_ID;
    }

    if (crmResult.CRM_Contact_ID) {
      applicationData.deal.crmContactId = crmResult.CRM_Contact_ID;
    }

    if (crmResult.CRM_Traveller_IDs) {
      applicationData.crmSync.travellerIds =
        crmResult.CRM_Traveller_IDs;

      applyTravellerCrmIds(
        crmResult.CRM_Traveller_IDs
      );
    }
  } catch (pollErr) {
    console.warn(
      `[Winny] ${requestType} failed:`,
      pollErr.message
    );

    // A detail-sync failure must stop navigation to payment.
    if (syncOnly) {
      throw pollErr;
    }
  }
}

      applicationData.crmSync.lastSyncAt  = new Date().toISOString();
      applicationData.crmSync.requestId   = creatorRecordId || applicationData.crmSync.requestId;
      applicationData.deal.dealSavedToCRM = true;
      return creatorRecordId;
    }

export {
  goDealSubStep, validateDealSubStep, openZPayWidget, showPaymentConfirmedScreen,
  goToQuestionnaire, fetchAgreement, completePayment, createZohoPaymentLink,
  saveDealDetails, saveDealData
};
