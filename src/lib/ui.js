// ─────────────────────────────────────────────────────────────────────────
// UI bridge. The original widget called DOM-driven helpers (showLoader, toast,
// openModal, markAutoSavePending) and full re-renders (renderAll) directly from
// logic functions. To keep that logic VERBATIM, those names still exist here as
// thin pass-throughs; the React shell registers the real implementations on
// mount via registerUi(). requestRender() is the renderAll() equivalent — it
// bumps the store version so components re-read the mutated applicationData.
// ─────────────────────────────────────────────────────────────────────────

let impl = {
  showLoader() {},
  hideLoader() {},
  toast() {},
  openModal() {},
  openConfirmModal() {},
  closeModal() {},
  confirmModalOk() {},
  markAutoSavePending() {},
  setAutoSaveLabel() {},
  requestRender() {},
};

export function registerUi(next) {
  impl = { ...impl, ...next };
}

export function showLoader(text) { impl.showLoader(text); }
export function hideLoader()     { impl.hideLoader(); }
export function toast(message)   { impl.toast(message); }
export function openModal(title, body) { impl.openModal(title, body); }
export function openConfirmModal(title, message, onConfirm) { impl.openConfirmModal(title, message, onConfirm); }
export function closeModal()     { impl.closeModal(); }
export function confirmModalOk() { impl.confirmModalOk(); }
export function markAutoSavePending() { impl.markAutoSavePending(); }
export function setAutoSaveLabel(text) { impl.setAutoSaveLabel(text); }
export function requestRender()  { impl.requestRender(); }

export function fail(message) { toast(message); return false; }
