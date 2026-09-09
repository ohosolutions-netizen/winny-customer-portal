import React from "react";
import { applicationData } from "../../store/runtime.js";
import { setApplicationType } from "../../core/deal.js";

const TYPES = [
  {
    key: "individual",
    icon: "🧑",
    title: "Just me",
    desc: "Single traveller. You answer your own visa questions privately.",
    badge: "1 person",
  },
  {
    key: "family",
    icon: "👨‍👩‍👧",
    title: "Family / Couple",
    desc: "2–6 people from one household. One payer, shared answers per family.",
    badge: "Up to 6 people",
  },
  {
    key: "friends",
    icon: "👥",
    title: "Friends / Group",
    desc: "Multiple friends travelling together. Separate financial responsibility per person.",
    badge: "Multiple people",
  },
  {
    key: "corporate",
    icon: "🏢",
    title: "Corporate / Company",
    desc: "Company-sponsored travel. Company pays, each employee answers privately.",
    badge: "Company travel",
  },
];

export default function ApplicationTypeSelector() {
  const current = applicationData.deal.applicationType || "";
  return (
    <div className="app-type-grid">
      {TYPES.map((t) => (
        <button
          key={t.key}
          className={`app-type-card${current === t.key ? " selected" : ""}`}
          type="button"
          onClick={() => setApplicationType(t.key)}
        >
          <span className="app-type-icon" aria-hidden="true">{t.icon}</span>
          <strong className="app-type-title">{t.title}</strong>
          <p className="app-type-desc">{t.desc}</p>
          <span className="app-type-badge">{t.badge}</span>
        </button>
      ))}
    </div>
  );
}
