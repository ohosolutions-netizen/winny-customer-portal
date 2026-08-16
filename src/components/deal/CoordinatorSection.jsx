import React from "react";
import { applicationData } from "../../store/runtime.js";
import { addCoordinator, removeCoordinator, toggleCoordAssign, toggleCoordAuth } from "../../core/deal.js";
import { Field, SelectField } from "../fields/Field.jsx";

// Reproduces renderCoordinatorList() (source 2286-2325).
export function CoordinatorList() {
  const coord = applicationData.customer.coordinator;
  if (!coord) {
    return (
      <div id="coordinatorList">
        <button className="btn ghost" type="button" style={{ width: "100%", justifyContent: "center", padding: 14, border: "2px dashed #cddcf5" }} onClick={() => addCoordinator()}>
          + Add Coordinator
        </button>
      </div>
    );
  }
  return (
    <div id="coordinatorList">
      <div className="traveller-card">
        <div className="traveller-head">
          <div className="traveller-title">
            <span className="avatar" style={{ background: "#f3f0ff", color: "#7c3aed" }}>C1</span>
            <span>Coordinator{coord.name ? " — " + coord.name : ""}</span>
          </div>
          <button className="btn danger" type="button" onClick={() => removeCoordinator()}>Remove</button>
        </div>
        <div className="form-grid">
          <Field label="Full Name *" path="customer.coordinator.name" type="text" placeholder="Full legal name" required />
          <SelectField label="Relationship" path="customer.coordinator.relationship" options={["", "Son / Daughter", "Nephew / Niece", "Sibling", "Parent", "Spouse", "Agent / Consultant", "Friend", "Other"]} />
          <Field label="Mobile *" path="customer.coordinator.mobile" type="tel" placeholder="+91 XXXXX XXXXX" required />
          <Field label="Email *" path="customer.coordinator.email" type="email" placeholder="coordinator@email.com" required />
        </div>
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 8 }}>Assigned to which travellers?</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {applicationData.deal.travellers.map((t) => (
              <label className="check-row" style={{ padding: "8px 12px" }} key={t.id}>
                <input type="checkbox" checked={(coord.assignedTo || []).includes(t.id)} onChange={(e) => toggleCoordAssign(t.id, e.target.checked)} />
                <span>{`${t.firstName || ""} ${t.lastName || ""}`.trim() || t.type || "Traveller"}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Reproduces renderAuthorisationList() (source 2328-2356).
export function AuthorisationList() {
  const coord = applicationData.customer.coordinator;
  if (!coord || !coord.name) {
    return <div id="authorisationList"><div style={{ fontSize: 13, color: "var(--muted)", textAlign: "center", padding: "14px 0" }}>Add a coordinator above to enable authorisation.</div></div>;
  }
  const relevant = applicationData.deal.travellers.filter((t) => (coord.assignedTo || []).includes(t.id));
  if (!relevant.length) {
    return <div id="authorisationList"><div style={{ fontSize: 13, color: "var(--muted)", textAlign: "center", padding: "14px 0" }}>Assign the coordinator to at least one traveller above.</div></div>;
  }
  return (
    <div id="authorisationList">
      {relevant.map((t) => {
        const travName = `${t.firstName || ""} ${t.lastName || ""}`.trim() || t.type;
        return (
          <div className={`auth-block ${coord.authorised ? "ok" : ""}`} style={{ marginBottom: 10, padding: 14, border: "1.5px solid var(--line)", borderRadius: 12, background: coord.authorised ? "var(--soft-teal)" : "#fff" }} key={t.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span className="avatar" style={{ background: "var(--soft-blue)", color: "var(--blue)" }}>{(travName[0] || "T").toUpperCase()}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 800 }}>{travName}</div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>Coordinator: {coord.name || "Coordinator"}</div>
              </div>
              {coord.authorised ? <span style={{ fontSize: 12, fontWeight: 800, color: "var(--green)" }}>✓ Authorised</span> : null}
            </div>
            <label className="check-row" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={coord.authorised} onChange={(e) => toggleCoordAuth(e.target.checked)} />
              <span style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                I, <strong>{travName}</strong>, authorise <strong>{coord.name || "the coordinator"}</strong> to share information and coordinate with Winny Global on my behalf.
              </span>
            </label>
          </div>
        );
      })}
    </div>
  );
}
