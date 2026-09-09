import React from "react";
import { applicationData } from "../../store/runtime.js";
import { addFamilyGroup, addTraveller, addIndependentTraveller, removeTraveller, setTravellerType } from "../../core/deal.js";
import { Field } from "../fields/Field.jsx";

const DEFAULT_FAMILY_ID = "family-1";

function TravellerFields({ traveller, index }) {
  return (
    <div className="form-grid three">
      <Field label="First Name" path={`deal.travellers.${index}.firstName`} type="text" placeholder="First name" required />
      <Field label="Last Name" path={`deal.travellers.${index}.lastName`} type="text" placeholder="Last name" required />
      <div className="field" data-field={`deal.travellers.${index}.type`}>
        <label>Traveller Type</label>
        <select value={traveller.type || ""} onChange={(e) => setTravellerType(traveller.id, e.target.value)}>
          {["Primary Applicant", "Spouse", "Child", "Parent", "Additional Traveller", "Other"].map((o) => (
            <option value={o} key={o}>{o}</option>
          ))}
        </select>
        <small className="error"></small>
      </div>
      <Field label="Date of Birth" path={`deal.travellers.${index}.dob`} type="date" placeholder="" required />
      <Field label="Nationality" path={`deal.travellers.${index}.nationality`} type="text" placeholder="Indian" />
      <Field label={traveller.type === "Primary Applicant" ? "Primary Applicant Email" : "Email"} path={`deal.travellers.${index}.email`} type="email" placeholder="traveller@example.com" required={traveller.type === "Primary Applicant"} />
      <Field label="Mobile" path={`deal.travellers.${index}.mobile`} type="tel" placeholder="+91" required />
    </div>
  );
}

// ── Friends / Corporate: flat list, each person is independent ──────────────
function IndependentList({ travellers, appType }) {
  const label = appType === "corporate" ? "Employee" : "Traveller";
  const addLabel = appType === "corporate" ? "Add employee" : "Add traveller";

  return (
    <div className="traveller-list" id="travellerList">
      <div className="family-entry-notice">
        <span aria-hidden="true">💡</span>
        <span>
          {appType === "corporate"
            ? "Each employee will get their own separate questionnaire to fill privately."
            : "Each person will get their own separate questionnaire to fill privately."}
        </span>
      </div>

      {travellers.map((traveller, index) => (
        <article className="traveller-card" key={traveller.id}>
          <div className="traveller-head">
            <div className="traveller-title">
              <span className="avatar">{index + 1}</span>
              <span>{index === 0 ? `Primary Applicant` : `${label} ${index + 1}`}</span>
            </div>
            <button
              className="btn danger"
              type="button"
              disabled={travellers.length === 1}
              onClick={() => removeTraveller(traveller.id)}
            >
              Remove
            </button>
          </div>
          <TravellerFields traveller={traveller} index={index} />
        </article>
      ))}

      <button className="family-member-add" type="button" onClick={() => addIndependentTraveller()}>
        <span aria-hidden="true">+</span>
        {addLabel}
      </button>
    </div>
  );
}

// ── Individual: only the primary applicant, no add buttons ──────────────────
function IndividualList({ travellers }) {
  const traveller = travellers[0];
  if (!traveller) return null;
  return (
    <div className="traveller-list" id="travellerList">
      <article className="traveller-card" key={traveller.id}>
        <div className="traveller-head">
          <div className="traveller-title">
            <span className="avatar">PA</span>
            <span>Primary Applicant</span>
          </div>
        </div>
        <TravellerFields traveller={traveller} index={0} />
      </article>
    </div>
  );
}

