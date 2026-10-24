import React, { useEffect, useRef } from "react";
import * as Docs from "../../api/documents.js";
import { loadDocumentChecklist, renderDocuments } from "../../api/documents.js";
import { state } from "../../store/runtime.js";

const DOC_HANDLERS = ["loadDocumentChecklist", "viewDocumentFile", "handleDocumentFileSelected", "switchDocumentUnit"];

export default function Documents() {
  const ref = useRef(null);
  useEffect(() => {
    DOC_HANDLERS.forEach((n) => { window[n] = Docs[n]; });
    state.activeFamilyUnit = "all"; // always start on the "All travellers" view
    renderDocuments();
    loadDocumentChecklist();
  }, []);
  return <section id="stepDocuments" className="wizard-step active" ref={ref} />;
}
