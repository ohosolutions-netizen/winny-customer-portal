import React from "react";
import { applicationData } from "../../store/runtime.js";
import { getSelectedServiceNames } from "../../core/derive.js";
import { goToQuestionnaire } from "../../api/deal.js";
import { formatCurrency } from "../../lib/utils.js";

// Reproduces showPaymentConfirmedScreen() (source 8198-8243). Rendered when
// state.payConfirmed is set after a successful payment.
export default function PayConfirmedScreen() {
  const basketItems = applicationData.deal.serviceBasket || [];
  const travellerNames = applicationData.deal.travellers
    .map((t) => `${t.firstName || ""} ${t.lastName || ""}`.trim()).filter(Boolean).join(", ");
  const serviceNames = [...new Set(basketItems.map((i) => i.name))].join(" · ") || getSelectedServiceNames();
  return (
    <div id="payConfirmedScreen" className="pay-confirmed-screen" style={{ display: "grid" }}>
      <div className="pay-confirmed-card">
        <div className="pay-confirmed-icon">✅</div>
        <h1>Payment confirmed.</h1>
        <p className="sub" style={{ background: "linear-gradient(135deg,#06c9b5,#4fc3f7)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text", fontWeight: 800, fontSize: 22, marginBottom: 8 }}>
          Let’s build your case.
        </p>
        <p className="sub">Your payment is confirmed and your case is live. A payment receipt has been sent to your email. Now complete your case questionnaire — it takes about 10 minutes.</p>
        <div className="pay-summary-box">
          <div className="pay-summary-label">Case Summary</div>
          <div className="pay-sum-row"><span className="pay-sum-key">Case reference</span><span className="pay-sum-val">{applicationData.applicationId}</span></div>
          <div className="pay-sum-row"><span className="pay-sum-key">Travellers</span><span className="pay-sum-val">{travellerNames || "—"}</span></div>
          <div className="pay-sum-row"><span className="pay-sum-key">Services</span><span className="pay-sum-val">{serviceNames || "—"}</span></div>
          <div className="pay-sum-row"><span className="pay-sum-key">Total paid</span><span className="pay-sum-val">{formatCurrency(applicationData.payment.grandTotal)} (incl. GST)</span></div>
        </div>
        <button className="pay-cta-btn" onClick={() => goToQuestionnaire()}>Start my case questionnaire now →</button>
      </div>
    </div>
  );
}
