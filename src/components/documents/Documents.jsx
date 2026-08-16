import React, { useEffect, useRef } from "react";
import * as Docs from "../../api/documents.js";
import { loadDocumentChecklist, renderDocuments } from "../../api/documents.js";

// Documents is an innerHTML island (see api/documents.js). renderDocuments()
// writes into qs("#stepDocuments"), so this component provides that container,
// exposes the inline handlers on window, paints the current state on mount, and
// ensures the checklist is loaded (navigation.showStep(3) also kicks it off; the
// loading guard prevents a double fetch).
const DOC_HANDLERS = ["loadDocumentChecklist", "viewDocumentFile", "handleDocumentFileSelected"];

export default function Documents() {
  const ref = useRef(null);
  useEffect(() => {
    DOC_HANDLERS.forEach((n) => { window[n] = Docs[n]; });
    renderDocuments();
    loadDocumentChecklist();
  }, []);
  return <section id="stepDocuments" className="wizard-step active" ref={ref} />;
}
