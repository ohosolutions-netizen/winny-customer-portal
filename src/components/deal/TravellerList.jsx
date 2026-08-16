import React from "react";
import { applicationData } from "../../store/runtime.js";
import { removeTraveller } from "../../core/deal.js";
import { Field, SelectField } from "../fields/Field.jsx";

// Reproduces renderTravellerList() (source 2908-2927).
export default function TravellerList() {
  const travellers = applicationData.deal.travellers;
  return (
    <div className="traveller-list" id="travellerList">
      {travellers.map((traveller, index) => (
        <article className="traveller-card" key={traveller.id}>
          <div className="traveller-head">
            <div className="traveller-title">
              <span className="avatar">{index === 0 ? "PA" : index + 1}</span>
              <span>{traveller.type || "Traveller"}</span>
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
  );
}
