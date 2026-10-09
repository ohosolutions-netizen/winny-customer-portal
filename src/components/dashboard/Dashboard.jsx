import React from "react";
import { applicationData, state } from "../../store/runtime.js";
import {
  hasApplicationInfo, getCurrentStage, getStageNote, getJourneyStageIndex, getCustomerName
} from "../../core/derive.js";
import { journeyStages } from "../../config/config.js";
import { openApplication, startNewApplication } from "../../core/drafts.js";
import ApplicationList from "./ApplicationList.jsx";

export default function Dashboard() {
  const hasInfo    = hasApplicationInfo();
  const waiting    = state.applicationsLoading && !hasInfo;

  const customerFirstName = applicationData.customer.firstName || "";
  const stageIndex        = getJourneyStageIndex();
  const totalStages       = journeyStages.length;
  const currentStageNum   = stageIndex + 1;
  const currentStageName  = waiting ? "Loading…" : hasInfo ? getCurrentStage() : "—";
  const stageNote         = waiting ? "Retrieving your portal data." : hasInfo ? getStageNote() : "Add a new application to begin.";
  const isSubmitted       = applicationData.stepStatus.submitted;

  const appTitle     = applicationData.deal.dealName || getCustomerName() || "Application";
  const appId        = applicationData.applicationId || "";
  const dealId       = applicationData.deal.crmDealId || "";
  const visaType     = applicationData.deal.goal || applicationData.deal.destination || "";
  const payStatus    = applicationData.payment.status || "Pending";
  const destination  = applicationData.deal.destination || "";

  const initials = appTitle.split(/\s+/).filter(Boolean).slice(0, 2).map(w => (w[0] || "").toUpperCase()).join("") || "?";

  const handleContinue = () => openApplication(dealId, appId);

  return (
    <section id="dashboardView" className="dashboard db-redesign">

      {/* ── Sidebar ── */}
      <aside className="db-sidebar">

        {/* Selected Application */}
        <div className="db-sidebar-section">
          <div className="db-sidebar-eyebrow">Selected Application</div>
          <div className="db-sel-app-row">
            <div className="db-avatar">{initials}</div>
            <div className="db-sel-app-info">
              <div className="db-sel-app-name">{appTitle}</div>
              {appId
                ? <div className="db-sel-app-id">{appId}</div>
                : <div className="db-sel-app-id" style={{ color: "#d97706" }}>Number pending</div>
              }
            </div>
            {hasInfo && (
              <button className="db-sel-app-arrow" onClick={handleContinue} aria-label="Continue application">
                →
              </button>
            )}
          </div>
        </div>

        {/* Current Stage */}
        <div className="db-sidebar-section">
          <div className="db-sidebar-eyebrow">Current Stage</div>
          <div className="db-stage-block">
            <div className="db-stage-circle">
              <span className="db-stage-num">{currentStageNum}</span>
              <span className="db-stage-denom">/{totalStages}</span>
            </div>
            <div>
              <div className="db-stage-name">{currentStageName}</div>
              <div className={`db-stage-badge${isSubmitted ? " submitted" : ""}`}>
                {isSubmitted ? "● Submitted" : "● In progress"}
              </div>
            </div>
          </div>
        </div>

        {/* Next Step */}
        <div className="db-sidebar-section">
          <div className="db-sidebar-eyebrow">Next Step</div>
          <p className="db-next-step">{stageNote}</p>
        </div>

        {/* Continue Button */}
        {hasInfo && (
          <div style={{ padding: "12px 20px 4px" }}>
            <button className="btn primary db-continue-btn" style={{ width: "100%", justifyContent: "center" }} onClick={handleContinue}>
              Continue application →
            </button>
          </div>
        )}

        {/* Details */}
        {hasInfo && (
          <div className="db-sidebar-section">
            <div className="db-sidebar-eyebrow">Details</div>
            {visaType && (
              <div className="db-detail-row">
                <span className="db-detail-key">Visa type</span>
                <span className="db-detail-val">{visaType}</span>
              </div>
            )}
            <div className="db-detail-row">
              <span className="db-detail-key">Payment</span>
              <span className={`db-detail-val ${payStatus === "Paid" ? "db-pay-paid" : "db-pay-pending"}`}>
                ● {payStatus}
              </span>
            </div>
            {destination && (
              <div className="db-detail-row">
                <span className="db-detail-key">Destinations</span>
                <span className="db-detail-val">{destination}</span>
              </div>
            )}
          </div>
        )}

        {/* Need Help */}
        <div className="db-need-help" style={{ marginTop: "auto", paddingTop: "16px" }}>
          <div className="db-need-help-icon">?</div>
          <div className="db-need-help-text">
            Need help?
            <span className="db-need-help-sub">Contact your advisor →</span>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="dash-main">
        <div className="db-main-header">
          <div className="db-main-top-row">
            <div>
              {customerFirstName && <p className="db-welcome">Welcome back, {customerFirstName}</p>}
              <h1>Your complete <span className="grad-text">Winny application journey</span></h1>
              <p className="db-main-subtitle">
                Track payment, answer case questions, complete your customer information file, and submit the final application from one secure Winny Global customer portal.
              </p>
            </div>
            <button className="btn primary db-new-app-btn" onClick={() => startNewApplication()}>
              + New application
            </button>
          </div>
        </div>

        <div id="journeyCards">
          <ApplicationList hideNewButton />
        </div>
      </main>

    </section>
  );
}
