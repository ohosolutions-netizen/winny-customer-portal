import React from "react";
import { applicationData, state } from "../../store/runtime.js";
import { journeyStages } from "../../config/config.js";
import { getApplicationCards, isFullyPaidStatus } from "../../core/derive.js";
import {
  startNewApplication, openApplication, selectApplication, confirmRemoveApplication
} from "../../core/drafts.js";

// Reproduces renderApplicationCard() (source 2396-2427) as JSX. React escapes
// text by default, so the explicit escapeHtml() calls are no longer needed.
function ApplicationCard({ app }) {
  const currentDealId = String(applicationData.deal.crmDealId || "");
  const currentAppId = String(applicationData.applicationId || "");
  const active = Boolean(
    (app.dealId && app.dealId === currentDealId) ||
    (!app.dealId && app.applicationId && app.applicationId === currentAppId)
  );
  const selectCard = () => selectApplication(app.dealId || "", app.applicationId || "", app);
  const handleCardKeyDown = (event) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectCard();
    }
  };
  const statusClass = app.status === "Submitted" || isFullyPaidStatus(app.paymentStatus) ? "done" : "open";
  const progressPercent = Number.isFinite(Number(app.progressPercent))
    ? Math.max(0, Math.min(100, Number(app.progressPercent)))
    : 0;
  const stageNameIndex = journeyStages.findIndex((stage) => stage === app.stage);
  const stageIndex = Number.isInteger(Number(app.stageIndex))
    ? Math.max(0, Math.min(journeyStages.length - 1, Number(app.stageIndex)))
    : stageNameIndex >= 0
      ? stageNameIndex
      : Math.max(0, Math.min(journeyStages.length - 1, Math.round((progressPercent / 100) * (journeyStages.length - 1))));
  return (
    <article
      className={`application-card ${active ? "active" : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={`Select ${app.title || "application"}`}
      onClick={selectCard}
      onKeyDown={handleCardKeyDown}
      style={{ cursor: "pointer" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
        <div>
          <h3>{app.title || "Application"}</h3>
          <p>{app.applicationId || "Application number pending"}</p>
        </div>
        <span className={`badge ${statusClass}`}>{app.status || "In Progress"}</span>
      </div>
      <div className="application-meta">
        {app.destination ? <span>{app.destination}</span> : null}
        {app.paymentStatus ? <span>{app.paymentStatus}</span> : null}
        {app.stage ? <span>{app.stage}</span> : null}
      </div>
      <p>{app.serviceType || "Service selection pending"}</p>
      <div className="application-stage-tracker" aria-label={`${app.title || "Application"} progress`}>
        <div className="application-stage-head">
          <span>Application progress</span>
          <strong>Stage {stageIndex + 1} of {journeyStages.length}</strong>
        </div>
        <div className="application-stage-scroll">
          <div className="application-stage-track" role="list">
            <div className="application-stage-rail" aria-hidden="true">
              <span style={{ width: `${(stageIndex / (journeyStages.length - 1)) * 100}%` }}></span>
            </div>
            {journeyStages.map((stage, index) => {
              const stageState = index < stageIndex ? "done" : index === stageIndex ? "current" : "upcoming";
              return (
                <div
                  className={`application-stage ${stageState}`}
                  key={stage}
                  role="listitem"
                  aria-current={stageState === "current" ? "step" : undefined}
                >
                  <span className="application-stage-node" aria-hidden="true">
                    {stageState === "done" ? "✓" : index + 1}
                  </span>
                  <span className="application-stage-label">{stage}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="application-actions">
        {!isFullyPaidStatus(app.paymentStatus) ? (
          <button
            className="btn danger"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              confirmRemoveApplication(app.dealId || "", app.applicationId || "");
            }}
          >
            Remove
          </button>
        ) : null}
        <button
          className="btn primary"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            openApplication(app.dealId || "", app.applicationId || "");
          }}
        >
          Continue
        </button>
      </div>
    </article>
  );
}

// Reproduces renderApplicationList() (source 2293-2309). Returns null when there
// are no cards, matching the original's empty-string return.
export default function ApplicationList() {
  const applications = getApplicationCards();
  if (!applications.length && state.applicationsLoading) {
    return (
      <section className="application-section" aria-busy="true" aria-live="polite">
        <div className="application-head">
          <div>
            <div className="eyebrow">Applications</div>
            <h2>Your applications</h2>
          </div>
        </div>
        <div className="application-loading-state">
          <span className="application-loading-spinner" aria-hidden="true"></span>
          <div>
            <strong>Loading your applications...</strong>
            <p>Retrieving the latest application details from your portal.</p>
          </div>
        </div>
      </section>
    );
  }
  if (!applications.length) return null;
  return (
    <section className="application-section">
      <div className="application-head">
        <div>
          <div className="eyebrow">Applications</div>
          <h2>Your applications</h2>
        </div>
        <button className="btn primary" type="button" onClick={() => startNewApplication()}>New Application</button>
      </div>
      <div className="application-list">
        {applications.map((app) => (
          <ApplicationCard key={getKey(app)} app={app} />
        ))}
      </div>
    </section>
  );
}

function getKey(app) {
  return app.dealId ? `deal:${app.dealId}` : app.applicationId ? `app:${app.applicationId}` : app.localKey || app.title || "new";
}
