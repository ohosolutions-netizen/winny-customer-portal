import React, { useState } from "react";
import { applicationData, state } from "../../store/runtime.js";
import { packageCatalog } from "../../config/config.js";
import { formatCurrency } from "../../lib/utils.js";
import { isFullyPaidStatus } from "../../core/derive.js";
import {
  GOAL_DEFS, getGoalProducts, getAddonProducts, getProductDescriptionBullets,
  getProductCardTheme, getProductCardIcon, getProductCardBadge, getProductCardTagline, getProductFeeNote,
} from "../../core/catalog.js";
import {
  setGoal, closeGoal, getSelectedServiceTypeKey, selectPendingPackage, toggleAssignTraveller,
  getGoalCountrySelection, getPackageDestinationCountries, toggleGoalCountry,
  addPendingToBasket, removeBasketItem, toggleAddon,
} from "../../core/deal.js";
import CountryTravellerMap from "./CountryTravellerMap.jsx";

// Reproduces renderGoalTiles() (source 14075-14093).
function GoalTiles() {
  const selectedGoalKey = getSelectedServiceTypeKey();
  return (
    <div className="service-goal-grid">
      {GOAL_DEFS.map((g) => {
        const active = state.activeGoal === g.key;
        const chosen = selectedGoalKey === g.key;
        const disabled = Boolean(selectedGoalKey) && !chosen;
        return (
          <button key={g.key} className={`goal-tile ${active ? "active" : ""}${chosen ? " chosen" : ""}`} type="button" onClick={() => setGoal(g.key)} disabled={disabled}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "16px 10px", border: `2px solid ${active || chosen ? "var(--blue)" : "var(--line)"}`, borderRadius: 14, background: active || chosen ? "var(--soft-blue)" : "#fff", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? .48 : 1, transition: "all .2s", textAlign: "center", minHeight: 100, position: "relative" }}>
            <div style={{ fontSize: 26, marginBottom: 7 }}>{g.icon}</div>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: active ? "var(--blue)" : "var(--navy)", lineHeight: 1.3 }}>{g.label}</div>
            <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 3 }}>{g.sub}</div>
            {chosen ? <div style={{ position: "absolute", top: 6, right: 8, fontSize: 11, fontWeight: 900, color: "var(--blue)" }}>{active ? "▼" : "✓"}</div> : null}
          </button>
        );
      })}
    </div>
  );
}

