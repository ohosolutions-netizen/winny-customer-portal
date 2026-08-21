// ─────────────────────────────────────────────────────────────────────────
// Questionnaire submit + save — copied VERBATIM from the original widget.
// saveQuestionnaire() builds the exact Visitor_Visa_Questionnaire_Sales1 payload
// (verified choice-value maps, fixed Traveller_1..4 slot mapping, exact Creator
// field link names) and saves via CREATOR.DATA.addRecords / CREATOR.API.addRecord.
// Mechanical change only: submitQuestionnaire's renderQuestionnaire() →
// rerenderQuestionnaire().
// ─────────────────────────────────────────────────────────────────────────
import { CONFIG } from "../config/config.js";
import { applicationData, state } from "../store/runtime.js";
import { toast, showLoader, hideLoader, fail } from "../lib/ui.js";
import { saveDraft } from "../core/drafts.js";
import { showStep } from "../core/navigation.js";
import { scheduleDocumentChecklistRefresh } from "./documents.js";
import {
  validateQuestionnaireForCreator, isQuestionnaireChild, rerenderQuestionnaire,
  showQuestionnaireValidationSection
} from "../core/questionnaire.js";

    // ── submitQuestionnaire (source 9038-9098) ──
    async function submitQuestionnaire() {
  if (applicationData.stepStatus.questionnaireCompleted) {
    toast(
      "This questionnaire has already been submitted and is locked."
    );
    rerenderQuestionnaire();
    return false;
  }

  if (state.submittingQuestionnaire) {
    toast("Questionnaire submission is already in progress.");
    return false;
  }

  state.submittingQuestionnaire = true;

  const validationError = validateQuestionnaireForCreator();

  if (validationError) {
    state.submittingQuestionnaire = false;
    showQuestionnaireValidationSection();
    return fail(validationError);
  }
      if (!applicationData.deal.crmDealId) {
        return fail("No CRM Deal ID found. Please open the correct application or save the deal again before submitting the questionnaire.");
      }
      showLoader("Saving questionnaire...");
      try {
                const questionnaireResult = await saveQuestionnaire();
        const questionnaireRecordId =
          questionnaireResult?.data?.ID ||
          questionnaireResult?.data?.id ||
          "";

        if (!questionnaireRecordId) {
          throw new Error(
            "Zoho did not return a questionnaire record ID. The questionnaire has not been marked complete."
          );
        }

        applicationData.questionnaire.creatorRecordId =
          questionnaireRecordId;

        applicationData.stepStatus.questionnaireCompleted = true;
        state.documents.items = [];
        state.documents.loaded = false;
        state.documents.loadedForDealId = null;
        saveDraft(false);
      toast("Questionnaire submitted ✓ CIF unlocked.");
      showStep(3);
      scheduleDocumentChecklistRefresh();
      return true;
      } catch (error) {
        console.error("[Winny] Questionnaire submit failed:", error);
        applicationData.stepStatus.questionnaireCompleted = false;
        toast(`Questionnaire save failed: ${error.message || error}`);
        return false;
      } finally {
  state.submittingQuestionnaire = false;
  hideLoader();
}
    }

    // ── saveQuestionnaire (source 10733-11360) ──
    async function saveQuestionnaire() {
      if (!applicationData.deal.crmDealId) {
        throw new Error("CRM Deal ID is missing. Questionnaire cannot be linked to the correct Deal.");
      }
      saveDraft(false);   // always save to localStorage first

      const q    = applicationData.questionnaire;
const fin  = q.finance || {};
const hist = q.history || {};
const ties = q.ties    || {};

const selectedPurposeKeys =
  Array.isArray(q.purpose) ? q.purpose : [];

const hasFamilyPurposeForSave =
  selectedPurposeKeys.includes("family");

const hasInviterPurposeForSave =
  selectedPurposeKeys.some((purpose) =>
    [
      "family",
      "friend",
      "family-func",
      "convocation",
      "business"
    ].includes(purpose)
  );

      const allTravellers = applicationData.deal.travellers;
      const paT = allTravellers.find(t => t.type === "Primary Applicant") || allTravellers[0] || {};
      const paId = paT.id || "";
      const paFin  = fin[paId]  || {};
const paHist = hist[paId] || {};
const paTiesM = (ties[paId] || {}).multiAnswers || {};

const paFinanceAnswers =
  paFin.multiAnswers || {};

const paFundingSelections =
  Array.isArray(paFin.funding)
    ? paFin.funding
    : (paFin.funding ? [paFin.funding] : []);

const paHasSponsor =
  paFundingSelections.includes("sponsor");

const paIsBusinessOwner =
  Boolean(paFinanceAnswers["occ-business"]);

const paHasOtherOccupation =
  Boolean(paFinanceAnswers["occ-other"]);

const paNeedsItr = [
  "occ-employed",
  "occ-freelancer",
  "occ-pensioner",
  "occ-business"
].some((key) => Boolean(paFinanceAnswers[key]));

const paHasOtherAsset =
  Boolean(paFinanceAnswers["asset-other"]);

const paHasOtherInvestment =
  Boolean(paFinanceAnswers["inv-other"]);

      const spouseT = allTravellers.find(t => t.type === "Spouse");
      const spId = spouseT ? spouseT.id : "";
      const spFin  = spId ? (fin[spId]  || {}) : {};
const spHist = spId ? (hist[spId] || {}) : {};

const spFinanceAnswers =
  spFin.multiAnswers || {};

const spIsBusinessOwner =
  Boolean(spFinanceAnswers["occ-business"]);

const spHasOtherOccupation =
  Boolean(spFinanceAnswers["occ-other"]);

const spNeedsItr = [
  "occ-employed",
  "occ-freelancer",
  "occ-pensioner",
  "occ-business",
  "occ-other"
].some((key) => Boolean(spFinanceAnswers[key]));

      const childrenAll =
  allTravellers.filter(isQuestionnaireChild);

const childrenList =
  childrenAll.slice(0, 3); // Creator supports Child 1/2/3 only

      // ── Fixed-slot Traveller_1..4 assignment ─────────────────────────────
      // Spouse and children get filled first (they have valid Relation picklist
      // values: "Spouse" / "Child 1-3"). Any remaining slots (up to 4 total) are
      // then filled with other companion types (Additional Traveller/Parent/Other)
      // so their NAME still appears — but Relation is left blank for these, since
      // Traveller_N_Relation is a single-select picklist whose only valid choices
      // are Spouse/Child 1/Child 2/Child 3 — there is no valid value to send for
      // any other type without the Zoho form being changed to allow it.
      const travellerSlots = [];
      if (spouseT) travellerSlots.push({ trav: spouseT, relation: "Spouse" });
      childrenList.forEach((c, i) => travellerSlots.push({ trav: c, relation: `Child ${i+1}` }));
      const otherCompanions = allTravellers.filter(t =>
        t.id !== paId && t.id !== spId && !childrenList.some(c => c.id === t.id)
      );
      otherCompanions.forEach(t => {
        if (travellerSlots.length < 4) travellerSlots.push({ trav: t, relation: "" });
      });
      const slotName = (i) => travellerSlots[i] ? `${travellerSlots[i].trav.firstName||""} ${travellerSlots[i].trav.lastName||""}`.trim() : "";
      const slotRelation = (i) => travellerSlots[i] ? travellerSlots[i].relation : "";

      // Total headcount = everyone except the primary applicant, regardless of type
      // (Spouse/Child/Additional Traveller/Parent/Other all count here — this is a
      // separate concept from the Traveller_1..4 slots below, which only support Spouse/Child)
      const companionCount = allTravellers.filter(t => t.id !== paId).length;
      const totalCountVal = companionCount === 0 ? "None" : String(Math.min(companionCount, 4));

      // ── Choice-value maps (verified against the live Visitor_Visa_Questionnaire_Sales1 form) ──
      const purposeMap = {
        "family": "To meet Family Members/ Relatives", "family-func": "To attend family function",
        "tourism": "Tourism", "business": "Business Visit", "friend": "To meet Friend",
        "convocation": "To attend convocation", "transit": "Transit", "medical": "Medical Treatment",
        "other": "Other / Just exploring"
      };
      const functionTypeMap = { wedding:"Wedding", engagement:"Engagement", reception:"Reception", anniversary:"Anniversary", birthday:"Birthday", housewarming:"Housewarming" };
      const maritalStatusMap = { single:"Single(Never Married)", married:"Married", divorced:"Divorced", widowed:"Widowed", separated:"Separated" };
      const inviterRelationMap = { direct:"Directly related to me", spouse:"Related to my spouse" };
      const inviterMap = {
  father: "Father ",
  mother: "Mother",
  brother: "Brother",
  sister: "Sister",
  son: "Son",
  daughter: "Daughter",
  uncle: "Uncle",
  aunt: "Aunt",
  cousin: "Cousin",
  grandson: "Grandson",
  granddaughter: "Granddaughter",
  husband: "Husband",
  wife: "Wife",
  grandparents: "Grandparents"
};
      const inviterStatusMap = { citizen:"Citizen", pr:"Permanent Resident", work:"Work Visa Holder", student:"Student Visa Holder" };
      const sponsorMap = {
        parent:"Parent (Father / Mother)", spouse:"Spouse (Husband / Wife)", sibling:"Sibling (Brother / Sister)",
        extended:"Extended Relative (Uncle,Aunt,Cousin)", employer:"Current Employee", event:"Event Organizers"
      };
      const fundsRangeMap = { "4-7l":"4 -7 Lakh INR", "7-10l":"7-10 Lakh INR", "10-15l":"10-15 Lakh INR", "15-20l":"15-20 Lakh INR", "20l-plus":"20 Lakh+ INR" };
      const occMapPrimary = {
        "occ-employed":"Employed (Job)", "occ-freelancer":"Self employed (Freelancer)", "occ-business":"Business Owner",
        "occ-homemaker":"Homemaker", "occ-pensioner":"Retired with pension", "occ-retired-nopension":"Retired without pension",
        "occ-student":"Student", "occ-unemployed":"Unemployed", "occ-other":"Other (Please Specify)"
      };
      const occMapSpouse = {
        "occ-employed":"Employed (Job)", "occ-freelancer":"Self employed (Freelancer)", "occ-business":"Business Owner",
        "occ-pensioner":"Retired with Pension", "occ-student":"Student", "occ-homemaker":"Homemaker",
        "occ-retired-nopension":"Retired without Pension", "occ-other":"Other (Please Specify)"
      };
      const bizTypeMap = { sole:"Sole Proprietorship (Sole owner)", partnership:"Partnership", pvtltd:"Public, Private, or an LLP" };
      const spouseBizTypeMap = { sole:"Sole owner", partnership:"Partnership", pvtllp:"Public, private, or LLP" };
      const assetMap = {
        "asset-house":"House", "asset-shop":"Shop", "asset-office":"Office", "asset-building":"Building",
        "asset-flat":"Apartment", "asset-factory":"Factory", "asset-shed":"Shed", "asset-warehouse":"Warehouse",
        "asset-plot":"Plot", "asset-land":"Land", "asset-none":"None", "asset-other":"Other (Please Specify)"
      };
      const investMap = {
        "inv-stocks":"Stock Market", "inv-bank":"Bank Savings", "inv-fd":"FD (Fix deposits)", "inv-mf":"Mutual Funds",
        "inv-ppf":"PPF (Public Provident Fund)", "inv-epf":"EPF (Employee's Provident Fund)", "inv-bonds":"Bonds",
        "inv-gold":"Gold", "inv-postal":"Postal Certificate/Savings", "inv-none":"I do not have any investments",
        "inv-other":"Other (Please Specify)"
      };
      const tiesMap = {
        "housing":"Position in Housing society (Chairman/Secretory)",
        "social":"Holding position in social community (Samaj, Group etc.)",
        "bizassoc":"Holding position in business or trade association",
        "coop":"Holding position in Credit or Co-operative society",
        "vol":"Voluntary position in Hospital, Educational Institute, NGO",
        "religious":"Holding position in religious group, trust or temple",
        "service":"Holding position in service club like Lions Club, Jaycees, Rotary Club etc.",
        "member":"Active membership in any of the above",
        "none":"I don't have any position or membership in any of the above"
      };
      const doingMap12 = { preschool:"Preschool / Nursery", school:"School Student", college:"College Student", infant:"Not Enrolled(Infant)" };
      const doingMap3  = { preschool:"Pre-School / Nursery", school:"School Student", college:"College Student", infant:"Not Enrolled (Infant)" };

      const mapMulti = (multiAnswers, map) =>
  Object.entries(map)
    .filter(([key]) => Boolean((multiAnswers || {})[key]))
    .map(([, value]) => String(value).trim());

const questionnaireYesNo = (value) => {
  if (value === "yes") return "Yes";
  if (value === "no") return "No";
  return "";
};

const inviterValues = hasFamilyPurposeForSave
  ? (Array.isArray(q.inviter) ? q.inviter : [])
      .map((key) => inviterMap[key])
      .filter(Boolean)
  : [];

      const applyingCountries = (q.applyingCountries || "").split(",").map(s => s.trim()).filter(Boolean);
      const questionnaireHasCanada = applyingCountries.some(country => country.toLowerCase() === "canada");
      const firstEntry = Object.values(q.travelDates || {}).find(d => d.entry)?.entry || "";
      // Convert the widget's <input type="date"> ISO value (yyyy-mm-dd) to the
      // Zoho form's configured date_format (dd-MMM-yyyy), e.g. 2026-08-15 → 15-Aug-2026
      const toZohoDate = (isoDate) => {
        if (!isoDate) return "";
        const d = new Date(isoDate + "T00:00:00");
        if (isNaN(d.getTime())) return "";
        const day = String(d.getDate()).padStart(2, "0");
        const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
        return `${day}-${month}-${d.getFullYear()}`;
      };
      const firstEntryZoho = toZohoDate(firstEntry);

      // ── Children detail text, combined (no per-child free-text field exists) ──
      const childRefusalDetails = childrenList
        .map((c,i) => (hist[c.id]||{}).refusalDetail ? `Child ${i+1}: ${(hist[c.id]||{}).refusalDetail}` : "")
        .filter(Boolean).join(" | ");
      const childBorderDetails = childrenList
        .map((c,i) => (hist[c.id]||{}).borderDetail ? `Child ${i+1}: ${(hist[c.id]||{}).borderDetail}` : "")
        .filter(Boolean).join(" | ");
      const childrenCombinedDetail = [childRefusalDetails, childBorderDetails].filter(Boolean).join(" || ");
      const childCriminalDetails = childrenList
  .map((c,i) => (hist[c.id]||{}).criminalDetail ? `Child ${i+1}: ${(hist[c.id]||{}).criminalDetail}` : "")
  .filter(Boolean).join(" | ");

const applicantRefusalBorderDetails = [
  paHist.refusal === "yes" && paHist.refusalDetail
    ? `Primary applicant — visa refusal: ${paHist.refusalDetail}`
    : "",
  paHist.border === "yes" && paHist.borderDetail
    ? `Primary applicant — border/immigration issue: ${paHist.borderDetail}`
    : "",
  spId && spHist.refusal === "yes" && spHist.refusalDetail
    ? `Spouse — visa refusal: ${spHist.refusalDetail}`
    : "",
  spId && spHist.border === "yes" && spHist.borderDetail
    ? `Spouse — border/immigration issue: ${spHist.borderDetail}`
    : ""
].filter(Boolean).join(" | ");

const applicantCriminalDetails = [
  paHist.criminalRecord === "yes" && paHist.criminalDetail
    ? `Primary applicant: ${paHist.criminalDetail}`
    : "",
  spId && spHist.criminalRecord === "yes" && spHist.criminalDetail
    ? `Spouse: ${spHist.criminalDetail}`
    : ""
].filter(Boolean).join(" | ");

const recordData = {
        // Identity
        Client_Name: `${applicationData.customer.firstName || ""} ${applicationData.customer.lastName || ""}`.trim(),
        CRM_ID:      applicationData.deal.crmDealId || "",

        // Country + trip
        Applying_for_Country1: applyingCountries,
        Applying_for_Country:  applyingCountries[0] || "",   // legacy single-select mirror field
        What_is_the_purpose_of_your_visit:
  selectedPurposeKeys.map(
    (purpose) => purposeMap[purpose] || purpose
  ),

Please_describe_your_exact_purpose_of_visit:
  selectedPurposeKeys.includes("other")
    ? (q.purposeOther || "")
    : "",
        Do_you_have_specific_travel_plans_or_a_pre_planned_itinerary: q.arrangements === "yes" ? "Yes" : "No",
        Marital_Status: maritalStatusMap[q.maritalStatus] || "",
        When_do_you_intend_to_travel:
  q.arrangements === "no" ? firstEntryZoho : "",
What_is_your_intended_travel_date:
  q.arrangements === "yes" ? firstEntryZoho : "",

        // Travellers (fixed slots)
        Total_number_of_people_traveling_with_you: totalCountVal,
        Traveller_1: slotName(0), Traveller_1_Relation: slotRelation(0),
        Traveller_2: slotName(1), Traveller_2_Relation: slotRelation(1),
        Traveller_3: slotName(2), Traveller_3_Relation: slotRelation(2),
        Traveller_4: slotName(3), Traveller_4_Relation: slotRelation(3),

      // Inviter
...(inviterValues.length
  ? { Who_is_inviting_you: inviterValues }
  : {}),

Please_indicate_the_type_of_function_you_will_attend:
  selectedPurposeKeys.includes("family-func")
    ? (functionTypeMap[q.functionType] || "")
    : "",

What_is_the_inviter_s_immigration_status:
  hasInviterPurposeForSave
    ? (inviterStatusMap[q.inviterStatus] || "")
    : "",

Do_you_have_or_will_you_have_invitation_letter_for_your_visit:
  hasInviterPurposeForSave
    ? (q.invitationLetter === "yes" ? "Yes" : "No")
    : "",

Is_the_inviter_related_to_you_directly_or_through_your_spouse:
  hasInviterPurposeForSave
    ? (inviterRelationMap[q.inviterRelation] || "")
    : "",

        // Primary applicant finances
        // Primary applicant finances
How_will_you_be_funding_your_trip:
  paFundingSelections
    .map((value) => ({
      sponsor:
        "Some one else will pay for me (sponsor or 3rd party)",
      inviter:
        "My Inviter",
      self:
        "Self-funded"
    })[value])
    .filter(Boolean),

Who_is_the_Financial_Sponsor:
  paHasSponsor
    ? (sponsorMap[paFin.sponsorType] || "")
    : "",

How_much_liquid_funds_available_to_you_to_support_your_trip:
  fundsRangeMap[paFin.fundsRange] || "",

What_is_your_current_occupation:
  mapMulti(paFinanceAnswers, occMapPrimary),

Please_provide_more_information_about_selection:
  paHasOtherOccupation
    ? (paFin.moreInfo || "")
    : "",

Do_your_ITRs_from_the_last_two_years_reflect_your_current_occupation:
  paNeedsItr
    ? (
        paFin.itr === "yes"
          ? "Yes"
          : paFin.itr === "notsure"
            ? "Not sure"
            : paFin.itr === "nofile"
              ? "I do not file ITR"
              : paFin.itr === "no"
                ? "No"
                : ""
      )
    : "",

What_type_of_business_do_you_own:
  paIsBusinessOwner
    ? (bizTypeMap[paFin.bizType] || "")
    : "",

Please_select_the_types_of_immovable_property_you_own_in_India:
  mapMulti(paFinanceAnswers, assetMap),

Please_provide_which_type_of_other_assets_do_you_own:
  paHasOtherAsset
    ? (paFin.otherAssetDesc || "")
    : "",

Please_select_what_kind_of_liquid_investment_you_hold:
  mapMulti(paFinanceAnswers, investMap),

Please_provide_which_type_of_other_investments_do_you_have:
  paHasOtherInvestment
    ? (paFin.otherInvestment || "")
    : "",

        // Ties to home country (primary applicant)
        Business_Data: mapMulti(paTiesM, tiesMap),

        // Primary applicant travel history
        Own_Travel_History:
  questionnaireYesNo(paHist.prevTravel),

Do_you_currently_hold_valid_USA_Visa:
  questionnaireHasCanada
    ? questionnaireYesNo(paHist.usaVisa)
    : "",

Do_you_have_any_previous_visa_refusals:
  questionnaireYesNo(paHist.refusal),

Own_Entry_Refusal:
  questionnaireYesNo(paHist.border),

Provide_details_in_Refused_data: applicantRefusalBorderDetails,
Own_Criminal_Record: questionnaireYesNo(paHist.criminalRecord),
Provide_details_in_Criminal_Record: applicantCriminalDetails,

        // Spouse
  Please_select_employment_source_of_income_of_your_spouse:
  spId
    ? mapMulti(spFinanceAnswers, occMapSpouse)
    : [],

Please_select_your_spouse_s_ownership_type_in_business:
  spId && spIsBusinessOwner
    ? (spouseBizTypeMap[spFin.spouseBizType] || "")
    : "",

Do_your_spouse_s_ITRs_from_the_last_two_years_reflect_their_occupation:
  spId && spNeedsItr
    ? (
        spFin.itr === "yes"
          ? "Yes"
          : spFin.itr === "notsure"
            ? "Not sure"
            : spFin.itr === "nofile"
              ? "I do not file ITR"
              : spFin.itr === "no"
                ? "No"
                : ""
      )
    : "",

Please_describe_your_spouse_s_other_source_of_income_employment_which_is_not_listed_above:
  spId && spHasOtherOccupation
    ? (spFin.otherIncomeDesc || "")
    : "",
        Has_your_spouse_ever_visited_any_country_other_than_their_country_of_nationality:
  spId ? questionnaireYesNo(spHist.prevTravel) : "",

Does_your_spouse_hold_a_currently_valid_USA_Visa:
  questionnaireHasCanada && spId
    ? questionnaireYesNo(spHist.usaVisa)
    : "",

Has_your_spouse_received_previous_visa_refusals:
  spId ? questionnaireYesNo(spHist.refusal) : "",

"For_any_country_has_your_spouse_ever_been_refused_entry_at_the_border_deported_stayed_beyond_valid":
  spId ? questionnaireYesNo(spHist.border) : "",

"Has_your_spouse_ever_had_any_criminal_convictions_driving_offences_outstanding_criminal_proceeding":
  spId ? questionnaireYesNo(spHist.criminalRecord) : "",

        // Children (fixed Child 1/2/3 slots)
        What_is_Child_1_currently_doing: childrenList[0] ? (doingMap12[(applicationData.questionnaire.childrenInfo||{})[childrenList[0].id]?.doing] || "") : "",
        What_is_Child_2_currently_doing: childrenList[1] ? (doingMap12[(applicationData.questionnaire.childrenInfo||{})[childrenList[1].id]?.doing] || "") : "",
        What_is_Child_3_currently_doing: childrenList[2] ? (doingMap3[(applicationData.questionnaire.childrenInfo||{})[childrenList[2].id]?.doing] || "") : "",
        Has_Child_1_ever_visited_any_country_other_than_their_country_of_nationality:
  childrenList[0]
    ? questionnaireYesNo((hist[childrenList[0].id] || {}).prevTravel)
    : "",

Has_Child_2_ever_visited_any_country_other_than_their_country_of_nationality:
  childrenList[1]
    ? questionnaireYesNo((hist[childrenList[1].id] || {}).prevTravel)
    : "",

"Has_Child_3_ever_visited_any_country_other_than_their_country_of_nationality1":
  childrenList[2]
    ? questionnaireYesNo((hist[childrenList[2].id] || {}).prevTravel)
    : "",
        Does_Child_1_hold_a_currently_valid_USA_Visa:
  questionnaireHasCanada && childrenList[0]
    ? questionnaireYesNo((hist[childrenList[0].id] || {}).usaVisa)
    : "",

Does_Child_2_hold_a_currently_valid_USA_Visa:
  questionnaireHasCanada && childrenList[1]
    ? questionnaireYesNo((hist[childrenList[1].id] || {}).usaVisa)
    : "",

Does_Child_3_hold_a_currently_valid_USA_Visa:
  questionnaireHasCanada && childrenList[2]
    ? questionnaireYesNo((hist[childrenList[2].id] || {}).usaVisa)
    : "",
        Has_Child_1_ever_been_refused_a_visa_for_any_country:
  childrenList[0]
    ? questionnaireYesNo((hist[childrenList[0].id] || {}).refusal)
    : "",

Has_Child_2_ever_been_refused_a_visa_for_any_country:
  childrenList[1]
    ? questionnaireYesNo((hist[childrenList[1].id] || {}).refusal)
    : "",

Has_Child_3_ever_been_refused_a_visa_for_any_country:
  childrenList[2]
    ? questionnaireYesNo((hist[childrenList[2].id] || {}).refusal)
    : "",
        "For_any_country_has_your_Child_1_ever_been_refused_entry_at_the_border_deported_stayed_beyond_vali":
  childrenList[0]
    ? questionnaireYesNo((hist[childrenList[0].id] || {}).border)
    : "",

"For_any_country_has_your_Child_2_ever_been_refused_entry_at_the_border_deported_stayed_beyond_vali":
  childrenList[1]
    ? questionnaireYesNo((hist[childrenList[1].id] || {}).border)
    : "",

"For_any_country_has_your_Child_3_ever_been_refused_entry_at_the_border_deported_stayed_beyond_vali":
  childrenList[2]
    ? questionnaireYesNo((hist[childrenList[2].id] || {}).border)
    : "",
        Please_provide_details_about_children:
  childrenCombinedDetail,

"Has_your_Child_1_ever_had_any_criminal_convictions_driving_offences_outstanding_criminal_proceedin":
  childrenList[0]
    ? questionnaireYesNo((hist[childrenList[0].id] || {}).criminalRecord)
    : "",

"Has_your_Child_2_ever_had_any_criminal_convictions_driving_offences_outstanding_criminal_proceedin":
  childrenList[1]
    ? questionnaireYesNo((hist[childrenList[1].id] || {}).criminalRecord)
    : "",

"Has_your_Child_3_ever_had_any_criminal_convictions_driving_offences_outstanding_criminal_proceedin":
  childrenList[2]
    ? questionnaireYesNo((hist[childrenList[2].id] || {}).criminalRecord)
    : "",

Provide_details_in_a_children_criminal_record:
  childCriminalDetails
      };

      console.log("[Winny] Saving questionnaire to Creator:", CONFIG.creator.formLinkNames.questionnaire);
      console.log("[Winny] Full record data:", JSON.stringify(recordData));

            // Try SDK v2 first, then SDK v1
      let lastSaveError = null;
      let transportFound = false;

      if (window.ZOHO?.CREATOR?.DATA?.addRecords) {
        transportFound = true;

        try {
          const res = await ZOHO.CREATOR.DATA.addRecords({
            app_name: CONFIG.creator.appLinkName,
            form_name: CONFIG.creator.formLinkNames.questionnaire,
            payload: { data: recordData }
          });

          console.log(
            "[Winny] SDK v2 questionnaire response:",
            JSON.stringify(res)
          );

          if (Number(res?.code) === 3000 && res?.data?.ID) {
            console.log(
              "[Winny] Questionnaire saved successfully. Record ID:",
              res.data.ID
            );

            return res;
          }

          throw new Error(
            `Creator rejected the questionnaire (${res?.code || "unknown code"}): ${
              res?.message ||
              res?.error?.message ||
              JSON.stringify(res)
            }`
          );
        } catch (error) {
          lastSaveError = error;

          console.error(
            "[Winny] SDK v2 questionnaire save failed:",
            error
          );
        }
      }

      if (window.ZOHO?.CREATOR?.API?.addRecord) {
        transportFound = true;

        try {
          const res = await ZOHO.CREATOR.API.addRecord({
            accountOwnerName: CONFIG.creator.appOwner,
            appLinkName: CONFIG.creator.appLinkName,
            formLinkName: CONFIG.creator.formLinkNames.questionnaire,
            data: { data: recordData }
          });

          console.log(
            "[Winny] SDK v1 questionnaire response:",
            JSON.stringify(res)
          );

          if (Number(res?.code) === 3000 && res?.data?.ID) {
            console.log(
              "[Winny] Questionnaire saved successfully. Record ID:",
              res.data.ID
            );

            return res;
          }

          throw new Error(
            `Creator rejected the questionnaire (${res?.code || "unknown code"}): ${
              res?.message ||
              res?.error?.message ||
              JSON.stringify(res)
            }`
          );
        } catch (error) {
          lastSaveError = error;

          console.error(
            "[Winny] SDK v1 questionnaire save failed:",
            error
          );
        }
      }

      if (!transportFound) {
        throw new Error(
          "Zoho Creator connection is unavailable. The questionnaire was saved only as a local draft and was not submitted."
        );
      }

      throw lastSaveError || new Error(
        "Zoho Creator did not create the questionnaire record."
      )}

export { submitQuestionnaire, saveQuestionnaire };
