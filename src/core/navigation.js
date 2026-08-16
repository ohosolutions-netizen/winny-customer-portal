// ─────────────────────────────────────────────────────────────────────────
// View / step navigation. The original toggled DOM classes (#dashboardView /
// #wizardView / .wizard-step.active) and called the renderX functions; here the
// same state (state.activeView, applicationData.currentStep) drives React
// conditional rendering, and requestRender() replaces the renderX sweep. All
// side-effect ordering (isStepLocked gate, loadDocumentChecklist on step 3,
// saveDraft, scrollTo, refreshCurrentDealFromCrm) is preserved exactly.
//   Source: showDashboard/showWizard/goToDashboard/showStep (7921-7961).
// ─────────────────────────────────────────────────────────────────────────
import { applicationData, state } from "../store/runtime.js";
import { toast, requestRender } from "../lib/ui.js";
import { isStepLocked } from "./derive.js";
import { saveDraft } from "./drafts.js";
import { refreshCurrentDealFromCrm } from "../api/portal.js";
import { loadDocumentChecklist } from "../api/documents.js";
import { validateDealSubStep, goDealSubStep } from "../api/deal.js";
import { submitQuestionnaire } from "../api/questionnaire.js";
import { completeCIF } from "./cif.js";
import { submitApplication } from "../api/review.js";

export function showDashboard() {
  state.activeView = "dashboard";
  requestRender();
  refreshCurrentDealFromCrm(true);
}

export function showWizard() {
  state.activeView = "wizard";
  showStep(applicationData.currentStep || 1);
}

export function goToDashboard() {
  saveDraft(false);
  showDashboard();
}

export function showStep(stepNumber) {
  if (isStepLocked(stepNumber)) { toast("Complete the previous step first."); return; }
  applicationData.currentStep = stepNumber;
  // Content is rebuilt by React from the mutated applicationData on the next
  // render — the original rebuilt the arriving step's DOM here for the same reason.
  if (stepNumber === 3) loadDocumentChecklist(true);
  saveDraft(false);
  requestRender();
  window.scrollTo(0, 0);
}

// nextStep / previousStep — copied VERBATIM from the original (source 7963-7992).
export function nextStep() {
  if (applicationData.currentStep === 1) {
    if (state.dealSubStep < 4) {
      if (!validateDealSubStep(state.dealSubStep)) return;
      goDealSubStep(state.dealSubStep + 1);
      return;
    }
    if (!applicationData.stepStatus.dealCompleted) { toast("Confirm payment to unlock the questionnaire."); return; }
  }
  if (applicationData.currentStep === 2 && !applicationData.stepStatus.questionnaireCompleted) { submitQuestionnaire(); return; }
  if (applicationData.currentStep === 4) {
    const crmApplicationIds = applicationData.crmSync?.applicationIds || [];
    if (!applicationData.stepStatus.cifCompleted || crmApplicationIds.length === 0) {
      completeCIF();
      return;
    }
  }
  if (applicationData.currentStep === 5) { submitApplication(); return; }
  showStep(Math.min(applicationData.currentStep + 1, 6));
}

export function previousStep() {
  if (applicationData.currentStep === 1 && state.dealSubStep > 1) { goDealSubStep(state.dealSubStep - 1); return; }
  showStep(Math.max(applicationData.currentStep - 1, 1));
}
