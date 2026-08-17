import React from "react";
import { applicationData, state } from "../../store/runtime.js";
import {
  hasApplicationInfo, getCurrentStage, getStageNote
} from "../../core/derive.js";
import { startNewApplication } from "../../core/drafts.js";
import ApplicationList from "./ApplicationList.jsx";

// Reproduces the static #dashboardView shell (source 1185-1231) + renderDashboard()
// (source 2232-2291). Value computation and the two branches (no info / info) are
// faithful; markup/classes are unchanged.
export default function Dashboard() {
  const hasInfo = hasApplicationInfo();
  const waitingForApplications = state.applicationsLoading && !hasInfo;

  const applicationId = waitingForApplications ? "Loading..." : hasInfo ? (applicationData.applicationId || "Pending") : "New";
  const currentStage = waitingForApplications ? "Loading applications" : hasInfo ? getCurrentStage() : "No application found";
  const stageNote = waitingForApplications ? "Retrieving your latest portal data." : hasInfo ? getStageNote() : "Add a new application to begin.";

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
        <div className="portal-hero" style={{ gridTemplateColumns: "1fr" }}>
          <article className="hero-card">
            <span className="eyebrow">Guided application workspace</span>
            <h1>Your complete <span className="grad-text">Winny application journey</span></h1>
            <p>Track payment, answer case questions, complete your customer information file, and submit the final application from one secure Zoho Creator widget.</p>
          </article>
        </div>

        <div className="journey-grid" id="journeyCards">
          <ApplicationList />
          {waitingForApplications
            ? null
            : hasInfo
            ? null
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
