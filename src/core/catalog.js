// Product-catalog helpers — copied VERBATIM (source 14043-14219, view builders
// excluded). Pure: goal defs, filters, product card theme/icon/badge/tagline/fee,
// and description parsing.
import { packageCatalog } from "../config/config.js";
import { applicationData, state } from "../store/runtime.js";

    const country = (name, code) => ({ name, code });

    const GOAL_DEFS = [
      {
        key: "study", icon: "🎓", label: "Study Abroad", sub: "Canada, UK, AUS...", countryMode: "multiple",
        featuredCountries: [country("Canada", "CA"), country("United States", "US"), country("United Kingdom", "GB"), country("New Zealand", "NZ"), country("Spain", "ES"), country("Germany", "DE"), country("Malta", "MT"), country("France", "FR")],
        otherCountries: ["Australia", "Ireland", "Italy", "Netherlands", "Finland", "Sweden", "Denmark", "Switzerland", "United Arab Emirates", "Singapore", "Malaysia", "Japan", "South Korea", "Cyprus", "Poland", "Hungary", "Czech Republic", "Portugal"],
        filter: (p) => /study|student|admission|university|college|scholar|education/i.test(productSearchText(p))
      },
      {
        key: "work", icon: "💼", label: "Work & Career", sub: "Germany, GOC...", countryMode: "multiple",
        featuredCountries: [country("Germany", "DE")],
        otherCountries: ["Canada", "Australia", "United Kingdom", "New Zealand", "United Arab Emirates", "United States"],
        filter: (p) => /goc|opportunity card|work permit|owp|nurse|career|job seeker|ausbildung/i.test(productSearchText(p))
      },
      {
        key: "pr", icon: "🏠", label: "Permanent Residency", sub: "Australia, Canada", countryMode: "multiple",
        featuredCountries: [country("Australia", "AU"), country("Canada", "CA")],
        otherCountries: ["New Zealand", "Germany", "United Kingdom", "United States", "Portugal"],
        filter: (p) => /\bpr\b|permanent residen|express entry|nomination|migration/i.test(productSearchText(p))
      },
      {
        key: "visit", icon: "✈️", label: "Visit & Travel", sub: "UK, US, Schengen...", countryMode: "multiple",
        featuredCountries: [country("United States", "US"), country("Canada", "CA"), country("United Kingdom", "GB"), country("Australia", "AU"), country("New Zealand", "NZ"), country("Schengen", "EU"), country("China", "CN"), country("United Arab Emirates", "AE")],
        otherCountries: ["Japan", "South Korea", "Singapore", "Malaysia", "Thailand", "Vietnam", "Indonesia", "Turkey", "South Africa", "Egypt", "Saudi Arabia"],
        filter: (p) => /schengen|europe tourism|documented|usa.*b1.*b2|visitor|visit visa|tourist/i.test(productSearchText(p))
      },
      {
        key: "coaching", icon: "📚", label: "Coaching", sub: "IELTS, PTE, TOEFL...", countryMode: "none",
        featuredCountries: [], otherCountries: [],
        filter: (p) => /ielts|german language|pte|toefl|language training|coaching/i.test(productSearchText(p))
      }
    ];

    const ADDON_DEFS = ["Priority Processing within 7 Business Days","Visa Refusal Insurance","Specific Location","USA Priority Date Booking","Interview Preparation (5 Sessions)"];

    function getGoalDefinition(value) {
      const normalized = String(value || "").trim().toLowerCase();
      if (!normalized) return null;
      const direct = GOAL_DEFS.find(goal => goal.key === normalized || goal.label.toLowerCase() === normalized);
      if (direct) return direct;
      if (/study|student|education/.test(normalized)) return GOAL_DEFS.find(goal => goal.key === "study");
      if (/work|career|permit|goc/.test(normalized)) return GOAL_DEFS.find(goal => goal.key === "work");
      if (/permanent|\bpr\b|migration/.test(normalized)) return GOAL_DEFS.find(goal => goal.key === "pr");
      if (/visit|visitor|travel|tourist|schengen/.test(normalized)) return GOAL_DEFS.find(goal => goal.key === "visit");
      if (/coach|language|ielts|pte|toefl/.test(normalized)) return GOAL_DEFS.find(goal => goal.key === "coaching");
      return null;
    }

    function getGoalProducts(goalKey, selectedCountries = []) {
      const def = GOAL_DEFS.find(g => g.key === goalKey);
      if (!def) return [];
      const selected = Array.isArray(selectedCountries) ? selectedCountries.filter(Boolean) : [selectedCountries].filter(Boolean);
      return packageCatalog.filter((p) => {
        if (!def.filter(p) || (p.category === "Add on" && goalKey !== "coaching")) return false;
        if (def.countryMode === "none" || !selected.length) return true;
        const supported = getProductCountries(p);
        return !supported.length || selected.some((selectedCountry) => supported.some((supportedCountry) => countriesMatch(selectedCountry, supportedCountry)));
      });
    }

    function getGoalCountries(goalKey) {
      const def = GOAL_DEFS.find(g => g.key === goalKey);
      if (!def) return [];
      return [...def.featuredCountries.map(item => item.name), ...def.otherCountries];
    }

    function productSearchText(product) {
      return [
        product.name,
        product.category,
        product.alias,
        product.code,
        ...(product.destinations || []),
        ...(product.tags || [])
      ].filter(Boolean).join(" ");
    }

    const COUNTRY_SEARCH_ALIASES = {
      "United States": ["united states", "usa", "u.s.a", "us", "b1/b2", "b1 b2"],
      "United Kingdom": ["united kingdom", "uk", "u.k."],
      "United Arab Emirates": ["united arab emirates", "uae", "dubai"],
      "New Zealand": ["new zealand", "nz"],
      "South Korea": ["south korea", "korea"],
      "Schengen": ["schengen", "europe tourism"],
      "Australia": ["australia"],
      "Canada": ["canada"],
      "Germany": ["germany", "goc", "opportunity card", "ausbildung"],
      "China": ["china"],
      "Spain": ["spain"],
      "Malta": ["malta"],
      "France": ["france"]
    };

    function normalizeCountry(value) {
      return String(value || "").trim().toLowerCase().replace(/[.]/g, "").replace(/\s+/g, " ");
    }

    function countriesMatch(left, right) {
      const a = normalizeCountry(left);
      const b = normalizeCountry(right);
      if (a === b) return true;
      return Object.entries(COUNTRY_SEARCH_ALIASES).some(([canonical, aliases]) => {
        const values = [canonical, ...aliases].map(normalizeCountry);
        return values.includes(a) && values.includes(b);
      });
    }

    function getProductCountries(product) {
      const explicit = Array.isArray(product.destinations) ? product.destinations.filter(Boolean) : [];
      if (explicit.length) return explicit;
      const text = ` ${productSearchText(product).toLowerCase()} `;
      return Object.entries(COUNTRY_SEARCH_ALIASES)
        .filter(([, aliases]) => aliases.some(alias => {
          const escaped = alias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
        }))
        .map(([canonical]) => canonical);
    }

    function getAddonProducts() {
      return packageCatalog.filter(p => {
        const text = productSearchText(p).toLowerCase();
        if (/ielts|german language|pte|toefl|language training|coaching/.test(text) && !/interview/.test(text)) return false;
        return p.category === "Add on" || ADDON_DEFS.some(n => text.includes(n.slice(0,10).toLowerCase()));
      });
    }

    function getProductDescriptionBullets(pkg) {
      return String(pkg.desc || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(div|p|li)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\r/g, "\n")
        .replace(/\s+(\d+\))/g, "\n$1")
        .split(/\n|;|\u2022|\u2713|\u2714/g)
        .map(line => line.trim().replace(/^\d+\)\s*/, "").replace(/^-+\s*/, ""))
        .filter(line => line && !/^(stage|includes?)\s*:?$/i.test(line));
    }

    function getProductDescriptionLines(pkg) {
      return String(pkg.desc || "")
        .replace(/\r/g, "\n")
        .split(/\n|•|;|\u2713|\u2714/g)
        .map(line => line.trim().replace(/^\d+\)\s*/, "").replace(/^-+\s*/, ""))
        .filter(line => line && !/^(stage|includes?)\s*:?$/i.test(line));
    }

    function getProductCardTheme(pkg) {
      const text = productSearchText(pkg).toLowerCase();
      if (/scholar|funding|refusal|insurance/.test(text)) return "amber";
      if (/premium|priority|smartfile|pr|permanent|residency/.test(text)) return "indigo";
      if (/study|admission|complete|mobility|documented|visitor|schengen|visa/.test(text)) return "teal";
      return "blue";
    }

    function getProductCardIcon(pkg) {
      const text = productSearchText(pkg).toLowerCase();
      if (/scholar|funding/.test(text)) return "🏅";
      if (/admission|study|student/.test(text)) return "📨";
      if (/smartfile|document|visa|visitor|schengen/.test(text)) return "📋";
      if (/work|job|goc|owp|ausbildung/.test(text)) return "💼";
      if (/pr|permanent|residency/.test(text)) return "🏠";
      return "🌟";
    }

    function getProductCardBadge(pkg) {
      const text = productSearchText(pkg).toLowerCase();
      if (pkg.alias) return pkg.alias;
      if (/complete|mobility|premium/.test(text)) return "Most Comprehensive";
      if (/scholar|funding/.test(text)) return "Scholarship Help";
      if (/admission/.test(text)) return "Admission Only";
      if (/smartfile|document/.test(text)) return "SmartFile";
      if (/priority/.test(text)) return "Priority";
      return pkg.category || "Package";
    }

    function getProductCardTagline(pkg) {
      const text = productSearchText(pkg).toLowerCase();
      if (/scholar|funding/.test(text)) return "Just the research report";
      if (/admission/.test(text)) return "Application support and shortlisting";
      if (/smartfile|document/.test(text)) return "Facilitation and documentation only";
      if (/work|job|goc|owp|ausbildung/.test(text)) return "Career and work pathway support";
      if (/pr|permanent|residency/.test(text)) return "Profile and nomination support";
      return "End-to-end application support";
    }

    function getProductFeeNote(pkg) {
      if (!pkg.price || pkg.price <= 0) return "No Winny service fee · third-party fees extra";
      return "Winny service fee · +18% GST · government/third-party fees extra";
    }

export {
  GOAL_DEFS, ADDON_DEFS, getGoalDefinition, getGoalProducts, getGoalCountries, getProductCountries, countriesMatch, productSearchText, getAddonProducts,
  getProductDescriptionBullets, getProductDescriptionLines, getProductCardTheme,
  getProductCardIcon, getProductCardBadge, getProductCardTagline, getProductFeeNote
};