function CountrySelector({ goal }) {
  const [showOther, setShowOther] = useState(false);
  if (goal.countryMode === "none") {
    return (
      <div className="service-flow-note">
        <span>🌐</span>
        <span>This service is available online and does not require a destination.</span>
      </div>
    );
  }

  const selected = getGoalCountrySelection(goal.key);
  const selectedOther = goal.otherCountries.filter(item => selected.includes(item));
  const selectCountry = (country) => toggleGoalCountry(goal.key, country);

  return (
    <div className="service-country-step">
      <div className="service-flow-heading">
        <div>
          <strong>{goal.icon} {goal.label} — {goal.countryMode === "multiple" ? "Select destinations" : "Choose destination"}</strong>
          <small>{goal.countryMode === "multiple" ? "Select every country needed for this application." : "Choose a country to see its available product packages."}</small>
        </div>
      </div>
      <div className="service-country-grid">
        {goal.featuredCountries.map(item => {
          const active = selected.includes(item.name);
          return (
            <button key={item.name} type="button" className={`service-country-card${active ? " active" : ""}`} onClick={() => selectCountry(item.name)}>
              <span className="service-country-code">{item.code}</span>
              <span>{item.name}</span>
              {active ? <b>✓</b> : null}
            </button>
          );
        })}
        {goal.otherCountries.length ? (
          <button type="button" className={`service-country-card other${showOther || selectedOther.length ? " active" : ""}`} onClick={() => setShowOther(value => !value)}>
            <span className="service-country-code">🌍</span>
            <span>Other</span>
            <small>{goal.otherCountries.length} more</small>
          </button>
        ) : null}
      </div>
      {showOther ? (
        <div className="service-other-country">
          <label htmlFor={`other-country-${goal.key}`}>Other country</label>
          <select id={`other-country-${goal.key}`} value="" onChange={(event) => { if (event.target.value) selectCountry(event.target.value); }}>
            <option value="">— Select country —</option>
            {goal.otherCountries.map(item => <option key={item} value={item}>{selected.includes(item) ? `✓ ${item}` : item}</option>)}
          </select>
          {selectedOther.length ? (
            <div className="service-country-tags">
              {selectedOther.map(item => <button key={item} type="button" onClick={() => selectCountry(item)}>{item} ×</button>)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Reproduces renderProductTileCard() (source 14132-14153).
function ProductTileCard({ pkg }) {
  const sel = state.pendingPackageId === pkg.id;
  const descLines = getProductDescriptionBullets(pkg).slice(0, 8);
  return (
    <button className={`package-card ${sel ? "selected" : ""}`} type="button" data-theme={getProductCardTheme(pkg)} onClick={() => selectPendingPackage(pkg.id)}>
      <div className="pkg-badge">{getProductCardBadge(pkg)}</div>
      <div className="pkg-icon-chip">{getProductCardIcon(pkg)}</div>
      <div className="pkg-card-name">{pkg.name}</div>
      <div className="pkg-card-tag">{getProductCardTagline(pkg)}</div>
      <div className="package-price">{pkg.price > 0 ? formatCurrency(pkg.price) : "Free"}</div>
      <div className="pkg-fee-note">{getProductFeeNote(pkg)}</div>
      {descLines.length ? (
        <ul className="pkg-includes">{descLines.map((line, i) => <li key={i}>{line}</li>)}</ul>
      ) : (
        <div className="pkg-empty-desc">Service details will be confirmed by your case officer.</div>
      )}
    </button>
  );
}

// Reproduces renderApplicantAssignment() (source 14238-14276).
function ApplicantAssignment() {
  const travellers = applicationData.deal.travellers;
  if (!travellers.length) return null;
  const pkg = packageCatalog.find((p) => p.id === state.pendingPackageId);
  if (!pkg) return null;
  const assigned = state.pendingAssignedTo || [];
  const activeGoal = GOAL_DEFS.find(goal => goal.key === state.activeGoal);
  if (activeGoal?.countryMode !== "none") {
    const assignedTravellers = travellers.filter(traveller => assigned.includes(traveller.id));
    const packageDestinations = getPackageDestinationCountries(activeGoal.key, pkg.id);
    return (
      <div className={`package-assignment-summary${assignedTravellers.length ? " ready" : " missing"}`}>
        <div>
          <strong>👥 Travellers included in this package</strong>
          <small>Automatically taken from the country assignment above—no second selection is needed.</small>
          {packageDestinations.length ? <small className="package-assignment-destinations">📍 Package destination: {packageDestinations.join(", ")}</small> : null}
        </div>
        {assignedTravellers.length ? (
          <>
            <div className="package-assignment-names">
              {assignedTravellers.map((traveller, index) => {
                const name = `${traveller.firstName || ""} ${traveller.lastName || ""}`.trim() || traveller.type || `Traveller ${index + 1}`;
                return <span key={traveller.id}>✓ {name}</span>;
              })}
            </div>
            <div className="package-assignment-total">
              <span>{assignedTravellers.length} traveller{assignedTravellers.length !== 1 ? "s" : ""} × {formatCurrency(pkg.price)}</span>
              <strong>{formatCurrency(pkg.price * assignedTravellers.length)}</strong>
            </div>
          </>
        ) : (
          <div className="package-assignment-warning">Assign at least one traveller to a destination above to add this package.</div>
        )}
      </div>
    );
  }
  return (
    <div style={{ border: "1.5px solid var(--teal)", borderRadius: 12, background: "var(--soft-teal)", padding: 14, marginTop: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 900, color: "#07766a", marginBottom: 10 }}>
        👤 Who is this <strong>{pkg.name}</strong> for?
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", marginLeft: 6 }}>{formatCurrency(pkg.price)} per person</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {travellers.map((t, i) => {
          const name = `${t.firstName || ""} ${t.lastName || ""}`.trim() || t.type || `Traveller ${i + 1}`;
          const isOn = assigned.includes(t.id);
          return (
            <label key={t.id} onClick={() => toggleAssignTraveller(t.id)}
              style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 13px", border: `1.5px solid ${isOn ? "var(--teal)" : "var(--line)"}`, borderRadius: 10, background: "#fff", cursor: "pointer", transition: "all .18s", userSelect: "none" }}>
              <span style={{ width: 20, height: 20, borderRadius: 5, border: `2px solid ${isOn ? "var(--teal)" : "var(--line)"}`, background: isOn ? "var(--teal)" : "#fff", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 900, color: "#fff", flexShrink: 0, transition: "all .18s" }}>{isOn ? "✓" : ""}</span>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>{name}</span>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>{t.type || ""}</span>
              {isOn ? <span style={{ fontSize: 13, fontWeight: 900, color: "var(--blue)" }}>{formatCurrency(pkg.price)}</span> : null}
            </label>
          );
        })}
      </div>
      {assigned.length ? (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed rgba(6,201,181,.3)", display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 800, color: "var(--navy)" }}>
          <span>{assigned.length} applicant{assigned.length > 1 ? "s" : ""} selected</span>
          <span>{formatCurrency(pkg.price * assigned.length)}</span>
        </div>
      ) : null}
    </div>
  );
}

// Reproduces renderAddonSection() (source 14278-14308).
function AddonSection() {
  const addons = getAddonProducts();
  if (!addons.length) return null;
  const activeAddons = applicationData.deal.selectedAddons || [];
  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
      <div style={{ fontSize: 11, fontWeight: 900, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".6px", marginBottom: 10 }}>➕ Optional Add-ons</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {addons.map((a) => {
          const on = activeAddons.includes(a.id);
          return (
            <div key={a.id} onClick={() => toggleAddon(a.id)} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 0", borderBottom: "1px solid #f0f3f9", cursor: "pointer" }}>
              <div style={{ width: 20, height: 20, borderRadius: 6, border: `2px solid ${on ? "var(--teal)" : "var(--line)"}`, background: on ? "var(--teal)" : "#fff", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 800, color: "#fff", flexShrink: 0, marginTop: 2, transition: "all .18s" }}>{on ? "✓" : "+"}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{a.name}</div>
                {a.desc ? <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>{a.desc.replace(/[✔✓]\s?/g, "").split("\n")[0].slice(0, 80)}</div> : null}
              </div>
              <div style={{ fontSize: 14, fontWeight: 800, color: "var(--blue)", flexShrink: 0 }}>{a.price > 0 ? "+" + formatCurrency(a.price) : "Free"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Reproduces renderActiveGoalPanel() (source 14095-14130).
function ActiveGoalPanel() {
  if (!state.activeGoal) {
    return (
      <div style={{ textAlign: "center", padding: 28, border: "2px dashed var(--line)", borderRadius: 14, color: "var(--muted)", marginBottom: 14 }}>
        <div style={{ fontSize: 32, marginBottom: 10 }}>☝️</div>
        <div style={{ fontWeight: 800, color: "var(--ink)" }}>Select a service category above</div>
        <div style={{ fontSize: 13, marginTop: 4 }}>Click a tile to see available packages</div>
      </div>
    );
  }
  const goal = GOAL_DEFS.find((g) => g.key === state.activeGoal);
  const selectedCountries = getGoalCountrySelection(state.activeGoal);
  const countryReady = goal.countryMode === "none" || selectedCountries.length > 0;
  const products = countryReady ? getGoalProducts(state.activeGoal, selectedCountries) : [];
  const travellers = applicationData.deal.travellers;
  return (
    <div style={{ border: "1.5px solid var(--line)", borderRadius: 14, overflow: "hidden", marginBottom: 14, animation: "fadeUp .2s ease" }}>
      <div style={{ padding: "14px 18px", background: "#fafbff", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontWeight: 900, fontSize: 15, color: "var(--navy)" }}>{goal.icon} {goal.label}</div>
        <button className="btn" type="button" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => closeGoal()}>✕ Close</button>
      </div>
      <div style={{ padding: 18 }}>
        <CountrySelector goal={goal} />
        {countryReady ? (
          <>
            {goal.countryMode !== "none" ? (
              <div className="service-traveller-country-map integrated">
                <div className="service-flow-heading"><div><strong>Assign travellers to destinations</strong><small>Select travellers once here. The same assignment is used automatically when calculating each package.</small></div></div>
                <CountryTravellerMap />
              </div>
            ) : null}
            <div className="service-package-step">
              <div className="service-flow-heading">
                <div><strong>Product packages</strong><small>Choose the package that best fits this application.</small></div>
              </div>
              {products.length ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 12, marginBottom: 16 }}>
                  {products.map((pkg) => <ProductTileCard key={pkg.id} pkg={pkg} />)}
                </div>
              ) : (
                <div className="service-empty-packages">No product package is currently mapped to this service and destination.</div>
              )}
              {state.pendingPackageId ? <ApplicantAssignment /> : null}
              {state.pendingPackageId && travellers.length ? (
                <div style={{ textAlign: "right", marginTop: 12 }}>
                  <button className="btn primary" type="button" disabled={!state.pendingAssignedTo?.length} style={{ display: "inline-flex", alignItems: "center", gap: 8, opacity: state.pendingAssignedTo?.length ? 1 : .5, cursor: state.pendingAssignedTo?.length ? "pointer" : "not-allowed" }} onClick={() => addPendingToBasket()}>➕ Add to basket →</button>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
        <AddonSection />
      </div>
    </div>
  );
}

// Reproduces renderServiceBasket() (source 14310-14352).
export function ServiceBasket({ compact = false }) {
  const basket = applicationData.deal.serviceBasket || [];
  const addons = applicationData.deal.selectedAddons || [];
  const addonItems = getAddonProducts().filter((a) => addons.includes(a.id));
  const paid = isFullyPaidStatus(applicationData.payment.status);
  if (!basket.length && !addonItems.length) {
    return (
      <div className={compact ? "summary-service-basket" : ""} style={{ textAlign: "center", padding: compact ? 14 : 20, border: "2px dashed #d0daf0", borderRadius: 14, color: "var(--muted)" }}>
        <div style={{ fontSize: compact ? 22 : 28, marginBottom: 8 }}>🛒</div>
        <div style={{ fontWeight: 800, fontSize: 13, color: "var(--ink)" }}>Your basket is empty</div>
        <div style={{ fontSize: 12, marginTop: 4 }}>Select a package and assign travellers to add it here</div>
      </div>
    );
  }
  const total = basket.reduce((s, i) => s + i.total, 0) + addonItems.reduce((s, a) => s + a.price, 0);
  const count = basket.length + addonItems.length;
  return (
    <div className={compact ? "summary-service-basket" : ""} style={{ border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden", marginTop: 4 }}>
      <div style={{ padding: "12px 16px", background: "linear-gradient(135deg,var(--navy),#2a2060)", color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 14, fontWeight: 900 }}>🗺️ Your Service Basket</div>
        <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.5)" }}>{count} item{count !== 1 ? "s" : ""}</div>
      </div>
      <div style={{ padding: "10px 14px" }}>
        {basket.map((item) => (
          <div key={item.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 0", borderBottom: "1px solid #f0f3f9" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 800 }}>{item.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>{item.applicants}</div>
              {item.destinations?.length ? <div style={{ fontSize: 11, color: "var(--blue)", marginTop: 3 }}>📍 {item.destinations.join(", ")}</div> : null}
            </div>
            <div style={{ fontWeight: 900, color: "var(--blue)", fontSize: 14 }}>{formatCurrency(item.total)}</div>
            <button type="button" onClick={() => removeBasketItem(item.id)} disabled={paid} title={paid ? "Paid services cannot be removed" : "Remove this package"} aria-label={`Remove ${item.name}`} style={{ background: "none", border: "none", cursor: paid ? "not-allowed" : "pointer", opacity: paid ? .4 : 1, color: "var(--muted)", fontSize: 16, padding: "0 4px", lineHeight: 1 }}>✕</button>
          </div>
        ))}
        {addonItems.map((a) => (
          <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid #f0f3f9" }}>
            <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 700 }}>{a.name}</div><div style={{ fontSize: 11, color: "var(--muted)" }}>Add-on</div></div>
            <div style={{ fontWeight: 900, color: "var(--blue)" }}>{formatCurrency(a.price)}</div>
            <button type="button" onClick={() => toggleAddon(a.id)} disabled={paid} title={paid ? "Paid add-ons cannot be removed" : "Remove this add-on"} aria-label={`Remove ${a.name}`} style={{ background: "none", border: "none", cursor: paid ? "not-allowed" : "pointer", opacity: paid ? .4 : 1, color: "var(--muted)", fontSize: 16, padding: "0 4px", lineHeight: 1 }}>✕</button>
          </div>
        ))}
      </div>
      <div style={{ padding: "12px 16px", background: "#f4f6fb", borderTop: "2px solid var(--line)", display: "flex", justifyContent: "space-between", fontWeight: 900, fontSize: 15, color: "var(--navy)" }}>
        <span>{compact ? "Basket total" : "Basket total (excl. GST)"}</span><span>{formatCurrency(total)}</span>
      </div>
    </div>
  );
}

// Reproduces renderDealPane() sub-step 2 (source 2612-2622).
export default function ServicesPane() {
  const selectedGoalKey = getSelectedServiceTypeKey();
  const selectedGoal = GOAL_DEFS.find(goal => goal.key === selectedGoalKey);
  const hasBasketServices = (applicationData.deal.serviceBasket || []).length > 0;
  const paid = isFullyPaidStatus(applicationData.payment.status);
  return (
    <section className="wizard-panel">
      <div className="panel-head">
        <div><h3>Choose Services</h3><p>Choose one service type, then select multiple destinations and product packages within it.</p></div>
      </div>
      <div className="panel-body">
        <GoalTiles />
        {selectedGoal ? (
          <div className="service-type-lock-note">
            {hasBasketServices && paid
              ? `${selectedGoal.label} is selected and locked because payment is complete.`
              : hasBasketServices
                ? `${selectedGoal.label} is selected. Click it again to remove its unpaid basket items and choose another service type.`
              : `${selectedGoal.label} is selected. Click it again to deselect and enable the other service types.`}
          </div>
        ) : null}
        <ActiveGoalPanel />
      </div>
    </section>
  );
}
