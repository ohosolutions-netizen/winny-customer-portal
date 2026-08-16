import React from "react";

// Mirrors the original <header id="topNavigation" class="top-nav"> markup.
// nav-actions was populated/cleared by renderDashboard(); kept as an empty slot.
export default function TopNav() {
  return (
    <header id="topNavigation" className="top-nav">
      <div className="brand">
        <div className="wmark" aria-hidden="true"></div>
        <div>
          <h1 className="brand-name">Winny Global</h1>
          <p className="brand-sub">Customer Portal</p>
        </div>
      </div>
      <div className="nav-actions"></div>
    </header>
  );
}
