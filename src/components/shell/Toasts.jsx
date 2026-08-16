import React from "react";
import { useApp } from "../../store/AppStore.jsx";

// Mirrors <div id="toastContainer" class="toast-container"> with .toast children.
export default function Toasts() {
  const { toasts } = useApp();
  return (
    <div id="toastContainer" className="toast-container" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">{t.message}</div>
      ))}
    </div>
  );
}
