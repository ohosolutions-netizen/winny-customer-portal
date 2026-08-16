import React from "react";
import { applicationData } from "../../store/runtime.js";
import { steps, journeyStages } from "../../config/config.js";
import {
  hasApplicationInfo, getCompletionPercent, getCurrentStage, getStageNote,
  getJourneyStageIndex, isFullyPaidStatus, isDocumentChecklistClear
} from "../../core/derive.js";
import { startNewApplication } from "../../core/drafts.js";
import { showWizard, showStep } from "../../core/navigation.js";
import { formatDateTime } from "../../lib/utils.js";
import ApplicationList from "./ApplicationList.jsx";

// Reproduces the static #dashboardView shell (source 1185-1231) + renderDashboard()
// (source 2232-2291). Value computation and the two branches (no info / info) are
// faithful; markup/classes are unchanged.
export default function Dashboard() {
  const hasInfo = hasApplicationInfo();
  const percent = hasInfo ? getCompletionPercent() : 0;
  const doneIndex = getJourneyStageIndex();

  const applicationId = hasInfo ? (applicationData.applicationId || "New") : "New";
  const currentStage = hasInfo ? getCurrentStage() : "No application found";
  const stageNote = hasInfo ? getStageNote() : "Add a new application to begin.";
  const status = hasInfo
    ? (applicationData.stepStatus.submitted ? "Submitted" : isFullyPaidStatus(applicationData.payment.status) ? "In Progress" : "Draft")
    : "Not started";
  const lastSaved = hasInfo ? (applicationData.lastSavedAt ? formatDateTime(applicationData.lastSavedAt) : "Not saved") : "Not saved";
  const payment = hasInfo ? applicationData.payment.status : "Pending";

  const cards = [
    { title: "Application & Payment", desc: "Create customer profile, add travellers, select package, accept terms, and record payment.", status: applicationData.stepStatus.dealCompleted ? "Complete" : "Open", locked: false, step: 1 },
    { title: "Questionnaire", desc: "Collect travel purpose, countries, inviter, family ties, funds, and immigration history.", status: applicationData.stepStatus.questionnaireCompleted ? "Complete" : applicationData.stepStatus.dealCompleted ? "Open" : "Locked", locked: !applicationData.stepStatus.dealCompleted, step: 2 },
    { title: "Document Checklist", desc: "Upload the documents required for your case — generated from your questionnaire answers.", status: isDocumentChecklistClear() ? "Complete" : applicationData.stepStatus.questionnaireCompleted ? "Open" : "Locked", locked: !applicationData.stepStatus.questionnaireCompleted, step: 3 },
    { title: "Customer Information Form", desc: "Capture passport, address, employment, finance, travel history, and declarations.", status: applicationData.stepStatus.cifCompleted ? "Complete" : applicationData.stepStatus.questionnaireCompleted ? "Open" : "Locked", locked: !applicationData.stepStatus.questionnaireCompleted, step: 4 },
  ];

  const goStep = (step) => { showWizard(); showStep(step); };

  return (
    <section id="dashboardView" className="dashboard">
      <aside className="dash-side">
        <div className="side-panel">
          <div className="side-k">Application number</div>
          <div className="side-v" id="dashApplicationId">{applicationId}</div>
          <div className="side-note">Created after payment confirmation.</div>
        </div>
        <div className="side-panel">
          <div className="side-k">Current stage</div>
          <div className="side-v" id="dashCurrentStage">{currentStage}</div>
          <div className="side-note" id="dashStageNote">{stageNote}</div>
        </div>
      </aside>

      <main className="dash-main">
        <section className="card" style={{ marginBottom: 18 }}>
          <div className="panel-head">
            <div>
              <h3>Progress Tracker</h3>
              <p>Preserves the existing journey stages as a single-page stepper.</p>
            </div>
          </div>
          <div className="panel-body">
            <div className="stepper" id="dashboardStepper">
              {hasInfo
                ? journeyStages.map((stage, index) => {
                    const st = index < doneIndex ? "done" : index === doneIndex ? "active" : "locked";
                    return (
                      <div key={stage} className={`step ${st}`}>
                        <span className="step-dot">{index + 1}</span>{stage}
                      </div>
                    );
                  })
                : null}
            </div>
          </div>
        </section>

        <div className="portal-hero">
          <article className="hero-card">
            <span className="eyebrow">Guided application workspace</span>
            <h1>Your complete <span className="grad-text">Winny application journey</span></h1>
            <p>Track payment, answer case questions, complete your customer information file, and submit the final application from one secure Zoho Creator widget.</p>
          </article>
          <article className="progress-card card">
            <div className="progress-top"><span>Completion</span><strong id="dashPercent">{percent}%</strong></div>
            <div className="progress-bg"><div className="progress-fill" id="dashProgressBar" style={{ width: `${percent}%` }}></div></div>
            <div className="progress-meta">
              <div className="mini-row"><span>Status</span><strong id="dashStatus">{status}</strong></div>
              <div className="mini-row"><span>Last saved</span><strong id="dashLastSaved">{lastSaved}</strong></div>
              <div className="mini-row"><span>Payment</span><strong id="dashPayment">{payment}</strong></div>
            </div>
          </article>
        </div>

        <div className="journey-grid" id="journeyCards">
          <ApplicationList />
          {hasInfo
            ? cards.map((card, index) => (
                <article key={card.title} className={`journey-card ${card.locked ? "locked" : ""}`}>
                  <div className="journey-top">
                    <div className="journey-num">{index + 1}</div>
                    <span className={`badge ${card.status === "Complete" ? "done" : card.status === "Locked" ? "locked" : "open"}`}>{card.status}</span>
                  </div>
                  <div>
                    <h3>{card.title}</h3>
                    <p>{card.desc}</p>
                  </div>
                  <button className={`btn ${card.locked ? "" : "primary"}`} type="button" disabled={card.locked} onClick={() => goStep(card.step)}>
                    {card.status === "Complete" ? "Review" : "Start / Continue"}
                  </button>
                </article>
              ))
            : (
              <section className="no-deal-state">
                <h2>No application information found</h2>
                <p>Start a new application for this customer.</p>
                <button className="btn primary" type="button" onClick={() => startNewApplication()}>Add New Application</button>
              </section>
            )}
        </div>
      </main>
    </section>
  );
}
