import React, { useEffect, useRef } from "react";
import { renderReview, submitApplication } from "../../api/review.js";
import { showStep } from "../../core/navigation.js";

// Review island — renderReview() writes into qs("#stepReview"). Delegates the
// verbatim data-action buttons (edit-step, submit-application) the way the
// original global handleClick did.
export default function Review() {
  const ref = useRef(null);
  useEffect(() => {
    renderReview();
    const el = ref.current;
    const onClick = (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "submit-application") submitApplication();
      if (action === "edit-step") showStep(Number(btn.dataset.step));
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, []);
  return <section id="stepReview" className="wizard-step active" ref={ref} />;
}
