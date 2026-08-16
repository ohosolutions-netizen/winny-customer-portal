import React, { useEffect, useRef } from "react";
import * as Q from "../../core/questionnaire.js";
import { renderQuestionnaireHTML, registerQuestionnaireRerender } from "../../core/questionnaire.js";
import { showStep } from "../../core/navigation.js";

// The questionnaire is a self-contained imperative island (see core/questionnaire.js).
// This component injects the verbatim HTML and exposes the inline q* handlers on
// window so the original onclick/oninput attributes work unchanged. rerender
// re-injects (the original's two renderQuestionnaire() self-calls). Section
// navigation and dependent-block toggles are handled by the q* handlers against
// the injected DOM, exactly as before.
const Q_HANDLERS = [
  "qSelOpt", "qTogOpt", "qTogMulti", "qSetField", "qSetTravelDate",
  "qFinSel", "qFinTogFunding", "qFinTogM", "qFinSetField", "qTieTogM",
  "qChiSel", "qHistSel", "qHistSetField", "qGoNext", "qGoPrev", "qSubmitFinal",
];

export default function Questionnaire() {
  const ref = useRef(null);

  useEffect(() => {
    Q_HANDLERS.forEach((name) => { window[name] = Q[name]; });

    const inject = () => { if (ref.current) ref.current.innerHTML = renderQuestionnaireHTML(); };
    registerQuestionnaireRerender(inject);
    inject();

    // The "already submitted" view uses a data-step-nav button; the original had
    // a global click delegation for it. Scope one to this container.
    const el = ref.current;
    const onClick = (e) => {
      const btn = e.target.closest("[data-step-nav]");
      if (btn) showStep(Number(btn.dataset.stepNav));
    };
    el.addEventListener("click", onClick);

    return () => {
      el.removeEventListener("click", onClick);
      registerQuestionnaireRerender(null);
    };
  }, []);

  return <section id="stepQuestionnaire" className="wizard-step active" ref={ref} />;
}
