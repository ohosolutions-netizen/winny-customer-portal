import React from "react";
import { applicationData, state } from "../../store/runtime.js";
import { formatCurrency } from "../../lib/utils.js";
import { goDealSubStep } from "../../api/deal.js";
import DetailsPane from "./DetailsPane.jsx";
import ServicesPane, { ServiceBasket } from "./ServicesPane.jsx";
import TermsPane from "./TermsPane.jsx";
import PaymentPane from "./PaymentPane.jsx";

// Reproduces updatePricingSummary() (source 7867-7906) as the aside content.
function PricingSummary() {
  const paidAmount = Number(applicationData.payment.paidAmount || 0);
  const crmBalance = applicationData.payment.crmBalanceAmount;
  const hasCrmBalance = crmBalance !== null && crmBalance !== undefined && String(crmBalance).trim() !== "" && Number.isFinite(Number(crmBalance));
  const remainingAmount = hasCrmBalance ? Number(crmBalance) : Math.max(Number(applicationData.payment.grandTotal || 0) - paidAmount, 0);
  return (
    <div id="pricingSummary">
      <div className="summary-row"><span>Base Cost</span><strong>{formatCurrency(applicationData.payment.baseCost)}</strong></div>
      <div className="summary-row"><span>Taxes (18%)</span><strong>{formatCurrency(applicationData.payment.taxes)}</strong></div>
      <div className="summary-row"><span>Addons</span><strong>{formatCurrency(applicationData.payment.addons)}</strong></div>
      <div className="summary-row"><span>Amount Paid</span><strong>{formatCurrency(paidAmount)}</strong></div>
      <div className="summary-row"><span>Remaining</span><strong>{formatCurrency(remainingAmount)}</strong></div>
      <div className="summary-row"><span>Payment</span><strong>{applicationData.payment.status}</strong></div>
    </div>
  );
}

const SUB_LABELS = ["Who's applying", "Services", "Terms", "Payment"];

// Reproduces renderDeal() (source 2501-2545).
export default function DealStep() {
  const sub = state.dealSubStep;
  const showHero = sub === 1;
  const Pane = sub === 1 ? DetailsPane : sub === 2 ? ServicesPane : sub === 3 ? TermsPane : PaymentPane;

  return (
    <section id="stepDeal" className="wizard-step active">
      <div className="deal-shell">
        {showHero ? (
          <section className="deal-hero">
            <div>
              <span className="eyebrow">Trusted mobility partner since 1982</span>
              <h2>We exist to turn<br /><span className="grad-text">barriers into frontiers</span></h2>
              <p>Complete your details, add family members, choose your services, and confirm payment — all in one place.</p>
            </div>
            <div className="ecosystem-card">
              <strong style={{ fontSize: 20 }}>Your complete mobility ecosystem</strong>
              <div className="eco-item"><div className="eco-icon">V</div><div><strong>Visa &amp; Immigration</strong><small>Study, work, PR, visitor and travel cases.</small></div></div>
              <div className="eco-item"><div className="eco-icon">C</div><div><strong>Career &amp; Placement</strong><small>Career pathway and employer support.</small></div></div>
              <div className="eco-item"><div className="eco-icon">L</div><div><strong>Coaching &amp; Language</strong><small>IELTS, PTE, TOEFL, German and French.</small></div></div>
            </div>
          </section>
        ) : null}

        <div className={sub === 3 ? "" : "deal-layout"}>
          <div>
            <div className="sub-stepper">
              {[1, 2, 3, 4].map((n) => (
                <button key={n} className={`sub-step ${sub === n ? "active" : sub > n ? "done" : ""}`} type="button" onClick={() => goDealSubStep(n)}>
                  {n}. {SUB_LABELS[n - 1]}
                </button>
              ))}
            </div>
            <Pane />
          </div>
          {sub !== 3 ? (
            <aside className="summary-card">
              <ServiceBasket compact />
              <h3>Pricing Summary</h3>
              <PricingSummary />
              <div className="grand-total"><span>Total</span><strong id="summaryTotal">{formatCurrency(applicationData.payment.grandTotal)}</strong></div>
            </aside>
          ) : null}
        </div>
      </div>
    </section>
  );
}
