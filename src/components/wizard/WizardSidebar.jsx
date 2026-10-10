import React from "react";
import { applicationData } from "../../store/runtime.js";
import { steps } from "../../config/config.js";
import { formatCurrency } from "../../lib/utils.js";
import {
  isStepLocked, isStepDone,
  getCompletionPercent, getJourneyStageIndex, getStageNote, getCustomerName,
} from "../../core/derive.js";
import { showStep, goToDashboard } from "../../core/navigation.js";

const STEP_ICONS = ["📋", "📝", "📂", "📄", "🔍", "✅"];

export default function WizardSidebar() {
  const currentStep = applicationData.currentStep;
  const stageIndex  = getJourneyStageIndex();
  const percent     = getCompletionPercent();
  const stageNote   = getStageNote();
  const customerName = getCustomerName() || "New Application";
  const appNumber   = applicationData.applicationId || applicationData.deal.applicationNumber || "";
  const travellers  = applicationData.deal.travellers || [];
  const destinations = (applicationData.deal.selectedDestinations || []).join(", ")
    || applicationData.deal.destination || "";
  const grand       = Number(applicationData.payment.grandTotal || 0);
  const payStatus   = applicationData.payment.status || "Pending";
  const isPaid      = /paid|complete/i.test(payStatus);

  // Arc for the progress ring (r=20, circumference ≈ 125.7)
  const r = 20;
  const circ = 2 * Math.PI * r;
  const dash = circ - (percent / 100) * circ;

  return (
    <aside className="wz-sidebar">
      {/* ── Top: back link ── */}
      <button className="wz-sidebar-back" type="button" onClick={() => goToDashboard()}>
        ← All applications
      </button>

      {/* ── Application identity ── */}
      <div className="wz-sidebar-card">
        <div className="wz-sidebar-avatar">
          {(customerName[0] || "A").toUpperCase()}
          {(customerName.split(" ")[1]?.[0] || "").toUpperCase()}
        </div>
        <div className="wz-sidebar-appinfo">
          <div className="wz-sidebar-appname">{customerName}</div>
          {appNumber
            ? <div className="wz-sidebar-appnum">{appNumber}</div>
            : <div className="wz-sidebar-appnum pending">Number pending</div>}
        </div>
      </div>

      {/* ── Progress ring + stage ── */}
      <div className="wz-sidebar-progress">
        <svg className="wz-ring" viewBox="0 0 52 52" aria-hidden="true">
          <circle className="wz-ring-bg" cx="26" cy="26" r={r} />
          <circle
            className="wz-ring-fill"
            cx="26" cy="26" r={r}
            strokeDasharray={`${circ}`}
            strokeDashoffset={dash}
          />
          <text x="26" y="30" className="wz-ring-text">{percent}%</text>
        </svg>
        <div className="wz-sidebar-stage-info">
          <div className="wz-sidebar-stage-label">Stage {stageIndex + 1} of 6</div>
          <div className="wz-sidebar-stage-name">{applicationData.payment?.status === "Paid" || isPaid ? "Payment Complete" : stageIndex === 0 ? "Journey Begins" : ""}</div>
          <div className="wz-sidebar-stage-note">{stageNote}</div>
        </div>
      </div>

      {/* ── Step list ── */}
      <nav className="wz-sidebar-steps" aria-label="Application steps">
        {steps.map((step) => {
          const locked = isStepLocked(step.id);
          const done   = isStepDone(step.id);
          const active = currentStep === step.id;
          return (
            <button
              key={step.id}
              className={`wz-step-row${active ? " active" : ""}${done ? " done" : ""}${locked ? " locked" : ""}`}
              type="button"
              disabled={locked}
              onClick={() => showStep(step.id)}
              aria-current={active ? "step" : undefined}
            >
              <span className="wz-step-icon" aria-hidden="true">
                {done ? "✓" : STEP_ICONS[step.id - 1]}
              </span>
              <span className="wz-step-label">{step.label}</span>
              {locked && <span className="wz-step-lock" aria-label="Locked">🔒</span>}
            </button>
          );
        })}
      </nav>

      {/* ── Summary strip ── */}
      <div className="wz-sidebar-summary">
        {travellers.length > 0 && (
          <div className="wz-summary-row">
            <span>Travellers</span>
            <strong>{travellers.length}</strong>
          </div>
        )}
        {destinations && (
          <div className="wz-summary-row">
            <span>Destination</span>
            <strong>{destinations}</strong>
          </div>
        )}
        {grand > 0 && (
          <div className="wz-summary-row">
            <span>Total</span>
            <strong>{formatCurrency(grand)}</strong>
          </div>
        )}
        <div className="wz-summary-row">
          <span>Payment</span>
          <strong className={`wz-pay-badge ${isPaid ? "paid" : "pending"}`}>{payStatus}</strong>
        </div>
      </div>

      {/* ── Help ── */}
      <div className="wz-sidebar-help">
        <span>💬</span>
        <div>
          <strong>Need help?</strong>
          <small>Contact your advisor</small>
        </div>
      </div>
    </aside>
  );
}
