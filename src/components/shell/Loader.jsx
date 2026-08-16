import React from "react";
import { useApp } from "../../store/AppStore.jsx";

// Mirrors <div id="loaderOverlay" class="loader"> — .show toggles visibility.
export default function Loader() {
  const { loader } = useApp();
  return (
    <div id="loaderOverlay" className={`loader${loader.show ? " show" : ""}`} aria-live="polite">
      <div className="loader-box">
        <div className="spin"></div>
        <div id="loaderText">{loader.text}</div>
      </div>
    </div>
  );
}
