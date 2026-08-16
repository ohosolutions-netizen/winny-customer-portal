import React from "react";
import { applicationData } from "../../store/runtime.js";
import { addFamilyGroup, addTraveller, removeTraveller } from "../../core/deal.js";
import { Field, SelectField } from "../fields/Field.jsx";

const DEFAULT_FAMILY_ID = "family-1";

export default function TravellerList() {
  const travellers = applicationData.deal.travellers;
  const families = [];

  travellers.forEach((traveller, index) => {
    const familyId = traveller.familyId || DEFAULT_FAMILY_ID;
    let family = families.find((item) => item.id === familyId);
    if (!family) {
      family = { id: familyId, members: [] };
      families.push(family);
    }
    family.members.push({ traveller, index });
  });

  return (
    <div className="traveller-list" id="travellerList">
      <div className="family-entry-notice">
        <span aria-hidden="true">💡</span>
        <span>Add each person under their family. Every traveller will still be saved as an individual traveller record.</span>
      </div>

      {families.map((family, familyIndex) => (
        <section className="traveller-family" key={family.id}>
          <div className="traveller-family-head">
            <div>
              <span className="traveller-family-kicker">Family group</span>
              <h4>Family {familyIndex + 1}</h4>
            </div>
            <span className="traveller-family-count">
              {family.members.length} {family.members.length === 1 ? "traveller" : "travellers"}
            </span>
          </div>

          <div className="traveller-family-members">
            {family.members.map(({ traveller, index }, memberIndex) => (
              <article className="traveller-card" key={traveller.id}>
                <div className="traveller-head">
                  <div className="traveller-title">
                    <span className="avatar">{index === 0 ? "PA" : memberIndex + 1}</span>
                    <span>
                      {traveller.type || "Traveller"}
                      {memberIndex === 0 ? ` — Family ${familyIndex + 1}` : ""}
                    </span>
                  </div>
                  <button className="btn danger" type="button" disabled={travellers.length === 1} onClick={() => removeTraveller(traveller.id)}>Remove</button>
                </div>
                <div className="form-grid three">
                  <Field label="First Name" path={`deal.travellers.${index}.firstName`} type="text" placeholder="First name" required />
                  <Field label="Last Name" path={`deal.travellers.${index}.lastName`} type="text" placeholder="Last name" required />
                  <SelectField label="Traveller Type" path={`deal.travellers.${index}.type`} options={["Primary Applicant", "Spouse", "Child", "Parent", "Additional Traveller", "Other"]} />
                  <Field label="Date of Birth" path={`deal.travellers.${index}.dob`} type="date" placeholder="" />
                  <Field label="Nationality" path={`deal.travellers.${index}.nationality`} type="text" placeholder="Indian" />
                  <Field label="Email" path={`deal.travellers.${index}.email`} type="email" placeholder="traveller@example.com" />
                  <Field label="Mobile" path={`deal.travellers.${index}.mobile`} type="tel" placeholder="+91" />
                </div>
              </article>
            ))}
          </div>

          <button className="family-member-add" type="button" onClick={() => addTraveller(family.id)}>
            <span aria-hidden="true">+</span>
            Add family member to Family {familyIndex + 1}
          </button>
        </section>
      ))}

      <button className="add-family-group" type="button" onClick={() => addFamilyGroup()}>
        <span className="add-family-group-icon" aria-hidden="true">👨‍👩‍👧</span>
        <span className="add-family-group-copy">
          <strong>Add another family group</strong>
          <small>Keep separate families organised within the same application</small>
        </span>
        <span className="add-family-group-plus" aria-hidden="true">+</span>
      </button>
    </div>
  );
}
