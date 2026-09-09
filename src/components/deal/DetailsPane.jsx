import React from "react";
import { applicationData } from "../../store/runtime.js";
import { isDealSaved } from "../../core/derive.js";
import { saveDealDetails } from "../../api/deal.js";
import { Field } from "../fields/Field.jsx";
import TravellerList from "./TravellerList.jsx";
import ApplicationTypeSelector from "./ApplicationTypeSelector.jsx";
import { CoordinatorList, AuthorisationList } from "./CoordinatorSection.jsx";

const TRAVELLER_PANEL_LABELS = {
  individual: { title: "Your Details", sub: "Just you — fill in your own details below." },
  family:     { title: "Family Members", sub: "Add everyone travelling with you as part of your family." },
  friends:    { title: "Travellers", sub: "Add each person travelling in your group — they will each get a separate questionnaire." },
  corporate:  { title: "Employees", sub: "Add each employee travelling — each one will fill their own questionnaire privately." },
};

export default function DetailsPane() {
  const dealSaved = isDealSaved();
  const appType = applicationData.deal.applicationType || "";
  const typeSelected = !!appType;
  const panelLabel = TRAVELLER_PANEL_LABELS[appType] || { title: "Families & Travellers", sub: "Group applicants family-wise while keeping an individual record for every traveller." };

  return (
    <>
      <section className="wizard-panel">
        <div className="panel-head">
          <div>
            <h3>Your Details</h3>
            <p>{dealSaved ? "Your application is saved." : "Fill in your details to create your application."}</p>
          </div>
        </div>
        <div className="panel-body">
          {dealSaved ? (
            <div className="notice teal">
              <strong>✓ Application saved</strong>
              <span>Your application has been created. Add travellers below.</span>
            </div>
          ) : null}
          <div className="form-grid">
            <Field label="First Name" path="customer.firstName" type="text" placeholder="First name" required />
            <Field label="Last Name" path="customer.lastName" type="text" placeholder="Last name" required />
            <Field label="Email Address" path="customer.email" type="email" placeholder="your@email.com" required />
            <Field label="Mobile" path="customer.mobile" type="tel" placeholder="+91 98200 00000" required />
            <Field label="Nationality" path="customer.nationality" type="text" placeholder="Indian" />
          </div>
          {dealSaved ? null : (
            <div style={{ marginTop: 16 }}>
              <button className="btn primary" type="button" onClick={() => saveDealDetails()}>Save &amp; Continue</button>
            </div>
          )}
        </div>
      </section>

      {/* Application type selector — shown after deal is saved */}
      <section className={`wizard-panel ${dealSaved ? "" : "hidden"}`}>
        <div className="panel-head">
          <div>
            <h3>Who is this application for?</h3>
            <p>Choose the type that best describes your travel group. This affects how we collect details and questionnaires.</p>
          </div>
        </div>
        <div className="panel-body">
          <ApplicationTypeSelector />
        </div>
      </section>

      {/* Traveller list — shown only after type is selected */}
      <section className={`wizard-panel ${dealSaved && typeSelected ? "" : "hidden"}`}>
        <div className="panel-head">
          <div>
            <h3>{panelLabel.title}</h3>
            <p>{panelLabel.sub}</p>
          </div>
        </div>
        <div className="panel-body">
          <TravellerList />
        </div>
      </section>

      <section className={`wizard-panel ${dealSaved ? "" : "hidden"}`}>
        <div className="panel-head"><div><h3>📞 Contact / Coordinator</h3><p>Optional — only if someone else is helping manage this case (son, nephew, agent, consultant).</p></div></div>
        <div className="panel-body">
          <div className="notice amber"><strong>💡 Optional</strong> <span>Skip if handling everything yourself. Add only one family member, agent, or consultant if they are coordinating on behalf of the applicants.</span></div>
          <CoordinatorList />
        </div>
      </section>

      <section className={`wizard-panel ${dealSaved && applicationData.customer.coordinator ? "" : "hidden"}`} id="authorisationPanel">
        <div className="panel-head"><div><h3>✅ Authorisation</h3><p>Each adult applicant confirms their coordinator may act on their behalf with Winny Global.</p></div></div>
        <div className="panel-body">
          <div className="notice amber"><strong>🔒 Required when a coordinator is added</strong> <span>Each adult confirms that their coordinator may share information and coordinate with Winny Global on their behalf.</span></div>
          <AuthorisationList />
        </div>
      </section>
    </>
  );
}
