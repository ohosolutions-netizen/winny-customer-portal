// The original's DOM query helpers. Used by the CIF island (renderCIF writes to
// qs("#stepCIF")) and any other verbatim code that queries by selector.
export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));
