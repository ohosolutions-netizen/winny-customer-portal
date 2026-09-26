import React, { useEffect } from "react";
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
import PayerModeSelector from "./PayerModeSelector.jsx";

function buildInvoiceLines(serviceBasket, travellers) {
  const lines = [];
  const isMultiCountry = (serviceBasket || []).some((item) => (item.destinations || []).length > 1);

  (serviceBasket || []).forEach((item) => {
    const perHead = Number(item.price || 0);
    const showDest = (item.destinations || []).length > 0 && isMultiCountry;
    const destLabel = (item.destinations || []).join(", ");

    (item.assignedTo || []).forEach((tid) => {
      const t = (travellers || []).find((x) => x.id === tid);
      const tName = t ? `${t.firstName || ""} ${t.lastName || ""}`.trim() || t.type : "Traveller";
      lines.push({ key: `${item.id}-${tid}`, service: item.name, traveller: tName, dest: showDest ? destLabel : "", amount: perHead });
    });

    if (!(item.assignedTo || []).length) {
      lines.push({ key: item.id, service: item.name, traveller: item.applicants || "", dest: "", amount: Number(item.total || 0) });
    }
  });

  return lines;
}

// Reproduces renderDealPane() sub-step 4 — Payment (source 2720-2797).
export default function PaymentPane() {
  const confirmed = isPaymentConfirmed();

  useEffect(() => {
    if (!confirmed) {
      refreshCurrentDealFromCrm(false).then(requestRender).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const basketItems = applicationData.deal.serviceBasket || [];
  syncPaymentBreakdown();
  const payableAmount = getPayableAmount();
  const grand = Number(applicationData.payment.grandTotal || 0);
  const paid = Number(applicationData.payment.paidAmount || 0);
  const remainingMax = Math.max(grand - paid, 0);

  const travellers = applicationData.deal.travellers || [];
  const invoiceLines = buildInvoiceLines(basketItems, travellers);
  const addons = (applicationData.deal.selectedAddons || []).map((id) => packageCatalog.find((x) => x.id === id)).filter(Boolean);
  const baseCost = Number(applicationData.payment.baseCost || 0);
  const taxes = Number(applicationData.payment.taxes || 0);

  const primaryApplicant = travellers.find((t) => t.type === "Primary Applicant") || travellers[0];
  const primaryName = primaryApplicant
    ? `${primaryApplicant.firstName || ""} ${primaryApplicant.lastName || ""}`.trim() || "Applicant"
    : "Applicant";
  const externalPayer = applicationData.deal.externalPayer || {};
  const customerName =
    applicationData.deal.payerMode === "someone-else" && externalPayer.invoiceInPayerName && externalPayer.name
      ? externalPayer.name.trim()
      : primaryName;
  const refNumber = applicationData.deal.applicationNumber || applicationData.deal.crmDealId || "—";

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
        <div className="invoice-card">
          <div className="invoice-header">
            <div className="invoice-header-left">
              <span className="invoice-kicker">Invoice</span>
              <span className="invoice-customer">{customerName}</span>
            </div>
            <div className="invoice-header-right">
              <span className="invoice-ref-label">Reference</span>
              <span className="invoice-ref">{refNumber}</span>
            </div>
          </div>
          <div className="invoice-lines">
            {invoiceLines.map((line) => (
              <div className="invoice-line" key={line.key}>
                <div className="invoice-line-info">
                  <div className="invoice-line-service">{line.service}</div>
                  {line.traveller ? <div className="invoice-line-traveller">{line.traveller}</div> : null}
                </div>
                {line.dest ? <span className="invoice-line-dest">{line.dest}</span> : null}
                <div className="invoice-line-amount">{formatCurrency(line.amount)}</div>
              </div>
            ))}
            {addons.map((p) => (
              <div className="invoice-line" key={p.id}>
                <div className="invoice-line-info">
                  <div className="invoice-line-service">{p.name}</div>
                  <div className="invoice-line-traveller">Add-on service</div>
                </div>
                <div className="invoice-line-amount">{formatCurrency(p.price)}</div>
              </div>
            ))}
          </div>
          <div className="invoice-totals">
            <div className="invoice-total-row subtotal">
              <span>Subtotal</span><span>{formatCurrency(baseCost)}</span>
            </div>
            <div className="invoice-total-row gst">
              <span>GST (18%)</span><span>{formatCurrency(taxes)}</span>
            </div>
            <div className="invoice-total-row grand">
              <span>Total</span><span>{formatCurrency(grand)}</span>
            </div>
          </div>
        </div>

        {!confirmed && <PayerModeSelector />}

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
