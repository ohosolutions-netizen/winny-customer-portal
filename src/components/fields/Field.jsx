import React from "react";
import { bindInput, fieldErrors } from "../../hooks/useBind.js";

// Reproduces field() (source 13827-13834). Adds the .invalid class + .error text
// exactly as the original validateFieldFormat did on blur.
export function Field({ label, path, type = "text", placeholder = "", required = false, max }) {
  const err = fieldErrors[path] || "";
  return (
    <div className={`field${err ? " invalid" : ""}`} data-field={path}>
      <label>{label}{required ? " *" : ""}</label>
      <input type={type} placeholder={placeholder} max={max} data-required={required ? "true" : undefined} {...bindInput(path)} />
      <small className="error">{err}</small>
    </div>
  );
}

// Reproduces textareaField() (source 13836-13843).
export function TextareaField({ label, path, placeholder = "", extraClass = "" }) {
  const { value, onChange, onBlur, ...rest } = bindInput(path);
  return (
    <div className={`field ${extraClass}`} data-field={path}>
      <label>{label}</label>
      <textarea placeholder={placeholder} value={value} onChange={onChange} onBlur={onBlur} {...rest} />
      <small className="error"></small>
    </div>
  );
}

// Reproduces selectField() (source 13845-13854).
export function SelectField({ label, path, options, required = false }) {
  const { value, onChange, onBlur, ...rest } = bindInput(path);
  return (
    <div className="field" data-field={path}>
      <label>{label}{required ? " *" : ""}</label>
      <select value={value} onChange={onChange} onBlur={onBlur} data-required={required ? "true" : undefined} {...rest}>
        {options.map((opt, i) => (
          <option key={`${opt}-${i}`} value={opt}>{opt ? opt : "-- Select --"}</option>
        ))}
      </select>
      <small className="error"></small>
    </div>
  );
}
