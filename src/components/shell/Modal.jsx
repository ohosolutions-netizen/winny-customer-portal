import React from "react";
import { useApp } from "../../store/AppStore.jsx";

// Mirrors <div id="modalBackdrop" class="modal-backdrop">. openModal() shows a
// plain-text body; openConfirmModal() shows the Cancel/OK confirm layout — both
// reproduced here with identical markup/classes.
export default function Modal() {
  const { modal, closeModal, confirmModalOk } = useApp();
  const isWide = modal.kind === "wide";
  const modalStyle = isWide
    ? { width: "min(900px, 96vw)", maxHeight: "90vh", display: "flex", flexDirection: "column" }
    : {};
  const bodyStyle = isWide
    ? { padding: "18px", overflowY: "auto", flex: 1 }
    : {};

  return (
    <div id="modalBackdrop" className={`modal-backdrop${modal.show ? " show" : ""}`}
      style={isWide ? { alignItems: "center" } : {}}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" style={modalStyle}>
        <div className="modal-head">
          <h3 id="modalTitle">{modal.title}</h3>
          <button className="btn" type="button" onClick={closeModal}>Close</button>
        </div>
        <div className="modal-body" id="modalBody" style={bodyStyle}>
          {modal.kind === "confirm" ? (
            <>
              <p style={{ margin: "0 0 18px", lineHeight: 1.6 }}>{modal.message}</p>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button className="btn" type="button" onClick={closeModal}>Cancel</button>
                <button className="btn danger" type="button" onClick={confirmModalOk}>OK</button>
              </div>
            </>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: modal.body }} />
          )}
        </div>
      </div>
    </div>
  );
}
