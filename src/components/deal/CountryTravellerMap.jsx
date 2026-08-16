import React from "react";
import { applicationData } from "../../store/runtime.js";
import { getDestinationCountries, toggleTravellerCountry } from "../../core/deal.js";
import { deriveTravellerRelationship } from "../../core/derive.js";
import { requestRender } from "../../lib/ui.js";

// Reproduces renderCountryTravellerMap() (source 2817-2853).
export default function CountryTravellerMap() {
  const dest = getDestinationCountries();
  const travellers = applicationData.deal.travellers;
  if (!dest.length || !travellers.length) {
    return (
      <div id="countryTravellerMap">
        <div style={{ fontSize: 13, color: "var(--muted)", textAlign: "center", padding: "14px 0" }}>
          Select a destination and add travellers to assign them to countries.
        </div>
      </div>
    );
  }
  const onToggle = (id, country, checked) => { toggleTravellerCountry(id, country, checked); requestRender(); };
  return (
    <div id="countryTravellerMap">
      {dest.map((country) => (
        <div className="traveller-card" style={{ marginBottom: 12 }} key={country}>
          <div className="traveller-head" style={{ marginBottom: 10 }}>
            <div className="traveller-title">
              <span className="avatar">{country.slice(0, 2).toUpperCase()}</span>
              <span>{country}</span>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {travellers.map((t, index) => {
              const name = `${t.firstName || ""} ${t.lastName || ""}`.trim() || `Traveller ${index + 1}`;
              const role = t.type === "Primary Applicant" ? "Primary Applicant" : deriveTravellerRelationship(t, travellers) || t.type || "Traveller";
              const checked = (t.countries || []).includes(country);
              return (
                <label className="check-row" style={{ padding: "8px 12px" }} key={t.id}>
                  <input type="checkbox" checked={checked} onChange={(e) => onToggle(t.id, country, e.target.checked)} />
                  <span>{name} <small style={{ color: "var(--muted)" }}>— {role}</small></span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