// ── Family: grouped view (existing behaviour), no "add another family" button ─
function FamilyList({ travellers }) {
  const families = [];
  travellers.forEach((traveller, index) => {
    const familyId = traveller.familyId || DEFAULT_FAMILY_ID;
    let family = families.find((f) => f.id === familyId);
    if (!family) { family = { id: familyId, members: [] }; families.push(family); }
    family.members.push({ traveller, index });
  });

  return (
    <div className="traveller-list" id="travellerList">
      <div className="family-entry-notice">
        <span aria-hidden="true">💡</span>
        <span>Add each person travelling with you. Everyone in one family shares the same questionnaire.</span>
      </div>

      {families.map((family, familyIndex) => (
        <section className="traveller-family" key={family.id}>
          <div className="traveller-family-head">
            <div>
              <span className="traveller-family-kicker">Your family</span>
              <h4>Family members</h4>
            </div>
            <span className="traveller-family-count">
              {family.members.length} {family.members.length === 1 ? "person" : "people"}
            </span>
          </div>

          <div className="traveller-family-members">
            {family.members.map(({ traveller, index }, memberIndex) => (
              <article className="traveller-card" key={traveller.id}>
                <div className="traveller-head">
                  <div className="traveller-title">
                    <span className="avatar">{traveller.type === "Primary Applicant" ? "PA" : memberIndex + 1}</span>
                    <span>{traveller.type || "Traveller"}</span>
                  </div>
                  <button
                    className="btn danger"
                    type="button"
                    disabled={travellers.length === 1}
                    onClick={() => removeTraveller(traveller.id)}
                  >
                    Remove
                  </button>
                </div>
                <TravellerFields traveller={traveller} index={index} />
              </article>
            ))}
          </div>

          <button className="family-member-add" type="button" onClick={() => addTraveller(family.id)}>
            <span aria-hidden="true">+</span>
            Add family member
          </button>
        </section>
      ))}
    </div>
  );
}

// ── Multi-family (Friends who each have their own family) ───────────────────
function MultiFamilyList({ travellers }) {
  const families = [];
  travellers.forEach((traveller, index) => {
    const familyId = traveller.familyId || DEFAULT_FAMILY_ID;
    let family = families.find((f) => f.id === familyId);
    if (!family) { family = { id: familyId, members: [] }; families.push(family); }
    family.members.push({ traveller, index });
  });

  return (
    <div className="traveller-list" id="travellerList">
      <div className="family-entry-notice">
        <span aria-hidden="true">💡</span>
        <span>Each group will get a separate questionnaire. Add family members within each group.</span>
      </div>

      {families.map((family, familyIndex) => (
        <section className="traveller-family" key={family.id}>
          <div className="traveller-family-head">
            <div>
              <span className="traveller-family-kicker">Group {familyIndex + 1}</span>
              <h4>{family.members[0]?.traveller?.firstName
                ? `${family.members[0].traveller.firstName}'s group`
                : `Group ${familyIndex + 1}`}
              </h4>
            </div>
            <span className="traveller-family-count">
              {family.members.length} {family.members.length === 1 ? "person" : "people"}
            </span>
          </div>

          <div className="traveller-family-members">
            {family.members.map(({ traveller, index }, memberIndex) => (
              <article className="traveller-card" key={traveller.id}>
                <div className="traveller-head">
                  <div className="traveller-title">
                    <span className="avatar">{memberIndex === 0 ? "PA" : memberIndex + 1}</span>
                    <span>{traveller.type || "Traveller"}{memberIndex === 0 ? ` — Group ${familyIndex + 1}` : ""}</span>
                  </div>
                  <button
                    className="btn danger"
                    type="button"
                    disabled={travellers.length === 1}
                    onClick={() => removeTraveller(traveller.id)}
                  >
                    Remove
                  </button>
                </div>
                <TravellerFields traveller={traveller} index={index} />
              </article>
            ))}
          </div>

          <button className="family-member-add" type="button" onClick={() => addTraveller(family.id)}>
            <span aria-hidden="true">+</span>
            Add person to {family.members[0]?.traveller?.firstName
              ? `${family.members[0].traveller.firstName}'s group`
              : `Group ${familyIndex + 1}`}
          </button>
        </section>
      ))}

      <button className="add-family-group" type="button" onClick={() => addFamilyGroup()}>
        <span className="add-family-group-icon" aria-hidden="true">👥</span>
        <span className="add-family-group-copy">
          <strong>Add another group</strong>
          <small>Each group travels together and shares a questionnaire</small>
        </span>
        <span className="add-family-group-plus" aria-hidden="true">+</span>
      </button>
    </div>
  );
}

export default function TravellerList() {
  const travellers = applicationData.deal.travellers;
  const appType = applicationData.deal.applicationType || "family";

  if (appType === "individual") return <IndividualList travellers={travellers} />;
  if (appType === "friends" || appType === "corporate") return <IndependentList travellers={travellers} appType={appType} />;
  if (appType === "family") return <FamilyList travellers={travellers} />;
  // fallback for "friends-with-families" or unrecognised — use multi-family grouped view
  return <MultiFamilyList travellers={travellers} />;
}
