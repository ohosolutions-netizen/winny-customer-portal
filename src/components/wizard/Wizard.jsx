import React from "react";
import { applicationData, state } from "../../store/runtime.js";
import { steps } from "../../config/config.js";
import { useApp } from "../../store/AppStore.jsx";
import { isStepLocked, isStepDone, getCompletionPercent } from "../../core/derive.js";
import { showStep, goToDashboard, nextStep, previousStep } from "../../core/navigation.js";
import { toast } from "../../lib/ui.js";
import WizardSidebar from "./WizardSidebar.jsx";
import DealStep from "../deal/DealStep.jsx";
import Questionnaire from "../questionnaire/Questionnaire.jsx";
import CIF from "../cif/CIF.jsx";
import Documents from "../documents/Documents.jsx";
import Review from "../review/Review.jsx";
import Success from "../success/Success.jsx";

// Reproduces renderStepper() (source 2486-2497).
function WizardStepper() {
  const percent = getCompletionPercent();
  return (
    <>
      <div className="progress-bg" aria-label="Application progress">
        <div className="progress-fill" id="wizardProgressBar" style={{ width: `${percent}%` }}></div>
      </div>
      <div id="stepper" className="stepper" style={{ marginTop: 12 }}>
        {steps.map((step) => {
          const locked = isStepLocked(step.id);
          const done = isStepDone(step.id);
          const active = applicationData.currentStep === step.id;
          return (
            <button
              key={step.id}
              className={`step ${done ? "done" : ""} ${active ? "active" : ""} ${locked ? "locked" : ""}`}
              type="button"
              disabled={locked}
              onClick={() => showStep(step.id)}
            >
              <span className="step-dot">{done ? "✓" : step.id}</span>{step.label}
            </button>
          );
        })}
      </div>
    </>
  );
}

// Reproduces the static #wizardView shell (source 1233-1260) + updateWizardHeader()
// (source 13764-13771).
export default function Wizard() {
  const { autoSaveState } = useApp();
  const step = steps.find((s) => s.id === applicationData.currentStep) || steps[0];
  const backDisabled = applicationData.currentStep === 1 && state.dealSubStep === 1;
  const nextText = applicationData.currentStep === 5 ? "Submit Application" : applicationData.currentStep === 6 ? "Submitted" : "Next";
  const nextDisabled = applicationData.currentStep === 6;

  return (
    <section id="wizardView" className="wizard active">
      <div className="wz-layout">
        <WizardSidebar />

        <div className="wz-main">
          <div id="wizardHeader" className="wizard-header">
            <div className="wizard-head-row">
              <div className="wizard-title">
                <h2 id="wizardTitle">{step.title}</h2>
                <p id="wizardSubtitle">{step.subtitle}</p>
              </div>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>{autoSaveState}</span>
            </div>
          </div>

          <main id="wizardContent" className="wizard-content">
            {applicationData.currentStep === 1 && <DealStep />}
            {applicationData.currentStep === 2 && <Questionnaire />}
            {applicationData.currentStep === 3 && <Documents />}
            {applicationData.currentStep === 4 && <CIF />}
            {applicationData.currentStep === 5 && <Review />}
            {applicationData.currentStep === 6 && <Success />}
          </main>

          <footer id="wizardFooter" className="wizard-footer">
            <button className="btn" type="button" onClick={() => goToDashboard()}>← Back to dashboard</button>
            <button className="btn" type="button" id="footerBack" disabled={backDisabled} onClick={() => previousStep()}>← Previous</button>
            <button className="btn primary" type="button" id="footerNext" disabled={nextDisabled} onClick={() => {
              if (applicationData.currentStep === 1 && state.dealSubStep === 2) {
                const today = new Date().toISOString().slice(0, 10);
                const from = applicationData.deal.travelDateFrom;
                if (from && from < today) {
                  toast("Please fix the departure date — it cannot be in the past.");
                  return;
                }
              }
              nextStep();
            }}>{nextText} →</button>
          </footer>
        </div>
      </div>
    </section>
  );
}
