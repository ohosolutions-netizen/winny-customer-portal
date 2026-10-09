import React, { useState } from "react";
import { applicationData, state } from "../../store/runtime.js";
import { journeyStages } from "../../config/config.js";
import { getApplicationCards, isFullyPaidStatus } from "../../core/derive.js";
import {
  openApplication, selectApplication, confirmRemoveApplication
} from "../../core/drafts.js";

const STAGE_SHORT = [
  "Journey Begins",
  "Payment",
  "Case Questions",
  "CIF & Docs",
  "Review",
  "Submitted",
];

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Updated today";
  if (days === 1) return "Updated 1 day ago";
  if (days < 30)  return `Updated ${days} days ago`;
  const months = Math.floor(days / 30);
  return `Updated ${months} month${months > 1 ? "s" : ""} ago`;
}

function getInitials(title) {
  return (title || "A")
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => (w[0] || "").toUpperCase()).join("") || "?";
}

function getStageIndex(app) {
  const pct = Number.isFinite(Number(app.progressPercent))
    ? Math.max(0, Math.min(100, Number(app.progressPercent))) : 0;
  const nameIdx = journeyStages.findIndex(s => s === app.stage);
  if (Number.isInteger(Number(app.stageIndex))) {
    return Math.max(0, Math.min(journeyStages.length - 1, Number(app.stageIndex)));
  }
  if (nameIdx >= 0) return nameIdx;
  return Math.max(0, Math.min(journeyStages.length - 1, Math.round((pct / 100) * (journeyStages.length - 1))));
}

function ApplicationCard({ app }) {
  const currentDealId = String(applicationData.deal.crmDealId || "");
  const currentAppId  = String(applicationData.applicationId || "");
  const active = Boolean(
    (app.dealId && app.dealId === currentDealId) ||
    (!app.dealId && app.applicationId && app.applicationId === currentAppId)
  );

  const stageIndex  = getStageIndex(app);
  const initials    = getInitials(app.title);
  const updatedText = timeAgo(app.lastSavedAt || app.createdTime);
  const isPaid      = isFullyPaidStatus(app.paymentStatus);

  const selectCard = () => selectApplication(app.dealId || "", app.applicationId || "", app);

  return (
    <div
      className={`db-app-row-card${active ? " active" : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={`Select ${app.title || "application"}`}
      onClick={selectCard}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectCard(); } }}
    >
      {/* Left: avatar + info */}
      <div className="db-app-row-left">
        <div className="db-avatar db-avatar-sm">{initials}</div>
        <div className="db-app-row-info">
          <div className="db-app-row-name">{app.title || "Application"}</div>
          <div className="db-app-row-meta">
            {app.serviceType && <span>{app.serviceType}</span>}
            {app.destination && <span>{app.destination}</span>}
            {app.applicationId
              ? <span>{app.applicationId}</span>
              : <span className="db-pending">Number pending</span>
            }
          </div>
        </div>
      </div>

      {/* Centre: inline stage dots */}
      <div className="db-stage-track-inline" role="list" aria-label="Application progress">
        {journeyStages.map((stage, index) => {
          const dotState = index < stageIndex ? "done" : index === stageIndex ? "current" : "upcoming";
          return (
            <React.Fragment key={stage}>
              {index > 0 && (
                <div className={`db-stage-connector${index <= stageIndex ? " filled" : ""}`} aria-hidden="true" />
              )}
              <div className="db-stage-dot-wrap" role="listitem" aria-current={dotState === "current" ? "step" : undefined}>
                <div className={`db-stage-dot ${dotState}`} aria-hidden="true">
                  {dotState === "done" ? "✓" : index + 1}
                </div>
                <span className="db-stage-dot-label">{STAGE_SHORT[index] || stage}</span>
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Right: continue + timestamp */}
      <div className="db-app-row-right">
        <button
          className="btn primary db-continue-row-btn"
          type="button"
          onClick={e => { e.stopPropagation(); openApplication(app.dealId || "", app.applicationId || ""); }}
        >
          Continue →
        </button>
        {updatedText && <span className="db-updated-text">🕐 {updatedText}</span>}
        {!isPaid && (
          <button
            className="btn danger"
            type="button"
            style={{ fontSize: "11px", padding: "4px 10px", marginTop: "2px" }}
            onClick={e => { e.stopPropagation(); confirmRemoveApplication(app.dealId || "", app.applicationId || ""); }}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

export default function ApplicationList({ hideNewButton }) {
  const [filter, setFilter] = useState("all");
  const applications = getApplicationCards();

  const inProgress = applications.filter(a => a.status !== "Submitted");
  const submitted  = applications.filter(a => a.status === "Submitted");
  const filtered   =
    filter === "in-progress" ? inProgress :
    filter === "submitted"   ? submitted  :
    applications;

  if (!applications.length && state.applicationsLoading) {
    return (
      <div className="db-app-section" aria-busy="true" aria-live="polite">
        <div className="db-app-section-head">
          <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#1a1f36" }}>Your applications</h2>
        </div>
        <div className="application-loading-state" style={{ padding: "32px 24px" }}>
          <span className="application-loading-spinner" aria-hidden="true"></span>
          <div>
            <strong>Loading your applications…</strong>
            <p>Retrieving the latest application details from your portal.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="db-app-section">
      <div className="db-app-section-head">
        <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#1a1f36" }}>Your applications</h2>
        <div className="db-filter-tabs" role="tablist">
          {[
            { key: "all",         label: `All · ${applications.length}` },
            { key: "in-progress", label: `In progress · ${inProgress.length}` },
            { key: "submitted",   label: `Submitted · ${submitted.length}` },
          ].map(tab => (
            <button
              key={tab.key}
              className={`db-filter-tab${filter === tab.key ? " active" : ""}`}
              role="tab"
              aria-selected={filter === tab.key}
              onClick={() => setFilter(tab.key)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="db-empty-state">
          <p>No {filter === "submitted" ? "submitted" : filter === "in-progress" ? "in-progress" : ""} applications to show.</p>
        </div>
      ) : (
        <div className="db-app-list">
          {filtered.map(app => (
            <ApplicationCard key={getKey(app)} app={app} />
          ))}
        </div>
      )}
    </div>
  );
}

function getKey(app) {
  return app.dealId ? `deal:${app.dealId}` : app.applicationId ? `app:${app.applicationId}` : app.localKey || app.title || "new";
}
