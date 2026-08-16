import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { COUNTRIES } from "../../config/config.js";
import { applicationData, state } from "../../store/runtime.js";
import { setByPath } from "../../lib/utils.js";
import { markAutoSavePending, requestRender } from "../../lib/ui.js";
import { reconcileTravellerCountries } from "../../core/deal.js";

// Reproduces multiSelectCountry() (source 13873-13906) + cmsSelect/cmsRemove/
// cmsClear side-effects. The dropdown uses position:fixed (per portal.css), so
// its top/left/width are computed from the trigger rect on open, exactly like
// the original cmsToggle().
function applySelection(path, updated) {
  setByPath(applicationData, path, updated.join(", "));
  if (path === "questionnaire.applyingCountries" || path === "deal.destination") {
    applicationData.stepStatus.cifCompleted = false;
    state.activeCifInstance = null;
    state.activeCifStage = null;
  }
  if (path === "deal.destination") reconcileTravellerCountries();
  markAutoSavePending();
  requestRender();
}

export default function MultiSelectCountry({ label, path }) {
  const selected = pathValue(path).split(",").map((s) => s.trim()).filter(Boolean);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);

  useLayoutEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => { if (!e.target.closest(".cms-wrap")) setOpen(false); };
    const onScrollResize = (e) => { if (e?.target?.closest?.(".cms-dropdown")) return; setOpen(false); };
    document.addEventListener("click", onDocClick);
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    return () => {
      document.removeEventListener("click", onDocClick);
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
    };
  }, [open]);

  const toggleCountry = (country) => {
    const idx = selected.indexOf(country);
    applySelection(path, idx >= 0 ? selected.filter((c) => c !== country) : [...selected, country]);
  };
  const removeCountry = (country) => applySelection(path, selected.filter((c) => c !== country));
  const clearAll = () => applySelection(path, []);

  const q = query.toLowerCase().trim();
  const filtered = COUNTRIES.filter((c) => !q || c.toLowerCase().includes(q));

  return (
    <div className="field full" data-field={path}>
      <label>{label}</label>
      <div className="cms-wrap" ref={wrapRef}>
        <div
          className={`cms-trigger${open ? " open" : ""}`}
          tabIndex={0}
          role="button"
          ref={triggerRef}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
        >
          {selected.length ? (
            selected.map((c) => (
              <span key={c} className="cms-tag">
                {c}
                <button type="button" onClick={(e) => { e.stopPropagation(); removeCountry(c); }}>×</button>
              </span>
            ))
          ) : (
            <span className="cms-placeholder">Select countries...</span>
          )}
        </div>
        <div className={`cms-dropdown${open ? " open" : ""}`} style={pos ? { top: pos.top, left: pos.left, width: pos.width } : undefined}>
          <input
            className="cms-search"
            type="text"
            placeholder="Search countries..."
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClick={(e) => e.stopPropagation()}
          />
          <div className="cms-list">
            {filtered.length ? (
              filtered.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`cms-option${selected.includes(c) ? " selected" : ""}`}
                  data-val={c}
                  onClick={(e) => { e.stopPropagation(); toggleCountry(c); }}
                >
                  {c}
                </button>
              ))
            ) : (
              <div className="cms-empty">{`No results for "${query}"`}</div>
            )}
          </div>
          <div className="cms-footer">
            <span>{selected.length} selected</span>
            <button type="button" className="cms-clear" onClick={(e) => { e.stopPropagation(); clearAll(); }}>Clear all</button>
          </div>
        </div>
      </div>
      <small className="error"></small>
    </div>
  );
}

function pathValue(path) {
  return String(path.split(".").reduce((o, k) => (o == null ? o : o[k]), applicationData) || "");
}
