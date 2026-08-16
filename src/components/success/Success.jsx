import React, { useEffect, useRef } from "react";
import { renderSuccess } from "../../api/review.js";

// Success island — renderSuccess() writes into qs("#stepSuccess").
export default function Success() {
  const ref = useRef(null);
  useEffect(() => { renderSuccess(); }, []);
  return <section id="stepSuccess" className="wizard-step active" ref={ref} />;
}
