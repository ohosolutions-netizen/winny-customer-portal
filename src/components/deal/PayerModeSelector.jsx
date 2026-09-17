import React from "react";
import { applicationData } from "../../store/runtime.js";
import { markAutoSavePending, requestRender } from "../../lib/ui.js";

const MODES = [
  {
    key: "primary",
    label: "I'll pay",
    desc: "The primary applicant pays directly.",
  },
  {
    key: "someone-else",
    label: "Someone else pays",
    desc: "A parent, sponsor, or company pays on your behalf.",
  },
  {
    key: "per-group",
    label: "Each group pays separately",
    desc: "Every group's primary applicant handles their own payment.",
  },
];

function setPayerMode(mode) {
  applicationData.deal.payerMode = mode;
  markAutoSavePending();
  requestRender();
}

function setExternalPayerField(field, value) {
  if (!applicationData.deal.externalPayer) applicationData.deal.externalPayer = {};
  applicationData.deal.externalPayer[field] = value;
  markAutoSavePending();
  requestRender();
}

export default function PayerModeSelector() {
  const deal = applicationData.deal;
  const mode = deal.payerMode || "primary";
  const payer = deal.externalPayer || {};

  // Count distinct family groups — "per-group" only makes sense for 2+
  const groupIds = [...new Set((deal.travellers || []).map((t) => t.familyId || "family-1"))];
  const multiGroup = groupIds.length > 1;

  const visibleModes = MODES.filter((m) => m.key !== "per-group" || multiGroup);

  return (
    <div className="review-card payer-mode-card" style={{ marginBottom: 14 }}>
      <h3 style={{ marginBottom: 12 }}>Who is paying?</h3>
      <div className="payer-mode-toggle">
        {visibleModes.map((m) => (
          <button
            key={m.key}
            type="button"
            className={`payer-mode-btn${mode === m.key ? " active" : ""}`}
            onClick={() => setPayerMode(m.key)}
          >
            <strong>{m.label}</strong>
            <small>{m.desc}</small>
          </button>
        ))}
      </div>

      {mode === "someone-else" && (
        <div className="payer-fields">
          <div className="form-grid">
            <label className="field">
              <span>Payer Full Name <b>*</b></span>
              <input
                type="text"
                placeholder="e.g. Ramesh Patel"
                value={payer.name || ""}
                onChange={(e) => setExternalPayerField("name", e.target.value)}
              />
            </label>
            <label className="field">
              <span>Payer Email</span>
              <input
                type="email"
                placeholder="payer@email.com"
                value={payer.email || ""}
                onChange={(e) => setExternalPayerField("email", e.target.value)}
              />
            </label>
            <label className="field">
              <span>Payer Mobile</span>
              <input
                type="tel"
                placeholder="+91 98200 00000"
                value={payer.mobile || ""}
                onChange={(e) => setExternalPayerField("mobile", e.target.value)}
              />
            </label>
            <label className="field">
              <span>Relation to Applicant</span>
              <select
                value={payer.relation || ""}
                onChange={(e) => setExternalPayerField("relation", e.target.value)}
              >
                <option value="">Select…</option>
                {["Parent", "Spouse", "Sibling", "Child", "Employer / Company", "Sponsor", "Other"].map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}

      {mode === "per-group" && (
        <div className="notice amber" style={{ marginTop: 12 }}>
          <strong>Per-group billing</strong>
          <span>Each group's primary applicant will pay for their own group separately. Winny will coordinate payment with each group lead.</span>
        </div>
      )}
    </div>
  );
}
