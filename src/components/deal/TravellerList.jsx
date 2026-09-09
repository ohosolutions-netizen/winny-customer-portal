import React from "react";
import { applicationData } from "../../store/runtime.js";
import { addFamilyGroup, addTraveller, removeTraveller, setTravellerType } from "../../core/deal.js";
import { Field } from "../fields/Field.jsx";

const DEFAULT_FAMILY_ID = "family-1";

export default function TravellerList() {
  const travellers = applicationData.deal.travellers;

  // Group by familyId — each group is one "card block"
  const groups = [];
  travellers.forEach((traveller, index) => {
    const fid = traveller.familyId || DEFAULT_FAMILY_ID;
    let group = groups.find((g) => g.id === fid);
    if (!group) { group = { id: fid, members: [] }; groups.push(group); }
    group.members.push({ traveller, index });
  });

  return (
    <div className="traveller-list" id="travellerList">

      <div className="traveller-group-guide">
        <div className="traveller-guide-row">
          <span>👨‍👩‍👧</span>
          <span><strong>Same group</strong> — share one questionnaire (e.g. parent &amp; child, husband &amp; wife)</span>
        </div>
        <div className="traveller-guide-row">
          <span>👤</span>
          <span><strong>Separate group</strong> — each gets their own questionnaire (e.g. friends, sibling, colleague, grandparent with grandchild)</span>
        </div>
      </div>

      {groups.map((group, groupIndex) => {
        const lead = group.members[0]?.traveller;
        const leadName = lead
          ? `${lead.firstName || ""}${lead.lastName ? " " + lead.lastName : ""}`.trim() || `Person ${groupIndex + 1}`
          : `Person ${groupIndex + 1}`;

        return (
          <div className="traveller-group" key={group.id}>

            {/* Group members */}
            {group.members.map(({ traveller, index }, memberIndex) => (
              <article className="traveller-card" key={traveller.id}>
                <div className="traveller-head">
                  <div className="traveller-title">
                    <span className="avatar">
                      {memberIndex === 0 ? (groupIndex === 0 ? "PA" : String(groupIndex + 1)) : "·"}
                    </span>
                    <span>
                      {memberIndex === 0
                        ? (groupIndex === 0 ? "Primary Applicant" : "Independent Traveller")
                        : "Family Member"}
                    </span>
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
                  <Field
                    label={traveller.type === "Primary Applicant" ? "Primary Applicant Email" : "Email"}
                    path={`deal.travellers.${index}.email`}
                    type="email"
                    placeholder="traveller@example.com"
                    required={traveller.type === "Primary Applicant"}
                  />
                  <Field label="Mobile" path={`deal.travellers.${index}.mobile`} type="tel" placeholder="+91" required />
                </div>
              </article>
            ))}

            {/* Add family member to this group */}
            <button className="family-member-add" type="button" onClick={() => addTraveller(group.id)}>
              <span aria-hidden="true">+</span>
              Add a family member to {leadName}&apos;s group
            </button>

          </div>
        );
      })}

      {/* Add a new independent traveller / group */}
      <button className="add-family-group" type="button" onClick={() => addFamilyGroup()}>
        <span className="add-family-group-icon" aria-hidden="true">👤</span>
        <span className="add-family-group-copy">
          <strong>Add another traveller / group</strong>
          <small>Each separate group gets its own questionnaire</small>
        </span>
        <span className="add-family-group-plus" aria-hidden="true">+</span>
      </button>

    </div>
  );
}
