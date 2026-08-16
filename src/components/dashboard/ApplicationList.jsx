import React from "react";
import { applicationData } from "../../store/runtime.js";
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
  const selectCard = () => selectApplication(app.dealId || "", app.applicationId || "");
  const handleCardKeyDown = (event) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectCard();
    }
  };
  const statusClass = app.status === "Submitted" || isFullyPaidStatus(app.paymentStatus) ? "done" : "open";
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
          <p>{app.applicationId || app.dealId || "Draft application"}</p>
        </div>
        <span className={`badge ${statusClass}`}>{app.status || "In Progress"}</span>
      </div>
      <div className="application-meta">
        {app.destination ? <span>{app.destination}</span> : null}
        {app.paymentStatus ? <span>{app.paymentStatus}</span> : null}
        {app.stage ? <span>{app.stage}</span> : null}
      </div>
      <p>{app.serviceType || "Service selection pending"}</p>
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
