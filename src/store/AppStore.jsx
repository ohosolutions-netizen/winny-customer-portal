// ─────────────────────────────────────────────────────────────────────────
// AppStore — the single source of truth wrapper around the mutable runtime
// singletons (applicationData, state). It mirrors the original widget's model:
// logic mutates applicationData in place, then a re-render is requested. Here
// requestRender() bumps `version` so subscribed components re-read the model.
//
// It also registers the real implementations for the UI bridge (loader, toast,
// modal, autosave label) so verbatim logic can keep calling showLoader/toast/…
// ─────────────────────────────────────────────────────────────────────────
import React, { createContext, useContext, useState, useRef, useCallback, useMemo, useEffect } from "react";
import { applicationData, state } from "./runtime.js";
import { registerUi } from "../lib/ui.js";
import { escapeHtml } from "../lib/utils.js";

const AppContext = createContext(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within <AppStore>");
  return ctx;
}

let toastSeq = 0;

export function AppStore({ children }) {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // Shell UI state (drives the Loader / Toasts / Modal components below).
  const [loader, setLoader] = useState({ show: false, text: "Loading portal..." });
  const [toasts, setToasts] = useState([]);
  const [modal, setModal] = useState({ show: false, title: "Notice", kind: "text", body: "", message: "" });
  const [autoSaveState, setAutoSaveState] = useState("Ready");
  const pendingConfirmRef = useRef(null);

  const closeModal = useCallback(() => {
    pendingConfirmRef.current = null;
    state.pendingConfirmCallback = null;
    setModal((m) => ({ ...m, show: false }));
  }, []);

  const confirmModalOk = useCallback(() => {
    const cb = pendingConfirmRef.current || state.pendingConfirmCallback;
    pendingConfirmRef.current = null;
    state.pendingConfirmCallback = null;
    setModal((m) => ({ ...m, show: false }));
    if (typeof cb === "function") cb();
  }, []);

  // Register the UI bridge implementations once.
  useEffect(() => {
    registerUi({
      showLoader: (text) => setLoader({ show: true, text: text || "Loading..." }),
      hideLoader: () => setLoader((l) => ({ ...l, show: false })),
      toast: (message) => {
        const id = ++toastSeq;
        setToasts((list) => [...list, { id, message }]);
        setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 3600);
      },
      openModal: (title, body) => setModal({ show: true, title, kind: "text", body: String(body ?? ""), message: "" }),
      openConfirmModal: (title, message, onConfirm) => {
        pendingConfirmRef.current = onConfirm;
        state.pendingConfirmCallback = onConfirm;
        setModal({ show: true, title, kind: "confirm", body: "", message: String(message ?? "") });
      },
      closeModal,
      confirmModalOk,
      markAutoSavePending: () => setAutoSaveState("Unsaved changes"),
      setAutoSaveLabel: (text) => setAutoSaveState(text),
      requestRender: bump,
    });
  }, [bump, closeModal, confirmModalOk]);

  const value = useMemo(
    () => ({
      data: applicationData,
      state,
      version,
      bump,
      loader,
      toasts,
      modal,
      autoSaveState,
      setAutoSaveState,
      closeModal,
      confirmModalOk,
    }),
    [version, bump, loader, toasts, modal, autoSaveState, closeModal, confirmModalOk]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export { escapeHtml };
