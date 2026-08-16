import React from "react";
import { applicationData } from "../../store/runtime.js";
import { packageCatalog } from "../../config/config.js";
import { formatCurrency } from "../../lib/utils.js";
import { requestRender } from "../../lib/ui.js";
import {
  getPaymentMode, getPayableAmount, syncPaymentBreakdown,
  setPaymentMode, updatePartialPayable,
} from "../../core/derive.js";
import { isPaymentConfirmed } from "../../core/deal.js";
import { openZPayWidget } from "../../api/deal.js";
import { refreshCurrentDealFromCrm } from "../../api/portal.js";

// Reproduces renderDealPane() sub-step 4 — Payment (source 2720-2797).
export default function PaymentPane() {
  const basketItems = applicationData.deal.serviceBasket || [];
  syncPaymentBreakdown();
  const payableAmount = getPayableAmount();
  const confirmed = isPaymentConfirmed();
  const grand = Number(applicationData.payment.grandTotal || 0);
  const paid = Number(applicationData.payment.paidAmount || 0);
  const remainingMax = Math.max(grand - paid, 0);

  return (
    <section className="wizard-panel">
      <div className="panel-head">
        <div><h3>Payment</h3><p>Review your order and pay securely via Zoho Payments.</p></div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className={`badge ${confirmed ? "done" : "pending"}`}>{applicationData.payment.status}</span>
          {!confirmed ? <button className="btn ghost" type="button" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => refreshCurrentDealFromCrm(false)}>↺ Check status</button> : null}
        </div>
      </div>
      <div className="panel-body">
        <div className="review-card" style={{ marginBottom: 18 }}>
          <h3 style={{ marginBottom: 14 }}>Order Summary</h3>
          {basketItems.map((item) => (
            <div className="review-row" key={item.id}>
              <span>{item.name}<br /><small style={{ color: "var(--muted)", fontSize: 11 }}>{item.applicants}</small></span>
              <strong>{formatCurrency(item.total)}</strong>
            </div>
          ))}
          {(applicationData.deal.selectedAddons || []).map((id) => {
            const p = packageCatalog.find((x) => x.id === id);
            return p ? <div className="review-row" key={id}><span>{p.name}</span><strong>{formatCurrency(p.price)}</strong></div> : null;
          })}
          <div className="review-row"><span>GST (18%)</span><strong>{formatCurrency(applicationData.payment.taxes)}</strong></div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 0 0", borderTop: "2px solid var(--line)", fontSize: 18, fontWeight: 900, color: "var(--navy)" }}>
            <span>Total</span><span>{formatCurrency(grand)}</span>
          </div>
        </div>

        {confirmed ? (
          <div className="notice teal">
            <strong>✓ Payment confirmed</strong>
            <span>Reference: {applicationData.payment.paymentId || applicationData.payment.paymentLinkId || "—"}</span>
          </div>
        ) : (
          <>
            <div className="review-card" style={{ marginBottom: 14 }}>
              <h3 style={{ marginBottom: 12 }}>Payment Option</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 10, marginBottom: 12 }}>
                <label className="check-row" style={{ cursor: "pointer" }}>
                  <input type="radio" name="paymentMode" value="Full" checked={getPaymentMode() === "Full"} onChange={() => setPaymentMode("Full")} />
                  <span><strong>Pay full amount</strong><br /><small style={{ color: "var(--muted)" }}>Pay {formatCurrency(remainingMax)} now.</small></span>
                </label>
                <label className="check-row" style={{ cursor: "pointer" }}>
                  <input type="radio" name="paymentMode" value="Partial" checked={getPaymentMode() === "Partial"} onChange={() => setPaymentMode("Partial")} />
                  <span><strong>Pay partial amount</strong><br /><small style={{ color: "var(--muted)" }}>Pay an advance and keep balance pending.</small></span>
                </label>
              </div>
              {getPaymentMode() === "Partial" ? (
                <div className="form-grid" style={{ marginBottom: 10 }}>
                  <label className="field">
                    <span>Amount to Pay Now <b>*</b></span>
                    <input type="number" min="1" max={Math.max(grand - paid, 1)} step="1"
                      value={applicationData.payment.payableNow || ""}
                      placeholder="Enter amount"
                      onChange={(e) => { updatePartialPayable(e.target.value); requestRender(); }}
                      onBlur={() => requestRender()} />
                  </label>
                </div>
              ) : null}
              <div className="review-row"><span>Pay now</span><strong>{formatCurrency(payableAmount)}</strong></div>
              <div className="review-row"><span>Balance after this payment</span><strong>{formatCurrency(applicationData.payment.balanceAmount)}</strong></div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
              <button className="btn primary" style={{ justifyContent: "center", padding: 15, fontSize: 15 }} type="button" onClick={() => openZPayWidget()}>
                🔒 Pay {formatCurrency(payableAmount)} securely
              </button>
              <div style={{ textAlign: "center", fontSize: 12, color: "var(--muted)" }}>UPI · Card · Net Banking &nbsp;·&nbsp; Secured by Zoho Payments</div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
