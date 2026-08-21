// ─────────────────────────────────────────────────────────────────────────
// CIF engine — copied VERBATIM from the original widget. This schema-driven
// multi-country form engine (UK 3-form chain, USA, Australia, Schengen) is
// intensely DOM-imperative (renderCIF writes to qs("#stepCIF"), dozens of inline
// cif* handlers, subforms, metadata fetch, per-traveller save + record-ID
// chaining). To preserve UI + logic exactly it is kept as one module and hosted
// as an island: the <CIF> component provides <section id="stepCIF"> and calls
// renderCIF(); the inline handlers are exposed on window.
//
// EXACT endpoints/forms preserved: CREATOR.META.getFields, CREATOR.DATA.addRecords
// /updateRecordById, invokeUrl REST, and the "Create Applications" Deluge bridge.
// No render→return rewrite was needed (unlike the questionnaire) because renderCIF
// targets #stepCIF by id, which the component renders.
// ─────────────────────────────────────────────────────────────────────────
import {
  CONFIG, COUNTRIES, UK_CIF_COUNTRIES, CIF_TYPE_DEFINITIONS, SCHENGEN_COUNTRIES,
  SCHENGEN_CATEGORIES, SCHENGEN_FIELD_CATEGORY_MAP, GENERIC_CATEGORY_CONFIG
} from "../config/config.js";
import { applicationData, state } from "../store/runtime.js";
import { qs, qsa } from "../lib/dom.js";
import { getByPath, setByPath, uid, escapeHtml, safeJsonParse } from "../lib/utils.js";
import { birthDateInputBounds, isBirthDateField, classifyFieldValidation, validators } from "../lib/validators.js";
import {
  toast, showLoader, hideLoader, markAutoSavePending, requestRender,
  openModal, openConfirmModal, fail
} from "../lib/ui.js";
import {
  getResponseRows, getCreatorRecordId, readZohoValue, readZohoId, hasCreatorRestTransport
} from "../api/zoho.js";
import { submitPortalCrmRequest, pollCreatorRecord } from "../api/portal.js";
import { saveDraft } from "./drafts.js";
import { showStep } from "./navigation.js";
import { isQuestionnaireChild, qQuestionnaireCountries } from "./questionnaire.js";
import { reconcileTravellerCountries, isPaymentConfirmed } from "./deal.js";
import { isFullyPaidStatus } from "./derive.js";
import { saveDealData } from "../api/deal.js";

const cifBirthDateFields = new Map();

    // ── cifNormalizeCountry (source 4041-4055) ──
function cifNormalizeCountry(country) {
      const raw = String(country || "").trim();
      const aliases = {
        "us": "United States",
        "u.s.": "United States",
        "usa": "United States",
        "u.s.a.": "United States",
        "united states of america": "United States",
        "uk": "United Kingdom",
        "u.k.": "United Kingdom",
        "great britain": "United Kingdom",
        "czechia": "Czech Republic"
      };
      return aliases[raw.toLowerCase()] || raw;
    }

    // ── CIF render + logic + schema + schengen (source 4057-7241) ──
    function cifTypeForCountry(country) {
      const normalized = cifNormalizeCountry(country);
      if (normalized === "Australia") return "australia";
      if (normalized === "United States") return "usa";
      // "Schengen" stored as zone name (not a specific country) → Schengen CIF
      if (normalized.toLowerCase() === "schengen") return "schengen";
      if (SCHENGEN_COUNTRIES.has(normalized.toLowerCase())) return "schengen";
      return "uk";
    }

    function cifInstanceSlug(country) {
      return cifNormalizeCountry(country).toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "general";
    }

    function cifDestinationInstances() {
      const countries = qQuestionnaireCountries();
      const seen = new Set();
      return countries.map(country => cifNormalizeCountry(country)).filter(country => {
        const key = country.toLowerCase();
        if (!country || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map(country => {
        const type = cifTypeForCountry(country);
        return {
          id: `${cifInstanceSlug(country)}-${type}`,
          country,
          type,
          definition: CIF_TYPE_DEFINITIONS[type]
        };
      });
    }

    function cifGetInstance(instanceId) {
      const instances = cifDestinationInstances();
      return instances.find(instance => instance.id === instanceId) || instances[0] || null;
    }

    function cifEnsureDataModel() {
      if (!applicationData.cifData || typeof applicationData.cifData !== "object") applicationData.cifData = {};
      if (!applicationData.cifRecords || typeof applicationData.cifRecords !== "object") applicationData.cifRecords = {};
      const instances = cifDestinationInstances();
      applicationData.deal.travellers.forEach(traveller => {
        const legacy = applicationData.cifData[traveller.id] || {};
        if (!legacy.instances || typeof legacy.instances !== "object") legacy.instances = {};
        // Preserve old UK drafts by assigning them to the first destination
        // that uses the UK schema. If none exists, use the first destination.
        if (legacy.f1 || legacy.f2 || legacy.f3) {
          const target = instances.find(instance => instance.type === "uk");
          if (target && !legacy.instances[target.id]) {
            legacy.instances[target.id] = {
              f1: legacy.f1 || {},
              f2: legacy.f2 || {},
              f3: legacy.f3 || {}
            };
          }
          delete legacy.f1;
          delete legacy.f2;
          delete legacy.f3;
        }
        applicationData.cifData[traveller.id] = legacy;
        if (!applicationData.cifRecords[traveller.id]) applicationData.cifRecords[traveller.id] = {};

        // Migrate existing UK save IDs without treating them as another country's CIF.
        const legacySaveKey = String(traveller.crmId || traveller.id || "");
        const legacySaved = applicationData.cifSaveState?.[legacySaveKey];
        const ukTarget = instances.find(instance => instance.type === "uk");
        if (
          ukTarget &&
          legacySaved?.saved === true &&
          legacySaved.id1 &&
          legacySaved.id2 &&
          legacySaved.id3 &&
          !applicationData.cifRecords[traveller.id][ukTarget.id]
        ) {
          applicationData.cifRecords[traveller.id][ukTarget.id] = {
            ids: {
              f1: String(legacySaved.id1),
              f2: String(legacySaved.id2),
              f3: String(legacySaved.id3)
            },
            status: "saved",
            savedAt: legacySaved.savedAt || ""
          };
        }
      });
      if (!state.activeCifInstance || !instances.some(instance => instance.id === state.activeCifInstance)) {
        state.activeCifInstance = instances[0]?.id || null;
        state.activeCifCategory = null;
        state.activeCifStage = null;
      }
    }

    function cifInstanceData(travId, instanceId) {
      cifEnsureDataModel();
      const travellerData = applicationData.cifData[travId] || (applicationData.cifData[travId] = { instances:{} });
      if (!travellerData.instances) travellerData.instances = {};
      const id = instanceId || state.activeCifInstance;
      if (!travellerData.instances[id]) travellerData.instances[id] = {};
      return travellerData.instances[id];
    }

    function cifRecordState(travId, instanceId) {
      cifEnsureDataModel();
      const travellerRecords = applicationData.cifRecords[travId] || (applicationData.cifRecords[travId] = {});
      const id = instanceId || state.activeCifInstance;
      return travellerRecords[id] || null;
    }

    function cifIsInstanceSaved(travId, instanceId) {
      const record = cifRecordState(travId, instanceId);
      return Boolean(record && record.status === "saved" && record.ids && Object.keys(record.ids).length);
    }

    function cifSetRecordState(travId, instanceId, ids) {
      if (!applicationData.cifRecords[travId]) applicationData.cifRecords[travId] = {};
      applicationData.cifRecords[travId][instanceId] = {
        ids: Object.assign({}, ids || {}),
        status: "saved",
        savedAt: new Date().toISOString()
      };
      saveDraft(false);
    }

    function cifSetPartialRecordState(travId, instanceId, ids) {
      if (!applicationData.cifRecords[travId]) applicationData.cifRecords[travId] = {};
      applicationData.cifRecords[travId][instanceId] = {
        ids:Object.assign({}, ids || {}),
        status:"saving",
        savedAt:""
      };
      saveDraft(false);
    }

    function cifMarkInstanceDirtyFromPath(path) {
      const parts = String(path || "").split(".");
      if (parts[0] !== "cifData" || parts[2] !== "instances") return;
      const travellerRecords = applicationData.cifRecords?.[parts[1]];
      const record = travellerRecords?.[parts[3]];
      if (record && record.status === "saved") record.status = "edited";
      if (applicationData.stepStatus.cifCompleted) applicationData.stepStatus.cifCompleted = false;
    }

    function cifRenderDestinationTabs(instances) {
      return `<div class="cifx-travtabs" style="margin-bottom:18px">${instances.map(instance => {
        const savedCount = applicationData.deal.travellers.filter(t => cifIsInstanceSaved(t.id, instance.id)).length;
        const active = instance.id === state.activeCifInstance;
        return `<button type="button" class="cifx-tabbtn ${active ? "on" : ""}" onclick="cifSwitchInstance('${instance.id}')">
          ${instance.definition.icon} ${escapeHtml(instance.country)}
          <span class="badge">${escapeHtml(instance.definition.title)} · ${savedCount}/${applicationData.deal.travellers.length}</span>
        </button>`;
      }).join("")}</div>`;
    }

    function cifSwitchInstance(instanceId) {
      state.activeCifInstance = instanceId;
      state.activeCifCategory = null;
      state.activeCifStage = null;
      renderCIF();
      qs("#stepCIF")?.scrollIntoView({ behavior:"smooth", block:"start" });
    }

    // ─── CIF ─────────────────────────────────────────────────────────────────


    // ==== CIF ENGINE — schema-driven, real Zoho field link names used directly ====
    // Data lives at applicationData.cifData[travellerId][formTag][fieldKey]
    // formTag: f1 -> UK_CIF_1, f2 -> UK_CIF_2, f3 -> UK_CIF_3 (chained per traveller)
    /* ============================================================================
   CIF_UK_SECTIONS — CORRECTED VERSION
   ============================================================================
   ============================================================================ */

const CIF_UK_SECTIONS = [
  { id:"personal", title:"Personal Information", icon:"&#x1F464;", fields:[
    ["Prefix","f1","Your_name_as_printed_in_your_passport.prefix","select",["Mr.","Mrs.","Ms."],false],
    ["First Name (as in passport)","f1","Your_name_as_printed_in_your_passport.first_name","text",null,true],
    ["Last Name (as in passport)","f1","Your_name_as_printed_in_your_passport.last_name","text",null,true],
    ["Are you known by another name?","f1","Are_you_now_or_have_you_ever_been_known_by_another_name","yesno",null,true],
    ["Other name - First","f1","Your_other_name.first_name","text",null,false,{key:"Are_you_now_or_have_you_ever_been_known_by_another_name",form:"f1",equals:"Yes"}],
    ["Other name - Last","f1","Your_other_name.last_name","text",null,false,{key:"Are_you_now_or_have_you_ever_been_known_by_another_name",form:"f1",equals:"Yes"}],
    ["Gender","f1","Gender","select",["Male","Female"],true],
    ["Marital / Relationship Status","f1","What_is_your_relationship_status","select",["Single","Married or civil partner","Unmarried partner","Divorced or partnership dissolved","Separated","Widowed or a surviving civil partner"],true],
    ["Date of Birth","f1","Date_of_Birth","date",null,true],
    ["Place of Birth","f1","Place_of_Birth","text",null,true],
    ["Country of Birth","f1","Country_of_Birth","select",UK_CIF_COUNTRIES,true],
    ["Country of Nationality","f1","Country_of_Nationality","select",UK_CIF_COUNTRIES,true],
  ]},
  { id:"contact", title:"Contact Details", icon:"&#x260E;&#xFE0F;", fields:[
    ["Email address","f1","Provide_Email_address","text",null,true],
    ["Who does this email belong to?","f1","Who_does_this_email_address_belong_to","select",["You","Some one else"],true],
    ["Do you have an email address?","f1","Do_you_have_an_email_address","yesno",null,false,{key:"Who_does_this_email_address_belong_to",form:"f1",equals:"Some one else"}],
    ["Your own email address","f1","Provide_your_own_email_address","text",null,false,{key:"Do_you_have_an_email_address",form:"f1",equals:"Yes"}],
    ["Telephone number","f1","Provide_your_telephone_number","phone",null,true],
    ["Where do you use this number?","f1","Where_do_you_use_this_telephone_number_You_can_select_more_than_one_option","multiselect",["For use whilst in the UK","For use whilst out of the UK"],true],
    ["Type of number","f1","Select_whether_this_is_your_home_mobile_or_work_telephone_number","multiselect",["Home telephone number","Business telephone number","Mobile telephone number"],true],
    ["How can you be contacted?","f1","Are_you_able_to_be_contacted_by_telephone","multiselect",["I can be contacted by telephone call and text message (SMS)","I can only be contacted by telephone call","I can only be contacted by text message (SMS)","I cannot be contacted by telephone call or text message (SMS)"],true],
  ]},
  { id:"address", title:"Address", icon:"&#x1F3E0;", fields:[
    ["Current residence address","f1","Your_current_residence_address","address",null,true],
    ["How long lived at this address?","f1","How_long_have_you_lived_at_this_address","select",["Days","Weeks","Months","Years"],true],
    ["Please input number of days/weeks/months/years","f1","TimeValue","number",null,false,{key:"How_long_have_you_lived_at_this_address",form:"f1",notEmpty:true}],
    ["Ownership status of home","f1","What_is_the_ownership_status_of_your_home","select",["I own it","I rent it","Other"],true],
    ["More about your living situation","f1","Give_more_details_about_your_living_situation_such_as_who_you_live_with_and_who_owns_the_property","textarea",null,false,{key:"What_is_the_ownership_status_of_your_home",form:"f1",equals:"Other"}],
    ["Is this also your correspondence address?","f1","Is_this_address_also_your_correspondence_address","yesno",null,true],
    ["Correspondence Address (if different)","f1","Correspondence_Address","address",null,false,{key:"Is_this_address_also_your_correspondence_address",form:"f1",equals:"No"}],
  ]},
  { id:"passport", title:"Passport & Nationality", icon:"&#x1F4D8;", fields:[
    ["Passport number","f1","Passport_number_or_travel_document_reference_number","text",null,true],
    ["Issuing authority","f1","Issuing_authority_Your_passport","text",null,true],
    ["Issue date","f1","Passport_issue_date_Your_passport","date",null,true],
    ["Expiry date","f1","Passport_expiry_date_Your_passport","date",null,true],
    ["Hold/held other nationality?","f1","Do_you_currently_hold_or_have_you_ever_held_any_other_nationality_or_citizenship2","yesno",null,true],
   ["Country of other nationality","f1","Country_of_other_Nationality","select",UK_CIF_COUNTRIES,false,{key:"Do_you_currently_hold_or_have_you_ever_held_any_other_nationality_or_citizenship2",form:"f1",equals:"Yes"}],
    ["Date since holding this nationality","f1","Provide_date_since_when_you_hold_this_nationality","date",null,false,{key:"Do_you_currently_hold_or_have_you_ever_held_any_other_nationality_or_citizenship2",form:"f1",equals:"Yes"}],
    ["Still hold this nationality?","f1","Do_you_still_hold_this_nationality_or_citizenship","yesno",null,false,{key:"Do_you_currently_hold_or_have_you_ever_held_any_other_nationality_or_citizenship2",form:"f1",equals:"Yes"}],
    ["Held until date","f1","Till_which_date_you_held_this_nationality","date",null,false,{key:"Do_you_still_hold_this_nationality_or_citizenship",form:"f1",equals:"No"}],
    ["Can provide valid passport for other nationality?","f1","Can_you_provide_a_valid_passport_for_your_other_nationality","yesno",null,false,{key:"Do_you_currently_hold_or_have_you_ever_held_any_other_nationality_or_citizenship2",form:"f1",equals:"Yes"}],
    ["Passport number (other nationality)","f1","Passport_number_Other_nationality","text",null,false,{key:"Can_you_provide_a_valid_passport_for_your_other_nationality",form:"f1",equals:"Yes"}],
    ["Issuing authority (other nationality)","f1","Issuing_authority_Other_nationality","text",null,false,{key:"Can_you_provide_a_valid_passport_for_your_other_nationality",form:"f1",equals:"Yes"}],
    ["Issue date (other nationality)","f1","Passport_issue_date_Other_nationality","date",null,false,{key:"Can_you_provide_a_valid_passport_for_your_other_nationality",form:"f1",equals:"Yes"}],
    ["Expiry date (other nationality)","f1","Passport_expiry_date_Other_nationality","date",null,false,{key:"Can_you_provide_a_valid_passport_for_your_other_nationality",form:"f1",equals:"Yes"}],
  ]},
  { id:"employment", title:"Employment", icon:"&#x1F4BC;", fields:[
    ["Employment status","f1","What_is_your_employment_status","multiselect",["Employed","Self-Employed","A Student","Retired","Unemployed"],true],
    ["Employer's name","f1","Employer_s_name","text",null,false,{key:"What_is_your_employment_status",form:"f1",includes:"Employed"}],
    ["Employer's address","f1","Employer_s_address","address",null,false,{key:"What_is_your_employment_status",form:"f1",includes:"Employed"}],
    ["Employer's telephone number","f1","Employer_s_telephone_number","phone",null,false,{key:"What_is_your_employment_status",form:"f1",includes:"Employed"}],
    ["Date you started working","f1","Date_you_started_working","date",null,false,{key:"What_is_your_employment_status",form:"f1",includes:"Employed"}],
    ["Your job title","f1","Your_job_title","text",null,false,{key:"What_is_your_employment_status",form:"f1",includes:"Employed"}],
    ["Monthly income currency","f1","How_much_do_you_earn_each_month_after_tax","select",["INR","GBP"],false,{key:"What_is_your_employment_status",form:"f1",includes:"Employed"}],
    ["Monthly income amount (after tax)","f1","Amount_earning_Employed","number",null,false,{key:"What_is_your_employment_status",form:"f1",includes:"Employed"}],
    ["Describe your job","f1","Describe_your_job","textarea",null,false,{key:"What_is_your_employment_status",form:"f1",includes:"Employed"}],
    ["Self-employed: What is your job?","f1","What_is_your_job","text",null,false,{key:"What_is_your_employment_status",form:"f1",includes:"Self-Employed"}],
    ["Self-employed: Annual income currency","f1","How_much_do_you_earn_from_this_job_in_a_year","select",["INR","GBP"],false,{key:"What_is_your_employment_status",form:"f1",includes:"Self-Employed"}],
    ["Self-employed: Annual income amount","f1","Amount_earning_Self_Employed","number",null,false,{key:"What_is_your_employment_status",form:"f1",includes:"Self-Employed"}],
  ]},
  { id:"income", title:"Income & Savings", icon:"&#x1F4B0;", fields:[
    ["Any other income or savings?","f1","Do_you_have_another_income_or_any_savings","yesno",null,true],
    ["Which applies to you?","f1","Please_choose_appropriate_option_for_you_from_below","multiselect",["Other regular additional income","Savings"],false,{key:"Do_you_have_another_income_or_any_savings",form:"f1",equals:"Yes"}],
    ["Type of additional income","f1","What_kind_of_regular_additional_income_do_you_have","multiselect",["Allowance or regular money from your family","Pension","Investments","Another income"],false,{key:"Please_choose_appropriate_option_for_you_from_below",form:"f1",includes:"Other regular additional income"}],
    ["Additional income currency","f1","Total_amount_of_regular_additional_income_that_you_get_in_a_year","select",["INR","GBP"],false,{key:"Please_choose_appropriate_option_for_you_from_below",form:"f1",includes:"Other regular additional income"}],
    ["Total additional income amount","f1","Your_total_additional_income","number",null,false,{key:"Please_choose_appropriate_option_for_you_from_below",form:"f1",includes:"Other regular additional income"}],
    ["Total savings (GBP)","f1","How_much_money_do_you_have_in_savings_in_GBP","number",null,false,{key:"Please_choose_appropriate_option_for_you_from_below",form:"f1",includes:"Savings"}], 
  ]},
  { id:"tripcost", title:"Cost of Trip", icon:"&#x1F4B5;", fields:[
    ["Personal spend currency","f1","How_much_money_are_you_personally_planning_to_spend_on_your_visit_to_the_UK","select",["INR","GBP"],true],
    ["Amount planning to spend on visit","f1","Amount_you_are_planning_to_spent_during_your_visit","number",null,true],
    ["Monthly spend currency","f1","What_is_the_total_amount_of_money_you_spend_each_month","select",["INR","GBP"],true],
    ["Total amount spent each month","f1","Total_amount_you_spent_each_month","number",null,true],
    ["Will anyone pay towards your visit?","f1","Will_anyone_be_paying_towards_the_cost_of_your_visit","yesno",null,false],
    ["Who is paying?","f1","Who_is_paying_towards_the_cost_of_your_visit","select",["Someone I know (for example, family or friend)","My employer or company","Another company or organisation"],false,{key:"Will_anyone_be_paying_towards_the_cost_of_your_visit",form:"f1",equals:"Yes"}],
    ["Name of person/entity paying","f1","Name_of_the_person_entity_who_is_paying_cost_for_your_visit","text",null,false,{anyOf:[{key:"Who_is_paying_towards_the_cost_of_your_visit",form:"f1",equals:"Someone I know (for example, family or friend)"},{key:"Who_is_paying_towards_the_cost_of_your_visit",form:"f1",equals:"Another company or organisation"}]}],
    ["Address of person/entity paying","f1","Address_of_the_person_entity_who_is_paying_cost_for_your_visit","address",null,false,{anyOf:[{key:"Who_is_paying_towards_the_cost_of_your_visit",form:"f1",equals:"Someone I know (for example, family or friend)"},{key:"Who_is_paying_towards_the_cost_of_your_visit",form:"f1",equals:"Another company or organisation"}]}],
["Currency they will pay in","f1","How_much_money_will_they_be_paying_towards_your_visit","select",["INR","GBP"],false,{key:"Will_anyone_be_paying_towards_the_cost_of_your_visit",form:"f1",equals:"Yes"}],
["Amount they will pay","f1","Amount_they_pay_for_your_visit","number",null,false,{key:"Will_anyone_be_paying_towards_the_cost_of_your_visit",form:"f1",equals:"Yes"}],
    ["Why are they helping to pay?","f1","Why_are_they_helping_to_pay_for_your_visit","textarea",null,false,{key:"Will_anyone_be_paying_towards_the_cost_of_your_visit",form:"f1",equals:"Yes"}],
    ["Second person also paying?","f1","Will_anyone_other_be_paying_towards_the_cost_of_your_visit_2nd_Person","yesno",null,false,{key:"Will_anyone_be_paying_towards_the_cost_of_your_visit",form:"f1",equals:"Yes"}],
    ["Who is second payer?","f1","Who_is_paying_towards_the_cost_of_your_visit_2nd_Person","select",["Someone I know (for example, family or friend)","My employer or company","Another company or organisation"],false,{key:"Will_anyone_other_be_paying_towards_the_cost_of_your_visit_2nd_Person",form:"f1",equals:"Yes"}],
    ["Name of second person/entity paying","f1","Name_of_the_person_entity_who_is_paying_cost_for_your_visit1","text",null,false,{anyOf:[{key:"Who_is_paying_towards_the_cost_of_your_visit_2nd_Person",form:"f1",equals:"Someone I know (for example, family or friend)"},{key:"Who_is_paying_towards_the_cost_of_your_visit_2nd_Person",form:"f1",equals:"Another company or organisation"}]}],
    ["Address of second payer","f1","Address_of_the_person_entity_who_is_paying_cost_for_your_visit1","address",null,false,{anyOf:[{key:"Who_is_paying_towards_the_cost_of_your_visit_2nd_Person",form:"f1",equals:"Someone I know (for example, family or friend)"},{key:"Who_is_paying_towards_the_cost_of_your_visit_2nd_Person",form:"f1",equals:"Another company or organisation"}]}],
["Currency second payer will pay in","f1","How_much_money_will_they_be_paying_towards_your_visit_2nd_Person","select",["INR","GBP"],false,{key:"Will_anyone_other_be_paying_towards_the_cost_of_your_visit_2nd_Person",form:"f1",equals:"Yes"}],
["Amount second payer will pay","f1","Amount_the_second_person_will_pay_for_your_visit","number",null,false,{key:"Will_anyone_other_be_paying_towards_the_cost_of_your_visit_2nd_Person",form:"f1",equals:"Yes"}],
    ["Why is second payer helping?","f1","Why_are_they_helping_to_pay_for_your_visit_2nd_Person","textarea",null,false,{key:"Will_anyone_other_be_paying_towards_the_cost_of_your_visit_2nd_Person",form:"f1",equals:"Yes"}],
    ["Date you plan to arrive in the UK","f1","Date_you_plan_to_arrive_in_the_UK","date",null,true],
    ["Date you plan to leave the UK","f1","Date_you_plan_to_leave_the_UK","date",null,true],
    ["Preferred language for UK officials to contact you","f1","UK_officials_may_have_to_talk_to_you_about_your_application_Which_language_would_you_prefer_to_use","select",["English","Other"],true],
    ["Which language?","f1","Which_language_would_you_prefer_to_use","text",null,false,{key:"UK_officials_may_have_to_talk_to_you_about_your_application_Which_language_would_you_prefer_to_use",form:"f1",equals:"Other"}],
  ]},
  { id:"purpose", title:"Purpose of Visit", icon:"&#x1F3AF;", fields:[
    ["Main reason for visit","f1","What_is_the_main_reason_for_your_visit_to_the_UK","select",["Tourism (including visiting family and friends)","Business (including sports and entertainment)","Transit through the UK","Academic visit (including teaching, exchange and visiting as a dependant of an academic visitor)","Marriage or civil partnership","Private medical treatment or organ donation","Short-term study (up to 6 months), including recreational course","Other - I am visiting for another reason"],false],
    // FIX: was unconditional — only relevant when main reason = Tourism
    ["Holiday reason","f1","What_is_the_main_reason_for_your_holiday_visit_to_the_UK","select",["Tourist","Visiting family","Visiting friends"],false,
      {key:"What_is_the_main_reason_for_your_visit_to_the_UK",form:"f1",equals:"Tourism (including visiting family and friends)"}],
    // FIX: was unconditional — only relevant when main reason = Business
    ["Business reason","f1","What_is_the_main_reason_for_your_business_visit_to_the_UK","select",["Attend business meetings","Research or fact finding","Business-related training","Attend lectures","Perform at an entertainment event","Perform at a sporting event","Religious activities","Secure funding to start, take over, join or run a business","Clinical attachments or dental observer posts","Permitted Paid Engagement","Other"],false,
      {key:"What_is_the_main_reason_for_your_visit_to_the_UK",form:"f1",equals:"Business (including sports and entertainment)"}],
    // FIX: was unconditional — only relevant when main reason = Business
    ["What business will you do in the UK?","f1","What_business_will_you_be_doing_in_the_UK","text",null,false,
      {key:"What_is_the_main_reason_for_your_business_visit_to_the_UK",form:"f1",equals:"Other"}],
    // FIX: was unconditional — only relevant when business reason = Permitted Paid Engagement
    ["Who will pay you for paid engagement?","f1","Who_will_pay_you_for_this_paid_engagement","text",null,false,
      {key:"What_is_the_main_reason_for_your_business_visit_to_the_UK",form:"f1",equals:"Permitted Paid Engagement"}],
    // FIX: was unconditional — only relevant when business reason = Permitted Paid Engagement
    ["Type of Permitted Paid Engagement","f1","Which_of_the_following_describes_your_main_form_of_Permitted_Paid_Engagement_in_the_UK","select",["Be a student examiner or assessor","Take part in selection panels as an academic","Give lectures at a higher level education institution","Examine UK-based pilots","Provide advocacy in a particular area of law","Take part in arts, entertainment or sporting activities, including broadcasting","Take part in fashion modelling assignments","Speak at a conference or seminar"],false,
      {key:"What_is_the_main_reason_for_your_business_visit_to_the_UK",form:"f1",equals:"Permitted Paid Engagement"}],
    // FIX: was unconditional — only relevant when main reason = Transit
    ["Transit reason","f1","What_is_the_main_reason_for_your_transit_visit_through_the_UK","select",["To go through UK border control and leave the UK within 48 hours","To change flights in the UK within 24 hours, without going through UK border control","To start work on a ship or aircraft"],false,
      {key:"What_is_the_main_reason_for_your_visit_to_the_UK",form:"f1",equals:"Transit through the UK"}],
    // FIX: was unconditional — arrival/departure/next-country block only applies to Transit
    ["Where will you arrive in the UK?","f1","Where_will_you_arrive_in_the_UK","text",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To go through UK border control and leave the UK within 48 hours"},
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To change flights in the UK within 24 hours, without going through UK border control"}
      ]}],
    ["Arrival flight/train/ship number","f1","What_is_the_flight_number_train_service_or_ship_name_that_you_will_arrive_on_include_operator_name","text",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To go through UK border control and leave the UK within 48 hours"},
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To change flights in the UK within 24 hours, without going through UK border control"}
      ]}],
    ["Where will you depart the UK from?","f1","Where_will_you_depart_the_UK_from","text",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To go through UK border control and leave the UK within 48 hours"},
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To change flights in the UK within 24 hours, without going through UK border control"}
      ]}],
    ["Departure flight/train/ship number","f1","What_is_the_flight_number_train_service_or_ship_name_that_you_will_depart_on","text",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To go through UK border control and leave the UK within 48 hours"},
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To change flights in the UK within 24 hours, without going through UK border control"}
      ]}],
    ["Which country next after UK?","f1","Which_country_are_you_travelling_on_to_from_the_UK","select",UK_CIF_COUNTRIES,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To go through UK border control and leave the UK within 48 hours"},
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To change flights in the UK within 24 hours, without going through UK border control"}
      ]}],
    ["Why going to that country?","f1","Why_are_you_going_to_this_country","select",["Tourism","Business","Visit Family","Returning to my country of nationality","Other"],false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To go through UK border control and leave the UK within 48 hours"},
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To change flights in the UK within 24 hours, without going through UK border control"}
      ]}],
    ["Details of your visit","f1","Details_of_your_visit","text",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To go through UK border control and leave the UK within 48 hours"},
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To change flights in the UK within 24 hours, without going through UK border control"}
      ]}],
    ["Why travelling through the UK?","f1","Why_are_you_travelling_through_the_UK","text",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To go through UK border control and leave the UK within 48 hours"},
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To change flights in the UK within 24 hours, without going through UK border control"}
      ]}],
    // FIX: was unconditional — only relevant for Transit
    ["Valid visa/residence permit for that country?","f1","Do_you_have_a_valid_visa_or_residence_permit_for_the_country_you_are_travelling_to","yesno",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To go through UK border control and leave the UK within 48 hours"},
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To change flights in the UK within 24 hours, without going through UK border control"}
      ]}],
    // FIX: was unconditional — these 3 only apply when the visa question above = Yes
    ["Reference number of that visa/permit","f1","What_is_the_reference_number_of_your_permit_or_visa_to_this_country","text",null,false,
      {key:"Do_you_have_a_valid_visa_or_residence_permit_for_the_country_you_are_travelling_to",form:"f1",equals:"Yes"}],
    ["Date of issue for that visa","f1","What_is_the_date_of_issue_for_your_visa","date",null,false,
      {key:"Do_you_have_a_valid_visa_or_residence_permit_for_the_country_you_are_travelling_to",form:"f1",equals:"Yes"}],
    ["Where was that visa issued?","f1","Where_was_the_visa_issued","text",null,false,
      {key:"Do_you_have_a_valid_visa_or_residence_permit_for_the_country_you_are_travelling_to",form:"f1",equals:"Yes"}],
  ]},
  { id:"returntrip", title:"Return Trip & Ship/Aircraft Work", icon:"&#x2708;&#xFE0F;", showIf:{key:"What_is_the_main_reason_for_your_visit_to_the_UK",form:"f1",equals:"Transit through the UK"}, fields:[
    ["Travelling back through UK after visiting another country?","f1","Will_you_be_travelling_back_through_the_UK_following_your_visit_to_another_country","yesno",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To go through UK border control and leave the UK within 48 hours"},
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To change flights in the UK within 24 hours, without going through UK border control"}
      ]}],
    ["Return: where will you arrive in UK?","f1","Where_will_you_arrive_in_the_UK_while_your_return_trip","text",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To go through UK border control and leave the UK within 48 hours"},
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To change flights in the UK within 24 hours, without going through UK border control"}
      ]}],
    ["Return: arrival flight/train/ship","f1","What_is_the_flight_number_train_service_or_ship_name_that_you_will_arrive_on_while_return_trip","text",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To go through UK border control and leave the UK within 48 hours"},
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To change flights in the UK within 24 hours, without going through UK border control"}
      ]}],
    ["Return: where will you depart UK from?","f1","Where_will_you_depart_the_UK_from_while_your_return_trip","text",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To go through UK border control and leave the UK within 48 hours"},
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To change flights in the UK within 24 hours, without going through UK border control"}
      ]}],
    ["Return: departure flight/train/ship","f1","What_is_the_flight_number_train_service_or_ship_name_that_you_will_depart_on_while_return_trip","text",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To go through UK border control and leave the UK within 48 hours"},
        {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To change flights in the UK within 24 hours, without going through UK border control"}
      ]}],
    ["Organisation/agent who arranged ship/aircraft trip","f1","Which_organisation_or_agent_has_arranged_this_trip_for_you","text",null,false,
      {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To start work on a ship or aircraft"}],
    ["When do you expect to depart the UK?","f1","When_do_you_expect_to_depart_the_UK","date",null,false,
      {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To start work on a ship or aircraft"}],
    ["Depart UK from (ship/aircraft work)","f1","Where_will_you_depart_the_UK_from_to_work_on_ship_or_aircraft","text",null,false,
      {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To start work on a ship or aircraft"}],
    ["Flight/ship name leaving UK on","f1","What_is_the_flight_number_or_name_of_the_ship_that_you_will_leave_the_UK_on","text",null,false,
      {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To start work on a ship or aircraft"}],
    ["What work on the ship/aircraft?","f1","What_work_will_you_be_doing_on_the_aircraft_or_ship","text",null,false,
      {key:"What_is_the_main_reason_for_your_transit_visit_through_the_UK",form:"f1",equals:"To start work on a ship or aircraft"}],
  ]},
  { id:"academic", title:"Academic Visit", icon:"&#x1F393;", showIf:{key:"What_is_the_main_reason_for_your_visit_to_the_UK",form:"f1",equals:"Academic visit (including teaching, exchange and visiting as a dependant of an academic visitor)"}, fields:[
    ["Main reason for academic visit","f1","What_is_the_main_reason_for_your_academic_visit_to_the_UK","select",["Research","Teaching","Clinical Practice","Formal Exchange","Collaborate on an international project","Dependant of an academic visitor"],false],
    ["How long do you plan to come for?","f1","How_long_do_you_plan_to_come_to_the_UK_for","select",["Up to and including 6 months","Over 6 months"],false],
    ["Field of academic expertise","f1","What_is_your_field_of_academic_expertise","text",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Research"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Teaching"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Clinical Practice"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Formal Exchange"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Collaborate on an international project"}
      ]}],
    ["Currently working in this field overseas?","f1","Are_you_currently_working_in_this_field_at_an_academic_institution_or_higher_education_facility_ov","yesno",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Research"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Teaching"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Clinical Practice"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Formal Exchange"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Collaborate on an international project"}
      ]}],
    ["Name of institution/facility","f1","What_is_the_name_of_the_academic_institution_or_higher_education_facility_you_work_at","text",null,false,
      {key:"Are_you_currently_working_in_this_field_at_an_academic_institution_or_higher_education_facility_ov",form:"f1",equals:"Yes"}],
    ["Address of institution/facility","f1","What_is_the_address_of_the_academic_institution_or_higher_education_facility_you_work_at","address",null,false,
      {key:"Are_you_currently_working_in_this_field_at_an_academic_institution_or_higher_education_facility_ov",form:"f1",equals:"Yes"}],
    ["Professional qualifications/experience","f1","What_professional_qualifications_or_experience_do_you_hold","textarea",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Research"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Teaching"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Clinical Practice"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Formal Exchange"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Collaborate on an international project"}
      ]}],
    ["Benefits from this UK trip","f1","What_benefits_will_you_gain_from_this_trip_to_the_UK","textarea",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Research"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Teaching"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Clinical Practice"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Formal Exchange"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Collaborate on an international project"}
      ]}],
    ["Need ATAS permission?","f1","Do_you_need_to_obtain_permission_from_the_ATAS","yesno",null,false],
    ["ATAS reference number","f1","What_is_your_Academic_Technology_Approval_Scheme_ATAS_reference_number","text",null,false,
      {key:"Do_you_need_to_obtain_permission_from_the_ATAS",form:"f1",equals:"Yes"}],
    ["Will you be paid for activities in UK?","f1","Will_you_be_paid_for_any_of_your_activities_while_in_the_UK","yesno",null,false,
      {anyOf:[
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Research"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Teaching"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Clinical Practice"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Formal Exchange"},
        {key:"What_is_the_main_reason_for_your_academic_visit_to_the_UK",form:"f1",equals:"Collaborate on an international project"}
      ]}],
    ["Who will pay you in the UK?","f1","Who_will_be_paying_you_while_you_are_in_the_UK","text",null,false,
      {key:"Will_you_be_paid_for_any_of_your_activities_while_in_the_UK",form:"f1",equals:"Yes"}],
    ["Payment currency","f1","How_much_will_you_be_paid","select",["INR","GBP"],false,
      {key:"Will_you_be_paid_for_any_of_your_activities_while_in_the_UK",form:"f1",equals:"Yes"}],
    ["Amount you will be paid","f1","Amount_you_will_receive","number",null,false,
      {key:"Will_you_be_paid_for_any_of_your_activities_while_in_the_UK",form:"f1",equals:"Yes"}],
    ["What are you being paid for?","f1","What_are_you_being_paid_for","text",null,false,
      {key:"Will_you_be_paid_for_any_of_your_activities_while_in_the_UK",form:"f1",equals:"Yes"}],
    ["Activities planned in UK","f1","Provide_activities_you_are_planning_to_do_in_UK","textarea",null,false],
  ]},
  { id:"marriage", title:"Marriage / Civil Partnership", icon:"&#x1F48D;", showIf:{key:"What_is_the_main_reason_for_your_visit_to_the_UK",form:"f1",equals:"Marriage or civil partnership"}, fields:[
    ["Future spouse - First Name","f1","Tell_us_about_your_future_spouse_or_civil_partner.first_name","text",null,false],
    ["Future spouse - Last Name","f1","Tell_us_about_your_future_spouse_or_civil_partner.last_name","text",null,false],
   ["Future spouse passport number","f1","Passport_number","text",null,false],
    ["Future spouse country of nationality","f1","Country_of_nationality_Future_Spouse","select",UK_CIF_COUNTRIES,false],
    ["Date of wedding/civil ceremony","f1","Date_of_your_wedding_or_civil_ceremony","date",null,false],
    ["Address of venue (must be UK)","f1","Address_of_the_venue","address",null,false],
    ["Given notice at a Register Office in the UK?","f1","Have_you_given_notice_at_a_Register_Office_in_the_UK","yesno",null,false],
    ["Married/in civil partnership before?","f1","Have_you_been_married_or_in_a_civil_partnership_before","yesno",null,false],
  ]},
  { id:"medical", title:"Medical Treatment / Organ Donation", icon:"&#x1FA7A;", showIf:{key:"What_is_the_main_reason_for_your_visit_to_the_UK",form:"f1",equals:"Private medical treatment or organ donation"}, fields:[
    ["Where will you go for medical treatment? (UK)","f1","Where_will_you_go_for_medical_treatment","text",null,false],
    ["Clinic/Hospital address","f1","Clinic_or_Hospital_Address","address",null,false],
    ["Clinic/Hospital telephone","f1","Clinic_or_Hospital_Telephone_number","phone",null,false],
    ["Involves organ donation?","f1","Does_your_medical_treatment_involve_organ_donation","yesno",null,false],
    ["Details of treatment","f1","Provide_details_about_the_treatment_you_will_have","textarea",null,false],
    ["Recipient of organ (full name)","f1","Full_name_of_the_intended_recipient_who_will_be_receiving_the_organ_s_from_you","text",null,false,{key:"Does_your_medical_treatment_involve_organ_donation",form:"f1",equals:"Yes"}],
    ["Recipient's visa/permission type","f1","Select_which_type_of_visa_leave_to_enter_or_remain_or_other_permission_they_have","select",["Visit","Work","Study","Family","Status under the EU Settlement Scheme","Settlement","Other"],false,{key:"Does_your_medical_treatment_involve_organ_donation",form:"f1",equals:"Yes"}],
    ["Recipient's visa/permission detail","f1","What_type_of_visa_leave_to_enter_or_remain_or_other_permission_do_they_have","text",null,false,{key:"Does_your_medical_treatment_involve_organ_donation",form:"f1",equals:"Yes"}],
    ["Recipient's relationship to you","f1","Organ_receiver_s_relationship_to_you","text",null,false,{key:"Does_your_medical_treatment_involve_organ_donation",form:"f1",equals:"Yes"}],
    ["Receiving payment for donation?","f1","Are_you_receiving_payment_for_this_donation","yesno",null,false,{key:"Does_your_medical_treatment_involve_organ_donation",form:"f1",equals:"Yes"}],
    ["Payment currency","f1","How_much_will_you_be_paid_for_organ_donation","select",["INR","GBP"],false,{key:"Are_you_receiving_payment_for_this_donation",form:"f1",equals:"Yes"}],
    ["Amount for organ donation","f1","Amount_you_will_receive_for_organ_donation","number",null,false,{key:"Are_you_receiving_payment_for_this_donation",form:"f1",equals:"Yes"}],
    ["Treatment start date","f1","Start_date_of_treatment","date",null,false],
    ["Treatment end date","f1","End_date_of_treatment","date",null,false],
    ["Paying for treatment yourself?","f1","Will_you_pay_for_the_medical_treatment_yourself","yesno",null,false],
    ["Who is paying for treatment?","f1","Who_is_paying_towards_the_cost_of_your_treatment","select",["My employer","My government","A charity","Other"],false,{key:"Will_you_pay_for_the_medical_treatment_yourself",form:"f1",equals:"No"}],
    ["Charity name","f1","Name_of_the_charity","text",null,false,{key:"Who_is_paying_towards_the_cost_of_your_treatment",form:"f1",equals:"A charity"}],
    ["Contact at charity","f1","Name_of_the_person_you_have_contact_with_in_the_charity_if_known","text",null,false,{key:"Who_is_paying_towards_the_cost_of_your_treatment",form:"f1",equals:"A charity"}],
    ["Person helping with treatment","f1","Name_of_the_person_who_is_helping_you_for_treatment","text",null,false,{key:"Who_is_paying_towards_the_cost_of_your_treatment",form:"f1",equals:"Other"}],
    ["Address of charity/helper","f1","Address_of_the_charity_or_person_who_is_helping","address",null,false,{anyOf:[{key:"Who_is_paying_towards_the_cost_of_your_treatment",form:"f1",equals:"A charity"},{key:"Who_is_paying_towards_the_cost_of_your_treatment",form:"f1",equals:"Other"}]}],
    ["Telephone of charity/helper","f1","Telephone_number_of_charity_or_person_who_is_helping","phone",null,false,{anyOf:[{key:"Who_is_paying_towards_the_cost_of_your_treatment",form:"f1",equals:"A charity"},{key:"Who_is_paying_towards_the_cost_of_your_treatment",form:"f1",equals:"Other"}]}],
    ["Amount they will pay","f1","How_much_money_will_they_be_paying_towards_your_treatment","number",null,false,{key:"Will_you_pay_for_the_medical_treatment_yourself",form:"f1",equals:"No"}],
    ["Why are they helping to pay?","f1","Why_are_they_helping_to_pay_for_your_treatment","textarea",null,false,{key:"Will_you_pay_for_the_medical_treatment_yourself",form:"f1",equals:"No"}],
  ]},
  { id:"study", title:"Short-Term Study", icon:"&#x1F4DA;", showIf:{key:"What_is_the_main_reason_for_your_visit_to_the_UK",form:"f1",equals:"Short-term study (up to 6 months), including recreational course"}, fields:[
    ["Enrolled/accepted on accredited UK course?","f1","Are_you_enrolled_or_accepted_on_a_UK_course_at_an_accredited_institution","yesno",null,false],
    ["Recreational course (max 30 days)?","f1","Is_the_course_you_plan_on_studying_a_recreational_course_lasting_no_longer_than_30_days","yesno",null,false,
      {key:"Are_you_enrolled_or_accepted_on_a_UK_course_at_an_accredited_institution",form:"f1",equals:"No"}],
    ["Institution name","f1","Institution_name","text",null,false,
      {key:"Are_you_enrolled_or_accepted_on_a_UK_course_at_an_accredited_institution",form:"f1",equals:"Yes"}],
    ["Course name","f1","Course_name","text",null,false,
      {key:"Are_you_enrolled_or_accepted_on_a_UK_course_at_an_accredited_institution",form:"f1",equals:"Yes"}],
    ["Qualification you will get","f1","Qualification_you_will_get","text",null,false,
      {key:"Are_you_enrolled_or_accepted_on_a_UK_course_at_an_accredited_institution",form:"f1",equals:"Yes"}],
    ["Course start date","f1","Course_start_date","date",null,false,
      {key:"Are_you_enrolled_or_accepted_on_a_UK_course_at_an_accredited_institution",form:"f1",equals:"Yes"}],
    ["Course end date","f1","Course_end_date","date",null,false,
      {key:"Are_you_enrolled_or_accepted_on_a_UK_course_at_an_accredited_institution",form:"f1",equals:"Yes"}],
  ]},
  { id:"orgvisit", title:"Visits to Organisations in UK", icon:"&#x1F3E2;", fields:[
    ["Visiting a company/organisation in the UK?","f1","Will_you_be_visiting_a_company_or_organisation_in_the_UK","yesno",null,false],
    // FIX: was unconditional — all below only relevant if visiting = Yes
    ["Organisation name","f1","Organisation_name","text",null,false,
      {key:"Will_you_be_visiting_a_company_or_organisation_in_the_UK",form:"f1",equals:"Yes"}],
    ["Invited by someone who works there?","f1","Have_you_been_invited_to_visit_by_someone_who_works_there","yesno",null,false,
      {key:"Will_you_be_visiting_a_company_or_organisation_in_the_UK",form:"f1",equals:"Yes"}],
    // FIX: was unconditional — only relevant if invited = Yes
    ["Inviter - First Name","f1","Name_of_inviter.first_name","text",null,false,
      {key:"Have_you_been_invited_to_visit_by_someone_who_works_there",form:"f1",equals:"Yes"}],
    ["Inviter - Last Name","f1","Name_of_inviter.last_name","text",null,false,
      {key:"Have_you_been_invited_to_visit_by_someone_who_works_there",form:"f1",equals:"Yes"}],
    // FIX: was unconditional — only relevant if visiting = Yes
    ["What work does the organisation do?","f1","What_sort_of_work_does_the_organisation_do","text",null,false,
      {key:"Will_you_be_visiting_a_company_or_organisation_in_the_UK",form:"f1",equals:"Yes"}],
    ["Organisation telephone","f1","Organisation_Telephone_number","phone",null,false,
      {key:"Will_you_be_visiting_a_company_or_organisation_in_the_UK",form:"f1",equals:"Yes"}],
    ["Organisation's address (UK)","f1","Enter_the_organisation_s_address","address",null,false,
      {key:"Will_you_be_visiting_a_company_or_organisation_in_the_UK",form:"f1",equals:"Yes"}],
  ]},
  { id:"family", title:"Family Information", icon:"&#x1F46A;", fields:[
    ["Current partner/spouse - First Name","f2","Your_current_partner_Spouse.first_name","text",null,false],
    ["Current partner/spouse - Last Name","f2","Your_current_partner_Spouse.last_name","text",null,false],
    ["Spouse's Date of Birth","f2","Spouse_s_Date_of_Birth","date",null,false],
    ["Spouse's Country of nationality","f2","Spouse_s_Country_of_nationality","select",UK_CIF_COUNTRIES,false],
    ["Do they currently live with you?","f2","Do_they_currently_live_with_you","yesno",null,false],
    // FIX: was unconditional — address only needed when NOT living with you
    ["Spouse's address","f2","Spouse_s_address","address",null,false,
      {key:"Do_they_currently_live_with_you",form:"f2",equals:"No"}],
    ["Will they travel with you to the UK?","f2","Will_they_be_travelling_with_you_to_the_UK","yesno",null,false],
   ["Spouse's passport number","f2","Spouse_s_passport_number","text",null,false],
    ["How many children travelling with you?","f2","How_many_of_your_children_travelling_with_you","select",["0","1","2","3","4"],false],
  ]},
  { id:"dependents", title:"Financial Dependents", icon:"&#x1F91D;", fields:[
    ["Does anyone rely on you for financial support?","f2","Does_anyone_rely_on_you_for_financial_support","yesno",null,true],
  ]},
  // FIX: added section-level showIf — this subform previously rendered unconditionally
  { id:"dependentsList", title:"Dependent Details", icon:"&#x1F91D;", subform:true, form:"f2", key:"Dependent_details",
    showIf:{key:"Does_anyone_rely_on_you_for_financial_support",form:"f2",equals:"Yes"}, rowFields:[
    ["Relationship to you","What_is_this_person_s_relationship_to_you","text",null,false],
["Prefix","Name.prefix","select",["Mr.","Mrs.","Ms."],false],
["First Name","Name.first_name","text",null,false],
["Last Name","Name.last_name","text",null,false],
    ["Date of Birth","date_of_birth","date",null,false],
    ["Currently lives with you?","Does_this_person_currently_live_with_you","yesno",null,false],
    ["Address","Address","address",null,false,{key:"Does_this_person_currently_live_with_you",equals:"No"}],
    ["Travelling with you to the UK?","Is_this_person_travelling_with_you_to_the_UK","yesno",null,false],
    ["Country of nationality","Country_of_nationality","select",UK_CIF_COUNTRIES,false,{key:"Is_this_person_travelling_with_you_to_the_UK",equals:"Yes"}],
    ["Passport number","Passport_number","text",null,false,{key:"Is_this_person_travelling_with_you_to_the_UK",equals:"Yes"}],
  ]},
  { id:"parents", title:"Parents' Details", icon:"&#x1F468;&#x200D;&#x1F469;&#x200D;&#x1F467;", fields:[
    ["Father's name","f2","Your_father_s_name","text",null,true],
    ["Father's date of birth","f2","Father_s_date_of_birth","date",null,true],
    ["Father's country of nationality","f2","Father_s_Country_of_nationality","select",COUNTRIES,true],
    ["Father always had same nationality?","f2","Have_your_father_always_had_the_same_nationality","yesno",null,true],
    // FIX: was unconditional — only relevant if father's nationality changed
    ["Father's nationality when you were born","f2","Father_s_Country_of_nationality_when_you_were_born","select",COUNTRIES,false,
      {key:"Have_your_father_always_had_the_same_nationality",form:"f2",equals:"No"}],
    ["Mother's name","f2","Your_mother_s_name","text",null,true],
    ["Mother's date of birth","f2","Mother_s_date_of_birth","date",null,true],
    ["Mother's country of nationality","f2","Mother_s_Country_of_nationality","select",COUNTRIES,false],
    ["Mother always had same nationality?","f2","Have_your_mother_always_had_the_same_nationality","yesno",null,true],
    // FIX: was unconditional — only relevant if mother's nationality changed
    ["Mother's nationality when you were born","f2","Mother_s_Country_of_nationality_when_you_were_born","select",COUNTRIES,false,
      {key:"Have_your_mother_always_had_the_same_nationality",form:"f2",equals:"No"}],
    ["Do you have any family in the UK?","f2","Do_you_have_any_family_in_the_UK","yesno",null,true],
  ]},
  // FIX: added section-level showIf — this subform previously rendered unconditionally
  { id:"relativesUK", title:"Relatives in the UK", icon:"&#x1F1EC;&#x1F1E7;", subform:true, form:"f2", key:"Relatives_In_the_UK",
    showIf:{key:"Do_you_have_any_family_in_the_UK",form:"f2",equals:"Yes"}, rowFields:[
    ["Their relationship to you","Their_relationship_to_you","select",["Brother","Brother-in-law","Child","Child's spouse (daughter-in-law or son-in-law)","Daughter","Daughter-in-law","Father","Father-in-law","Grandchild","Grandparent","Husband","Mother","Mother-in-law","Parent","Sister","Sister-in-law","Son","Son-in-law","Spouse (husband or wife)","Step-child","Step-parents","Step-sister or brother","Unmarried partner","Wife"],false],
    ["Prefix","Name_of_Relative.prefix","select",["Mr.","Mrs.","Ms."],false],
    ["First Name","Name_of_Relative.first_name","text",null,false],
    ["Last Name","Name_of_Relative.last_name","text",null,false],
    ["Country of nationality","Country_of_nationality","select",UK_CIF_COUNTRIES,false],
    ["Their permission to be in the UK","What_permission_do_they_have_to_be_in_the_UK","select",["They have a temporary visa","They are in the UK permanently","They do not have a visa and are not in the UK permanently","I cannot contact my relative"],false],
    ["Their passport number","Their_passport_number","text",null,false],
    ["Details of their UK status","Give_as_much_information_as_possible_about_their_status_in_the_UK_including_if_they_are_waiting_fo","textarea",null,false],
    ["Why can't you ask your relative?","Why_can_you_not_ask_your_relative","textarea",null,false],
  ]},
 /* ============================================================================
   REPLACE the existing `{ id:"adultsTravelling", ... }` object inside
   CIF_UK_SECTIONS with this one. Two bugs fixed:

   1. "Which two adults (if 2)?" and "Which adult (if 1)?" had NO showIf —
      both could hold stale values simultaneously and both got sent to Zoho
      even when only one applied (e.g. picking "2 adults" left an old "1
      adult" answer in the payload too). Now each is gated on the actual
      "How many adults" selection.

   2. The Co-traveller 1 condition used `containsText:"An adult who is not
      my parent or guardian"` against the two-adults field. That substring
      does NOT appear in the option "Both adults who are not my parent or
      guardian" (plural wording), so picking "Both adults..." would never
      correctly reveal — or require — Co-traveller 1's details in a clean
      flow. Added an explicit `equals` check for that option.
   ============================================================================ */

{ id:"adultsTravelling", title:"Adults Travelling With You", icon:"&#x1F465;", fields:[
  ["How many adults on your visa?","f2","How_many_adults_do_you_want_to_list_on_your_visa","select",["2 adults","1 adult","I will be travelling alone"],true],

  // FIX: was un-gated — now only shows/sends when "2 adults" is picked
  ["Which two adults (if 2)?","f2","Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you","select",["My Mother and Father","My Mother and An adult who is not my parent or guardian","My Father and An adult who is not my parent or guardian","Both adults who are not my parent or guardian"],false,
    {key:"How_many_adults_do_you_want_to_list_on_your_visa",form:"f2",equals:"2 adults"}],

  // FIX: was un-gated — now only shows/sends when "1 adult" is picked
  ["Which adult (if 1)?","f2","Which_adult_will_travel_with_you_if_single_adult_is_travelling_with_you","select",["My Mother","My Father","An adult who is not my parent or guardian"],false,
    {key:"How_many_adults_do_you_want_to_list_on_your_visa",form:"f2",equals:"1 adult"}],

  // FIX: added the missing equals check for "Both adults..." (plural wording
  // doesn't match the old containsText test)
  ["Co-traveller 1: How do you know them?","f2","How_do_you_know_this_person","select",["Relative","Paid carer","Other"],true,
    {anyOf:[
      {key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",containsText:"An adult who is not my parent or guardian"},
      {key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",equals:"Both adults who are not my parent or guardian"},
      {key:"Which_adult_will_travel_with_you_if_single_adult_is_travelling_with_you",form:"f2",equals:"An adult who is not my parent or guardian"}
    ]}],
  ["Co-traveller 1: Relationship details","f2","Give_your_relationship_details","textarea",null,true,
    {anyOf:[
      {key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",containsText:"An adult who is not my parent or guardian"},
      {key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",equals:"Both adults who are not my parent or guardian"},
      {key:"Which_adult_will_travel_with_you_if_single_adult_is_travelling_with_you",form:"f2",equals:"An adult who is not my parent or guardian"}
    ]}],
  ["Co-traveller 1 - First Name","f2","Give_name_of_the_person_one.first_name","text",null,true,
    {anyOf:[
      {key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",containsText:"An adult who is not my parent or guardian"},
      {key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",equals:"Both adults who are not my parent or guardian"},
      {key:"Which_adult_will_travel_with_you_if_single_adult_is_travelling_with_you",form:"f2",equals:"An adult who is not my parent or guardian"}
    ]}],
  ["Co-traveller 1 - Last Name","f2","Give_name_of_the_person_one.last_name","text",null,true,
    {anyOf:[
      {key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",containsText:"An adult who is not my parent or guardian"},
      {key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",equals:"Both adults who are not my parent or guardian"},
      {key:"Which_adult_will_travel_with_you_if_single_adult_is_travelling_with_you",form:"f2",equals:"An adult who is not my parent or guardian"}
    ]}],

  // unchanged — this one was already correctly gated
  ["Co-traveller 2: How do you know them?","f2","How_do_you_know_this_second_person","select",["Relative","Paid carer","Other"],false,{key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",equals:"Both adults who are not my parent or guardian"}],
  ["Co-traveller 2: Relationship details","f2","Give_your_relationship_details_with_second_person","textarea",null,false,{key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",equals:"Both adults who are not my parent or guardian"}],
  ["Co-traveller 2 - First Name","f2","Give_name_of_the_person_two.first_name","text",null,false,{key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",equals:"Both adults who are not my parent or guardian"}],
  ["Co-traveller 2 - Last Name","f2","Give_name_of_the_person_two.last_name","text",null,false,{key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",equals:"Both adults who are not my parent or guardian"}],

  ["Mother's contact telephone","f2","Mother_s_contact_telephone_number","phone",null,true,{anyOf:[{key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",containsText:"Mother"},{key:"Which_adult_will_travel_with_you_if_single_adult_is_travelling_with_you",form:"f2",equals:"My Mother"}]}],
  ["Mother's email address","f2","Mother_s_Email_address","text",null,true,{anyOf:[{key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",containsText:"Mother"},{key:"Which_adult_will_travel_with_you_if_single_adult_is_travelling_with_you",form:"f2",equals:"My Mother"}]}],
  ["Mother's passport number","f2","Mother_s_Passport_number","text",null,true,{anyOf:[{key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",containsText:"Mother"},{key:"Which_adult_will_travel_with_you_if_single_adult_is_travelling_with_you",form:"f2",equals:"My Mother"}]}],
  ["I live with my mother","f2","I_live_with_my_mother","yesnobool",null,true,{anyOf:[{key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",containsText:"Mother"},{key:"Which_adult_will_travel_with_you_if_single_adult_is_travelling_with_you",form:"f2",equals:"My Mother"}]}],
  ["Mother's address","f2","Mother_s_Address","address",null,true,{anyOf:[{key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",containsText:"Mother"},{key:"Which_adult_will_travel_with_you_if_single_adult_is_travelling_with_you",form:"f2",equals:"My Mother"}]}],
  ["Father's contact telephone","f2","Father_s_contact_telephone_number","phone",null,true,   {anyOf:[{key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",containsText:"Father"},{key:"Which_adult_will_travel_with_you_if_single_adult_is_travelling_with_you",form:"f2",equals:"My Father"}]}],
  ["Father's email address","f2","Father_s_Email_address","text",null,true,{anyOf:[{key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",containsText:"Father"},{key:"Which_adult_will_travel_with_you_if_single_adult_is_travelling_with_you",form:"f2",equals:"My Father"}]}],
  ["Father's passport number","f2","Father_s_Passport_number","text",null,true,{anyOf:[{key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",containsText:"Father"},{key:"Which_adult_will_travel_with_you_if_single_adult_is_travelling_with_you",form:"f2",equals:"My Father"}]}],
  ["I live with my father","f2","I_live_with_my_father","yesnobool",null,true,{anyOf:[{key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",containsText:"Father"},{key:"Which_adult_will_travel_with_you_if_single_adult_is_travelling_with_you",form:"f2",equals:"My Father"}]}],
  ["Father's address","f2","Father_s_Address","address",null,true,{anyOf:[{key:"Which_adult_will_travel_with_you_if_two_adults_are_travelling_with_you",form:"f2",containsText:"Father"},{key:"Which_adult_will_travel_with_you_if_single_adult_is_travelling_with_you",form:"f2",equals:"My Father"}]}],

  ["Travelling as part of an organised group?","f2","Will_you_be_travelling_to_the_UK_as_part_of_an_organised_group","yesno",null,true],
  ["Company/group name","f2","Company_or_group_name","text",null,false,
    {key:"Will_you_be_travelling_to_the_UK_as_part_of_an_organised_group",form:"f2",equals:"Yes"}],
  ["Travelling with someone who isn't your partner/spouse/dependant?","f2","Will_you_be_travelling_to_the_UK_with_someone_who_is_not_your_partner_spouse_or_dependant","yesno",null,false],
  ["Companion - First Name","f2","Who_will_you_be_travelling_with_to_the_UK.first_name","text",null,false,
    {key:"Will_you_be_travelling_to_the_UK_with_someone_who_is_not_your_partner_spouse_or_dependant",form:"f2",equals:"Yes"}],
  ["Companion - Last Name","f2","Who_will_you_be_travelling_with_to_the_UK.last_name","text",null,false,
    {key:"Will_you_be_travelling_to_the_UK_with_someone_who_is_not_your_partner_spouse_or_dependant",form:"f2",equals:"Yes"}],
  ["Companion's country of nationality","f2","Country_of_nationality_Co_Traveller","select",UK_CIF_COUNTRIES,false,
    {key:"Will_you_be_travelling_to_the_UK_with_someone_who_is_not_your_partner_spouse_or_dependant",form:"f2",equals:"Yes"}],
  ["Companion's relationship to you","f2","Relationship_to_you","select",["Parent","Fiance or fiancee","Son or Daughter","Friend","Work colleague","Employer","Other"],false,
    {key:"Will_you_be_travelling_to_the_UK_with_someone_who_is_not_your_partner_spouse_or_dependant",form:"f2",equals:"Yes"}],
  ["Relationship detail (if Other)","f2","Enter_their_relationship_to_you","text",null,false,
    {key:"Relationship_to_you",form:"f2",equals:"Other"}],
  ["Have an address for UK accommodation?","f2","Do_you_have_an_address_for_where_you_are_going_to_stay_in_the_UK","yesno",null,true],
]},
  // FIX: added section-level showIf — this subform previously rendered unconditionally
  { id:"accommodation", title:"Accommodation in the UK", icon:"&#x1F3E8;", subform:true, form:"f2", key:"Accommodation_in_UK",
    showIf:{key:"Do_you_have_an_address_for_where_you_are_going_to_stay_in_the_UK",form:"f2",equals:"Yes"}, rowFields:[
    ["Where are you planning to stay?","Where_are_you_planning_to_stay_in_the_UK","text",null,false],
    ["Address","Address","address",null,false],
    ["Arrival date","When_will_you_arrive_there","date",null,false],
    ["Departure date","When_will_you_leave_there","date",null,false],
  ]},
  { id:"stayPlan", title:"Stay Plan (if no fixed address)", icon:"&#x1F5FA;&#xFE0F;",
    // FIX: section title always said "if no fixed address" but the condition was never wired in
    showIf:{key:"Do_you_have_an_address_for_where_you_are_going_to_stay_in_the_UK",form:"f2",equals:"No"}, fields:[
    ["Where do you plan to stay in the UK?","f2","Where_do_you_plan_to_stay_in_the_UK","textarea",null,false],
  ]},
  { id:"ukHistory", title:"Previous Travel to the UK", icon:"&#x1F1EC;&#x1F1E7;", fields:[
    ["Been to the UK in the past 10 years?","f3","Have_you_been_to_the_UK_in_the_past_10_years","yesno",null,true],
    // FIX: was unconditional — only relevant if been to UK = Yes
    ["How many times in past 10 years?","f3","How_many_times_have_you_been_to_the_UK_in_the_past_10_years","number",null,false,
      {key:"Have_you_been_to_the_UK_in_the_past_10_years",form:"f3",equals:"Yes"}],
  ]},
  // FIX: added section-level showIf — this subform previously rendered unconditionally
  { id:"ukVisits", title:"Your Most Recent Times in the UK", icon:"&#x1F1EC;&#x1F1E7;", subform:true, form:"f3", key:"Your_most_recent_time_in_the_UK",
    showIf:{key:"Have_you_been_to_the_UK_in_the_past_10_years",form:"f3",equals:"Yes"}, rowFields:[
    ["Why were you in the UK?","Select_why_you_were_in_the_UK","select",["Tourism (including visiting family and friends)","Work","Study","Transit (travelling through the country)","Other"],false],
    ["Details","Provide_details_about_why_you_were_in_the_UK","textarea",null,false],
    ["Date arrived","Date_you_arrived_in_the_UK","date",null,false],
    ["How long (days)","How_long_were_you_in_the_UK_Number_of_Days","number",null,false],
  ]},
  { id:"ukMedical", title:"Previous Medical Treatment in UK", icon:"&#x1FA7A;", showIf:{key:"Have_you_been_to_the_UK_in_the_past_10_years",form:"f3",equals:"Yes"}, fields:[
    ["Ever given medical treatment in the UK?","f3","Have_you_ever_been_given_medical_treatment_in_the_UK","yesno",null,false],
    ["Told to pay for treatment?","f3","Were_you_told_that_you_had_to_pay_the_hospital_clinic_or_doctor_s_surgery_for_your_medical_treatment","yesno",null,false,
      {key:"Have_you_ever_been_given_medical_treatment_in_the_UK",form:"f3",equals:"Yes"}],
    ["Paid the full amount?","f3","Have_you_paid_the_full_amount","yesno",null,false,
      {key:"Were_you_told_that_you_had_to_pay_the_hospital_clinic_or_doctor_s_surgery_for_your_medical_treatment",form:"f3",equals:"Yes"}],
  ]},
  // FIX: added section-level showIf — this subform previously rendered unconditionally
  { id:"ukMedicalDetails", title:"Medical Treatment Details (Main applicant)", icon:"&#x1FA7A;", subform:true, form:"f3", key:"Medical_treatment_in_UK_Main_applicant",
    showIf:{key:"Have_you_ever_been_given_medical_treatment_in_the_UK",form:"f3",equals:"Yes"}, rowFields:[
    ["Where did you go?","Where_did_you_go_for_your_previous_medical_treatment_in_the_UK","select",["Accident and Emergency (A &E) at a hospital","To a doctor, clinic or hospital for non-emergency treatment"],false],
    ["Name of hospital/clinic/doctor","Name_of_hospital_clinic_or_doctors_s_surgery","text",null,false],
    ["Hospital address","Hospital_Address","address",null,false],
    ["When did treatment start?","When_did_you_start_receiving_this_medical_treatment","date",null,false],
    ["Still receiving treatment?","Are_you_still_receiving_this_medical_treatment","yesno",null,false],
    ["When did treatment stop?","When_did_you_stop_receiving_this_medical_treatment","date",null,false,{key:"Are_you_still_receiving_this_medical_treatment",equals:"No"}],
  ]},
  { id:"ukMisc", title:"UK National Insurance / Driving / Public Funds", icon:"&#x1F4C4;", showIf:{key:"Have_you_been_to_the_UK_in_the_past_10_years",form:"f3",equals:"Yes"}, fields:[
    ["Have a UK National Insurance number?","f3","Do_you_have_a_UK_National_Insurance_number","yesno",null,false],
    ["National Insurance number","f3","What_is_your_National_Insurance_number","text",null,false,
      {key:"Do_you_have_a_UK_National_Insurance_number",form:"f3",equals:"Yes"}],
    ["Have a UK driving licence?","f3","Do_you_have_a_UK_driving_licence","yesno",null,false],
    ["Licence number","f3","Enter_your_licence_number_if_you_know_it","text",null,false,
      {key:"Do_you_have_a_UK_driving_licence",form:"f3",equals:"Yes"}],
    ["Received any public funds (money) in the UK?","f3","Have_you_received_any_public_funds_money_in_the_UK","yesno",null,false],
  ]},
  // FIX: added section-level showIf — this subform previously rendered unconditionally
  { id:"publicFunds", title:"Public Funds Received (Main applicant)", icon:"&#x1F4B7;", subform:true, form:"f3", key:"Public_funds_Main_applicant",
    showIf:{key:"Have_you_received_any_public_funds_money_in_the_UK",form:"f3",equals:"Yes"}, rowFields:[
    ["Name of public fund","Name_of_public_fund","text",null,false],
    ["Frequency of payment","Frequency_of_payment","select",["Weekly","Monthly"],false],
    ["Amount per payment (GBP)","Public_fund_amount_per_payment_GBP","text",null,false],
    ["When did you start receiving it?","When_did_you_start_receiving_this_public_fund","date",null,false],
    ["Still receiving it?","Are_you_still_receive_this_public_fund","yesno",null,false],
    ["When did you stop receiving it?","When_did_you_stop_receiving_this_public_fund","date",null,false,{key:"Are_you_still_receive_this_public_fund",equals:"No"}],
  ]},
  { id:"visaHistory", title:"UK Visa & Leave History", icon:"&#x1F4CB;", fields:[
    ["Issued a UK visa in past 10 years?","f3","Have_you_been_issued_with_a_UK_visa_in_the_past_10_years","yesno",null,false,
      {key:"Have_you_been_to_the_UK_in_the_past_10_years",form:"f3",equals:"Yes"}],
    // FIX: was unconditional — only relevant if issued a UK visa = Yes
    ["Date of visa issue","f3","Date_of_visa_issue","date",null,false,
      {key:"Have_you_been_issued_with_a_UK_visa_in_the_past_10_years",form:"f3",equals:"Yes"}],
    ["Applied for leave to remain in past 10 years?","f3","Have_you_applied_for_leave_to_remain_in_the_UK_in_the_past_10_years","yesno",null,false,
      {key:"Have_you_been_to_the_UK_in_the_past_10_years",form:"f3",equals:"Yes"}],
    // FIX: was unconditional — only relevant if applied for leave to remain = Yes
    ["Date of application","f3","Date_of_application","date",null,false,
      {key:"Have_you_applied_for_leave_to_remain_in_the_UK_in_the_past_10_years",form:"f3",equals:"Yes"}],
    // FIX: was unconditional — only relevant if applied for leave to remain = Yes
    ["Result of application","f3","What_was_the_result_of_your_application","select",["Approved","Refused"],false,
      {key:"Have_you_applied_for_leave_to_remain_in_the_UK_in_the_past_10_years",form:"f3",equals:"Yes"}],
    ["Times visited Australia/Canada/NZ/USA/Switzerland/EEA in past 10yrs","f3","How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo","select",["Zero","Once","2 to 5 times","6 or more times"],true],
    // FIX: was unconditional — "most recent visit" block only relevant if visits != Zero
    ["Most recent visit - which country?","f3","Which_country_did_you_visit_most_recently","select",["Australia","Canada","New Zealand","USA","European Economic Area and Switzerland"],false,
      {key:"How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo",form:"f3",notEquals:"Zero"}],
    ["Most recent visit - reason category","f3","What_was_the_reason_for_your_visit","select",["Tourism (including visiting family and friends)","Work","Study","Transit (travelling through the country)","Other reason"],false,
      {key:"How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo",form:"f3",notEquals:"Zero"}],
    ["Most recent visit - reason detail","f3","What_was_the_reason_for_your_most_recent_visit","text",null,false,
      {key:"How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo",form:"f3",notEquals:"Zero"}],
    ["Most recent visit - start date","f3","Date_of_your_most_recent_visit","date",null,false,
      {key:"How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo",form:"f3",notEquals:"Zero"}],
    ["Most recent visit - end date","f3","End_date_of_your_most_recent_visit","date",null,false,
      {key:"How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo",form:"f3",notEquals:"Zero"}],
    // FIX: was unconditional — "second recent visit" block only relevant if visits = "2 to 5 times" or "6 or more times"
    ["Second recent visit - which country?","f3","Which_second_country_did_you_visit_recently","select",["Australia","Canada","New Zealand","USA","European Economic Area and Switzerland"],false,
      {anyOf:[{key:"How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo",form:"f3",equals:"2 to 5 times"},{key:"How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo",form:"f3",equals:"6 or more times"}]}],
    ["Second recent visit - reason category","f3","What_was_the_reason_for_your_visit_to_second_country","select",["Tourism (including visiting family and friends)","Work","Study","Transit (travelling through the country)","Other reason"],false,
      {anyOf:[{key:"How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo",form:"f3",equals:"2 to 5 times"},{key:"How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo",form:"f3",equals:"6 or more times"}]}],
    ["Second recent visit - reason detail","f3","What_was_the_reason_for_your_second_recent_visit","text",null,false,
      {anyOf:[{key:"How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo",form:"f3",equals:"2 to 5 times"},{key:"How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo",form:"f3",equals:"6 or more times"}]}],
    ["Second recent visit - start date","f3","Date_of_your_second_recent_visit","date",null,false,
      {anyOf:[{key:"How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo",form:"f3",equals:"2 to 5 times"},{key:"How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo",form:"f3",equals:"6 or more times"}]}],
    ["Second recent visit - end date","f3","End_date_of_your_second_recent_visit","date",null,false,
      {anyOf:[{key:"How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo",form:"f3",equals:"2 to 5 times"},{key:"How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo",form:"f3",equals:"6 or more times"}]}],
    ["Been to any OTHER countries in past 10 years?","f3","Have_you_been_to_any_other_countries_in_the_past_10_years","yesno",null,true],
  ]},
  // FIX: added section-level showIf — this subform previously rendered unconditionally
  { id:"worldTravel", title:"World Travel History (Other Countries)", icon:"&#x1F30D;", subform:true, form:"f3", key:"World_travel_history",
    showIf:{key:"Have_you_been_to_any_other_countries_in_the_past_10_years",form:"f3",equals:"Yes"}, rowFields:[
   ["Which country did you visit?","Which_country_did_you_visit","select",UK_CIF_COUNTRIES,false],
    ["Reason category","What_was_the_reason_for_your_visit_Required","select",["Tourism (including visiting family and friends)","Work","Study","Transit (travelling visiting family and friends)","Other - provide details"],false],
    ["Reason detail","What_was_the_reason_for_your_visit","textarea",null,false],
    ["Date entered country","When_did_you_enter_this_country","date",null,false],
    ["Date left country","When_did_you_leave_this_country","date",null,false],
  ]},
  { id:"immigrationHist", title:"Immigration History", icon:"&#x26A0;&#xFE0F;", fields:[
    ["Ever refused visa/entry/asylum, deported, removed, excluded (UK or any country)?","f3","Above_the_Immigration_history","yesno",null,true],
  ]},
  // FIX: added section-level showIf — this subform previously rendered unconditionally
  { id:"immigrationProblems", title:"Details of Immigration Problem", icon:"&#x26A0;&#xFE0F;", subform:true, form:"f3", key:"Details_of_an_immigration_problem",
    showIf:{key:"Above_the_Immigration_history",form:"f3",equals:"Yes"}, rowFields:[
    ["What happened?","Give_details_of_what_happened","select",["An appication for a visa was refused","I was refused entry at the border","I was refused permission to  stay or remain","I was deported","I was removed","I was required to leave","I was excluded or bannee from entry"],true],
    ["Which country?","In_which_country_immigration_problem_was_happen","select",UK_CIF_COUNTRIES,false],
    ["When did it happen?","When_did_this_immigration_problem_happen","date",null,false],
    ["More details","Give_more_details_of_what_happened","textarea",null,false],
  ]},
  { id:"breachHist", title:"Breach of UK Immigration Law", icon:"&#x1F6AB;", fields:[
    ["Ever entered UK illegally / overstayed / breached conditions / given false info / other breach?","f3","Above_the_Breach_of_UK_immigration_law","yesno",null,true],
  ]},
  // FIX: added section-level showIf — this subform previously rendered unconditionally
  { id:"breachDetails", title:"Details of Breach", icon:"&#x1F6AB;", subform:true, form:"f3", key:"History_Breach_of_UK_immigration_law",
    showIf:{key:"Above_the_Breach_of_UK_immigration_law",form:"f3",equals:"Yes"}, rowFields:[
    ["What happened?","Give_details_of_what_happened","select",["I entered the UK Ilegally","I remained in the UK the validity of my visa/permission to stay","I breached the conditions of my leave","I gave false information when applying for a visa, leave to enter or remain"],false],
    ["When did it happen?","When_did_this_breach_of_UK_immigration_law_happen","date",null,false],
    ["More details","Give_more_details_of_what_happened","textarea",null,false],
  ]},
  { id:"convictionsHist", title:"Convictions & Other Penalties", icon:"&#x2696;&#xFE0F;", fields:[
    ["Ever had convictions, offences, cautions, penalties, court judgments (incl. UK immigration law)?","f3","Have_you_ever_had_any_convictions_offences_cautions_penalties_or_court_judgments_including_under_U","yesno",null,true],
  ]},
  // FIX: added section-level showIf — this subform previously rendered unconditionally
 { id:"convictionsDetails", title:"Conviction / Penalty Details", icon:"&#x2696;&#xFE0F;", subform:true, form:"f3", key:"Convictions_and_other_penalties",
    showIf:{key:"Have_you_ever_had_any_convictions_offences_cautions_penalties_or_court_judgments_including_under_U",form:"f3",equals:"Yes"}, rowFields:[
    ["Type","Please_select_exact_Convictions_or_other_penalties","select",["A criminal conviction","A penalty for a driving offence, for example disqualification for speeding or no motor insurance","An arrest or charge for which you are currently on, or awaiting trial","A caution, warning, reprimand or other out-of-court penalty","Civilcourtjudgmentagainstyoufor examplefornonpaymentofdebtbankruptcyorantisocialbehaviour","A Civil penalty issed under UK immigration law"],true],
    ["What crime were you convicted of?","What_crime_were_you_convicted_of","text",null,false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"A criminal conviction"}],
    ["Details of sentence","Give_details_about_your_sentence","textarea",null,false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"A criminal conviction"}],
    ["Date sentenced","Date_you_were_sentenced","date",null,false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"A criminal conviction"}],
    ["Driving offence type","You_must_declare_fixed_penalty_notices_e_g_speeding_parking_if_you_have_3_or_more_Also_declare_if","select",["Disqualification for speeding","No insurance","Other"],false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"A penalty for a driving offence, for example disqualification for speeding or no motor insurance"}],
    ["Driving offence detail","Give_more_detail_for_example_the_fine_or_points_on_your_licence","textarea",null,false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"A penalty for a driving offence, for example disqualification for speeding or no motor insurance"}],
    ["Date of penalty (driving)","Date_of_the_penalty","date",null,false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"A penalty for a driving offence, for example disqualification for speeding or no motor insurance"}],
    ["Why were you arrested/charged?","Why_were_you_arrested_and_charged","text",null,false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"An arrest or charge for which you are currently on, or awaiting trial"}],
    ["Arrest/charge detail","Give_more_detail_including_arrest_date_charge_date_and_any_court_dates","textarea",null,false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"An arrest or charge for which you are currently on, or awaiting trial"}],
    ["Out-of-court penalty type","Which_out_of_court_penalty_did_you_receive","select",["A conditional caution","A warning or reprimand","A fixed penalty notice","Other"],false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"A caution, warning, reprimand or other out-of-court penalty"}],
    ["Out-of-court penalty detail","Give_more_detail_and_if_it_was_a_conditional_caution_include_the_conditions","textarea",null,false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"A caution, warning, reprimand or other out-of-court penalty"}],
    ["Date of out-of-court penalty","Date_you_got_this_penalty","date",null,false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"A caution, warning, reprimand or other out-of-court penalty"}],
    ["Civil court judgment","What_was_the_court_judgment","text",null,false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"Civilcourtjudgmentagainstyoufor examplefornonpaymentofdebtbankruptcyorantisocialbehaviour"}],
    ["Civil judgment detail","Give_more_detail_about_civil_court_judgment","textarea",null,false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"Civilcourtjudgmentagainstyoufor examplefornonpaymentofdebtbankruptcyorantisocialbehaviour"}],
    ["Date of judgment","Date_of_judgment","date",null,false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"Civilcourtjudgmentagainstyoufor examplefornonpaymentofdebtbankruptcyorantisocialbehaviour"}],
    ["Country convicted in","Which_country_were_you_convicted_in","select",UK_CIF_COUNTRIES,false,{anyOf:[
      {key:"Please_select_exact_Convictions_or_other_penalties",equals:"A criminal conviction"},
      {key:"Please_select_exact_Convictions_or_other_penalties",equals:"A penalty for a driving offence, for example disqualification for speeding or no motor insurance"},
      {key:"Please_select_exact_Convictions_or_other_penalties",equals:"An arrest or charge for which you are currently on, or awaiting trial"},
      {key:"Please_select_exact_Convictions_or_other_penalties",equals:"A caution, warning, reprimand or other out-of-court penalty"},
      {key:"Please_select_exact_Convictions_or_other_penalties",equals:"Civilcourtjudgmentagainstyoufor examplefornonpaymentofdebtbankruptcyorantisocialbehaviour"}
    ]}],
    ["Why civil penalty (immigration)?","Why_did_you_get_the_civil_penalty","text",null,false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"A Civil penalty issed under UK immigration law"}],
    ["Civil penalty detail","Give_more_detail_for_example_how_much_was_the_penalty","textarea",null,false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"A Civil penalty issed under UK immigration law"}],
    ["Date of civil penalty","Date_of_penalty","date",null,false,{key:"Please_select_exact_Convictions_or_other_penalties",equals:"A Civil penalty issed under UK immigration law"}],
  ]},
  { id:"character", title:"Character & Security Declarations", icon:"&#x1F6E1;&#xFE0F;", fields:[
    ["Ever involved in/suspected of war crimes, crimes against humanity, or genocide?","f3","War_crimes","yesno",null,true],
    ["Please provide details","f3","More_information_about_your_involvement","textarea",null,false,{key:"War_crimes",form:"f3",equals:"Yes"}],
    ["Ever involved in, supported, or encouraged terrorist activities?","f3","Have_you_ever_been_involved_in_supported_or_encouraged_terrorist_activities_in_any_country","yesno",null,true],
    ["Please provide details","f3","Give_more_information_about_your_terrorist_activities","textarea",null,false,{key:"Have_you_ever_been_involved_in_supported_or_encouraged_terrorist_activities_in_any_country",form:"f3",equals:"Yes"}],
    ["Ever a member of / supported an organisation concerned in terrorism?","f3","Have_you_ever_been_a_member_of_or_given_support_to_an_organisation_which_has_been_concerned_in_ter","yesno",null,true],
    ["Please provide details","f3","Give_more_information_about_the_terrorist_organisation_s","textarea",null,false,{key:"Have_you_ever_been_a_member_of_or_given_support_to_an_organisation_which_has_been_concerned_in_ter",form:"f3",equals:"Yes"}],
    ["Ever expressed views justifying/glorifying terrorist violence?","f3","Have_you_by_any_means_or_medium_expressed_views_that_justify_or_glorify_terrorist_violence_or_that","yesno",null,true],
["Please provide details","f3","Give_more_information_about_your_terrorist_views","textarea",null,false,{key:"Have_you_by_any_means_or_medium_expressed_views_that_justify_or_glorify_terrorist_violence_or_that",form:"f3",equals:"Yes"}],
["Ever a member of / supported an organisation concerned with extremism?","f3","Have_you_ever_been_a_member_of_or_given_support_to_an_organisation_which_is_or_has_been_concerned","yesno",null,true],
    ["Please provide details","f3","Give_more_information_about_the_extremist_organisation_s","textarea",null,false,{key:"Have_you_ever_been_a_member_of_or_given_support_to_an_organisation_which_is_or_has_been_concerned",form:"f3",equals:"Yes"}],
    ["Ever expressed extremist views?","f3","Have_you_by_any_means_or_medium_expressed_any_extremist_views","yesno",null,true],
    ["Please provide details","f3","Give_more_information_about_your_extremist_views","textarea",null,false,{key:"Have_you_by_any_means_or_medium_expressed_any_extremist_views",form:"f3",equals:"Yes"}],
    ["Undertaken activity for a non-UK government dangerous to UK/allies' interests?","f3","A_part_of_your_employment_or_otherwise_undertaken_paid_or_unpaid_activity_on_behalf_of_a_non_UK_go","yesno",null,true],
    ["Please provide details","f3","Give_further_details_about_dangerous_activity_against_UK","textarea",null,false,{key:"A_part_of_your_employment_or_otherwise_undertaken_paid_or_unpaid_activity_on_behalf_of_a_non_UK_go",form:"f3",equals:"Yes"}],
    ["Engaged in other activities indicating you may not be of good character?","f3","Have_you_ever_engaged_in_any_other_activities_which_might_indicate_that_you_may_not_be_considered","yesno",null,true],
    ["Please provide details","f3","Give_further_details_Ever_done_anything_showing_bad_character","textarea",null,false,{key:"Have_you_ever_engaged_in_any_other_activities_which_might_indicate_that_you_may_not_be_considered",form:"f3",equals:"Yes"}],
    ["Any other information about your character/behaviour to disclose?","f3","Is_there_any_other_information_about_your_character_or_behaviour_which_you_would_like_to_make_us_a","yesno",null,true],
    ["Please provide details","f3","Give_further_details_regarding_Any_past_actions_showing_bad_character","textarea",null,false,{key:"Is_there_any_other_information_about_your_character_or_behaviour_which_you_would_like_to_make_us_a",form:"f3",equals:"Yes"}],
    ["Ever worked for Armed Forces, government, intelligence, security, media, or judiciary?","f3","Have_you_ever_worked_for_Armed_Forces_Any_government_Intelligence_services_Security_organisations","yesno",null,true],
    ["Worked for Armed Forces (career)?","f3","Have_you_ever_worked_for_Armed_Forces_career","yesno",null,false,{key:"Have_you_ever_worked_for_Armed_Forces_Any_government_Intelligence_services_Security_organisations",form:"f3",equals:"Yes"}],
    ["Details: Armed Forces (career)","f3","Provide_further_information_work_for_Armed_Forces_career","textarea",null,false,{key:"Have_you_ever_worked_for_Armed_Forces_career",form:"f3",equals:"Yes"}],
    ["Worked for Armed Forces (compulsory national/military service)?","f3","Have_you_ever_worked_for_Armed_Forces_Armed_Forces_compulsory_national_or_military_service","yesno",null,false,{key:"Have_you_ever_worked_for_Armed_Forces_Any_government_Intelligence_services_Security_organisations",form:"f3",equals:"Yes"}],
    ["Details: compulsory service","f3","Provide_further_information_work_for_government","textarea",null,false,{key:"Have_you_ever_worked_for_Armed_Forces_Armed_Forces_compulsory_national_or_military_service",form:"f3",equals:"Yes"}],
    ["Worked for Intelligence services?","f3","Have_you_ever_worked_for_Intelligence_services","yesno",null,false,{key:"Have_you_ever_worked_for_Armed_Forces_Any_government_Intelligence_services_Security_organisations",form:"f3",equals:"Yes"}],
    ["Details: Intelligence services","f3","Provide_further_information_work_for_intelligence_services","textarea",null,false,{key:"Have_you_ever_worked_for_Intelligence_services",form:"f3",equals:"Yes"}],
    ["Worked for Security organisations?","f3","Have_you_ever_worked_for_Security_organisations_including_police_and_private_security_services","yesno",null,false,{key:"Have_you_ever_worked_for_Armed_Forces_Any_government_Intelligence_services_Security_organisations",form:"f3",equals:"Yes"}],
    ["Details: Security organisations","f3","Provide_further_information_Security_organisations","textarea",null,false,{key:"Have_you_ever_worked_for_Security_organisations_including_police_and_private_security_services",form:"f3",equals:"Yes"}],
    ["Worked for Media organisations?","f3","Have_you_ever_worked_for_Media_organisations","yesno",null,false,{key:"Have_you_ever_worked_for_Armed_Forces_Any_government_Intelligence_services_Security_organisations",form:"f3",equals:"Yes"}],
    ["Details: Media organisations","f3","Provide_further_information_Media_organisations","textarea",null,false,{key:"Have_you_ever_worked_for_Media_organisations",form:"f3",equals:"Yes"}],
    ["Worked for Judiciary?","f3","Have_you_ever_worked_for_Judiciary_including_work_as_a_judge_or_magistrate","yesno",null,false,{key:"Have_you_ever_worked_for_Armed_Forces_Any_government_Intelligence_services_Security_organisations",form:"f3",equals:"Yes"}],
    ["Details: Judiciary","f3","Provide_further_information_Judiciary","textarea",null,false,{key:"Have_you_ever_worked_for_Judiciary_including_work_as_a_judge_or_magistrate",form:"f3",equals:"Yes"}],
    ["Additional/other important information","f3","Additional_Other_important_information_related_to_applicant","textarea",null,false],
  ]},
];

    function cifPath(travId, form, key, instanceId) {
      const id = instanceId || state.activeCifInstance;
      return `cifData.${travId}.instances.${id}.${form}.${key}`;
    }

    // Groups the 37 granular CIF_UK_SECTIONS into themed categories for
    // navigation — matches the reference design's "slides" concept while
    // keeping every underlying section/field exactly as already defined.
    const CIF_CATEGORIES = [
      { id:"personal_cat",   title:"Personal & Contact",              icon:"&#x1F464;", sections:["personal","contact","address"] },
      { id:"passport_cat",   title:"Passport & Nationality",          icon:"&#x1F4D8;", sections:["passport"] },
      { id:"finance_cat",    title:"Employment & Finances",           icon:"&#x1F4BC;", sections:["employment","income","tripcost"] },
      { id:"trip_cat",       title:"Trip & Purpose",                  icon:"&#x1F3AF;", sections:["purpose","returntrip","academic","marriage","medical","study","orgvisit"] },
      { id:"family_cat",     title:"Family",                          icon:"&#x1F46A;", sections:["family","dependents","dependentsList","parents","relativesUK","adultsTravelling","accommodation","stayPlan"] },
      { id:"history_cat",    title:"Travel & Immigration History",   icon:"&#x1F6C2;", sections:["ukHistory","ukVisits","ukMedical","ukMedicalDetails","ukMisc","publicFunds","visaHistory","worldTravel","immigrationHist","immigrationProblems","breachHist","breachDetails","convictionsHist","convictionsDetails"] },
      { id:"character_cat",  title:"Character & Security",           icon:"&#x1F6E1;&#xFE0F;", sections:["character"] }
    ];

    // Collect every field/section "showIf" trigger key as "form.key" so we
    // know which <select> elements need to force a re-render on change (Yes/No
    // pills already re-render via cifSetYesNo; native <select> triggers need
    // this explicit wiring since the global input handler deliberately does
    // NOT re-render on every keystroke, to avoid losing focus in text fields).
    function cifCollectTriggerKeys() {
      const keys = new Set();
      const addShowIf = (showIf) => {
        if (!showIf) return;
        if (showIf.anyOf) { showIf.anyOf.forEach(addShowIf); return; }
        keys.add(`${showIf.form}.${showIf.key}`);
      };
      CIF_UK_SECTIONS.forEach(section => {
        addShowIf(section.showIf);
        (section.fields || []).forEach(def => addShowIf(def[6]));
        (section.rowFields || []).forEach(def => addShowIf(def[5]));
      });
      return keys;
    }
    const CIF_TRIGGER_KEYS = cifCollectTriggerKeys();

    function cifShowIfMet(travId, showIf, instanceId) {
      if (!showIf) return true;
      if (showIf.anyOf) return showIf.anyOf.some(c => cifShowIfMet(travId, c, instanceId));
      const value = getByPath(applicationData, cifPath(travId, showIf.form, showIf.key, instanceId));
      if (showIf.equals !== undefined) return value === showIf.equals;
      if (showIf.notEquals !== undefined) return value !== showIf.notEquals && value !== undefined && value !== null && value !== "";
      if (showIf.includes !== undefined) return String(value || "").split(",").map(s => s.trim()).includes(showIf.includes);
      if (showIf.containsText !== undefined) return String(value || "").includes(showIf.containsText);
      if (showIf.notEmpty) return value !== undefined && value !== null && value !== "";
      return true;
    }

    function cifRenderField(travId, def) {
      const [label, form, key, ftype, extra, req, showIf] = def;
      if (!cifShowIfMet(travId, showIf)) return "";
      const path = cifPath(travId, form, key);
      if (ftype === "yesno" || ftype === "yesnobool") return cifYesNoField(label, path, req);
      if (ftype === "select") {
        const opts = extra === "COUNTRIES" ? UK_CIF_COUNTRIES : extra;
        const isTrigger = CIF_TRIGGER_KEYS.has(`${form}.${key}`);
        return cifSelectField(label, path, ["", ...opts], req, false, isTrigger);
      }
      if (ftype === "multiselect") return cifMultiSelectField(label, path, extra, req);
      if (ftype === "address")     return cifAddressField(label, path, req);
      const inputType = ftype === "date" ? "date" : ftype === "phone" ? "tel" : ftype === "number" ? "number" : ftype === "textarea" ? "textarea" : "text";
      return cifTextField(label, path, inputType, req);
    }

    function cifTextField(label, path, inputType, req) {
      const value = escapeHtml(getByPath(applicationData, path) || "");
      const full = inputType === "textarea" ? " full" : "";
      const placeholder = inputType === "tel" ? 'placeholder="e.g. +91 9820000000"' : "";
      const isBirthDate = inputType === "date" && (isBirthDateField(path) || isBirthDateField(label));
      const birthDateBounds = isBirthDate ? birthDateInputBounds() : null;
      const birthDateAttrs = isBirthDate ? `data-birth-date="true" min="${birthDateBounds.min}"` : "";
      if (isBirthDate) cifBirthDateFields.set(path, label);

      // For non-birth date fields, constrain the date picker based on semantic kind:
      // pastDate (issue dates, visit dates) → max = today; expiryDate → min = today
      let dateConstraintAttrs = "";
      if (inputType === "date" && !isBirthDate) {
        const today = new Date().toISOString().split("T")[0];
        const dateKind = classifyFieldValidation(path) || classifyFieldValidation(label);
        if (dateKind === "pastDate") dateConstraintAttrs = `min="1900-01-01" max="${today}"`;
        else if (dateKind === "expiryDate") dateConstraintAttrs = `min="${today}" max="2100-12-31"`;
        else dateConstraintAttrs = `min="1900-01-01" max="2100-12-31"`;
      }

      const numberAttrs = inputType === "number" ? 'min="0"' : "";
      const inner = inputType === "textarea"
        ? `<textarea data-bind="${path}">${value}</textarea>`
        : `<input type="${inputType}" data-bind="${path}" value="${value}" ${placeholder} ${birthDateAttrs || dateConstraintAttrs} ${numberAttrs}>`;
      return `<div class="cifx-field${full}" data-field="${path}">
        <label>${escapeHtml(label)}${req ? ' <span class="req">*</span>' : ""}</label>
        ${inner}
      </div>`;
    }

    function cifSelectField(label, path, options, req, full, isTrigger) {
      const value = getByPath(applicationData, path) || "";
      return `<div class="cifx-field${full ? " full" : ""}" data-field="${path}">
        <label>${escapeHtml(label)}${req ? ' <span class="req">*</span>' : ""}</label>
        <select data-bind="${path}" ${isTrigger ? 'onchange="setTimeout(renderCIF,0)"' : ""}>
          ${options.map(opt => `<option value="${escapeHtml(opt)}" ${String(value) === String(opt) ? "selected" : ""}>${opt ? escapeHtml(opt) : "-- Select --"}</option>`).join("")}
        </select>
      </div>`;
    }

    function cifCountryOptions(currentValue = "") {
      const values = [...COUNTRIES];
      const current = String(currentValue || "").trim();
      if (current && !values.includes(current)) values.unshift(current);
      return ["", ...values];
    }

    function cifIsCountrySelectorField(field) {
      const link = String(field?.link_name || "");
      const label = String(field?.display_name || "").trim();
      if (!link && !label) return false;
      if (/authority/i.test(link) || /details|reason|explain/i.test(label)) return false;
      return /^(country|which_country|in_which_country|select_(?:the_)?country|your_current_country|current_country|name_of_country)/i.test(link)
        || /(?:^|_)country_(?:of|region|where|they|you|the|currently|residence|service|training)(?:_|$)/i.test(link)
        || /(?:^|_)country$/i.test(link)
        || /^(country|which country|select (?:a |the )?country|current country|your current country|name of country)/i.test(label)
        || /country of (?:birth|issue|nationality|residence|passport|service|training)/i.test(label);
    }

    function cifYesNoField(label, path, req) {
      const value = getByPath(applicationData, path) || "";
      return `<div class="cifx-field full" data-field="${path}">
        <label>${escapeHtml(label)}${req ? ' <span class="req">*</span>' : ""}</label>
        <div class="cifx-pg">
          <button type="button" class="cifx-yn yes ${value === "Yes" ? "on" : ""}" onclick="cifSetYesNo('${path}','Yes',this)">Yes</button>
          <button type="button" class="cifx-yn no ${value === "No" ? "on" : ""}" onclick="cifSetYesNo('${path}','No',this)">No</button>
        </div>
      </div>`;
    }

    function cifSetYesNo(path, value, el) {
      setByPath(applicationData, path, value);
      cifMarkInstanceDirtyFromPath(path);
      markAutoSavePending();
      renderCIF();
    }

      function cifMultiSelectField(label, path, options, req) {
        const selected = String(getByPath(applicationData, path) || "").split(",").map(s => s.trim()).filter(Boolean);
        return `<div class="cifx-field full" data-field="${path}">
          <label>${escapeHtml(label)}${req ? ' <span class="req">*</span>' : ""}</label>
          <div class="cifx-pg">
            ${options.map(opt => `<button type="button" class="cifx-rp ${selected.includes(opt) ? "on" : ""}" onclick="cifToggleMulti('${path}','${escapeHtml(opt).replace(/'/g,"\\'")}',this)">${escapeHtml(opt)}</button>`).join("")}
          </div>
        </div>`;
      }
      // Fields that should render as the searchable dropdown-with-tags
    // component (same pattern as the Deal destination picker) instead of a
    // flat wall of pill buttons — reserved for genuinely large option lists
    // like country selectors, where pill buttons become unusable.
    const CIF_COUNTRY_DROPDOWN_FIELDS = new Set([
      "Please_select_country_s_you_have_visited_in_past_10_years",
      "Please_select_country_s_your_spouse_visited_in_past_10_years",
      "Please_select_country_s_your_child_visited_in_past_10_years"
    ]);

    // Renders a multiselect field using the widget's existing searchable
    // dropdown component (cmsToggle/cmsSelect/cmsRemove/cmsClear/cmsFilter —
    // already built for the Deal destination picker). Those handler
    // functions are already generic over `path`, so this just needs to
    // build matching markup using the field's own live Creator choices
    // instead of the hardcoded global COUNTRIES list.
    function cifCountryMultiSelectField(label, path, options, req) {
      const selected = String(getByPath(applicationData, path) || "").split(",").map(s => s.trim()).filter(Boolean);
      const safeId = "cif-" + path.replace(/[.[\]]/g, "-");
      const tagsHtml = selected.length
        ? selected.map(c => `<span class="cms-tag">${escapeHtml(c)}<button type="button" onclick="cmsRemove('${path}','${escapeHtml(c)}');event.stopPropagation()">×</button></span>`).join("")
        : `<span class="cms-placeholder">Select countries...</span>`;
      return `<div class="cifx-field full" data-field="${path}">
        <label>${escapeHtml(label)}${req ? ' <span class="req">*</span>' : ""}</label>
        <div class="cms-wrap" id="cms-${safeId}">
          <div class="cms-trigger" id="cms-trigger-${safeId}" tabindex="0" role="button"
            onclick="cmsToggle('${safeId}','${path}')"
            onkeydown="if(event.key==='Enter'||event.key===' ')cmsToggle('${safeId}','${path}')">${tagsHtml}</div>
          <div class="cms-dropdown" id="cms-drop-${safeId}">
            <input class="cms-search" type="text" placeholder="Search countries..."
              oninput="cmsFilter('${safeId}', this.value)" autocomplete="off"
              onclick="event.stopPropagation()">
            <div class="cms-list" id="cms-list-${safeId}">
              ${options.map(c => `<button type="button"
                class="cms-option ${selected.includes(c) ? "selected" : ""}"
                data-val="${escapeHtml(c)}"
                onclick="cmsSelect('${path}','${escapeHtml(c)}','${safeId}');event.stopPropagation()">
                ${escapeHtml(c)}
              </button>`).join("")}
            </div>
            <div class="cms-footer">
              <span id="cms-count-${safeId}">${selected.length} selected</span>
              <button type="button" class="cms-clear" onclick="cmsClear('${path}','${safeId}');event.stopPropagation()">Clear all</button>
            </div>
          </div>
        </div>
      </div>`;
    }

    function cifToggleMulti(path, value, el) {
      const selected = String(getByPath(applicationData, path) || "").split(",").map(s => s.trim()).filter(Boolean);
      const idx = selected.indexOf(value);
      if (idx >= 0) selected.splice(idx, 1); else selected.push(value);
      setByPath(applicationData, path, selected.join(", "));
      cifMarkInstanceDirtyFromPath(path);
      markAutoSavePending();
      const isTrigger = [...CIF_TRIGGER_KEYS].some(k => path.endsWith("." + k));
      if (isTrigger) { renderCIF(); } else { el.classList.toggle("on"); }
    }

    function cifAddressField(label, basePath, req) {
      const sub = (s) => `${basePath}.${s}`;
      const v = (s) => escapeHtml(getByPath(applicationData, sub(s)) || "");
      return `<div class="cifx-field full" data-field="${basePath}">
        <label>${escapeHtml(label)}${req ? ' <span class="req">*</span>' : ""}</label>
        <div class="cifx-fg" style="margin-top:4px">
          <input type="text" placeholder="Address Line 1" data-bind="${sub("address_line_1")}" value="${v("address_line_1")}">
          <input type="text" placeholder="Address Line 2" data-bind="${sub("address_line_2")}" value="${v("address_line_2")}">
          <input type="text" placeholder="City / District" data-bind="${sub("district_city")}" value="${v("district_city")}">
          <input type="text" placeholder="State / Province" data-bind="${sub("state_province")}" value="${v("state_province")}">
          <input type="text" placeholder="Postal Code" data-bind="${sub("postal_Code")}" value="${v("postal_Code")}">
          <select data-bind="${sub("country")}">
            ${cifCountryOptions(getByPath(applicationData, sub("country"))).map(option => `<option value="${escapeHtml(option)}" ${String(getByPath(applicationData, sub("country")) || "") === option ? "selected" : ""}>${option ? escapeHtml(option) : "-- Country --"}</option>`).join("")}
          </select>
        </div>
      </div>`;
    }

    function cifSubformRows(travId, section) {
      const path = cifPath(travId, section.form, section.key);
      const rows = getByPath(applicationData, path) || [];
      return rows;
    }

    function cifAddSubformRow(travId, sectionId) {
      const section = CIF_UK_SECTIONS.find(s => s.id === sectionId);
      if (!section) return;
      const path = cifPath(travId, section.form, section.key);
      let rows = getByPath(applicationData, path);
      if (!Array.isArray(rows)) { rows = []; setByPath(applicationData, path, rows); }
      const row = {};
      section.rowFields.forEach(([, subkey]) => {
        if (subkey.includes(".")) {
          const [parent, child] = subkey.split(".");
          if (!row[parent]) row[parent] = {};
          row[parent][child] = "";
        } else {
          row[subkey] = "";
        }
      });
      rows.push(row);
      cifMarkInstanceDirtyFromPath(path);
      markAutoSavePending();
      renderCIF();
    }

    function cifRemoveSubformRow(travId, sectionId, index) {
      const section = CIF_UK_SECTIONS.find(s => s.id === sectionId);
      if (!section) return;
      const path = cifPath(travId, section.form, section.key);
      const rows = getByPath(applicationData, path) || [];
      rows.splice(index, 1);
      cifMarkInstanceDirtyFromPath(path);
      markAutoSavePending();
      renderCIF();
    }

    // Evaluates a "showIf"-style condition scoped to one row of a subform,
    // by resolving the condition's key against the SAME row (section.key +
    // rowIndex + condition.key) rather than a top-level form field. This
    // mirrors cifShowIfMet's equals / notEquals / includes / anyOf logic but
    // needed its own path builder since row fields live one level deeper.
    function cifRowShowIfMet(travId, section, rowIndex, condition, instanceId) {
      if (!condition) return true;
      if (condition.anyOf) return condition.anyOf.some(c => cifRowShowIfMet(travId, section, rowIndex, c, instanceId));
      const path = cifPath(travId, section.form, `${section.key}.${rowIndex}.${condition.key}`, instanceId);
      const value = getByPath(applicationData, path);
      if (condition.equals !== undefined) return value === condition.equals;
      if (condition.notEquals !== undefined) return value !== condition.notEquals && value !== undefined && value !== null && value !== "";
      if (condition.includes !== undefined) return String(value || "").split(",").map(s => s.trim()).includes(condition.includes);
      if (condition.notEmpty) return value !== undefined && value !== null && value !== "";
      return true;
    }

    function cifRenderSubformSection(travId, section) {
      const rows = cifSubformRows(travId, section);
      const rowsHtml = rows.map((row, i) => {
        return `<div class="cifx-rep">
          <div class="cifx-rep-lbl">Entry ${i + 1}</div>
          <button type="button" class="cifx-rep-rm" onclick="cifRemoveSubformRow('${travId}','${section.id}',${i})">&#x1F5D1;&#xFE0F; Remove</button>
          <div class="cifx-fg">
            ${section.rowFields.map(([label, subkey, ftype, extra, req, rowShowIf]) => {
              if (rowShowIf && !cifRowShowIfMet(travId, section, i, rowShowIf)) return "";
              return cifRenderField(travId, [label, section.form, `${section.key}.${i}.${subkey}`, ftype, extra, req]);
            }).join("")}
          </div>
        </div>`;
      }).join("");
      return `${rowsHtml}
        <button type="button" class="cifx-add-btn" onclick="cifAddSubformRow('${travId}','${section.id}')">&#x2795; Add ${escapeHtml(section.title)}</button>`;
    }

    function cifSectionProgress(travId, section) {
      if (section.subform) {
        const rows = cifSubformRows(travId, section);
        return rows.length > 0 ? 100 : 0;
      }
      const visibleFields = section.fields.filter(def => cifShowIfMet(travId, def[6]));
      const filled = visibleFields.filter(([, form, key]) => {
        const v = getByPath(applicationData, cifPath(travId, form, key));
        return v !== undefined && v !== null && v !== "";
      }).length;
      return visibleFields.length ? Math.round((filled / visibleFields.length) * 100) : 0;
    }

    function cifCategoryProgress(travId, category) {
      const sections = category.sections.map(id => CIF_UK_SECTIONS.find(s => s.id === id))
        .filter(Boolean).filter(s => cifShowIfMet(travId, s.showIf));
      if (!sections.length) return 0;
      const total = sections.reduce((sum, s) => sum + cifSectionProgress(travId, s), 0);
      return Math.round(total / sections.length);
    }

    function cifOverallProgress(travId) {
      return Math.round(CIF_CATEGORIES.reduce((sum, c) => sum + cifCategoryProgress(travId, c), 0) / CIF_CATEGORIES.length);
    }

    // Pre-fills CIF fields from data already collected earlier in the flow
    // (Step 1 traveller record, Customer info) — runs once per traveller per
    // session, and ONLY ever fills a field that is currently empty. Never
    // overwrites anything the person already typed, in the CIF or elsewhere.
    function cifAutofillTraveller(travId) {
            const traveller = applicationData.deal.travellers.find(
        (item) => item.id === travId
      );
      if (!traveller) return;
      const isPrimary = traveller.type === "Primary Applicant";

      const isBlankAutofillValue = (value) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

const setIfEmpty = (path, value) => {
  if (isBlankAutofillValue(value)) return;

  const current = getByPath(applicationData, path);

  if (isBlankAutofillValue(current)) {
    setByPath(applicationData, path, value);
  }
};

      setIfEmpty(cifPath(travId, "f1", "Your_name_as_printed_in_your_passport.first_name"), traveller.firstName);
      setIfEmpty(cifPath(travId, "f1", "Your_name_as_printed_in_your_passport.last_name"), traveller.lastName);
      setIfEmpty(cifPath(travId, "f1", "Date_of_Birth"), traveller.dob);

      // "Indian" (demonym, our default) vs "India" (country name used by the
      // CIF's own COUNTRIES list) — normalize the one case we know is common.
      let nationality = traveller.nationality || "";
      if (nationality === "Indian") nationality = "India";
      if (nationality && COUNTRIES.includes(nationality)) {
        setIfEmpty(cifPath(travId, "f1", "Country_of_Nationality"), nationality);
      }

      setIfEmpty(cifPath(travId, "f1", "Provide_Email_address"), traveller.email || (isPrimary ? applicationData.customer.email : ""));
      setIfEmpty(cifPath(travId, "f1", "Provide_your_telephone_number"), traveller.mobile || (isPrimary ? applicationData.customer.mobile : ""));

      setIfEmpty(cifPath(travId, "f1", "Your_current_residence_address.address_line_1"), applicationData.customer.mailingStreet);
      setIfEmpty(cifPath(travId, "f1", "Your_current_residence_address.district_city"), applicationData.customer.mailingCity);
      setIfEmpty(cifPath(travId, "f1", "Your_current_residence_address.state_province"), applicationData.customer.mailingState);
      setIfEmpty(cifPath(travId, "f1", "Your_current_residence_address.postal_Code"), applicationData.customer.mailingZip);
      setIfEmpty(cifPath(travId, "f1", "Your_current_residence_address.country"), applicationData.customer.mailingCountry);

      // ── From Questionnaire (Step 2) ─────────────────────────────────────
      // Autofills categorical facts that map cleanly: purpose, employment,
      // marital status, travel dates, history declarations. All use setIfEmpty
      // so the applicant's own CIF edits are never overwritten.
      // NOT autofilled: money amounts (questionnaire only has bucketed ranges,
      // not exact GBP figures — a guessed number is worse than a blank one).
      const q = applicationData.questionnaire || {};

      if (isPrimary && q.maritalStatus) {
        const maritalMap = {
          single: "Single", married: "Married or civil partner", divorced: "Divorced or partnership dissolved",
          widowed: "Widowed or a surviving civil partner", separated: "Separated"
        };
        setIfEmpty(cifPath(travId, "f1", "What_is_your_relationship_status"), maritalMap[q.maritalStatus]);
      }

      const selectedPurposes = Array.isArray(q.purpose)
  ? q.purpose.filter(Boolean)
  : (q.purpose ? [q.purpose] : []);

if (selectedPurposes.length === 1) {
  const purposeMap = {
    tourism: "Tourism (including visiting family and friends)",
    family: "Tourism (including visiting family and friends)",
    friend: "Tourism (including visiting family and friends)",
    business: "Business (including sports and entertainment)",
    transit: "Transit through the UK",
    medical: "Private medical treatment or organ donation",
    other: "Other - I am visiting for another reason"
  };

  const mappedPurpose = purposeMap[selectedPurposes[0]];

  if (mappedPurpose) {
    setIfEmpty(
      cifPath(
        travId,
        "f1",
        "What_is_the_main_reason_for_your_visit_to_the_UK"
      ),
      mappedPurpose
    );
  }
}
if (isPrimary) {
  const spouseTraveller = applicationData.deal.travellers.find(
    (item) => item.type === "Spouse"
  );

  if (spouseTraveller) {
    setIfEmpty(
      cifPath(
        travId,
        "f2",
        "Your_current_partner_Spouse.first_name"
      ),
      spouseTraveller.firstName
    );

    setIfEmpty(
      cifPath(
        travId,
        "f2",
        "Your_current_partner_Spouse.last_name"
      ),
      spouseTraveller.lastName
    );

    setIfEmpty(
      cifPath(travId, "f2", "Spouse_s_Date_of_Birth"),
      spouseTraveller.dob
    );

    let spouseNationality = spouseTraveller.nationality || "";

    if (spouseNationality === "Indian") {
      spouseNationality = "India";
    }

    if (
      spouseNationality &&
      COUNTRIES.includes(spouseNationality)
    ) {
      setIfEmpty(
        cifPath(
          travId,
          "f2",
          "Spouse_s_Country_of_nationality"
        ),
        spouseNationality
      );
    }
  }
}
if (isPrimary) {
  const ukChildrenCount = (applicationData.deal.travellers || []).filter(
    traveller =>
      traveller.type === "Child" &&
      Array.isArray(traveller.countries) &&
      traveller.countries.some(
        country => cifNormalizeCountry(country) === "United Kingdom"
      )
  ).length;

  if (ukChildrenCount > 0 && ukChildrenCount <= 4) {
    setIfEmpty(
      cifPath(
        travId,
        "f2",
        "How_many_of_your_children_travelling_with_you"
      ),
      String(ukChildrenCount)
    );
  }
}
const ukPurposeSelections = Array.isArray(q.purpose)
  ? q.purpose.filter(Boolean)
  : (q.purpose ? [q.purpose] : []);

if (ukPurposeSelections.length === 1) {
  const ukHolidayReasonMap = {
    tourism: "Tourist",
    family: "Visiting family",
    friend: "Visiting friends"
  };

  setIfEmpty(
    cifPath(
      travId,
      "f1",
      "What_is_the_main_reason_for_your_holiday_visit_to_the_UK"
    ),
    ukHolidayReasonMap[ukPurposeSelections[0]]
  );
}
const ukTravelDatesEntry = Object.entries(q.travelDates || {}).find(
  ([country]) => cifNormalizeCountry(country) === "United Kingdom"
);

const ukTravelDates = ukTravelDatesEntry
  ? ukTravelDatesEntry[1]
  : null;

if (ukTravelDates) {
  setIfEmpty(
    cifPath(travId, "f1", "Date_you_plan_to_arrive_in_the_UK"),
    ukTravelDates.entry
  );

  setIfEmpty(
    cifPath(travId, "f1", "Date_you_plan_to_leave_the_UK"),
    ukTravelDates.exit
  );
}
      const finance = (q.finance || {})[travId];
      if (finance) {
  const selectedFunding = Array.isArray(finance.funding)
    ? finance.funding.filter(Boolean)
    : (finance.funding ? [finance.funding] : []);

  if (
    selectedFunding.includes("inviter") ||
    selectedFunding.includes("sponsor")
  ) {
    setIfEmpty(
      cifPath(
        travId,
        "f1",
        "Will_anyone_be_paying_towards_the_cost_of_your_visit"
      ),
      "Yes"
    );
  } else if (
    selectedFunding.length === 1 &&
    selectedFunding[0] === "self"
  ) {
    setIfEmpty(
      cifPath(
        travId,
        "f1",
        "Will_anyone_be_paying_towards_the_cost_of_your_visit"
      ),
      "No"
    );
  }
}
if (finance) {
  const selectedFunding = Array.isArray(finance.funding)
    ? finance.funding.filter(Boolean)
    : (finance.funding ? [finance.funding] : []);

  const externalFunding = selectedFunding.filter(
    value => value === "inviter" || value === "sponsor"
  );

  if (
    externalFunding.length === 1 &&
    externalFunding[0] === "sponsor"
  ) {
    const ukPayerTypeMap = {
      parent: "Someone I know (for example, family or friend)",
      spouse: "Someone I know (for example, family or friend)",
      sibling: "Someone I know (for example, family or friend)",
      extended: "Someone I know (for example, family or friend)",
      employer: "My employer or company",
      event: "Another company or organisation"
    };

    setIfEmpty(
      cifPath(
        travId,
        "f1",
        "Who_is_paying_towards_the_cost_of_your_visit"
      ),
      ukPayerTypeMap[finance.sponsorType]
    );
  }
}
      if (finance && finance.multiAnswers) {
        const occMap = [
          ["occ-employed", "Employed"], ["occ-freelancer", "Self-Employed"], ["occ-business", "Self-Employed"],
          ["occ-student", "A Student"], ["occ-pensioner", "Retired"], ["occ-retired-nopension", "Retired"],
          ["occ-unemployed", "Unemployed"]
        ];
        const matched = occMap.filter(([key]) => finance.multiAnswers[key]).map(([, label]) => label);
        if (matched.length) {
          setIfEmpty(
  cifPath(travId, "f1", "What_is_your_employment_status"),
  [...new Set(matched)]
);
        }
      }

      // ── History & character declarations (f3) ────────────────────────────
      // "Above_the_Immigration_history" covers: visa refusals, border refusals,
      // deportation, removal — any true flag in history means the answer is Yes.
      const history = (q.history || {})[travId] || {};
      const hadImmigrationIssue = history.refusal || history.border;
      if (hadImmigrationIssue === true || hadImmigrationIssue === "Yes") {
        setIfEmpty(cifPath(travId, "f3", "Above_the_Immigration_history"), "Yes");
      } else if (hadImmigrationIssue === false || hadImmigrationIssue === "No") {
        setIfEmpty(cifPath(travId, "f3", "Above_the_Immigration_history"), "No");
      }

      if (history.criminalRecord === true || history.criminalRecord === "Yes") {
        setIfEmpty(cifPath(travId, "f3", "Have_you_ever_had_any_convictions_offences_cautions_penalties_or_court_judgments_including_under_U"), "Yes");
      } else if (history.criminalRecord === false || history.criminalRecord === "No") {
        setIfEmpty(cifPath(travId, "f3", "Have_you_ever_had_any_convictions_offences_cautions_penalties_or_court_judgments_including_under_U"), "No");
      }
    }

    const CIF_PURPOSE_LABELS = {
      family: "Family Visit", "family-func": "Family Function", tourism: "Tourism",
      business: "Business Visit", friend: "Visiting a Friend", convocation: "Convocation",
      transit: "Transit", medical: "Medical Treatment", other: "Other"
    };

    // Overview block for the CIF step — stat cards, planned route, and a
    // per-traveller progress grid. Pure display logic built from data that
    // already exists (deal, questionnaire) — adds nothing to the save model.
    // UK-only for now, matching the current build; a Schengen/multi-country
    // version of the route visual can be added once that phase starts.
    function cifRenderOverview(instance) {
      const travellers = applicationData.deal.travellers;
      const destinations = (applicationData.questionnaire.applyingCountries || applicationData.deal.destination || "")
        .split(",").map(s => s.trim()).filter(Boolean);
      const rawPurpose = applicationData.questionnaire.purpose;
      const selectedPurposes = Array.isArray(rawPurpose)
        ? rawPurpose.filter(Boolean)
        : String(rawPurpose || "").split(",").map(value => value.trim()).filter(Boolean);
      const purposeLabel = selectedPurposes
        .map(value => CIF_PURPOSE_LABELS[value] || value)
        .join(", ") || "Not yet set";
      const primary = travellers.find(t => t.type === "Primary Applicant") || travellers[0];
      const familyName = primary?.lastName ? `${primary.lastName} Family` : "Your Application";

      const statsHtml = `
        <div class="cifx-stats">
          <div class="cifx-stat"><div class="cifx-stat-ic">&#x1F465;</div><div><div class="cifx-stat-k">Applicants</div><div class="cifx-stat-v">${travellers.length} traveller${travellers.length !== 1 ? "s" : ""}</div></div></div>
          <div class="cifx-stat"><div class="cifx-stat-ic">&#x1F1EC;&#x1F1E7;</div><div><div class="cifx-stat-k">Destination</div><div class="cifx-stat-v">${escapeHtml(destinations.join(", ") || "Not set")}</div></div></div>
          <div class="cifx-stat"><div class="cifx-stat-ic">&#x1F3AF;</div><div><div class="cifx-stat-k">Purpose</div><div class="cifx-stat-v">${escapeHtml(purposeLabel)}</div></div></div>
          <div class="cifx-stat"><div class="cifx-stat-ic">&#x1F4CB;</div><div><div class="cifx-stat-k">Application No.</div><div class="cifx-stat-v">${escapeHtml(applicationData.applicationId || "—")}</div></div></div>
        </div>`;

      const travelDates = applicationData.questionnaire.travelDates || {};
      const routeStops = [
        { label: "India", sub: "Departure" },
        ...destinations.map(c => {
          const td = travelDates[c] || {};
          const sub = td.entry ? `${td.entry}${td.exit ? " – " + td.exit : ""}` : "Dates TBC";
          return { label: c, sub };
        }),
        { label: "India", sub: "Return" }
      ];
      const routeHtml = destinations.length ? `
        <div class="cifx-route-card">
          <div class="cifx-route-title">&#x1F5FA;&#xFE0F; Planned Route</div>
          <div class="cifx-route-wrap">
            ${routeStops.map((stop, i) => `${i > 0 ? '<span class="cifx-route-arrow">&#x2192;</span>' : ""}<div class="cifx-route-stop"><strong>${escapeHtml(stop.label)}</strong><span>${escapeHtml(stop.sub)}</span></div>`).join("")}
          </div>
        </div>` : "";

      const memberGridHtml = `
        <div class="cifx-membergrid">
          ${travellers.map(t => {
            const name = `${t.firstName || ""} ${t.lastName || ""}`.trim() || "Traveller";
            const avClass = t.type === "Spouse" ? "sp" : t.type === "Child" ? "ch" : "";
            const initials = `${(t.firstName || "")[0] || ""}${(t.lastName || "")[0] || ""}`.toUpperCase() || "T";
            const pct = instance?.type === "uk" ? cifOverallProgress(t.id) : cifGenericProgress(t.id, instance);
            const isActive = t.id === state.activeCifTraveller;
            const saved = cifIsInstanceSaved(t.id, instance?.id);
            return `<div class="cifx-mc ${isActive ? "on" : ""}" onclick="cifSwitchTraveller('${t.id}')">
              <div class="cifx-mc-top">
                <div class="cifx-mc-av ${avClass}">${escapeHtml(initials)}</div>
                <div style="flex:1"><div class="cifx-mc-name">${escapeHtml(name)}</div><div class="cifx-mc-role">${escapeHtml(t.type || "Traveller")}</div></div>
                <span class="cifx-pill ${saved ? "cifx-p-green" : "cifx-p-blue"}" style="flex-shrink:0">${saved ? "&#x2713; Saved" : "Not saved"}</span>
              </div>
              <div class="cifx-mc-bar-bg"><div class="cifx-mc-bar-fill" style="width:${pct}%"></div></div>
              <div class="cifx-mc-pct">${pct}% complete</div>
            </div>`;
          }).join("")}
        </div>`;

      return statsHtml + routeHtml + memberGridHtml;
    }

      const CIF_SYSTEM_FIELDS = new Set([
      "App_ID","App_iD","APP_Id","Client_Name","Cilent_Name",
      "Case_Officer_Name","Case_officer_name","Case_officer_email_id","Case_officer_s_email",
      "Applying_for_Country",
      "Deal_ID","This_CIF_belongs_to","UK_CIF_1","UK_CIF_2","UK_CIF_3",
      "Australia_Customer_Information","Australia_Customer_Information_2",
      "Australia_Customer_Information_3","Australia_Customer_Information_4",
      "Us_Form_1","Us_Form_2","Us_Form_3","Us_Form_4"
    ]);

    function cifMetadataFields(response, seen = new Set()) {
      if (response === undefined || response === null) return [];
      if (typeof response === "string") {
        const parsed = safeJsonParse(response);
        return parsed && parsed !== response ? cifMetadataFields(parsed, seen) : [];
      }
      if (typeof response !== "object" || seen.has(response)) return [];
      seen.add(response);
      const direct = response.fields || response?.data?.fields || response?.meta?.field_layout || response?.data?.meta?.field_layout;
      if (Array.isArray(direct)) return direct;
      for (const nested of [response.response, response.responseText, response.result, response.body]) {
        const fields = cifMetadataFields(nested, seen);
        if (fields.length) return fields;
      }
      return [];
    }

    function cifMetadataErrorText(error) {
      if (error === undefined || error === null) return "Unknown metadata error";
      if (typeof error === "string") return error;
      if (error instanceof Error && error.message) return error.message;
      for (const candidate of [error.message, error.error, error.responseText, error.response, error.data]) {
        if (!candidate) continue;
        if (typeof candidate === "string") return candidate;
        try {
          const serialized = JSON.stringify(candidate);
          if (serialized && serialized !== "{}") return serialized;
        } catch (ignored) {}
      }
      try {
        const serialized = JSON.stringify(error);
        if (serialized && serialized !== "{}") return serialized;
      } catch (ignored) {}
      return String(error);
    }

    async function cifFetchStageMetadata(stage) {
      if (state.cifMetadata[stage.form]) return state.cifMetadata[stage.form];
      if (state.cifMetadataLoading[stage.form]) return state.cifMetadataLoading[stage.form];
      state.cifMetadataLoading[stage.form] = (async () => {
        let rawFields = [];
        const failures = [];
        if (window.ZOHO?.CREATOR?.META?.getFields) {
          try {
            const response = await ZOHO.CREATOR.META.getFields({ app_name:CONFIG.creator.appLinkName, form_name:stage.form });
            rawFields = cifMetadataFields(response);
            if (!rawFields.length) failures.push("embedded metadata service returned no fields");
          } catch (error) {
            failures.push(`embedded metadata service: ${cifMetadataErrorText(error)}`);
          }
        }
        if (!rawFields.length && window.ZOHO?.CREATOR?.API?.invokeUrl) {
          try {
            const response = await ZOHO.CREATOR.API.invokeUrl({
              url:`https://www.zohoapis.in/creator/v2.1/meta/${CONFIG.creator.appOwner}/${CONFIG.creator.appLinkName}/form/${stage.form}/fields`,
              type:"GET",
              connectionName:CONFIG.creatorConnectionName
            });
            rawFields = cifMetadataFields(response);
            if (!rawFields.length) failures.push("Creator REST metadata service returned no fields");
          } catch (error) {
            failures.push(`Creator REST metadata service: ${cifMetadataErrorText(error)}`);
          }
        }
        if (!rawFields.length) {
          const detail = failures.length ? ` ${failures.join("; ")}` : " Zoho Creator metadata service is unavailable.";
          throw new Error(`Could not load metadata for ${stage.form}.${detail}`);
        }
        // 15-Aug-2026 FIX: this flatten previously only ran for stage.form
        // starting with "Us_Form_" (USA). Australia_Customer_Information*
        // and Schengen_Visitor_visa stages kept their raw type-28 "Section"
        // wrapper objects instead — and cifCustomerFields() unconditionally
        // drops every type-28 node (by design, a bare section wrapper isn't
        // a real input). Net effect: every field nested inside an
        // Australia/Schengen section was silently discarded before it ever
        // reached the renderer — confirmed via MCP against the live
        // Australia_Customer_Information 1-4 forms, where entire pages
        // (Form 4 especially — every declaration checkbox) rendered with
        // zero fields. Flattening for ALL generic-engine forms fixes this
        // without touching anything else:
        //   - UK CIF is unaffected: it never goes through this function at
        //     all, it uses the separate static CIF_UK_SECTIONS field list.
        //   - USA CIF is unaffected: it already received this exact flatten
        //     before, so its output is identical.
        //   - Subforms (type 21) are unaffected either way: Creator always
        //     keeps them as top-level siblings, never nested inside a
        //     type-28 section, so they were never touched by this branch.
        const fields = Array.isArray(rawFields)
          ? rawFields.flatMap(field => {
              if (!field) return [];
              if (field.type === 28) {
                return Array.isArray(field.fields) ? field.fields : [];
              }
              return [field];
            })
          : [];
        if (!Array.isArray(fields) || !fields.length) {
          throw new Error(`No field metadata returned for ${stage.form}.`);
        }
        state.cifMetadata[stage.form] = fields;
        delete state.cifMetadataErrors[stage.form];
        return fields;
      })().catch(error => {
        state.cifMetadataErrors[stage.form] = cifMetadataErrorText(error);
        throw error;
      }).finally(() => delete state.cifMetadataLoading[stage.form]);
      return state.cifMetadataLoading[stage.form];
    }

    function cifLoadInstanceMetadata(instance) {
      if (!instance || instance.type === "uk") return Promise.resolve();
      return Promise.all(instance.definition.stages.map(cifFetchStageMetadata));
    }

    function cifCustomerFields(fields) {
      return (fields || []).filter(field => field && field.link_name && field.type !== 24 && field.type !== 28 && !CIF_SYSTEM_FIELDS.has(field.link_name));
    }

    function cifGenericProgress(travId, instance) {
      if (!instance || instance.type === "uk") return cifOverallProgress(travId);
      const scores = instance.definition.stages.map(stage => {
        const data = cifInstanceData(travId, instance.id)[stage.tag] || {};
        const fields = cifCustomerFields(state.cifMetadata[stage.form]).filter(field =>
          cifGenericFieldVisible(instance, stage, data, field.link_name)
        );
        if (!fields.length) return 0;
        const required = fields.filter(field => field.mandatory);
        const measured = required.length ? required : fields;
        const filled = measured.filter(field => {
          const value = data[field.link_name];
          if (Array.isArray(value)) return value.length > 0;
          if (value && typeof value === "object") return Object.values(value).some(v => String(v || "").trim());
          return value !== undefined && value !== null && String(value).trim() !== "";
        }).length;
        return Math.round((filled / measured.length) * 100);
      });
      return scores.length ? Math.round(scores.reduce((a,b) => a + b, 0) / scores.length) : 0;
    }

    function cifAutofillGenericTraveller(travId, instance, activeStage) {
      if (!state.cifAutofilledIds) state.cifAutofilledIds = new Set();
      const stg = activeStage || instance.definition.stages[0];
      const autofillKey = `${travId}::${instance.id}::${stg.tag}`;
      if (state.cifAutofilledIds.has(autofillKey)) return;
      const traveller = applicationData.deal.travellers.find(t => t.id === travId);
      const fields = cifCustomerFields(state.cifMetadata[stg.form]);
      if (!traveller || !fields.length) return;

      const setEmpty = (path, value) => {
        if (value === undefined || value === null || value === "") return;
        const current = getByPath(applicationData, path);
        if (current === undefined || current === null || current === "") setByPath(applicationData, path, value);
      };

      const q = applicationData.questionnaire || {};
      const finance = (q.finance || {})[travId] || {};
      const history = (q.history || {})[travId] || {};
      const cifType = instance.type; // "usa" | "schengen" | "australia"
      const cust = applicationData.customer || {};

      // Resolve travel dates for this CIF's destination
      const allDates = q.travelDates || {};
      let entryDate = "", exitDate = "";
      if (cifType === "usa") {
        const td = allDates["United States"] || allDates["United States of America"] || {};
        entryDate = td.entry || ""; exitDate = td.exit || "";
      } else if (cifType === "australia") {
        const td = allDates["Australia"] || {};
        entryDate = td.entry || ""; exitDate = td.exit || "";
      } else {
        // Schengen — pick first destination that has dates
        const dests = (q.applyingCountries || "").split(",").map(s => s.trim()).filter(Boolean);
        for (const dest of dests) {
          const td = allDates[dest] || {};
          if (td.entry) { entryDate = td.entry; exitDate = td.exit || ""; break; }
        }
        if (!entryDate) { const td = allDates["Schengen"] || {}; entryDate = td.entry || ""; exitDate = td.exit || ""; }
      }

      // Purpose mapping per CIF type
      const rawPurpose = Array.isArray(q.purpose) ? q.purpose.filter(Boolean)
        : String(q.purpose || "").split(",").map(s => s.trim()).filter(Boolean);
      const PURPOSE_USA = { tourism:"Tourism/Vacation", family:"Visit Family/Friends", friend:"Visit Family/Friends", business:"Business", medical:"Medical Treatment", transit:"Transit", "family-func":"Other", convocation:"Other", other:"Other" };
      const PURPOSE_SCHENGEN = { tourism:"Tourism", family:"Visiting family or friends", friend:"Visiting family or friends", business:"Business", medical:"Medical reasons", transit:"Transit", "family-func":"Cultural/Sports/Religious events", convocation:"Study", other:"Other" };
      const PURPOSE_AUSTRALIA = { tourism:"Tourist stream (tourism/visit family or friends)", family:"Tourist stream (tourism/visit family or friends)", friend:"Tourist stream (tourism/visit family or friends)", business:"Business Visitor stream (business visit for meetings, conferences or negotiations but not for work)", "family-func":"Tourist stream (tourism/visit family or friends)", convocation:"Tourist stream (tourism/visit family or friends)", medical:"Other", transit:"Other", other:"Other" };
      const purposeMap = cifType === "usa" ? PURPOSE_USA : cifType === "australia" ? PURPOSE_AUSTRALIA : PURPOSE_SCHENGEN;
      const purposeValue = rawPurpose.length ? (purposeMap[rawPurpose[0]] || "") : "";

      // Marital status mapping per CIF type
      const MARITAL_USA = { single:"Single", married:"Married", divorced:"Divorced", widowed:"Widowed", separated:"Separated" };
      const MARITAL_SCHENGEN = { single:"Single", married:"Married", divorced:"Divorced", widowed:"Widow/Widower", separated:"Legally Separated" };
      const MARITAL_AUSTRALIA = { single:"Never married", married:"Married", divorced:"Divorced", widowed:"Widowed", separated:"Separated" };
      const maritalMap = cifType === "usa" ? MARITAL_USA : cifType === "australia" ? MARITAL_AUSTRALIA : MARITAL_SCHENGEN;
      const maritalValue = maritalMap[q.maritalStatus] || "";

      // Employment status from multiAnswers occ-* keys
      const EMP_USA = { "occ-employed":"Employed", "occ-freelancer":"Self Employed", "occ-business":"Self Employed", "occ-student":"Student", "occ-pensioner":"Retired", "occ-retired-nopension":"Retired", "occ-unemployed":"Unemployed" };
      const EMP_AUSTRALIA = { "occ-employed":"Employed", "occ-freelancer":"Self employed", "occ-business":"Self employed", "occ-student":"Student", "occ-pensioner":"Retired", "occ-retired-nopension":"Retired", "occ-unemployed":"Unemployed" };
      const empMap = cifType === "australia" ? EMP_AUSTRALIA : EMP_USA;
      const empMatched = Object.entries(empMap).filter(([key]) => finance.multiAnswers?.[key]).map(([, label]) => label);
      const empValue = empMatched.length ? empMatched[0] : "";

      // History yes/no helpers (boolean or truthy string)
      const yesNo = val => val === true || val === "Yes" ? "Yes" : (val === false || val === "No" ? "No" : "");

      // Field-name patterns — matched against each field's link_name
      const PATTERNS = [
        // Personal basics
        { re: /^Surnames$|^surname$/i,                       value: traveller.lastName },
        { re: /^Given_Names$|^given.names?$/i,               value: traveller.firstName },
        { re: /^(Date1|Date_of_Birth)$|date.of.birth/i,      value: traveller.dob },
        { re: /^(Your_email_id|Email_address|Email1)$|^email/i, value: traveller.email || cust.email },
        { re: /^(Phone_Number|Mobile_Cell_phone)$|^phone.number$/i, value: traveller.mobile || cust.mobile },
        { re: /^nationality$|^country.of.nationality$/i,      value: traveller.nationality },
        { re: /^country.of.birth$/i,                          value: traveller.nationality },
        // Travel dates
        { re: /arrival.date|date.of.arrival|intended.*arrival|planned.*arrival/i, value: entryDate },
        { re: /departure.date|date.of.departure|intended.*departure|planned.*departure|final.*departure/i, value: exitDate },
        // Purpose
        { re: /purpose.of.trip|purpose.of.visit|purpose.of.the.trip|reason.for.travel|visit.purpose/i, value: purposeValue },
        { re: /^Select_all_reasons_for_visiting_Australia$/,  value: purposeValue },
        { re: /^Select_the_stream_the_applicant_is_applying_for$/, value: cifType === "australia" ? purposeValue : "" },
        // Marital status
        { re: /marital.status|civil.status|current.marital/i, value: maritalValue },
        // Employment
        { re: /^Employment_status$|^employment.status$/i,     value: empValue },
        // History declarations (Yes/No only — skip detail/narrative fields)
        { re: /visa.*refus|refus.*visa|ever.*refused|refused.*visa/i,
          skip: /detail|give|add|explain|provide/i, value: yesNo(history.refusal) },
        { re: /criminal.*record|convicted|ever.*been.*charged|has.*the.*applicant.*been.*convicted/i,
          skip: /detail|give|add|explain|provide/i, value: yesNo(history.criminalRecord) },
        { re: /deport|removed.*from.*country|overstay.*visa|border.*issue/i,
          skip: /detail|give|add|explain|provide/i, value: yesNo(history.border) },
        { re: /previously.*travel|travelled.*outside|lived.*outside/i,
          skip: /detail|give|add|explain|provide/i, value: yesNo(history.prevTravel) },
        // Finance / funding (Schengen)
        { re: /means.of.support|source.of.funds|cost.of.trip.paid/i, value: (() => {
          if (!finance.funding) return "";
          const arr = Array.isArray(finance.funding) ? finance.funding : [finance.funding];
          if (arr.includes("self")) return "Cash";
          if (arr.includes("sponsor") || arr.includes("inviter")) return "Sponsor";
          return "";
        })() },
        // Schengen — funding dropdown (exact field name used by Schengen CIF form)
        { re: /^How_will_you_be_funding_your_trip$/, value: (() => {
          if (cifType !== "schengen" || !finance.funding) return "";
          const arr = Array.isArray(finance.funding) ? finance.funding : [finance.funding];
          if (arr.includes("inviter")) return "My Inviter";
          if (arr.includes("sponsor")) return "A Sponsor (Third party)";
          if (arr.includes("self")) return "Self-funded";
          return "";
        })() },
        // Schengen — sponsor details (visible when funding = "A Sponsor (Third party)")
        { re: /^Name_of_sponsor$/,              value: cifType === "schengen" ? (q.inviter || "") : "" },
        { re: /^Your_relationship_with_sponsor$/, value: cifType === "schengen" ? (q.inviterRelation || "") : "" },
        // US — previous US visa
        { re: /^Have_you_ever_been_issued_a_U_S_Visa$/, value: cifType === "usa" ? yesNo(history.usaVisa) : "" },
      ];

      fields.forEach(field => {
        const fn = field.link_name;
        const basePath = cifPath(travId, stg.tag, fn, instance.id);

        // Pattern matching
        for (const pat of PATTERNS) {
          if (pat.re.test(fn) && !(pat.skip && pat.skip.test(fn)) && pat.value) {
            setEmpty(basePath, pat.value);
            break;
          }
        }

        // Composite name field (type 29) — match subfields by label
        if (field.type === 29) {
          (field.subfields || []).filter(sub => !sub.is_hidden).forEach(sub => {
            const key = sub.link_name || sub.column_name;
            const label = String(sub.display_name || "").toLowerCase();
            if (/surname|family|last/.test(label)) setEmpty(`${basePath}.${key}`, traveller.lastName);
            else if (/given|first/.test(label)) setEmpty(`${basePath}.${key}`, traveller.firstName);
          });
        }

        // Composite address field — fill customer mailing address into residential/home address fields
        if (/residential.address|home.address|permanent.address|current.address|address.in.india|address.in.home|applicant.*address/i.test(fn) && !/sponsor|organisation|org|postal|office/i.test(fn)) {
          const subParts = (field.subfields || []).filter(sub => !sub.is_hidden);
          const defaults = subParts.length ? subParts : [
            {link_name:"address_line_1"},{link_name:"address_line_2"},{link_name:"district_city"},
            {link_name:"state_province"},{link_name:"postal_Code"},{link_name:"country"}
          ];
          defaults.forEach(sub => {
            const key = sub.link_name || sub.column_name || "";
            const subPath = `${basePath}.${key}`;
            if (/address.line.1|^street$/i.test(key)) setEmpty(subPath, cust.mailingStreet);
            else if (/address.line.2/i.test(key)) setEmpty(subPath, "");
            else if (/city|district/i.test(key)) setEmpty(subPath, cust.mailingCity);
            else if (/state|province/i.test(key)) setEmpty(subPath, cust.mailingState);
            else if (/postal|zip/i.test(key)) setEmpty(subPath, cust.mailingZip);
            else if (/^country$/i.test(key)) setEmpty(subPath, cust.mailingCountry || "India");
          });
        }
      });

      state.cifAutofilledIds.add(autofillKey);
    }

    function cifGenericCompositeField(label, path, field) {
      const defaults = field.type === 29
        ? [{link_name:"first_name",display_name:"First Name"},{link_name:"last_name",display_name:"Last Name"}]
        : [
            {link_name:"address_line_1",display_name:"Address Line 1"},{link_name:"address_line_2",display_name:"Address Line 2"},
            {link_name:"district_city",display_name:"City / District"},{link_name:"state_province",display_name:"State / Province"},
            {link_name:"postal_Code",display_name:"Postal Code"},{link_name:"country",display_name:"Country"}
          ];
      const parts = (field.subfields || []).filter(sub => !sub.is_hidden);
      return `<div class="cifx-field full" data-field="${path}">
        <label>${escapeHtml(label)}${field.mandatory ? ' <span class="req">*</span>' : ""}</label>
        <div class="cifx-fg" style="margin-top:4px">${(parts.length ? parts : defaults).map(sub => {
          const key = sub.link_name || sub.column_name;
          const subPath = `${path}.${key}`;
          const current = getByPath(applicationData, subPath) || "";
          const choices = (sub.choices || []).map(choice => String(choice.value ?? choice.key ?? ""));
          const isCountry = cifIsCountrySelectorField({ link_name: key, display_name: sub.display_name || key });
          return choices.length
            ? `<select data-bind="${subPath}"><option value="">-- ${escapeHtml(sub.display_name || key)} --</option>${choices.map(choice => `<option value="${escapeHtml(choice)}" ${String(current) === choice ? "selected" : ""}>${escapeHtml(choice)}</option>`).join("")}</select>`
            : isCountry
              ? `<select data-bind="${subPath}">${cifCountryOptions(current).map(option => `<option value="${escapeHtml(option)}" ${String(current) === option ? "selected" : ""}>${option ? escapeHtml(option) : `-- ${escapeHtml(sub.display_name || key)} --`}</option>`).join("")}</select>`
            : `<input type="text" data-bind="${subPath}" value="${escapeHtml(current)}" placeholder="${escapeHtml(sub.display_name || key)}">`;
        }).join("")}</div>
      </div>`;
    }
    function cifAustraliaConditionMet(data, condition) {
      if (!condition) return true;
      if (condition.anyOf) return condition.anyOf.some(item => cifAustraliaConditionMet(data, item));
      if (condition.allOf) return condition.allOf.every(item => cifAustraliaConditionMet(data, item));
      const value = String(data?.[condition.field] ?? "");
      if (condition.equals !== undefined) return value === condition.equals;
      if (condition.in !== undefined) return condition.in.includes(value);
      return true;
    }

    const AUSTRALIA_FORM1_SHOWIF_MAP = {
      Select_your_current_location_Country:{field:"Is_the_applicant_currently_outside_Australia",equals:"Yes"},
      Select_your_status_at_this_location:{field:"Is_the_applicant_currently_outside_Australia",equals:"Yes"},
      Give_details_of_why_the_applicant_is_at_their_current_location_including_the_end_date_of_their_cur:{field:"Is_the_applicant_currently_outside_Australia",equals:"Yes"},
      Select_the_stream_the_applicant_is_applying_for:{field:"Is_the_applicant_currently_outside_Australia",equals:"Yes"},
      Select_all_reasons_for_visiting_Australia:{field:"Is_the_applicant_currently_outside_Australia",equals:"Yes"},
      Give_details_of_any_significant_dates_on_which_the_applicant_needs_to_be_in_Australia:{field:"Is_the_applicant_currently_outside_Australia",equals:"Yes"},
      Length_of_further_stay:{field:"Is_the_applicant_currently_outside_Australia",equals:"No"},
      Requested_end_date:{field:"Is_the_applicant_currently_outside_Australia",equals:"No"},
      Reason_for_further_stay:{field:"Is_the_applicant_currently_outside_Australia",equals:"No"},
      Is_the_applicant_travelling_as_a_representative_of_a_foreign_government_or_travelling_on_a_United:{field:"Is_the_applicant_currently_outside_Australia",equals:"No"},
      Select_the_special_category_of_entry:{field:"Is_the_applicant_travelling_as_a_representative_of_a_foreign_government_or_travelling_on_a_United",equals:"Yes"},

      Will_the_applicant_undertake_a_course_of_study_in_Australia:{field:"Select_the_stream_the_applicant_is_applying_for",in:["Business Visitor stream (business visit for meetings, conferences or negotiations but not for work)","Sponsored Family stream (requires Sponsorship form 1149)","Tourist stream (tourism/visit family or friends)"]},
      Will_the_applicant_visit_any_relatives_friends_or_contacts_while_in_Australia:{field:"Select_the_stream_the_applicant_is_applying_for",in:["Sponsored Family stream (requires Sponsorship form 1149)","Tourist stream (tourism/visit family or friends)"]},
      Course_name:{field:"Will_the_applicant_undertake_a_course_of_study_in_Australia",equals:"Yes"},
      Institution_name:{field:"Will_the_applicant_undertake_a_course_of_study_in_Australia",equals:"Yes"},
      Course_start_date:{field:"Will_the_applicant_undertake_a_course_of_study_in_Australia",equals:"Yes"},
      Course_end_date:{field:"Will_the_applicant_undertake_a_course_of_study_in_Australia",equals:"Yes"},
      Contact_in_Australia:{field:"Will_the_applicant_visit_any_relatives_friends_or_contacts_while_in_Australia",equals:"Yes"},

      Name:{field:"Do_you_have_have_a_national_identity_card",equals:"Yes"},
      Identification_number:{field:"Do_you_have_have_a_national_identity_card",equals:"Yes"},
      Country_of_issue:{field:"Do_you_have_have_a_national_identity_card",equals:"Yes"},
      Date_of_issue:{field:"Do_you_have_have_a_national_identity_card",equals:"Yes"},
      Date_of_expiry:{field:"Do_you_have_have_a_national_identity_card",equals:"Yes"},
      Give_the_reason_the_applicant_cannot_provide_details_of_a_national_identity_card_issued_by_their_c:{field:"Do_you_have_have_a_national_identity_card",equals:"No"},
      Pacific_Australia_Card_serial_number:{field:"Is_the_applicant_a_Pacific_Australia_Card_holder",equals:"Yes"},
      Previous_name:{field:"Is_this_applicant_currently_or_have_they_ever_been_known_by_any_other_names",equals:"Yes"},
      Reason_for_name_change:{field:"Is_this_applicant_currently_or_have_they_ever_been_known_by_any_other_names",equals:"Yes"},
      Give_detailed_reason_for_name_change:{allOf:[{field:"Is_this_applicant_currently_or_have_they_ever_been_known_by_any_other_names",equals:"Yes"},{field:"Reason_for_name_change",equals:"Other"}]},
      List_countries_where_you_hold_citizen_status:{field:"Is_this_applicant_a_citizen_of_any_other_country",equals:"Yes"},
      Is_this_applicant_currently_stateless:{allOf:[{field:"Is_this_applicant_a_citizen_of_the_selected_country_of_passport",equals:"No"},{field:"Is_this_applicant_a_citizen_of_any_other_country",equals:"No"}]},
      Give_details_as_to_why_the_applicant_is_not_a_citizen_of_any_country_and_is_not_stateless:{allOf:[{field:"Is_this_applicant_a_citizen_of_the_selected_country_of_passport",equals:"No"},{field:"Is_this_applicant_a_citizen_of_any_other_country",equals:"No"},{field:"Is_this_applicant_currently_stateless",equals:"No"}]},
      Australian_visa_grant_number_if_known:{field:"Do_you_have_an_Australian_visa_grant_number",equals:"Yes"},
      Give_details_of_your_heath_examination:{field:"Have_you_undertaken_a_health_examination_for_an_Australian_visa_in_the_last_12_months",equals:"Yes"},
      HAP_ID_If_available:{field:"Have_you_undertaken_a_health_examination_for_an_Australian_visa_in_the_last_12_months",equals:"Yes"},
      Does_you_intend_to_on_a_United_Nations_Laissez_Passer:{field:"Do_you_have_any_other_passports_or_documents_for_travel",equals:"Yes"},
      Add_document_other_passport_Travel:{field:"Do_you_have_any_other_passports_or_documents_for_travel",equals:"Yes"},
      Name_as_on_UN_passport:{field:"Does_you_intend_to_on_a_United_Nations_Laissez_Passer",equals:"Yes"},
      Sex1:{field:"Does_you_intend_to_on_a_United_Nations_Laissez_Passer",equals:"Yes"},
      Date_of_birth1:{field:"Does_you_intend_to_on_a_United_Nations_Laissez_Passer",equals:"Yes"},
      Date_of_issue1:{field:"Does_you_intend_to_on_a_United_Nations_Laissez_Passer",equals:"Yes"},
      Passport_number1:{field:"Does_you_intend_to_on_a_United_Nations_Laissez_Passer",equals:"Yes"},
      Date_of_expiry1:{field:"Does_you_intend_to_on_a_United_Nations_Laissez_Passer",equals:"Yes"},
      Add_identity_document:{field:"Do_you_have_other_identity_documents",equals:"Yes"},
      Add_Companions:{field:"Are_there_any_other_persons_travelling_with_the_applicant_to_Australia",equals:"Yes"},
      Postal_address:{field:"Is_the_postal_address_the_same_as_the_residential_address",equals:"No"},
      Non_accompanying_member_of_the_family_unit:{field:"Do_you_have_any_members_of_your_family_unit_not_travelling_to_Australia_who_are_not_Australian_cit",equals:"Yes"},

      How_long_does_the_applicant_plan_to_stay_in_Australia:{field:"Does_the_applicant_intend_to_enter_Australia_on_more_than_one_occasion",in:["Yes","No"]},
      Planned_arrival_date:{field:"Does_the_applicant_intend_to_enter_Australia_on_more_than_one_occasion",in:["Yes","No"]},
      Planned_final_departure_date:{field:"Does_the_applicant_intend_to_enter_Australia_on_more_than_one_occasion",in:["Yes","No"]},
      Does_the_applicant_know_the_dates_of_entry_for_each_occasion_after_first_entry_to_Australia:{field:"Does_the_applicant_intend_to_enter_Australia_on_more_than_one_occasion",equals:"Yes"},
      Details_of_the_additional_entry:{field:"Does_the_applicant_know_the_dates_of_entry_for_each_occasion_after_first_entry_to_Australia",equals:"Yes"},
      Give_reason_Why_applicant_do_not_know_the_dates:{field:"Does_the_applicant_know_the_dates_of_entry_for_each_occasion_after_first_entry_to_Australia",equals:"No"},
      Does_the_applicant_want_to_apply_for_a_longer_visa_validity_period:{field:"Is_the_applicant_a_parent_or_step_parent_of_an_Australian_citizen_or_Australian_permanent_resident",equals:"Yes"},
      Has_the_applicant_applied_for_an_Australian_parent_visa:{field:"Is_the_applicant_a_parent_or_step_parent_of_an_Australian_citizen_or_Australian_permanent_resident",equals:"Yes"},
      Does_the_application_have_a_queue_date:{field:"Has_the_applicant_applied_for_an_Australian_parent_visa",equals:"Yes"},
      Is_the_applicant_applying_for_a_multiple_stay_visa_which_may_allow_the_applicant_to_stay_up_to_12:{field:"Has_the_applicant_applied_for_an_Australian_parent_visa",equals:"Yes"},
      Provide_queue_date:{field:"Does_the_application_have_a_queue_date",equals:"Yes"},

      Sponsor_s_relationship_to_the_applicant:{field:"Select_the_stream_the_applicant_is_applying_for",equals:"Sponsored Family stream (requires Sponsorship form 1149)"},
      Name_of_the_sponsor:{field:"Select_the_stream_the_applicant_is_applying_for",equals:"Sponsored Family stream (requires Sponsorship form 1149)"},
      Sex_of_sponsor:{field:"Select_the_stream_the_applicant_is_applying_for",equals:"Sponsored Family stream (requires Sponsorship form 1149)"},
      Sponsor_s_date_of_birth:{field:"Select_the_stream_the_applicant_is_applying_for",equals:"Sponsored Family stream (requires Sponsorship form 1149)"},
      Residential_address_of_sponsor:{field:"Select_the_stream_the_applicant_is_applying_for",equals:"Sponsored Family stream (requires Sponsorship form 1149)"},
      Phone_number_of_sponsor:{field:"Select_the_stream_the_applicant_is_applying_for",equals:"Sponsored Family stream (requires Sponsorship form 1149)"},
      Does_this_sponsor_have_a_passport:{field:"Select_the_stream_the_applicant_is_applying_for",equals:"Sponsored Family stream (requires Sponsorship form 1149)"},
      Passport_number_Sponsor:{allOf:[{field:"Select_the_stream_the_applicant_is_applying_for",equals:"Sponsored Family stream (requires Sponsorship form 1149)"},{field:"Does_this_sponsor_have_a_passport",equals:"Yes"}]},
      Country_of_passport_Sponsor:{allOf:[{field:"Select_the_stream_the_applicant_is_applying_for",equals:"Sponsored Family stream (requires Sponsorship form 1149)"},{field:"Does_this_sponsor_have_a_passport",equals:"Yes"}]},
      Nationality_of_passport_holder_Sponsor:{allOf:[{field:"Select_the_stream_the_applicant_is_applying_for",equals:"Sponsored Family stream (requires Sponsorship form 1149)"},{field:"Does_this_sponsor_have_a_passport",equals:"Yes"}]},
      Date_of_issue_Sponsor_s_passport:{allOf:[{field:"Select_the_stream_the_applicant_is_applying_for",equals:"Sponsored Family stream (requires Sponsorship form 1149)"},{field:"Does_this_sponsor_have_a_passport",equals:"Yes"}]},
      Date_of_expiry_Sponsor_s_passport:{allOf:[{field:"Select_the_stream_the_applicant_is_applying_for",equals:"Sponsored Family stream (requires Sponsorship form 1149)"},{field:"Does_this_sponsor_have_a_passport",equals:"Yes"}]},
      Place_of_issue_issuing_authority_Sponsor_s_passport:{allOf:[{field:"Select_the_stream_the_applicant_is_applying_for",equals:"Sponsored Family stream (requires Sponsorship form 1149)"},{field:"Does_this_sponsor_have_a_passport",equals:"Yes"}]},

      Occupation_grouping:{field:"Employment_status",in:["Employed","Self employed"]},
      Organisation:{field:"Employment_status",in:["Employed","Self employed"]},
      Start_date_with_current_employer:{field:"Employment_status",in:["Employed","Self employed"]},
      Organisation_address:{field:"Employment_status",in:["Employed","Self employed"]},
      Business_phone:{field:"Employment_status",in:["Employed","Self employed"]},
      Organisation_email_address:{field:"Employment_status",in:["Employed","Self employed"]},
      Date_since_you_are_unemployed:{field:"Employment_status",equals:"Unemployed"},
      Last_employment_position:{field:"Employment_status",equals:"Unemployed"},
      Retirement_date:{field:"Employment_status",equals:"Retired"},
      Current_course_name:{field:"Employment_status",equals:"Student"},
      Current_institution_name:{field:"Employment_status",equals:"Student"},
      Current_study_start_date:{field:"Employment_status",equals:"Student"},
      Current_study_end_date:{field:"Employment_status",equals:"Student"},
      Provide_detail_about_your_other_employment:{field:"Employment_status",equals:"Other"},
      What_funds_will_the_applicant_have_available_to_support_their_stay_in_Australia:{field:"Give_details_of_how_the_applicant_s_stay_in_Australia_will_be_funded",in:["Self funded","Supported by current employer","Supported by other organisation","Supported by other person"]},
      Type_of_support:{field:"Give_details_of_how_the_applicant_s_stay_in_Australia_will_be_funded",in:["Supported by current employer","Supported by other organisation","Supported by other person"]},
      Supporting_organisation_address:{field:"Give_details_of_how_the_applicant_s_stay_in_Australia_will_be_funded",equals:"Supported by other organisation"},
      Supporter_s_relationship_to_the_applicant:{field:"Give_details_of_how_the_applicant_s_stay_in_Australia_will_be_funded",equals:"Supported by other person"},
      Name_of_supporting_person:{field:"Give_details_of_how_the_applicant_s_stay_in_Australia_will_be_funded",equals:"Supported by other person"},
      Address_of_the_supporting_person:{field:"Give_details_of_how_the_applicant_s_stay_in_Australia_will_be_funded",equals:"Supported by other person"}
    };

    const AUSTRALIA_FORM3_VISIBLE_WHEN_YES = {
      Add_visit_details:"In_the_last_five_years_has_the_applicant_visited_or_lived_outside_their_country_of_passport_for_mo",
      Select_reason:"Does_the_applicant_intend_to_enter_a_hospital_or_a_health_care_facility_including_nursing_homes_wh",
      Give_details_for_intention_to_enter_hospitals_or_health_care_facilities:"Does_the_applicant_intend_to_enter_a_hospital_or_a_health_care_facility_including_nursing_homes_wh",
      On_which_role_the_applicant_will_work_in_age_care_or_disability_care:"Does_the_applicant_intend_to_work_study_or_train_within_aged_care_or_disability_care_while_in_Aust",
      Give_detail_about_applicant_s_intention_to_work_in_age_care_or_disability_care:"Does_the_applicant_intend_to_work_study_or_train_within_aged_care_or_disability_care_while_in_Aust",
      Give_detail_about_contact_with_tuberculosis:"Has_the_applicant_tuberculosis",
      Select_Condition:"During_their_proposed_visit_to_Australia_does_applicant_expect_to_incur_medical_costs",
      Give_details_of_the_medical_condition_for_which_the_applicant_expects_to_incur_costs_require_treat:"During_their_proposed_visit_to_Australia_does_applicant_expect_to_incur_medical_costs",
      Give_detail_about_requirement_of_Health_or_Community_Care:"Does_the_applicant_require_ongoing_medical_care_or_need_special_equipment_assistive_technology_or",
      Add_offense_detail:"Has_the_applicant_ever_been_charged_with_any_offence_that_is_currently_awaiting_legal_action",
      Add_details_in_conviction_offense:"Has_the_applicant_ever_been_convicted_of_an_offence_in_any_country_including_any_conviction_which",
      Add_details_in_Domestic_violence:"A_applicant_ever_been_the_subject_of_a_domestic_violence_or_family_violence_order_or_any_other_ord",
      Give_details_of_an_arrest_warrant_or_Interpol_notice:"Has_the_applicant_ever_been_the_subject_of_an_arrest_warrant_or_Interpol_notice",
      Give_details_of_a_sexually_based_offence_involving_a_child:"Has_the_applicant_ever_been_found_guilty_of_a_sexually_based_offence_involving_a_child_including_w",
      Give_details_for_applicant_s_name_on_a_sex_offender_register:"Has_the_applicant_ever_been_named_on_a_sex_offender_register",
      Give_details_about_acquittal:"Has_the_applicant_ever_been_acquitted_of_any_offence_on_the_grounds_of_unsoundness_of_mind_or_insa",
      Give_detail_of_incident_found_by_a_court_not_fit_to_plead:"Has_the_applicant_ever_been_found_by_a_court_not_fit_to_plead",
      Give_details_of_such_involvement_association_and_activity:"Has_the_applicant_ever_been_directly_or_indirectly_involved_in_or_associated_with_activities_which",
      Give_details_of_such_genocide_war_crimes_crimes_against_humanity_torture_slavery_or_any_other_crim:"Has_the_applicant_ever_been_charged_with_or_indicted_for_genocide_war_crimes_crimes_against_humani",
      Give_detail_of_such_association_or_involvement_in_criminal_conduct:"Has_the_applicant_ever_been_associated_with_a_person_group_or_organisation_that_has_been_or_is_inv",
      Give_details_of_association_with_an_organisation_engaged_in_above_stated_activities:"A_applicant_ever_been_associated_with_an_organisation_engaged_in_violence_or_engaged_in_acts_of_vi",
      Add_Service_details:"Has_the_applicant_ever_served_in_a_military_force_police_force_state_sponsored_private_militia_or",
      Add_training_details:"Has_the_applicant_ever_undergone_any_military_paramilitary_training_been_trained_in_weapons_explos",
      Give_details_about_involvement_in_people_smuggling_or_people_trafficking_offences:"Has_the_applicant_ever_been_involved_in_people_smuggling_or_people_trafficking_offences",
      Give_details_about_removal_deportation_or_exclusion_from_any_country_including_Australia:"Has_the_applicant_ever_been_removed_deported_or_excluded_from_any_country_including_Australia",
      Give_details_about_overstay_a_visa_in_any_country_including_Australia:"Has_the_applicant_ever_overstayed_a_visa_in_any_country_including_Australia",
      Give_details_about_such_debts:"Has_the_applicant_ever_had_any_outstanding_debts_to_the_Australian_Government_or_any_public_author",
      Give_details_of_Visa_your_are_currently_holding:"Has_the_applicant_held_or_does_the_applicant_currently_hold_a_visa_to_Australia_or_any_other_country",
      Give_details_of_such_incidents:"Has_the_applicant_ever_been_in_Australia_or_any_other_country_and_not_complied_with_visa_condition",
      Give_details_of_visa_refusal_and_or_cancellation:"Has_the_applicant_ever_had_a_visa_for_Australia_or_any_other_country_refused_or_cancelled"
    };

    function cifAustraliaFieldVisible(instance, stage, data, fieldName) {
      if (instance?.type !== "australia") return true;
      if (stage?.form === "Australia_Customer_Information") {
        return cifAustraliaConditionMet(data, AUSTRALIA_FORM1_SHOWIF_MAP[fieldName]);
      }
      if (stage?.form === "Australia_Customer_Information_3") {
        const trigger = AUSTRALIA_FORM3_VISIBLE_WHEN_YES[fieldName];
        return !trigger || String(data?.[trigger] ?? "") === "Yes";
      }
      return true;
    }

    function cifAustraliaSubformFieldVisible(instance, stage, parentFieldName, rowData, childFieldName) {
      if (instance?.type !== "australia" || stage?.form !== "Australia_Customer_Information") return true;
      if (parentFieldName !== "Add_document_other_passport_Travel" || childFieldName === "Type_of_document") return true;
      const type = String(rowData?.Type_of_document ?? "");
      const common = ["Name","Date_of_Birth","Country_of_issue","Nationality_of_document_holder"];
      if (common.includes(childFieldName)) return ["DFTTA","PLO56(M56)","Immicard","Passport","Titre de Voyage","Other Travel document"].includes(type);
      if (childFieldName === "Sex") return ["Immicard","Passport","Titre de Voyage","Other Travel document"].includes(type);
      if (childFieldName === "Document_number") return ["DFTTA","PLO56(M56)","Titre de Voyage","Other Travel document"].includes(type);
      if (childFieldName === "Passport_number") return type === "Passport";
      if (childFieldName === "Date_of_issue") return ["Passport","Titre de Voyage","Other Travel document"].includes(type);
      if (["Date_of_expiry","Place_of_issue_issuing_authority"].includes(childFieldName)) return ["Immicard","Passport","Titre de Voyage","Other Travel document"].includes(type);
      return true;
    }

    function cifGenericFieldVisible(instance, stage, data, fieldName) {
      return cifAustraliaFieldVisible(instance, stage, data, fieldName) &&
        cifUsFieldVisible(instance, stage, data, fieldName) &&
        cifUsForm2FieldVisible(instance, stage, data, fieldName) &&
        cifUsForm3FieldVisible(instance, stage, data, fieldName) &&
        cifUsForm4FieldVisible(instance, stage, data, fieldName) &&
        cifSchengenFieldVisible(instance, stage, data, fieldName);
    }

    function cifUsFieldVisible(instance, stage, data, fieldName) {
  // Do not affect UK, Australia or Schengen CIF forms.
  if (instance?.type !== "usa") return true;

  // Code 1 applies only to US Form 1.
  if (stage?.form !== "Us_Form_1") return true;

  const equals = (sourceField, expectedValue) =>
    String(data?.[sourceField] ?? "") === expectedValue;

  switch (fieldName) {
    case "Full_Name_in_Native_Alphabet":
      return equals("Does_your_name_exist_in_a_native_alphabet", "Yes");

    case "Other_Name":
      return equals(
        "Have_you_ever_used_other_names_i_e_maiden_religious_professional_alias_etc",
        "Yes"
      );

    case "Telecode_Surnames":
    case "Telecode_Given_Names":
      return equals(
        "Do_you_have_a_telecode_that_represents_your_name",
        "Yes"
      );

    case "State_Province1":
      return equals(
        "Does_your_address_include_a_state_or_province",
        "Yes"
      );

    case "Other_Country_Region1":
      return equals(
        "Do_you_hold_or_have_you_held_any_nationality_other_than_the_one_indicated_above_on_nationa",
        "Yes"
      );

    case "Other_Permanent_Resident_Country_Region":
      return equals(
        "Are_you_a_permanent_resident_of_a_country_region_other_than_your_country_region_of_origin",
        "Yes"
      );

    case "National_Identification_Number":
      return equals("Do_you_have_National_Identification_Number", "Yes");

    case "U_S_Social_Security_Number":
      return equals(
        "Does_the_applicant_have_a_U_S_Social_Security_Number",
        "Yes"
      );

    case "U_S_Taxpayer_ID_Number":
      return equals(
        "Does_the_applicant_have_a_U_S_Taxpayer_ID_Number",
        "Yes"
      );

    case "Date_of_Arrival_in_U_S":
    case "Arrival_Flight_if_known":
    case "Arrival_City":
    case "Date_of_Departure_from_U_S":
    case "Departure_Flight_if_known":
    case "Departure_City":
    case "Add_Location":
      return equals("Have_you_made_specific_travel_plans", "Yes");

    case "Intended_Date_of_Arrival":
    case "Length_of_Stay_in_U_S":
    case "Intended_Length_of_Stay_in_U_S":
      return !equals("Have_you_made_specific_travel_plans", "Yes");

    case "Surnames_of_Person_Paying_for_Trip":
    case "Given_Names_of_person_paying_for_Trip":
    case "Telephone_Number":
    case "Do_you_have_an_email_address":
    case "Relationship_to_you":
    case "Is_the_address_of_the_party_paying_for_your_trip_the_same_as_your_Home_or_Mailing_Address":
      return equals("Person_Entity_Paying_for_Your_Trip", "OTHER PERSON");

    case "Email1":
      return (
        equals("Person_Entity_Paying_for_Your_Trip", "OTHER PERSON") &&
        equals("Do_you_have_an_email_address", "Yes")
      );

    case "Address_of_person_paying":
      return (
        equals("Person_Entity_Paying_for_Your_Trip", "OTHER PERSON") &&
        equals(
          "Is_the_address_of_the_party_paying_for_your_trip_the_same_as_your_Home_or_Mailing_Address",
          "No"
        )
      );

    case "Name_of_the_Company_Organization_Paying_for_Trip":
    case "Telephone_Number1":
    case "Relationship_to_you1":
    case "Address_of_company_Organization_Paying":
      return equals(
        "Person_Entity_Paying_for_Your_Trip",
        "OTHER COMPANY/ORGANIZATION"
      );

    case "Specifydr":
      return equals(
        "Purpose_of_Trip_to_the_U_S",
        "TEMP. BUSINESS OR PLEASURE VISITOR (B)"
      );

    default:
      return true;
  }
} 
function cifUsForm2FieldVisible(instance, stage, data, fieldName) {
  // Leave every non-US Form 2 field unchanged.
  if (
    instance?.type !== "usa" ||
    stage?.form !== "Us_Form_2"
  ) {
    return true;
  }

  const equals = (sourceField, expectedValue) =>
    String(data?.[sourceField] ?? "") === expectedValue;

  const otherTravellers =
    equals("Are_there_other_persons_traveling_with_you", "Yes");

  const issuedUsVisa =
    equals("Have_you_ever_been_issued_a_U_S_Visa", "Yes");

  switch (fieldName) {
    case "Are_you_traveling_as_part_of_a_group_or_organization":
      return otherTravellers;

    case "Group_Name":
      return (
        otherTravellers &&
        equals(
          "Are_you_traveling_as_part_of_a_group_or_organization",
          "Yes"
        )
      );

    case "Surnames_of_Person_Traveling_With_You":
    case "Given_Names_of_Person_Traveling_With_You":
    case "Relationship_with_Person":
      return (
        otherTravellers &&
        equals(
          "Are_you_traveling_as_part_of_a_group_or_organization",
          "No"
        )
      );

    case "Add_previous_U_S_Visit_Details":
      return equals("Have_you_ever_been_in_the_U_S", "Yes");

    case "Add_U_S_Driver_s_License":
      return equals(
        "Do_you_or_did_you_ever_hold_a_U_S_Driver_s_License",
        "Yes"
      );

    case "Date_Last_Visa_Was_Issued":
    case "Does_your_visa_have_a_number":
    case "Are_you_applying_in_the_same_country_or_location_where_the_visa_above_was_issued_and_is_th":
    case "Have_you_been_ten_printed":
    case "Has_your_U_S_Visa_ever_been_lost_or_stolen":
    case "Has_your_U_S_Visa_ever_been_cancelled_or_revoked":
      return issuedUsVisa;

    case "Visa_Number":
      return (
        issuedUsVisa &&
        equals("Does_your_visa_have_a_number", "Yes")
      );

    case "Year1":
    case "Explain_Has_your_U_S_Visa_ever_been_lost_or_stolen":
      return (
        issuedUsVisa &&
        equals(
          "Has_your_U_S_Visa_ever_been_lost_or_stolen",
          "Yes"
        )
      );

    case "Explain_Has_your_U_S_Visa_ever_been_cancelled_or_revoked":
      return (
        issuedUsVisa &&
        equals(
          "Has_your_U_S_Visa_ever_been_cancelled_or_revoked",
          "Yes"
        )
      );

    case "Explain_Have_you_ever_been_refused_a_U_S_Visa_or_been_refused_admission_to_the_United_Stat":
      return equals(
        "Have_you_ever_been_refused_a_U_S_Visa_or_been_refused_admission_to_the_United_States_or_wi",
        "Yes"
      );

    case "Explain_Have_you_ever_been_denied_travel_authorization_by_the_Department_of_Homeland_Secur":
      return equals(
        "Have_you_ever_been_denied_travel_authorization_by_the_Department_of_Homeland_Security_thro",
        "Yes"
      );

    case "Explain_Has_anyone_ever_filed_an_immigrant_petition_on_your_behalf_with_the_United_States":
      return equals(
        "Has_anyone_ever_filed_an_immigrant_petition_on_your_behalf_with_the_United_States_Citizens",
        "Yes"
      );

    case "Provide_your_mailing_address":
      return equals(
        "Is_your_Mailing_Address_the_same_as_your_Home_Address",
        "No"
      );

    case "Secondary_Phone_Number":
      return equals("Do_you_have_a_secondary_phone_number", "Yes");

    case "Work_Phone_Number":
      return equals("Do_you_have_a_work_phone_number", "Yes");

    case "Add_Additional_Phone_Number":
      return equals(
        "Have_you_used_any_other_phone_numbers_in_the_last_five_years",
        "Yes"
      );

    case "Add_Additional_Email_Address":
      return equals(
        "Have_you_used_any_other_email_addresses_in_the_last_five_years",
        "Yes"
      );

    case "Add_Social_Media_Platform_and_identifiers":
      return equals(
        "Do_you_wish_to_provide_information_about_your_presence_on_any_other_websites_or_applicatio",
        "Yes"
      );

    case "Explain_Other_Passport_Travel_Document_Type":
      return equals("Passport_Travel_Document_Type", "OTHER");

    case "Passport_Book_Number":
      return equals(
        "Does_the_applicant_have_a_Passport_Book_Number",
        "Yes"
      );

    case "Expiration_Date":
      return equals(
        "Does_the_applicant_have_an_Expiration_Date",
        "Yes"
      );

    case "Add_passport_Travel_Document":
      return equals(
        "Have_you_ever_lost_a_passport_or_had_one_stolen",
        "Yes"
      );

    case "Surnames":
    case "Given_Names":
      return equals(
        "Does_the_applicant_have_a_Contact_Person_in_the_United_States",
        "Yes"
      );

    case "Organization_Name":
      return equals(
        "Does_the_applicant_have_an_Organization_Name_in_the_United_States",
        "Yes"
      );

    case "Email_Address1":
      return equals(
        "Does_the_applicant_have_an_Email_Address",
        "Yes"
      );

    default:
      return true;
  }
}
function cifUsForm3FieldVisible(instance, stage, data, fieldName) {
  // Do not affect other US forms, UK, Australia or Schengen.
  if (
    instance?.type !== "usa" ||
    stage?.form !== "Us_Form_3"
  ) {
    return true;
  }

  const visibleWhenYes = {
    Father_s_Surnames:
      "Does_the_applicant_know_their_Father_s_Surname",

    Father_s_Given_Names:
      "Does_the_applicant_know_their_Father_s_Given_Name",

    Father_s_Date_of_Birth:
      "Does_the_applicant_know_their_Father_s_Date_of_Birth",

    Father_s_Status:
      "Is_your_father_in_the_U_S",

    Mother_s_Surnames:
      "Does_the_applicant_know_their_Mother_s_Surnames",

    Mother_s_Given_Names:
      "Does_the_applicant_know_their_Mother_s_Given_Name",

    Mother_s_Date_of_Birth:
      "Does_the_applicant_know_their_Mother_s_Date_of_Birth",

    Mother_s_Status:
      "Is_your_mother_in_the_U_S",

    Add_Relative_s_in_U_S:
      "Do_you_have_any_immediate_relatives_not_including_parents_in_the_United_States",

    Do_you_have_any_other_relatives_in_the_United_States:
      "Do_you_have_any_immediate_relatives_not_including_parents_in_the_United_States",

    Monthly_Income_in_Local_Currency_if_employed:
      "Does_your_current_employment_provide_a_monthly_income_in_local_currency",

    Add_Employer_Employment_information:
      "Were_you_previously_employed",

    Add_Educational_information:
      "Have_you_attended_any_educational_institutions_at_a_secondary_level_or_above",

    Clan_or_Tribe_Name:
      "Do_you_belong_to_a_clan_or_tribe",

    // Correct Creator travel-history field.
    Country_Region1:
      "Have_you_traveled_to_any_countries_regions_within_the_last_five_years",

    Add_list_of_Organizations:
      "Have_you_belonged_to_contributed_to_or_worked_for_any_professional_social_or_charitable_or",

    Explain_Do_you_have_any_specialized_skills_or_training_such_as_firearms_explosives_nuclear:
      "Do_you_have_any_specialized_skills_or_training_such_as_firearms_explosives_nuclear_biologi",

    Add_Details_of_Applicant_s_Military_Service:
      "Have_you_ever_served_in_the_military",

    Explain_Have_you_ever_served_in_been_a_member_of_or_been_involved_with_a_paramilitary_unit:
      "Have_you_ever_served_in_been_a_member_of_or_been_involved_with_a_paramilitary_unit_vigilan",

    Explain_Do_you_have_any_communicable_disease_of_public_health_significance_e_g_chancroid_g:
      "Do_you_have_a_communicable_disease_of_public_health_significance_Communicable_diseases_of",

    Explain_Do_you_have_a_mental_or_physical_disorder_that_poses_or_is_likely_to_pose_a_threat:
      "Do_you_have_a_mental_or_physical_disorder_that_poses_or_is_likely_to_pose_a_threat_to_the",

    Explain_Are_you_or_have_you_ever_been_a_drug_abuser_or_addict:
      "Are_you_or_have_you_ever_been_a_drug_abuser_or_addict",

    Explain_Have_you_ever_been_arrested_or_convicted_for_any_offense_or_crime_even_though_subj:
      "Have_you_ever_been_arrested_or_convicted_for_any_offense_or_crime_even_though_subject_of_a",

    Explain_Have_you_ever_violated_or_engaged_in_a_conspiracy_to_violate_any_law_relating_to_c:
      "Have_you_ever_violated_or_engaged_in_a_conspiracy_to_violate_any_law_relating_to_controlle",

    Explain_Are_you_coming_to_the_United_States_to_engage_in_prostitution_or_unlawful_commerci:
      "Are_you_coming_to_the_United_States_to_engage_in_prostitution_or_unlawful_commercialized_v",

    // Correct trigger: money-laundering answer itself.
    Explain_Have_you_ever_been_involved_in_or_do_you_seek_to_engage_in_money_laundering:
      "Have_you_ever_been_involved_in_or_do_you_seek_to_engage_in_money_laundering",

    Explain_Have_you_ever_committed_or_conspired_to_commit_a_human_trafficking_offense_in_the_United_S:
      "Have_you_ever_committed_or_conspired_to_commit_a_human_trafficking_offense_in_the_United_States_or",

    Explain_Have_you_knowingly_aided_abetted_or_assisted_anyone_involved_in_a_severe_human_trafficking:
      "Have_you_knowingly_aided_abetted_or_assisted_anyone_involved_in_a_severe_human_trafficking_offense",

    Explain_Are_you_the_spouse_son_or_daughter_of_someone_involved_in_human_trafficking_in_or_outside:
      "Are_you_the_spouse_son_or_daughter_of_someone_involved_in_human_trafficking_in_or_outside_the_U_S"
  };

  const triggerField = visibleWhenYes[fieldName];

  if (!triggerField) return true;

  return String(data?.[triggerField] ?? "") === "Yes";
}
function cifUsForm4FieldVisible(instance, stage, data, fieldName) {
  // Do not affect other US forms, UK, Australia or Schengen.
  if (
    instance?.type !== "usa" ||
    stage?.form !== "Us_Form_4"
  ) {
    return true;
  }

  const visibleWhenYes = {
    Explain_Do_you_seek_to_engage_in_espionage_sabotage_export_control_violations_or_any_other1:
      "Do_you_seek_to_engage_in_espionage_sabotage_export_control_violations_or_any_other_illegal",

    Explain_Do_you_seek_to_engage_in_terrorist_activities_while_in_the_United_States_or_have_yo:
      "Do_you_seek_to_engage_in_terrorist_activities_while_in_the_United_States_or_have_you_ever",

    Explain_Have_you_ever_or_do_you_intend_to_provide_financial_assistance_or_other_support:
      "Have_you_ever_or_do_you_intend_to_provide_financial_assistance_or_other_support",

    Explain_Are_you_a_member_or_representative_of_a_terrorist_organization1:
      "Are_you_a_member_or_representative_of_a_terrorist_organization1",

    Explain_Are_you_the_spouse_son_or_daughter_of_someone_who_has_supported:
      "Are_you_the_spouse_son_or_daughter_of_someone_who_has_supported_terrorist",

    Explain_Have_you_ever_ordered_incited_committed_assisted_or_otherwise_participated:
      "Have_you_ever_ordered_incited_committed_assisted_or_otherwise_participated_in_genocide",

    Explain_Have_you_ever_committed_ordered_incited_assisted_or_otherwise_participated_in_torture:
      "Have_you_ever_committed_ordered_incited_assisted_or_otherwise_participated_in_torture",

    Explain_Have_you_committed_ordered_incited_assisted_or_otherwise_participated:
      "Have_you_committed_ordered_incited_assisted_or_otherwise_participated_in_extrajudicial_killings",

    Explain_Have_you_ever_engaged_in_the_recruitment_or_the_use_of_child_soldiers:
      "Have_you_ever_engaged_in_the_recruitment_or_the_use_of_child_soldiers",

    Explain_Have_you_while_serving_as_a_government_official_been_responsible:
      "Have_you_while_serving_as_a_government_official_been_responsible_for_or_directly_carried",

    Explain_Have_you_ever_been_involved_in_forcing_someone_to_undergo_abortion:
      "Have_you_ever_been_involved_in_forcing_someone_to_undergo_abortion_or_sterilization",

    Explain_Have_you_ever_been_directly_involved_in_the_coercive_transplantation_of_human:
      "Have_you_ever_been_directly_involved_in_the_coercive_transplantation_of_human_organs",

    Explain_Have_you_ever_tried_to_obtain_or_help_others_obtain_a_U_S_visa_or_immigration_benefit:
      "Have_you_ever_tried_to_obtain_or_help_others_obtain_a_U_S_visa_or_immigration_benefit_through",

    Explain_Have_you_ever_been_removed_or_deported_from:
      "Have_you_ever_been_removed_or_deported_from_any_country",

    Explain_Have_you_ever_withheld_custody_of_a_U_S_citizen_child_outside_the_United_States:
      "Have_you_ever_withheld_custody_of_a_U_S_citizen_child_outside_the_United_States_from_a_person",

    Explain_Have_you_voted_in_the_United_States_in_violation_of_any_law_or_regulation:
      "Have_you_voted_in_the_United_States_in_violation_of_any_law_or_regulation",

    Explain_Have_you_ever_renounced_United_States_citizenship_for_the_purposes_of_avoiding_taxation:
      "Have_you_ever_renounced_United_States_citizenship_for_the_purposes_of_avoiding_taxation"
  };

  const triggerField = visibleWhenYes[fieldName];

  if (!triggerField) return true;

  return String(data?.[triggerField] ?? "") === "Yes";
}
function cifUsSubformFieldVisible(
  instance,
  stage,
  parentFieldName,
  rowData,
  childFieldName
) {
  // Do not affect UK, Australia or Schengen CIF forms.
  if (instance?.type !== "usa") return true;

  // US Form 1: other-nationality passport number.
  if (
    stage?.form === "Us_Form_1" &&
    parentFieldName === "Other_Country_Region1" &&
    childFieldName === "Passport_Number"
  ) {
    return String(
      rowData?.Do_you_hold_a_passport_for_the_other_country_region_of_origin_nationality_indicated_above ??
      ""
    ) === "Yes";
  }

  // US Form 2: driver's licence number.
  if (
    stage?.form === "Us_Form_2" &&
    parentFieldName === "Add_U_S_Driver_s_License" &&
    childFieldName === "Driver_s_License_Number"
  ) {
    return String(
      rowData?.Does_the_applicant_know_their_driver_s_license_number ??
      ""
    ) === "Yes";
  }

  // US Form 2: lost/stolen passport number.
  if (
    stage?.form === "Us_Form_2" &&
    parentFieldName === "Add_passport_Travel_Document" &&
    childFieldName === "Passport_Travel_Document_Number"
  ) {
    return String(
      rowData?.Does_the_applicant_know_their_Passport_Travel_document_number ??
      ""
    ) === "Yes";
  }

  // Explanation is required only when the number is unknown.
  if (
    stage?.form === "Us_Form_2" &&
    parentFieldName === "Add_passport_Travel_Document" &&
    childFieldName ===
      "Explain_Does_the_applicant_know_their_Passport_Travel_document_number"
  ) {
    return String(
      rowData?.Does_the_applicant_know_their_Passport_Travel_document_number ??
      ""
    ) === "No";
  }
  return true;
}
// ═══════════════════════════════════════════════════════════════════════
// SCHENGEN CIF — hide/show logic, built from the real Field Rules scripts
// pulled from the Schengen_Visitor_visa Creator form. Scoped entirely to
// instance.type === "schengen" — never touches UK/Australia/USA.
// ═══════════════════════════════════════════════════════════════════════

// Evaluates one condition object against the current stage's data. Mirrors
// the shape used by cifShowIfMet (UK's version) but adapted for Schengen's
// flatter single-form structure — no cross-form "form" tag needed since
// Schengen only has 1 stage.
function cifSchengenConditionMet(data, condition) {
  if (!condition) return true;
  if (condition.anyOf) return condition.anyOf.some(c => cifSchengenConditionMet(data, c));
  if (condition.allOf) return condition.allOf.every(c => cifSchengenConditionMet(data, c));

  const raw = data?.[condition.field];
  const asList = Array.isArray(raw) ? raw : String(raw || "").split(SCHENGEN_MULTI_DELIM).map(s => s.trim()).filter(Boolean);

  if (condition.equals !== undefined) return String(raw ?? "") === condition.equals;
  if (condition.in !== undefined) return condition.in.includes(String(raw ?? ""));
  if (condition.contains !== undefined) return asList.includes(condition.contains);
  if (condition.notContainsAny !== undefined) return !condition.notContainsAny.some(v => asList.includes(v));
  if (condition.notEmpty) return asList.length > 0;
  return true;
}

// Target field link_name → the condition that must be true for it to show.
// Built directly from the live Field Rules scripts (see chat log for the
// full pasted source). Fields not listed here always show (no condition).
// ── Schengen-only checkbox handling ──────────────────────────────────────────
// Kept completely separate from cifMultiSelectField / cifToggleMulti (which UK also uses)
// so this fix cannot affect UK, Australia, or USA in any way.
//
// Why a separate delimiter: some real Schengen checkbox option values contain a literal
// comma in their own text (e.g. "Holding position in social community (Samaj, Group etc.)").
// The shared UK component joins/splits selections using ",", which mangles any option text
// that itself contains a comma. \u001F (Unicode "unit separator") never appears in real
// option text, so it's safe to use as the join/split delimiter here.
const SCHENGEN_MULTI_DELIM = "\u001F";

// Safely embeds `value` as a single-quoted JS string-literal argument inside an HTML
// onclick attribute. JS-escaping (backslash, then quote) must happen BEFORE HTML-escaping.
// Doing it the other way round — as the shared cifMultiSelectField still does, which is
// fine there only because none of UK's own checkbox options currently contain an
// apostrophe — leaves a raw apostrophe in the decoded attribute text once the browser
// parses it, which prematurely closes the JS string and throws
// "missing ) after argument list" for any option text containing an apostrophe
// (e.g. Schengen's "I don't have any position or membership in any of the above").
function cifSchengenJsAttr(value) {
  return escapeHtml(String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
}

function cifSchengenToggleMulti(path, value, el) {
  const selected = String(getByPath(applicationData, path) || "").split(SCHENGEN_MULTI_DELIM).map(s => s.trim()).filter(Boolean);
  const idx = selected.indexOf(value);
  if (idx >= 0) selected.splice(idx, 1); else selected.push(value);
  setByPath(applicationData, path, selected.join(SCHENGEN_MULTI_DELIM));
  cifMarkInstanceDirtyFromPath(path);
  markAutoSavePending();
  // Several Schengen fields conditionally show/hide other fields based on this value
  // (occupation, funding source, properties owned, etc.), so re-render to reflect that,
  // the same way UK's trigger-field handling already does for its own conditional fields.
  renderCIF();
}

function cifSchengenMultiSelectField(label, path, options, req) {
  const selected = String(getByPath(applicationData, path) || "").split(SCHENGEN_MULTI_DELIM).map(s => s.trim()).filter(Boolean);
  return `<div class="cifx-field full" data-field="${path}">
    <label>${escapeHtml(label)}${req ? ' <span class="req">*</span>' : ""}</label>
    <div class="cifx-pg">
      ${options.map(opt => `<button type="button" class="cifx-rp ${selected.includes(opt) ? "on" : ""}" onclick="cifSchengenToggleMulti('${path}','${cifSchengenJsAttr(opt)}',this)">${escapeHtml(opt)}</button>`).join("")}
    </div>
  </div>`;
}

const SCHENGEN_SHOWIF_MAP = {
  "Your_current_country_of_residence": { field:"Do_you_live_outside_your_home_country", equals:"Yes" },

  // ── Purpose of visit ──
  "Please_describe_your_visit": { field:"What_is_the_purpose_of_your_visit", contains:"To Visit family" },
  "What_is_the_business_activity": { field:"What_is_the_purpose_of_your_visit", contains:"Business visit (Paid or Unpaid)" },
  "Please_describe_your_exact_purpose_of_visit": { field:"What_is_the_purpose_of_your_visit", contains:"Other" },
  "What_is_the_function": { field:"What_is_the_purpose_of_your_visit", contains:"To attend family function" },
  "Please_share_tell_us_about_the_function_you_re_planning_to_attend": { field:"What_is_the_purpose_of_your_visit", contains:"To attend family function" },
  "Please_share_details_of_convocation": { field:"What_is_the_purpose_of_your_visit", contains:"To attend convocation" },
  "Do_you_have_or_will_you_have_invitation_letter_for_your_visit": { anyOf:[
    { field:"What_is_the_purpose_of_your_visit", contains:"To Visit family" },
    { field:"What_is_the_purpose_of_your_visit", contains:"Business visit (Paid or Unpaid)" },
    { field:"What_is_the_purpose_of_your_visit", contains:"To attend family function" }
  ]},

  // ── Travel dates ──
  "When_will_you_depart": { field:"Have_you_decided_your_travel_dates", equals:"Yes" },
  "When_will_you_return": { field:"Have_you_decided_your_travel_dates", equals:"Yes" },
  "Have_you_booked_your_flight_tickets": { field:"Have_you_decided_your_travel_dates", equals:"Yes" },
  "Client_has_not_decided_travel_dates": { field:"Have_you_decided_your_travel_dates", equals:"No" },
  "Please_provide_tentative_month_and_year_of_travel": { field:"Have_you_decided_your_travel_dates", equals:"No" },
  "When_client_has_booked_flight_tickets": { field:"Have_you_booked_your_flight_tickets", equals:"Yes" },
  "Client_has_not_booked_flight_tickets": { field:"Have_you_booked_your_flight_tickets", equals:"No" },

  // ── Itinerary / hotel / insurance ──
  "Please_select_Schengen_country_you_will_arrive_first": { field:"Have_you_finalized_your_travel_itinerary_and_the_countries_you_plan_to_visit", equals:"Yes" },
  "Please_select_Schengen_country_you_will_stay_for_most_of_the_time": { field:"Have_you_finalized_your_travel_itinerary_and_the_countries_you_plan_to_visit", equals:"Yes" },
  "Client_has_finalized_travel_itinerary": { field:"Have_you_finalized_your_travel_itinerary_and_the_countries_you_plan_to_visit", equals:"Yes" },
  "Client_has_not_finalized_travel_itinerary1": { field:"Have_you_finalized_your_travel_itinerary_and_the_countries_you_plan_to_visit", equals:"No" },
  "When_client_has_finalized_the_hotel": { field:"Have_you_booked_your_hotel_accommodation", equals:"Yes" },
  "When_client_has_not_finalized_the_hotel": { field:"Have_you_booked_your_hotel_accommodation", equals:"No" },
  "When_client_has_purchased_insurance": { field:"Have_you_purchased_travel_insurance_for_your_trip", equals:"Yes" },
  "When_client_has_not_purchased_insurance": { field:"Have_you_purchased_travel_insurance_for_your_trip", equals:"No" },

  // ── Funding ──
  "What_will_your_inviter_sponsor_cover_during_your_trip": { field:"How_will_you_be_funding_your_trip", equals:"My Inviter" },
  "Name_of_sponsor": { field:"How_will_you_be_funding_your_trip", equals:"A Sponsor (Third party)" },
  "Your_relationship_with_sponsor": { field:"How_will_you_be_funding_your_trip", equals:"A Sponsor (Third party)" },
  "Occupation_of_Sponsor": { field:"How_will_you_be_funding_your_trip", equals:"A Sponsor (Third party)" },
  "Sponsor_s_annual_income": { field:"How_will_you_be_funding_your_trip", equals:"A Sponsor (Third party)" },

  // ── Applicant occupation (multiselect) ──
  "Name_of_the_current_organisation_you_work_for": { field:"What_is_your_current_occupation", contains:"Employed (Job)" },
  "What_is_your_designation_position_in_the_organisation": { field:"What_is_your_current_occupation", contains:"Employed (Job)" },
  "Address_of_the_organisation": { field:"What_is_your_current_occupation", contains:"Employed (Job)" },
  "What_is_your_present_annual_salary": { field:"What_is_your_current_occupation", contains:"Employed (Job)" },
  "Describe_your_day_to_day_work_as_a_self_employed_person": { field:"What_is_your_current_occupation", contains:"Self employed (Freelancer)" },
  "What_is_your_annual_turnover_of_freelancing_work": { field:"What_is_your_current_occupation", contains:"Self employed (Freelancer)" },
  "How_much_amount_you_earn_annually_from_freelancing_work": { field:"What_is_your_current_occupation", contains:"Self employed (Freelancer)" },
  "What_type_of_business_do_you_own": { field:"What_is_your_current_occupation", contains:"Business Owner" },
  "What_is_the_name_of_your_business": { field:"What_is_your_current_occupation", contains:"Business Owner" },
  "Please_provide_address_of_your_business": { field:"What_is_your_current_occupation", contains:"Business Owner" },
  "What_is_the_annual_turnover_of_your_business": { field:"What_is_your_current_occupation", contains:"Business Owner" },
  "How_much_amount_you_earn_annually_from_business": { field:"What_is_your_current_occupation", contains:"Business Owner" },
  "Please_tell_us_more_about_your_business_Industry_products_you_sell_what_activities_you_perform_etc": { field:"What_is_your_current_occupation", contains:"Business Owner" },
  "What_was_the_name_of_organisation_where_you_get_retired": { field:"What_is_your_current_occupation", contains:"Retired" },
  "What_was_your_last_designation_position_in_the_oganisation_you_get_retired": { field:"What_is_your_current_occupation", contains:"Retired" },
  "Do_you_currently_receive_pension": { field:"What_is_your_current_occupation", contains:"Retired" },
  "When_did_you_join_this_organisation": { field:"What_is_your_current_occupation", contains:"Retired" },
  "When_did_you_retire": { field:"What_is_your_current_occupation", contains:"Retired" },
  "What_is_the_name_of_the_institute_you_are_currently_studying_at": { field:"What_is_your_current_occupation", contains:"Student" },
  "What_is_name_of_program_course_grade_are_you_currently_studying": { field:"What_is_your_current_occupation", contains:"Student" },
  "Address_of_institute_you_are_currently_studying": { field:"What_is_your_current_occupation", contains:"Student" },
  "Please_describe_any_other_other_sources_of_income_employment_not_listed_above": { field:"What_is_your_current_occupation", contains:"Other" },
  "Do_your_ITRs_from_last_two_years_reflects_your_occupation": { field:"What_is_your_current_occupation", notContainsAny:["Student","Unemployed","Housewife"] },
  "What_is_your_personal_annual_income": { field:"What_is_your_current_occupation", notContainsAny:["Student","Unemployed","Housewife"] },
  "What_is_the_monthly_pension_amount": { field:"Do_you_currently_receive_pension", equals:"Yes" },

  // ── Assets / investments ──
  "Please_check_the_properties_you_own": { field:"Do_you_personally_own_any_fix_assets_properties", equals:"Yes" },
  "What_is_the_total_value_of_all_property_s_owned_by_you": { field:"Do_you_personally_own_any_fix_assets_properties", equals:"Yes" },
  "Please_provide_which_type_of_other_assets_do_you_have": { field:"Please_check_the_properties_you_own", equals:"Other" },
  "What_is_the_total_amount_of_investment_you_have_done": { allOf:[
    { field:"Please_check_your_investments", notEmpty:true },
    { field:"Please_check_your_investments", notContainsAny:["I do not have any investments"] }
  ]},
  "Please_provide_which_type_of_other_investments_do_you_have": { field:"Please_check_your_investments", contains:"Other" },

  // ── Travel history / Schengen visa history ──
  "Please_select_country_s_you_have_visited_in_past_10_years": { field:"Have_you_ever_visited_any_country_other_than_your_country_of_nationality", equals:"Yes" },
  "Please_provide_your_visa_number": { field:"Have_you_applied_for_a_Schengen_Visa_in_the_past_5_years", equals:"Yes" },
  "Visa_Sticker_No": { field:"Have_you_provided_fingerprints_for_any_Schengen_Visa_previously", equals:"Yes" },
  "Date_field": { field:"Have_you_provided_fingerprints_for_any_Schengen_Visa_previously", equals:"Yes" },
  "When_did_you_submitted_fingerprints_for_Schengen_Visa": { field:"Have_you_provided_fingerprints_for_any_Schengen_Visa_previously", equals:"Yes" },

  // ── Marital status / spouse / children top-level gates ──
  // NOTE: Family_member_living_in_home_country_Spouse had two different
  // trigger rules pasted (Married-only, and spouse-accompanying-only).
  // Implemented here as BOTH must be true — verify against the live form
  // and adjust to an anyOf if that's wrong.
  "Family_member_living_in_home_country_Spouse": { allOf:[
    { field:"Marital_Status", equals:"Married" },
    { field:"Do_your_spouse_accompanying_you_for_this_visit", equals:"Yes" }
  ]},
  "About_your_children": { field:"Marital_Status", in:["Married","Divorced","Widow/er","Separated"] },
  "Do_you_have_children": { field:"Marital_Status", in:["Married","Divorced","Widow/er","Separated"] },
  "Do_your_spouse_accompanying_you_for_this_visit": { field:"Marital_Status", equals:"Married" },
  "Add_details_of_child": { field:"Do_you_have_children", equals:"Yes" },

  // ── Spouse detail fields (shown when accompanying == Yes) ──
  "Your_spouse_s_Nationality": { field:"Do_your_spouse_accompanying_you_for_this_visit", equals:"Yes" },
  "Do_your_spouse_live_outside_your_home_country": { field:"Do_your_spouse_accompanying_you_for_this_visit", equals:"Yes" },
  "Spouse_s_email_id": { field:"Do_your_spouse_accompanying_you_for_this_visit", equals:"Yes" },
  "Spouse_s_Phone": { field:"Do_your_spouse_accompanying_you_for_this_visit", equals:"Yes" },
  "Please_select_employment_source_of_income_of_your_spouse": { field:"Do_your_spouse_accompanying_you_for_this_visit", equals:"Yes" },
  "Do_your_spouse_s_ITRs_from_last_two_years_reflects_your_occupation": { field:"Do_your_spouse_accompanying_you_for_this_visit", equals:"Yes" },
  "What_is_personal_income_of_your_spouse_in_a_year": { field:"Do_your_spouse_accompanying_you_for_this_visit", equals:"Yes" },
  "Have_your_spouse_ever_visited_country_other_than_their_country_of_nationality": { field:"Do_your_spouse_accompanying_you_for_this_visit", equals:"Yes" },
  "Have_your_spouse_applied_for_a_Schengen_Visa_in_the_past_5_years": { field:"Do_your_spouse_accompanying_you_for_this_visit", equals:"Yes" },
  "Have_your_spouse_provided_fingerprints_for_any_Schengen_Visa_previously": { field:"Do_your_spouse_accompanying_you_for_this_visit", equals:"Yes" },
  // Name_of_your_spouse_As_per_passport shows for BOTH accompanying Yes/No
  "Name_of_your_spouse_As_per_passport": { field:"Do_your_spouse_accompanying_you_for_this_visit", in:["Yes","No"] },
  // shown only when NOT accompanying
  "Spouse_s_date_of_birth": { field:"Do_your_spouse_accompanying_you_for_this_visit", equals:"No" },
  "Name_of_City_Town_Village_they_live": { field:"Do_your_spouse_accompanying_you_for_this_visit", equals:"No" },
  "In_which_country_they_live": { field:"Do_your_spouse_accompanying_you_for_this_visit", equals:"No" },
  "Current_occupation_of_your_spouse": { field:"Do_your_spouse_accompanying_you_for_this_visit", equals:"No" },

  "Your_spouse_s_current_country_of_residence": { field:"Do_your_spouse_live_outside_your_home_country", equals:"Yes" },
  "What_is_the_monthly_pension_amount_your_spouse_receives": { field:"Do_your_spouse_currently_receive_pension", equals:"Yes" },
  "When_did_your_spouse_submitted_fingerprints_for_Schengen_Visa": { field:"Have_your_spouse_provided_fingerprints_for_any_Schengen_Visa_previously", equals:"Yes" },
  "Please_select_country_s_your_spouse_visited_in_past_10_years": { field:"Have_your_spouse_ever_visited_country_other_than_their_country_of_nationality", equals:"Yes" },
  "Please_provide_your_spouse_s_visa_number": { field:"Have_your_spouse_applied_for_a_Schengen_Visa_in_the_past_5_years", equals:"Yes" },

  // ── Spouse occupation (multiselect, mirrors applicant's own) ──
  "Name_of_the_current_organisation_your_spouse_work_for": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Employed (Job)" },
  "What_is_your_spouse_s_designation_position_in_the_organisation": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Employed (Job)" },
  "Address_of_the_organisation_your_spouse_working_for1": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Employed (Job)" },
  "What_is_your_spouse_s_present_annual_salary": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Employed (Job)" },
  "Please_describe_What_do_your_spouse_exactly_do_as_self_employed_person": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Self employed (Freelancer)" },
  "How_much_amount_your_spouse_earn_annually_from_freelancing_work": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Self employed (Freelancer)" },
  "What_is_your_spouse_s_annual_turnover_of_feelancing_work": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Self employed (Freelancer)" },
  "What_type_of_business_do_your_spouse_own": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Business Owner" },
  "What_is_the_name_of_your_spouse_s_business": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Business Owner" },
  "Please_provide_address_of_your_spouse_s_business": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Business Owner" },
  "What_is_the_annual_turnover_of_your_spouse_s_business": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Business Owner" },
  "How_much_amount_you_spouse_earn_annually_from_business": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Business Owner" },
  "Please_tell_us_more_about_your_spouse_s_business_Industry_products_you_sell_what_activities_you_pe": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Business Owner" },
  "What_was_the_name_of_organisation_where_your_spouse_get_retired": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Retired" },
  "What_was_the_last_designation_position_in_the_oganisation_your_spouse_get_retired": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Retired" },
  "When_did_your_spouse_join_this_organisation": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Retired" },
  "When_did_your_spouse_retire": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Retired" },
  "Do_your_spouse_currently_receive_pension": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Retired" },
  "What_is_the_name_of_the_institute_your_spouse_is_currently_studying_at": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Student" },
  "What_is_name_of_program_course_grade_your_spouse_currently_studying": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Student" },
  "Address_of_institute_your_spouse_is_currently_studying": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Student" },
  "Please_describe_your_spouse_s_other_source_of_income_employment_which_is_not_listed_above": { field:"Please_select_employment_source_of_income_of_your_spouse", contains:"Other" }
};

// Same idea, but for fields INSIDE the "Add_details_of_child" subform rows —
// conditions are evaluated against that row's own data, not the top-level
// stage data.
const SCHENGEN_CHILD_SHOWIF_MAP = {
  "Date_of_Birth": { field:"Is_accompanying_you_during_this_visit", in:["Yes","No"] },
  "Are_they_attending_any_Pre_school_School_College": { field:"Is_accompanying_you_during_this_visit", in:["Yes","No"] },
  "Nationality": { field:"Is_accompanying_you_during_this_visit", equals:"Yes" },
  "Do_they_live_at_your_current_residence_address": { field:"Is_accompanying_you_during_this_visit", equals:"Yes" },
  "Phone_number1": { field:"Is_accompanying_you_during_this_visit", equals:"Yes" },
  "Email_Id": { field:"Is_accompanying_you_during_this_visit", equals:"Yes" },
  "Do_they_currently_reside_outside_their_country_of_nationality": { field:"Is_accompanying_you_during_this_visit", equals:"Yes" },
  "Have_your_child_ever_visited_country_other_than_their_country_of_nationality": { field:"Is_accompanying_you_during_this_visit", equals:"Yes" },
  "Have_your_child_applied_for_a_Schengen_Visa_in_the_past_5_years": { field:"Is_accompanying_you_during_this_visit", equals:"Yes" },
  "Address_they_currently_live": { field:"Do_they_live_at_your_current_residence_address", equals:"No" },
  "Which_country_do_they_live_currently": { field:"Do_they_currently_reside_outside_their_country_of_nationality", equals:"Yes" },
  "Name_of_the_program_course_grade_they_are_studying": { field:"Are_they_attending_any_Pre_school_School_College", equals:"Yes" },
  "Name_of_the_institute_your_child_is_currently_attending": { field:"Are_they_attending_any_Pre_school_School_College", equals:"Yes" },
  "Address_of_the_institute_they_are_attending": { field:"Are_they_attending_any_Pre_school_School_College", equals:"Yes" },
  "Please_select_country_s_your_child_visited_in_past_10_years": { field:"Have_your_child_ever_visited_country_other_than_their_country_of_nationality", equals:"Yes" },
  "Please_provide_your_child_s_visa_number": { field:"Have_your_child_applied_for_a_Schengen_Visa_in_the_past_5_years", equals:"Yes" },
  "When_did_your_child_submitted_fingerprints_for_Schengen_Visa": { field:"Have_your_child_provided_fingerprints_for_any_Schengen_Visa_previously", equals:"Yes" }
};

// Top-level visibility check — used exactly like cifUsFieldVisible etc.
function cifSchengenFieldVisible(instance, stage, data, fieldName) {
  if (instance?.type !== "schengen") return true;
  const condition = SCHENGEN_SHOWIF_MAP[fieldName];
  if (!condition) return true;
  return cifSchengenConditionMet(data, condition);
}

// Row-level visibility check for the Add_details_of_child subform — used
// exactly like cifUsSubformFieldVisible.
function cifSchengenSubformFieldVisible(instance, stage, parentFieldName, rowData, childFieldName) {
  if (instance?.type !== "schengen") return true;
  if (parentFieldName !== "Add_details_of_child") return true;
  const condition = SCHENGEN_CHILD_SHOWIF_MAP[childFieldName];
  if (!condition) return true;
  return cifSchengenConditionMet(rowData, condition);
}

// Dynamic funding options — Creator's own rule shrinks/grows the
// "How will you be funding your trip?" choice list based on purpose of
// visit (see ui.add(fundList) in the source script): "My Inviter" is only
// offered when the purpose includes family-visit, family-function, or
// convocation. Everyone always gets "Self-funded" and "A Sponsor (Third
// party)".
function cifSchengenFundingOptions(data) {
  const purpose = Array.isArray(data?.What_is_the_purpose_of_your_visit)
    ? data.What_is_the_purpose_of_your_visit
    : String(data?.What_is_the_purpose_of_your_visit || "").split(",").map(s => s.trim()).filter(Boolean);
  const includesInviterEligible = ["To Visit family", "To attend family function", "To attend convocation"].some(p => purpose.includes(p));
  return includesInviterEligible
    ? ["Self-funded", "My Inviter", "A Sponsor (Third party)"]
    : ["Self-funded", "A Sponsor (Third party)"];
}
    function cifGenericRenderField(travId, instance, stage, field, pathOverride) {
      const path = pathOverride || cifPath(travId, stage.tag, field.link_name, instance.id);
      const label = field.display_name || field.link_name;
      const choices = (field.choices || []).map(choice => String(choice.value ?? choice.key ?? ""));
      if (field.type === 21) return cifGenericRenderSubform(travId, instance, stage, field);
      if (field.type === 29 || field.type === 30) return cifGenericCompositeField(label, path, field);
      if (field.type === 2 || field.type === 4) return cifTextField(label, path, "textarea", field.mandatory);
      if (field.type === 10) return cifTextField(label, path, "date", field.mandatory);
      if (field.type === 11) return cifTextField(label, path, "datetime-local", field.mandatory);
      if ([5,6,7,8].includes(field.type)) return cifTextField(label, path, "number", field.mandatory);
      if (field.type === 27) return cifTextField(label, path, "tel", field.mandatory);
      if ([14,15].includes(field.type)) {
        if (CIF_COUNTRY_DROPDOWN_FIELDS.has(field.link_name)) return cifCountryMultiSelectField(label, path, choices, field.mandatory);
        if (instance?.type === "schengen") return cifSchengenMultiSelectField(label, path, choices, field.mandatory);
        return cifMultiSelectField(label, path, choices, field.mandatory);
      }
      if ([12,13].includes(field.type) && choices.length) {
  const effectiveChoices = (instance?.type === "schengen" && field.link_name === "How_will_you_be_funding_your_trip")
    ? cifSchengenFundingOptions(cifInstanceData(travId, instance.id)[stage.tag] || {})
    : choices;
  return cifSelectField(
    label,
    path,
    ["", ...effectiveChoices],
    field.mandatory,
    false,
    instance?.type === "usa" || instance?.type === "australia"
  );
}
      if (cifIsCountrySelectorField(field)) {
        return cifSelectField(label, path, cifCountryOptions(getByPath(applicationData, path)), field.mandatory, false, false);
      }
      return cifTextField(label, path, field.type === 3 ? "email" : "text", field.mandatory);
    }

    function cifGenericRows(travId, instance, stage, field) {
      const rows = getByPath(applicationData, cifPath(travId, stage.tag, field.link_name, instance.id));
      return Array.isArray(rows) ? rows : [];
    }

    function cifGenericAddRow(travId, instanceId, stageTag, fieldName) {
      const instance = cifGetInstance(instanceId);
      const stage = instance?.definition.stages.find(item => item.tag === stageTag);
      if (!instance || !stage) return;
      const path = cifPath(travId, stageTag, fieldName, instanceId);
      const rows = (getByPath(applicationData, path) || []).slice();
      rows.push({});
      setByPath(applicationData, path, rows);
      cifMarkInstanceDirtyFromPath(path);
      markAutoSavePending();
      renderCIF();
    }

    function cifGenericRemoveRow(travId, instanceId, stageTag, fieldName, index) {
      const path = cifPath(travId, stageTag, fieldName, instanceId);
      const rows = (getByPath(applicationData, path) || []).slice();
      rows.splice(index, 1);
      setByPath(applicationData, path, rows);
      cifMarkInstanceDirtyFromPath(path);
      markAutoSavePending();
      renderCIF();
    }

    function cifGenericRenderSubform(travId, instance, stage, field) {
      const rows = cifGenericRows(travId, instance, stage, field);
      const basePath = cifPath(travId, stage.tag, field.link_name, instance.id);
      return `<div class="cifx-field full"><label>${escapeHtml(field.display_name)}${field.mandatory ? ' <span class="req">*</span>' : ""}</label>
        ${rows.map((row, index) => `<div class="cifx-rep"><div class="cifx-rep-lbl">Entry ${index + 1}</div>
          <button type="button" class="cifx-rep-rm" onclick="cifGenericRemoveRow('${travId}','${instance.id}','${stage.tag}','${field.link_name}',${index})">&#x1F5D1;&#xFE0F; Remove</button>
          <div class="cifx-fg">${
  cifCustomerFields(field.fields)
    .filter(child =>
      cifAustraliaSubformFieldVisible(
        instance,
        stage,
        field.link_name,
        row,
        child.link_name
      ) &&
      cifUsSubformFieldVisible(
        instance,
        stage,
        field.link_name,
        row,
        child.link_name
      ) &&
      cifSchengenSubformFieldVisible(
        instance,
        stage,
        field.link_name,
        row,
        child.link_name
      )
    )
    .map(child =>
      cifGenericRenderField(
        travId,
        instance,
        stage,
        child,
        `${basePath}.${index}.${child.link_name}`
      )
    )
    .join("")
}</div>
        </div>`).join("")}
        <button type="button" class="cifx-add-btn" onclick="cifGenericAddRow('${travId}','${instance.id}','${stage.tag}','${field.link_name}')">&#x2795; Add ${escapeHtml(field.display_name)}</button>
      </div>`;
    }

    function cifSwitchStage(stageTag) {
      try {
        state.activeCifStage = stageTag;
        state.activeGenericCifCategory = null;
        renderCIF();
        qs("#stepCIF")?.scrollIntoView({ behavior:"smooth", block:"start" });
      } catch (e) {
        console.error("cifSwitchStage error:", e);
        toast(`Navigation error: ${e?.message || String(e)}`);
      }
    }

    function cifSwitchGenericCategory(categoryId) {
      state.activeGenericCifCategory = categoryId;
      renderCIF();
      qs("#stepCIF")?.scrollIntoView({ behavior:"smooth", block:"start" });
    }

    // Splits a flat field list into per-category groups using the type's
    // category config, preserving original field order within each group.
    // Falls back to a single implicit "All Fields" group when no category
    // config exists for this instance type yet (Australia/USA today).
    function cifGroupFieldsByCategory(instanceType, fields) {
      const config = GENERIC_CATEGORY_CONFIG[instanceType];
      if (!config) return null;
      const grouped = {};
      config.categories.forEach(cat => { grouped[cat.id] = []; });
      const unmapped = [];
      fields.forEach(field => {
        const catId = config.fieldMap[field.link_name];
        if (catId && grouped[catId]) grouped[catId].push(field);
        else unmapped.push(field);
      });
      return { grouped, unmapped, categories: config.categories };
    }

    function cifRetryMetadata() {
      const instance = cifGetInstance(state.activeCifInstance);
      (instance?.definition.stages || []).forEach(stage => {
        delete state.cifMetadata[stage.form];
        delete state.cifMetadataErrors[stage.form];
      });
      renderCIF();
    }

    function cifRenderGeneric(instances, instance) {
      const travellers = applicationData.deal.travellers;
      const travId = state.activeCifTraveller;
      const missing = instance.definition.stages.filter(stage => !state.cifMetadata[stage.form]);
      if (missing.length) {
        const error = missing.map(stage => state.cifMetadataErrors[stage.form]).find(Boolean);
        if (!error && !missing.some(stage => state.cifMetadataLoading[stage.form])) cifLoadInstanceMetadata(instance).then(renderCIF).catch(renderCIF);
        
        qs("#stepCIF").innerHTML = `<section class="wizard-panel"><div class="panel-head"><div><h3>${instance.definition.icon} ${escapeHtml(instance.country)} — ${escapeHtml(instance.definition.title)}</h3><p>Destination-specific customer information form.</p></div></div>
          <div class="panel-body">${cifRenderDestinationTabs(instances)}<div class="qn ${error ? "qn-amber" : "qn-blue"}">${error ? `Could not load the Zoho form: ${escapeHtml(error)}` : "Loading the latest form fields from Zoho Creator…"}</div>${error ? '<button class="btn" type="button" onclick="cifRetryMetadata()">Retry</button>' : ""}</div></section>`;
        return;
      }
      if (!state.activeCifStage || !instance.definition.stages.some(stage => stage.tag === state.activeCifStage)) state.activeCifStage = instance.definition.stages[0].tag;
      const stage = instance.definition.stages.find(
  item => item.tag === state.activeCifStage
);

const stageData =
  cifInstanceData(travId, instance.id)[stage.tag] || {};

const fields = cifCustomerFields(
  state.cifMetadata[stage.form]
).filter(field => cifGenericFieldVisible(instance, stage, stageData, field.link_name));

const traveller = travellers.find(t => t.id === travId);
      cifAutofillGenericTraveller(travId, instance, stage);
      const name = `${traveller?.firstName || ""} ${traveller?.lastName || ""}`.trim() || "Traveller";
      const progress = cifGenericProgress(travId, instance);
      const saved = cifIsInstanceSaved(travId, instance.id);
      const stageTabs = instance.definition.stages.map(item => `<button type="button" class="cifx-tabbtn ${item.tag === stage.tag ? "on" : ""}" onclick="cifSwitchStage('${item.tag}')">${escapeHtml(item.title)}</button>`).join("");

      const grouping = cifGroupFieldsByCategory(instance.type, fields);
      let categoryTabsHtml = "";
      let fieldsBodyHtml = "";

      if (grouping) {
        // Treat unmapped fields as a synthetic extra category — it only
        // appears as a tab (and only renders its fields) when there's
        // actually something unmapped, and only when it's the selected tab,
        // instead of being permanently glued to the bottom of every category.
        const hasUnmapped = grouping.unmapped.length > 0;
        const allTabs = hasUnmapped
          ? [...grouping.categories, { id:"__other__", title:"Other Fields", icon:"&#x2753;" }]
          : grouping.categories;

        if (!state.activeGenericCifCategory || !allTabs.some(c => c.id === state.activeGenericCifCategory)) {
          state.activeGenericCifCategory = allTabs[0].id;
        }

        categoryTabsHtml = `<div class="cifx-cattabs">${allTabs.map(cat => {
          const catFields = cat.id === "__other__" ? grouping.unmapped : (grouping.grouped[cat.id] || []);
          const filled = catFields.filter(field => {
            const value = (cifInstanceData(travId, instance.id)[stage.tag] || {})[field.link_name];
            if (Array.isArray(value)) return value.length > 0;
            if (value && typeof value === "object") return Object.values(value).some(v => String(v || "").trim());
            return value !== undefined && value !== null && String(value).trim() !== "";
          }).length;
          const pct = catFields.length ? Math.round((filled / catFields.length) * 100) : 0;
          const active = cat.id === state.activeGenericCifCategory;
          return `<button type="button" class="cifx-tabbtn ${active ? "on" : ""}" onclick="cifSwitchGenericCategory('${cat.id}')">${cat.icon} ${escapeHtml(cat.title)} <span class="badge">${pct}%</span></button>`;
        }).join("")}</div>`;

        const activeCatFields = state.activeGenericCifCategory === "__other__" ? grouping.unmapped : (grouping.grouped[state.activeGenericCifCategory] || []);
        const activeCat = allTabs.find(c => c.id === state.activeGenericCifCategory);
        fieldsBodyHtml = `<div class="cifx-card cifx-cb"><div class="cifx-card-top"><div><strong>${activeCat.icon} ${escapeHtml(activeCat.title)}</strong></div><span class="cifx-pill cifx-p-blue">${activeCatFields.length} fields</span></div>
            <div class="cifx-fg">${activeCatFields.map(field => cifGenericRenderField(travId, instance, stage, field)).join("")}</div></div>`;
      } else {
        // No category config for this instance type yet (Australia/USA) —
        // fall back to the original flat single-card layout, unchanged.
        fieldsBodyHtml = `<div class="cifx-card cifx-cb"><div class="cifx-card-top"><div><strong>${escapeHtml(stage.title)}</strong></div><span class="cifx-pill cifx-p-blue">${fields.length} fields</span></div>
            <div class="cifx-fg">${fields.map(field => cifGenericRenderField(travId, instance, stage, field)).join("")}</div></div>`;
      }

      // Prev/next category navigation — rendered when this instance type has
      // category grouping (currently just Schengen).
      let categoryNavHtml = "";
      if (grouping) {
        const allNavTabs = grouping.unmapped.length
          ? [...grouping.categories, { id:"__other__", title:"Other Fields" }]
          : grouping.categories;
        const idx = allNavTabs.findIndex(c => c.id === state.activeGenericCifCategory);
        const prevCat = allNavTabs[idx - 1];
        const nextCat = allNavTabs[idx + 1];
        categoryNavHtml = `<div style="display:flex;justify-content:space-between;gap:10px;margin-top:16px;padding-top:16px;border-top:1px solid var(--cx-line)">
          ${prevCat ? `<button class="btn" type="button" onclick="cifSwitchGenericCategory('${prevCat.id}')">&larr; ${escapeHtml(prevCat.title)}</button>` : "<span></span>"}
          ${nextCat ? `<button class="btn primary" type="button" onclick="cifSwitchGenericCategory('${nextCat.id}')">${escapeHtml(nextCat.title)} &rarr;</button>` : "<span></span>"}
        </div>`;
      }

      // Prev/next stage navigation for forms with multiple stages (USA / Australia)
      // that don't use category grouping — gives the same bottom-nav UX as UK CIF.
      let stageNavHtml = "";
      if (!grouping && instance.definition.stages.length > 1) {
        const stageIdx = instance.definition.stages.findIndex(s => s.tag === state.activeCifStage);
        const prevStage = instance.definition.stages[stageIdx - 1];
        const nextStage = instance.definition.stages[stageIdx + 1];
        stageNavHtml = `<div style="display:flex;justify-content:space-between;gap:10px;margin-top:16px;padding-top:16px;border-top:1px solid var(--cx-line)">
          ${prevStage ? `<button class="btn" type="button" onclick="cifSwitchStage('${prevStage.tag}')">&larr; ${escapeHtml(prevStage.title)}</button>` : "<span></span>"}
          ${nextStage ? `<button class="btn primary" type="button" onclick="cifSwitchStage('${nextStage.tag}')">${escapeHtml(nextStage.title)} &rarr;</button>` : "<span></span>"}
        </div>`;
      }

      qs("#stepCIF").innerHTML = `<section class="wizard-panel"><div class="panel-head"><div><h3>${instance.definition.icon} ${escapeHtml(instance.country)} — ${escapeHtml(instance.definition.title)}</h3><p>Complete and save this destination form separately for every traveller.</p></div></div>
        <div class="panel-body">${cifRenderDestinationTabs(instances)}${cifRenderOverview(instance)}
          <div class="cifx-info-b">&#x2139;&#xFE0F; Answering for <strong>${escapeHtml(name)}</strong> — ${progress}% complete${saved ? ' · <strong style="color:var(--cx-green)">&#x2713; Saved to Zoho</strong>' : ""}.</div>
          ${instance.definition.stages.length > 1 ? `<div class="cifx-cattabs">${stageTabs}</div>` : ""}
          ${categoryTabsHtml}
          <div class="cifx-stack">${fieldsBodyHtml}</div>
          ${categoryNavHtml}${stageNavHtml}
          <div style="margin-top:20px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn primary" type="button" onclick="cifSaveTraveller('${travId}')" ${state.cifSaving ? "disabled" : ""}>${state.cifSaving ? "Saving…" : (saved ? "↻ Update this CIF" : "💾 Save this CIF")}</button>
            <small style="color:var(--cx-muted)">${travellers.filter(t => cifIsInstanceSaved(t.id, instance.id)).length} of ${travellers.length} travellers saved for ${escapeHtml(instance.country)}</small></div>
        </div></section>`;
    }

    function renderCIF() {
      const travellers = applicationData.deal.travellers;
      if (!travellers.length) {
        qs("#stepCIF").innerHTML = `<section class="wizard-panel"><div class="panel-body"><div class="qn qn-amber">No travellers found — go back to Step 1 to add travellers before filling the CIF.</div></div></section>`;
        return;
      }
      cifEnsureDataModel();
      const instances = cifDestinationInstances();
      if (!instances.length) {
        qs("#stepCIF").innerHTML = `<section class="wizard-panel"><div class="panel-body"><div class="qn qn-amber">No destination countries were selected. Return to the questionnaire and select at least one country.</div></div></section>`;
        return;
      }
      if (!state.activeCifTraveller || !travellers.some(t => t.id === state.activeCifTraveller)) state.activeCifTraveller = travellers[0].id;
      const instance = cifGetInstance(state.activeCifInstance);
      if (instance.type !== "uk") {
        cifRenderGeneric(instances, instance);
        return;
      }
      renderUKCIF(instances, instance);
    }

    function renderUKCIF(instances, instance) {
      const travellers = applicationData.deal.travellers;
      if (!travellers.length) {
        qs("#stepCIF").innerHTML = `<section class="wizard-panel"><div class="panel-body">
          <div class="qn qn-amber">No travellers found — go back to Step 1 to add travellers before filling the CIF.</div>
        </div></section>`;
        return;
      }
      if (!state.activeCifTraveller || !travellers.find(t => t.id === state.activeCifTraveller)) {
        state.activeCifTraveller = travellers[0].id;
      }
      const travId = state.activeCifTraveller;
      cifAutofillTraveller(travId);
      if (!state.activeCifCategory || !CIF_CATEGORIES.find(c => c.id === state.activeCifCategory)) {
        state.activeCifCategory = CIF_CATEGORIES[0].id;
      }
      const category = CIF_CATEGORIES.find(c => c.id === state.activeCifCategory);
      const traveller = travellers.find(t => t.id === travId);
      const travName = `${traveller?.firstName || ""} ${traveller?.lastName || ""}`.trim() || "Traveller";
      const overallPct = cifOverallProgress(travId);

      const catTabsHtml = CIF_CATEGORIES.map(c => {
        const pct = cifCategoryProgress(travId, c);
        return `<button type="button" class="cifx-tabbtn ${c.id === state.activeCifCategory ? "on" : ""}" onclick="cifSwitchCategory('${c.id}')">${c.icon} ${escapeHtml(c.title)} <span class="badge">${pct}%</span></button>`;
      }).join("");

      const sectionsHtml = category.sections.map(sectionId => {
        const section = CIF_UK_SECTIONS.find(s => s.id === sectionId);
        if (!section) return "";
        if (!cifShowIfMet(travId, section.showIf)) return "";
        const progress = cifSectionProgress(travId, section);
        const pillClass = progress === 100 ? "cifx-p-green" : progress > 0 ? "cifx-p-amber" : "cifx-p-blue";
        const body = section.subform ? cifRenderSubformSection(travId, section) : `<div class="cifx-fg">${section.fields.map(def => cifRenderField(travId, def)).join("")}</div>`;
        return `<div class="cifx-card cifx-cb">
          <div class="cifx-card-top">
            <div><strong>${section.icon} ${escapeHtml(section.title)}</strong></div>
            <span class="cifx-pill ${pillClass}">${progress}%</span>
          </div>
          ${body}
        </div>`;
      }).join("");

      qs("#stepCIF").innerHTML = `
        <section class="wizard-panel">
          <div class="panel-head"><div><h3>${instance.definition.icon} ${escapeHtml(instance.country)} — ${escapeHtml(instance.definition.title)}</h3><p>Complete a full CIF for each traveller. Save each person separately — one traveller's progress never blocks another's.</p></div></div>
          <div class="panel-body">
            ${cifRenderDestinationTabs(instances)}
            ${cifRenderOverview(instance)}
            <div class="cifx-info-b">&#x2139;&#xFE0F; Answering for <strong>${escapeHtml(travName)}</strong> — ${overallPct}% complete${cifIsInstanceSaved(travId, instance.id) ? ' · <strong style="color:var(--cx-green)">&#x2713; Saved to Zoho</strong>' : ""}. Switch categories below — every section stays filled in as you move between them.</div>
            <div class="cifx-cattabs">${catTabsHtml}</div>
            <div class="cifx-stack">${sectionsHtml}</div>
            ${(() => {
              const idx = CIF_CATEGORIES.findIndex(c => c.id === state.activeCifCategory);
              const prevCat = CIF_CATEGORIES[idx - 1];
              const nextCat = CIF_CATEGORIES[idx + 1];
              return `<div style="display:flex;justify-content:space-between;gap:10px;margin-top:16px;padding-top:16px;border-top:1px solid var(--cx-line)">
                ${prevCat ? `<button class="btn" type="button" onclick="cifGoToCategoryOffset(-1)">&larr; ${escapeHtml(prevCat.title)}</button>` : "<span></span>"}
                ${nextCat ? `<button class="btn primary" type="button" onclick="cifGoToCategoryOffset(1)">${escapeHtml(nextCat.title)} &rarr;</button>` : "<span></span>"}
              </div>`;
            })()}
            <div style="margin-top:20px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
  <button class="btn primary" type="button" onclick="cifSaveTraveller('${travId}')" ${state.cifSaving === travId ? "disabled" : ""}>
    ${state.cifSaving === travId ? "Saving…" : (cifIsInstanceSaved(travId, instance.id) ? "&#x21BA; Update this traveller's CIF" : "&#x1F4BE; Save this traveller's CIF")}
  </button>
  <small style="color:var(--cx-muted)">${travellers.filter(t => cifIsInstanceSaved(t.id, instance.id)).length} of ${travellers.length} travellers saved for ${escapeHtml(instance.country)}</small>
</div>
          </div>
        </section>`;
    }

    function cifIsTravellerSaved(travId) {
      const instances = cifDestinationInstances();
      return Boolean(instances.length && instances.every(instance => cifIsInstanceSaved(travId, instance.id)));
    }

    function cifClearValidationHighlights() {
  const cifRoot = qs("#stepCIF");
  if (!cifRoot) return;

  cifRoot.querySelectorAll(".cifx-field.invalid").forEach((wrapper) => {
    wrapper.classList.remove("invalid");
  });

  cifRoot.querySelectorAll(".cifx-err").forEach((error) => {
    error.textContent = "";
  });
}
function cifFieldIsEmpty(value, ftype) {
  if (ftype === "address") {
    if (!value || typeof value !== "object") return true;
    return !["address_line_1", "district_city", "country"].some(k => String(value[k] || "").trim());
  }
  if (ftype === "multiselect") {
    if (!value) return true;
    if (typeof value === "string") return !value.split(",").map(s => s.trim()).filter(Boolean).length;
    return !Array.isArray(value) || !value.length;
  }
  return value === undefined || value === null || String(value).trim() === "";
}

function cifGetMissingRequiredFields(travId, instanceId) {
  const missing = [];
  CIF_CATEGORIES.forEach(category => {
    category.sections.forEach(sectionId => {
      const section = CIF_UK_SECTIONS.find(s => s.id === sectionId);
      if (!section || section.subform) return;
      if (!cifShowIfMet(travId, section.showIf, instanceId)) return;
      section.fields.forEach(def => {
        const [label, form, key, ftype, , req, showIf] = def;
        if (!req) return;
        if (!cifShowIfMet(travId, showIf, instanceId)) return;
        const path = cifPath(travId, form, key, instanceId);
        const value = getByPath(applicationData, path);
        if (cifFieldIsEmpty(value, ftype)) {
          missing.push({ categoryId: category.id, sectionId: section.id, label, path });
        }
      });
    });
  });
  return missing;
}

function cifHighlightMissingFields(missing) {
  let firstEl = null;
  missing.forEach(item => {
    const el = document.querySelector(`[data-field="${item.path}"]`);
    if (el) {
      el.classList.add("invalid");
      if (!firstEl) firstEl = el;
    }
  });
  if (firstEl) firstEl.scrollIntoView({ behavior: "smooth", block: "center" });
}
function cifDaysToMs(days) {
  return Number(days || 0) * 24 * 60 * 60 * 1000;
}

function cifGetTravelDateRanges(travId, instanceId) {
  const ranges = [];

  const ukVisits = getByPath(applicationData, cifPath(travId, "f3", "Your_most_recent_time_in_the_UK", instanceId)) || [];
  ukVisits.forEach((row, i) => {
    const entry = row.Date_you_arrived_in_the_UK;
    const days = Number(row.How_long_were_you_in_the_UK_Number_of_Days || 0);
    if (!entry || !days) return;
    const entryDate = new Date(entry);
    if (isNaN(entryDate.getTime())) return;
    const exitDate = new Date(entryDate.getTime() + cifDaysToMs(days));
    ranges.push({
      label: `UK visit (Entry ${i + 1})`,
      entry: entryDate, exit: exitDate,
      paths: [
        cifPath(travId, "f3", `Your_most_recent_time_in_the_UK.${i}.Date_you_arrived_in_the_UK`, instanceId),
        cifPath(travId, "f3", `Your_most_recent_time_in_the_UK.${i}.How_long_were_you_in_the_UK_Number_of_Days`, instanceId)
      ]
    });
  });

  const timesVisited = getByPath(applicationData, cifPath(travId, "f3", "How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo", instanceId));
  if (timesVisited && timesVisited !== "Zero") {
    const mrCountry = getByPath(applicationData, cifPath(travId, "f3", "Which_country_did_you_visit_most_recently", instanceId));
    const mrStart = getByPath(applicationData, cifPath(travId, "f3", "Date_of_your_most_recent_visit", instanceId));
    const mrEnd = getByPath(applicationData, cifPath(travId, "f3", "End_date_of_your_most_recent_visit", instanceId));
    if (mrStart && mrEnd) {
      const s = new Date(mrStart), e = new Date(mrEnd);
      if (!isNaN(s.getTime()) && !isNaN(e.getTime())) {
        ranges.push({
          label: `Most recent visit (${mrCountry || "country"})`,
          entry: s, exit: e,
          paths: [
            cifPath(travId, "f3", "Date_of_your_most_recent_visit", instanceId),
            cifPath(travId, "f3", "End_date_of_your_most_recent_visit", instanceId)
          ]
        });
      }
    }
    if (timesVisited === "2 to 5 times" || timesVisited === "6 or more times") {
      const srCountry = getByPath(applicationData, cifPath(travId, "f3", "Which_second_country_did_you_visit_recently", instanceId));
      const srStart = getByPath(applicationData, cifPath(travId, "f3", "Date_of_your_second_recent_visit", instanceId));
      const srEnd = getByPath(applicationData, cifPath(travId, "f3", "End_date_of_your_second_recent_visit", instanceId));
      if (srStart && srEnd) {
        const s = new Date(srStart), e = new Date(srEnd);
        if (!isNaN(s.getTime()) && !isNaN(e.getTime())) {
          ranges.push({
            label: `Second recent visit (${srCountry || "country"})`,
            entry: s, exit: e,
            paths: [
              cifPath(travId, "f3", "Date_of_your_second_recent_visit", instanceId),
              cifPath(travId, "f3", "End_date_of_your_second_recent_visit", instanceId)
            ]
          });
        }
      }
    }
  }

  const worldTravel = getByPath(applicationData, cifPath(travId, "f3", "World_travel_history", instanceId)) || [];
  worldTravel.forEach((row, i) => {
    const country = row.Which_country_did_you_visit;
    const entry = row.When_did_you_enter_this_country;
    const exit = row.When_did_you_leave_this_country;
    if (!entry || !exit) return;
    const s = new Date(entry), e = new Date(exit);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return;
    ranges.push({
      label: `World travel (${country || "Entry " + (i + 1)})`,
      entry: s, exit: e,
      paths: [
        cifPath(travId, "f3", `World_travel_history.${i}.When_did_you_enter_this_country`, instanceId),
        cifPath(travId, "f3", `World_travel_history.${i}.When_did_you_leave_this_country`, instanceId)
      ]
    });
  });

  return ranges;
}

function cifFindOverlappingTravelDates(travId, instanceId) {
  const ranges = cifGetTravelDateRanges(travId, instanceId);
  const overlaps = [];
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i], b = ranges[j];
      if (a.entry <= b.exit && b.entry <= a.exit) overlaps.push([a, b]);
    }
  }
  return overlaps;
}

function cifHighlightOverlappingTravelDates(overlaps) {
  let firstEl = null;
  overlaps.forEach(([a, b]) => {
    [...a.paths, ...b.paths].forEach(path => {
      const el = document.querySelector(`[data-field="${path}"]`);
      if (el) {
        el.classList.add("invalid");
        if (!firstEl) firstEl = el;
      }
    });
  });
  if (firstEl) firstEl.scrollIntoView({ behavior: "smooth", block: "center" });
}
// Checks whether "Date you plan to arrive in the UK" OR "Date you plan to
// leave the UK" has been set to a date before today. Both are
// forward-looking fields by definition — a visa application describing a
// trip that's already over shouldn't be treated as a valid "planned" visit.
function cifCheckPlannedArrivalNotInPast(travId, instanceId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const checks = [
    { key: "Date_you_plan_to_arrive_in_the_UK", label: "Date you plan to arrive in the UK" },
    { key: "Date_you_plan_to_leave_the_UK", label: "Date you plan to leave the UK" }
  ];

  for (const { key, label } of checks) {
    const path = cifPath(travId, "f1", key, instanceId);
    const value = getByPath(applicationData, path);
    if (!value) continue;
    const date = new Date(value);
    if (isNaN(date.getTime())) continue;
    date.setHours(0, 0, 0, 0);
    if (date < today) {
      return { path, label };
    }
  }
  return null;
}
// Checks every row in "Your Most Recent Times in the UK" — this subform
// documents trips that have already happened, so an arrival date of today
// or later contradicts that (it would describe a visit that hasn't started
// yet, not completed past travel).
function cifCheckPastUkVisitsNotInFuture(travId, instanceId) {
  const rows = getByPath(applicationData, cifPath(travId, "f3", "Your_most_recent_time_in_the_UK", instanceId)) || [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < rows.length; i++) {
    const entry = rows[i].Date_you_arrived_in_the_UK;
    if (!entry) continue;
    const arrival = new Date(entry);
    if (isNaN(arrival.getTime())) continue;
    arrival.setHours(0, 0, 0, 0);
    if (arrival >= today) {
      return {
        path: cifPath(travId, "f3", `Your_most_recent_time_in_the_UK.${i}.Date_you_arrived_in_the_UK`, instanceId),
        label: `Your Most Recent Times in the UK — Entry ${i + 1} date arrived`
      };
    }
  }
  return null;
}
// Runs every UK CIF save-time check and returns one combined list of
// issues, instead of stopping at the first failure. Each issue carries
// enough info to jump to the right category and highlight the right
// field(s).
function cifRunAllUkValidations(travId, instanceId) {
  const issues = [];

  cifGetMissingRequiredFields(travId, instanceId).forEach(m => {
    issues.push({ categoryId: m.categoryId, paths: [m.path], message: `Required field: "${m.label}"` });
  });

  cifFindOverlappingTravelDates(travId, instanceId).forEach(([a, b]) => {
    issues.push({ categoryId: "history_cat", paths: [...a.paths, ...b.paths], message: `Travel dates overlap: "${a.label}" and "${b.label}" cover the same period — you can't be in two countries at once.` });
  });

  const pastArrival = cifCheckPlannedArrivalNotInPast(travId, instanceId);
  if (pastArrival) issues.push({ categoryId: "trip_cat", paths: [pastArrival.path], message: `"${pastArrival.label}" cannot be in the past.` });

  const futurePastVisit = cifCheckPastUkVisitsNotInFuture(travId, instanceId);
  if (futurePastVisit) issues.push({ categoryId: "history_cat", paths: [futurePastVisit.path], message: `"${futurePastVisit.label}" cannot be today or in the future — this section is for trips that have already happened.` });

  return issues;
}

// Highlights every field involved in every issue at once (not just the
// first one), and jumps to the first issue's field so the person lands
// somewhere useful.
function cifHighlightAllIssues(issues) {
  let firstEl = null;
  issues.forEach(issue => {
    issue.paths.forEach(path => {
      const el = document.querySelector(`[data-field="${path}"]`);
      if (el) {
        el.classList.add("invalid");
        if (!firstEl) firstEl = el;
      }
    });
  });
  if (firstEl) firstEl.scrollIntoView({ behavior: "smooth", block: "center" });
}

// Shows every collected issue in one modal, using the existing
// modal component already in this widget (openModal/#modalBackdrop),
// instead of a sequence of separate toasts.
function cifShowValidationSummary(issues) {
  const listHtml = issues.map(issue => `<li style="margin-bottom:8px;line-height:1.5">${escapeHtml(issue.message)}</li>`).join("");
  const title = `${issues.length} issue${issues.length > 1 ? "s" : ""} to fix before saving`;
  // openModal goes through React state so the Close button works correctly.
  // Modal.jsx renders modal.body via dangerouslySetInnerHTML for text-kind modals.
  openModal(title, `<ul style="margin:0;padding-left:20px">${listHtml}</ul>`);
}

function cifGetInvalidBirthDateIssues(travId, instanceId) {
  const pathPrefix = `cifData.${travId}.instances.${instanceId}.`;
  return [...cifBirthDateFields.entries()]
    .filter(([path]) => path.startsWith(pathPrefix))
    .map(([path, label]) => ({ path, label, message: validators.birthDate(getByPath(applicationData, path)) }))
    .filter(issue => Boolean(issue.message))
    .map(issue => ({
      paths: [issue.path],
      message: `${issue.label}: ${issue.message}.`
    }));
}

// Checks UK CIF passport and visit dates for past/future constraints.
// UK CIF uses hardcoded field definitions so Zoho metadata is not available;
// these checks must be done explicitly by field name.
function cifGetUkDateIssues(travId, instanceId) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const issues = [];

  const f1 = cifInstanceData(travId, instanceId)["f1"] || {};
  const f3 = cifInstanceData(travId, instanceId)["f3"] || {};

  const checkPast = (value, form, key, label) => {
    if (!value) return;
    const d = new Date(`${value}T00:00:00`);
    if (Number.isNaN(d.getTime())) return;
    if (d >= today) issues.push({
      paths: [cifPath(travId, form, key, instanceId)],
      message: `${label}: this date must be in the past.`
    });
  };

  const checkFuture = (value, form, key, label) => {
    if (!value) return;
    const d = new Date(`${value}T00:00:00`);
    if (Number.isNaN(d.getTime())) return;
    if (d <= today) issues.push({
      paths: [cifPath(travId, form, key, instanceId)],
      message: `${label}: passport has expired — expiry date must be in the future.`
    });
  };

  // Primary passport
  checkPast(f1.Passport_issue_date_Your_passport, "f1", "Passport_issue_date_Your_passport", "Passport Issue Date");
  checkFuture(f1.Passport_expiry_date_Your_passport, "f1", "Passport_expiry_date_Your_passport", "Passport Expiry Date");

  // Other nationality passport (only when applicable)
  if (f1.Can_you_provide_a_valid_passport_for_your_other_nationality === "Yes") {
    checkPast(f1.Passport_issue_date_Other_nationality, "f1", "Passport_issue_date_Other_nationality", "Other Nationality Passport Issue Date");
    checkFuture(f1.Passport_expiry_date_Other_nationality, "f1", "Passport_expiry_date_Other_nationality", "Other Nationality Passport Expiry Date");
  }

  // Most recent visit dates (only when visits ≠ Zero)
  const timesVisited = f3.How_many_times_have_you_visited_Australia_Canada_New_Zealand_USA_Switzerland_or_the_European_Econo;
  if (timesVisited && timesVisited !== "Zero") {
    checkPast(f3.Date_of_your_most_recent_visit, "f3", "Date_of_your_most_recent_visit", "Most Recent Visit — Start Date");
    checkPast(f3.End_date_of_your_most_recent_visit, "f3", "End_date_of_your_most_recent_visit", "Most Recent Visit — End Date");
    if (timesVisited === "2 to 5 times" || timesVisited === "6 or more times") {
      checkPast(f3.Date_of_your_second_recent_visit, "f3", "Date_of_your_second_recent_visit", "Second Recent Visit — Start Date");
      checkPast(f3.End_date_of_your_second_recent_visit, "f3", "End_date_of_your_second_recent_visit", "Second Recent Visit — End Date");
    }
  }

  // UK visit subform rows
  const ukVisits = f3.Your_most_recent_time_in_the_UK || [];
  ukVisits.forEach((row, i) => {
    if (!row.Date_you_arrived_in_the_UK) return;
    const d = new Date(`${row.Date_you_arrived_in_the_UK}T00:00:00`);
    if (Number.isNaN(d.getTime())) return;
    if (d >= today) issues.push({
      paths: [cifPath(travId, "f3", `Your_most_recent_time_in_the_UK.${i}.Date_you_arrived_in_the_UK`, instanceId)],
      message: `UK Visit ${i + 1} — Arrival Date: this date must be in the past.`
    });
  });

  return issues;
}

// Scans all filled fields across all stages for format errors (email, phone,
// passport, postal). Birth dates are handled separately via cifGetInvalidBirthDateIssues.
function cifGetFormatIssues(travId, instance) {
  const issues = [];
  for (const stage of instance.definition.stages) {
    const metadata = state.cifMetadata[stage.form];
    if (!metadata) continue;
    const data = cifInstanceData(travId, instance.id)[stage.tag] || {};
    cifCustomerFields(metadata).forEach(field => {
      const kind = classifyFieldValidation(field.link_name);
      if (!kind || kind === "birthDate") return;
      const value = data[field.link_name];
      if (!value) return;
      const msg = validators[kind](value);
      if (msg) {
        issues.push({
          paths: [cifPath(travId, stage.tag, field.link_name, instance.id)],
          message: `${stage.title} — ${field.display_name}: ${msg}`
        });
      }
    });
  }
  return issues;
}

// Collects ALL validation issues for a generic CIF instance (US/Schengen/Australia)
// instead of stopping at the first one. Each stage contributes:
//   • every missing mandatory field
//   • the first conditional rule failure from that stage's dedicated validator
function cifRunAllGenericValidations(travId, instance) {
  const issues = [];
  for (const stage of instance.definition.stages) {
    const metadata = state.cifMetadata[stage.form];
    if (!metadata) continue;
    const data = cifInstanceData(travId, instance.id)[stage.tag] || {};
    const fields = cifCustomerFields(metadata);

    // Missing required fields
    fields
      .filter(field => {
        if (!cifGenericFieldVisible(instance, stage, data, field.link_name)) return false;
        if (!field.mandatory) return false;
        const value = data[field.link_name];
        if (Array.isArray(value)) return !value.length;
        if (value && typeof value === "object") return !Object.values(value).some(v => String(v || "").trim());
        return value === undefined || value === null || String(value).trim() === "";
      })
      .forEach(field => {
        issues.push({
          paths: [cifPath(travId, stage.tag, field.link_name, instance.id)],
          message: `${stage.title}: Required field — "${field.display_name}"`
        });
      });

    // Conditional rule validation (first error per stage from dedicated validator)
    let conditionalError = null;
    if (instance.type === "usa") {
      if (stage.form === "Us_Form_1") conditionalError = cifValidateUsForm1(data);
      else if (stage.form === "Us_Form_2") conditionalError = cifValidateUsForm2(data);
      else if (stage.form === "Us_Form_3") conditionalError = cifValidateUsForm3(data);
      else if (stage.form === "Us_Form_4") conditionalError = cifValidateUsForm4(data);
    } else if (instance.type === "australia") {
      if (stage.form === "Australia_Customer_Information") conditionalError = cifValidateAustraliaForm1(data);
      else if (stage.form === "Australia_Customer_Information_3") conditionalError = cifValidateAustraliaForm3(data);
    } else if (instance.type === "schengen") {
      state.__schengenValidationField = null;
      conditionalError = cifValidateSchengen(data);
    }
    if (conditionalError) {
      const failedField = instance.type === "schengen" ? state.__schengenValidationField : null;
      issues.push({
        paths: failedField ? [cifPath(travId, stage.tag, failedField, instance.id)] : [],
        message: `${stage.title}: ${conditionalError}`
      });
    }
  }
  return issues;
}

async function cifSaveTraveller(travId) {
  try {
      const t = applicationData.deal.travellers.find(x => x.id === travId);
      const name = t ? `${t.firstName || ""} ${t.lastName || ""}`.trim() : "this traveller";
      const instance = cifGetInstance(state.activeCifInstance);

      if (instance && instance.type === "uk") {
        const issues = [
          ...cifGetInvalidBirthDateIssues(travId, instance.id),
          ...cifGetUkDateIssues(travId, instance.id),
          ...cifRunAllUkValidations(travId, instance.id),
        ];
        if (issues.length) {
          cifClearValidationHighlights();
          state.activeCifCategory = issues[0].categoryId || state.activeCifCategory;
          renderCIF();
          setTimeout(() => cifHighlightAllIssues(issues), 60);
          cifShowValidationSummary(issues);
          return;
        }
      }

      if (instance && instance.type !== "uk") {
        let issues = [];
        try {
          issues = [
            ...cifGetInvalidBirthDateIssues(travId, instance.id),
            ...cifGetFormatIssues(travId, instance),
            ...cifRunAllGenericValidations(travId, instance),
          ];
        } catch (validationErr) {
          console.error("CIF validation error:", validationErr);
        }
        if (issues.length) {
          cifClearValidationHighlights();
          renderCIF();
          setTimeout(() => cifHighlightAllIssues(issues), 60);
          cifShowValidationSummary(issues);
          return;
        }
      }

      cifClearValidationHighlights();
      state.cifSaving = travId;
      renderCIF();
      try {
               await saveCIFDataForTraveller(travId, instance.id);

        // Persist the Creator CIF record IDs so they survive refresh and
        // future saves update the same records — but skip this once the
        // application is already fully paid. The CRM's own Deluge workflow
        // deliberately blocks traveller/service re-sync on paid applications
        // (by design, to prevent billed applications from being altered),
        // so calling it here would only ever fail and produce a misleading
        // "could not save the CIF" toast even though the CIF itself saved.
        if (!isFullyPaidStatus(applicationData.payment.status)) {
          await saveDealData({
            syncOnly: true
          });
        }
        saveDraft(false);
        toast(`${name}'s ${instance.country} CIF saved ✓`);
      } catch (error) {
        toast(`Could not save ${name}'s CIF: ${error?.message || String(error)}`);
      } finally {
        state.cifSaving = null;
        renderCIF();
      }
  } catch (outerErr) {
    console.error("cifSaveTraveller unexpected error:", outerErr);
    toast(`Save failed: ${outerErr?.message || String(outerErr)}`);
    state.cifSaving = null;
    renderCIF();
  }
    }

    function cifSwitchTraveller(travId) {
      state.activeCifTraveller = travId;
      renderCIF();
    }

    function cifSwitchCategory(categoryId) {
      state.activeCifCategory = categoryId;
      renderCIF();
      qs("#stepCIF")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function cifGoToCategoryOffset(offset) {
      const idx = CIF_CATEGORIES.findIndex(c => c.id === state.activeCifCategory);
      const nextIdx = idx + offset;
      if (nextIdx < 0 || nextIdx >= CIF_CATEGORIES.length) return;
      cifSwitchCategory(CIF_CATEGORIES[nextIdx].id);
    }
    // ─── DOCUMENT CHECKLIST ──────────────────────────────────────────────────
    // Backed by the CRM `Document` module (verified via MCP — API name is
    // singular "Document", not "Documents"). Checklist items are generated
    // server-side (Deluge, matched against Questiinarie_Label_Value against the
    // questionnaire answers) — the widget only fetches, displays, and uploads
    // against existing records. It never creates checklist items itself.

    // ── completeCIF (source 9101-9243) ──
async function completeCIF() {
  const travellers = applicationData.deal.travellers || [];

  if (!travellers.length) {
    return fail(
      "Add at least one traveller in Step 1 before completing the CIF."
    );
  }

  const instances = cifDestinationInstances();
  const pending = [];

  instances.forEach(instance => {
    travellers.forEach(traveller => {
      if (!cifIsInstanceSaved(traveller.id, instance.id)) {
        const name =
          `${traveller.firstName || ""} ${traveller.lastName || ""}`.trim() ||
          "Traveller";
        pending.push(`${name} — ${instance.country}`);
      }
    });
  });

  if (pending.length) {
    return fail(
      `Save every destination CIF first — still pending: ${pending.join(", ")}.`
    );
  }

  if (!applicationData.deal.crmDealId) {
    return fail(
      "CRM Deal ID is missing. Applications cannot be created."
    );
  }

  // Copy the primary applicant's UK/fallback CIF address when one exists.
  const primaryTraveller =
    travellers.find(traveller => traveller.type === "Primary Applicant") ||
    travellers[0] ||
    {};
  const ukInstance = instances.find(instance => instance.type === "uk");
  const primaryCif = ukInstance
    ? cifInstanceData(primaryTraveller.id, ukInstance.id).f1 || {}
    : {};
  const address = primaryCif.Your_current_residence_address || {};

  if (address.address_line_1) applicationData.customer.mailingStreet = address.address_line_1;
  if (address.district_city) applicationData.customer.mailingCity = address.district_city;
  if (address.state_province) applicationData.customer.mailingState = address.state_province;
  if (address.postal_Code) applicationData.customer.mailingZip = address.postal_Code;

  showLoader("Creating applications in CRM...");

  try {
    const requestId = await submitPortalCrmRequest(
      "Create Applications"
    );

    if (!requestId) {
      throw new Error(
        "Creator did not return a CRM request record ID."
      );
    }

    const result = await pollCreatorRecord(
      requestId,
      15,
      1500
    );

    console.log(
      "[Winny] Create Applications result:",
      JSON.stringify(result)
    );

    if (result._timedOut) {
      throw new Error(
        "CRM application creation timed out. Please try again."
      );
    }

    if (result.Status !== "Success") {
      throw new Error(
        result.Error_Message ||
        "CRM application creation failed."
      );
    }

    const crmResponse =
      safeJsonParse(result.CRM_Response || "{}") || {};

    const applicationIds = Array.isArray(
      crmResponse.applicationIds
    )
      ? crmResponse.applicationIds
      : [];

    if (!applicationIds.length) {
      throw new Error(
        "CRM did not return any Application record IDs."
      );
    }

    applicationData.crmSync.applicationIds =
      applicationIds;

    applicationData.crmSync.requestId = requestId;
    applicationData.crmSync.lastSyncAt =
      new Date().toISOString();

    applicationData.stepStatus.cifCompleted = true;

    saveDraft(false);

    toast(
      `${applicationIds.length} CRM application${
        applicationIds.length === 1 ? "" : "s"
      } created. Review unlocked.`
    );

    showStep(5);
    return true;
  } catch (error) {
    console.error(
      "[Winny] Create Applications failed:",
      error
    );

    applicationData.stepStatus.cifCompleted = false;
    applicationData.crmSync.lastError =
      error.message || String(error);

    saveDraft(false);

    return fail(
      `CIF was saved, but CRM Application creation failed: ${
        error.message || error
      }`
    );
  } finally {
    hideLoader();
  }
}

    // ── CIF payload builders / validators / save (source 11367-13008) ──
    function cifBuildFormPayload(travId, formTag, extra, instanceId) {
      const data = (cifInstanceData(travId, instanceId)[formTag]) || {};
      const payload = {};
      CIF_UK_SECTIONS.forEach(section => {
        if (!cifShowIfMet(travId, section.showIf, instanceId)) return; // whole section hidden (e.g. Medical section when purpose != medical)
        if (section.subform) {
          if (section.form !== formTag) return;
          const rows = getByPath(applicationData, cifPath(travId, formTag, section.key, instanceId)) || [];
          if (!rows.length) return;
          payload[section.key] = rows.map(row => {
            const rowOut = {};
            section.rowFields.forEach(([, subkey, ftype]) => {
              let v;
              if (subkey.includes(".")) {
                const [parent, child] = subkey.split(".");
                if (!rowOut[parent]) rowOut[parent] = {};
                v = (row[parent] || {})[child] || "";
                rowOut[parent][child] = v;
                return;
              }
              v = row[subkey] || "";
              if (ftype === "multiselect" && v) v = v.split(",").map(s => s.trim()).filter(Boolean);
              if (ftype === "date" && v) v = toZohoDateCIF(v);
              rowOut[subkey] = v;
            });
            return rowOut;
          });
          return;
        }
        section.fields.forEach(def => {
          const [, form, key, ftype, , , showIf] = def;
          if (form !== formTag) return;
          if (!cifShowIfMet(travId, showIf, instanceId)) return; // field individually hidden (e.g. detail box when its Yes/No isn't Yes)
          if (key.includes(".")) {
            const [parent, child] = key.split(".");
            const v = ((data[parent] || {})[child]) || "";
            if (v === "") return;
            if (!payload[parent]) payload[parent] = {};
            payload[parent][child] = v;
            return;
          }
          let v = data[key];
          if (v === undefined || v === null || v === "") return;
          if (ftype === "yesnobool") v = (v === "Yes"); 
          if (ftype === "multiselect") v = String(v).split(",").map(s => s.trim()).filter(Boolean);
          if (ftype === "date") v = toZohoDateCIF(v);
          if (ftype === "address") {
            const addr = data[key] || {};
            v = addr; // address composite already stored as nested object via dot-paths
          }
          payload[key] = v;
        });
      });
      Object.assign(payload, extra || {});
      return payload;
    }

    function toZohoDateCIF(isoDate) {
      if (!isoDate) return "";
      const d = new Date(isoDate + "T00:00:00");
      if (isNaN(d.getTime())) return "";
      const day = String(d.getDate()).padStart(2, "0");
      const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
      return `${day}-${month}-${d.getFullYear()}`;
    }

    async function cifCreateRecord(formLinkName, payload) {
      if (!window.ZOHO?.CREATOR?.DATA?.addRecords) {
        throw new Error("Zoho transport unavailable — cannot save CIF right now.");
      }
      const res = await ZOHO.CREATOR.DATA.addRecords({
        app_name:  CONFIG.creator.appLinkName,
        form_name: formLinkName,
        payload:   { data: payload }
      });
      if (res?.code !== 3000) {
        throw new Error(`${formLinkName} save failed (${res?.code}): ${res?.message || JSON.stringify(res)}`);
      }
      return res?.data?.ID || res?.data?.id;
    }

    async function cifUpdateRecord(formLinkName, reportLinkName, id, payload) {
      if (!window.ZOHO?.CREATOR?.DATA?.updateRecordById) {
        throw new Error("Zoho update transport unavailable — cannot update the saved CIF.");
      }
      const res = await ZOHO.CREATOR.DATA.updateRecordById({
        app_name:    CONFIG.creator.appLinkName,
        report_name: reportLinkName,
        id:          id,
        payload:     { data: payload }
      });
      if (res?.code !== undefined && res.code !== 3000) {
        throw new Error(`${formLinkName} update failed (${res.code}): ${res.message || JSON.stringify(res)}`);
      }
      return res;
    }

    function cifTravellerContext(travId, instance) {
      const t = applicationData.deal.travellers.find(x => x.id === travId);
      const travellerName = t ? `${t.firstName||""} ${t.lastName||""}`.trim() : "";
      const cifBelongsTo = t?.type === "Spouse" ? "Spouse" : t?.type === "Child" ? "First Child" : "Main Applicant";
      const appIdDigits = (applicationData.applicationId || "").replace(/\D/g, "").slice(-6);
      return {
        traveller:t,
        travellerName,
        cifBelongsTo,
        appIdDigits,
        appIdNumber:appIdDigits ? Number(appIdDigits) : "",
        officerName:applicationData.customer.caseOfficerName || "Winny Global",
        officerEmail:applicationData.customer.caseOfficerEmail || applicationData.customer.email || "",
        dealId:applicationData.deal.crmDealId || "",
        country:instance.country
      };
    }

    function cifCommonPayload(type, context) {
      if (type === "schengen") return {
        App_ID:context.appIdNumber,
        Client_Name:context.travellerName,
        Applying_for_Country:context.country,
        Case_officer_name:context.officerName,
        Case_officer_s_email:context.officerEmail
      };
      if (type === "australia") return {
        App_iD:applicationData.applicationId || context.appIdDigits,
        Cilent_Name:context.travellerName,
        This_CIF_belongs_to:context.cifBelongsTo,
        Case_Officer_Name:context.officerName,
        Case_officer_email_id:context.officerEmail
      };
      if (type === "usa") return {
        APP_Id:context.appIdNumber,
        Client_Name:context.travellerName,
        This_CIF_belongs_to:context.cifBelongsTo,
        Case_officer_name:context.officerName,
        Case_officer_email_id:context.officerEmail
      };
      return {
        App_ID:context.appIdNumber,
        Cilent_Name:context.travellerName,
        This_CIF_belongs_to:context.cifBelongsTo,
        Case_Officer_Name:context.officerName,
        Case_officer_email_id:context.officerEmail,
        Deal_ID:context.dealId
      };
    }

    function cifGenericTransformValue(value, field, instanceType) {
      if (value === undefined || value === null || value === "") return undefined;
      if (field.type === 10) return toZohoDateCIF(value);
      if ([14,15].includes(field.type) && typeof value === "string") {
        const useSchengenDelim = instanceType === "schengen" && !CIF_COUNTRY_DROPDOWN_FIELDS.has(field.link_name);
        return value.split(useSchengenDelim ? SCHENGEN_MULTI_DELIM : ",").map(part => part.trim()).filter(Boolean);
      }
      if (field.type === 21 && Array.isArray(value)) {
        return value.map(row => {
          const output = {};
          cifCustomerFields(field.fields).forEach(child => {
            const transformed = cifGenericTransformValue(row[child.link_name], child, instanceType);
            if (transformed !== undefined) output[child.link_name] = transformed;
          });
          return output;
        }).filter(row => Object.keys(row).length);
      }
      return value;
    }

    function cifGenericBuildPayload(travId, instance, stage) {
      const data = cifInstanceData(travId, instance.id)[stage.tag] || {};
      const payload = {};
      cifCustomerFields(state.cifMetadata[stage.form]).forEach(field => {
        const value = cifGenericTransformValue(data[field.link_name], field, instance.type);
        if (value !== undefined && !(Array.isArray(value) && !value.length)) payload[field.link_name] = value;
      });
      return payload;
    }
    function cifValidateUsForm1(data) {
  const hasValue = value => {
    if (Array.isArray(value)) return value.length > 0;

    if (value && typeof value === "object") {
      return Object.values(value).some(hasValue);
    }

    return value !== undefined &&
      value !== null &&
      String(value).trim() !== "";
  };

  const requireField = (condition, fieldName, message) => {
    if (condition && !hasValue(data?.[fieldName])) return message;
    return "";
  };

  let error = "";

  error = requireField(
    data.Does_your_name_exist_in_a_native_alphabet === "Yes",
    "Full_Name_in_Native_Alphabet",
    "Enter full name in native alphabet."
  );
  if (error) return error;

  if (
    data.Have_you_ever_used_other_names_i_e_maiden_religious_professional_alias_etc ===
    "Yes"
  ) {
    const rows = Array.isArray(data.Other_Name) ? data.Other_Name : [];

    if (!rows.length) return "Please add at least one other name.";

    for (const row of rows) {
      if (
        !hasValue(
          row.Other_Surnames_Used_maiden_religious_professional_aliases_etc
        )
      ) {
        return "Please enter the other surname.";
      }

      if (!hasValue(row.Other_Given_Names_Used)) {
        return "Please enter the other given name.";
      }
    }
  }

  if (data.Do_you_have_a_telecode_that_represents_your_name === "Yes") {
    if (!hasValue(data.Telecode_Surnames)) {
      return "Enter the telecode surname.";
    }

    if (!hasValue(data.Telecode_Given_Names)) {
      return "Enter the telecode given name.";
    }
  }

  error = requireField(
    data.Does_your_address_include_a_state_or_province === "Yes",
    "State_Province1",
    "Enter the state or province."
  );
  if (error) return error;

  if (
    data.Do_you_hold_or_have_you_held_any_nationality_other_than_the_one_indicated_above_on_nationa ===
    "Yes"
  ) {
    const rows = Array.isArray(data.Other_Country_Region1)
      ? data.Other_Country_Region1
      : [];

    if (!rows.length) return "Please add at least one other country.";

    for (const row of rows) {
      if (!hasValue(row.Dropdown)) {
        return "Please select the other country.";
      }

      if (
        !hasValue(
          row.Do_you_hold_a_passport_for_the_other_country_region_of_origin_nationality_indicated_above
        )
      ) {
        return "Please select whether you hold a passport for the other country.";
      }

      if (
        row.Do_you_hold_a_passport_for_the_other_country_region_of_origin_nationality_indicated_above ===
          "Yes" &&
        !hasValue(row.Passport_Number)
      ) {
        return "Please enter the passport number for the other country.";
      }
    }
  }

  error = requireField(
    data.Do_you_have_National_Identification_Number === "Yes",
    "National_Identification_Number",
    "Enter the National Identification Number."
  );
  if (error) return error;

  error = requireField(
    data.Does_the_applicant_have_a_U_S_Social_Security_Number === "Yes",
    "U_S_Social_Security_Number",
    "Enter the U.S. Social Security Number."
  );
  if (error) return error;

  error = requireField(
    data.Does_the_applicant_have_a_U_S_Taxpayer_ID_Number === "Yes",
    "U_S_Taxpayer_ID_Number",
    "Enter the U.S. Taxpayer ID Number."
  );
  if (error) return error;

  if (data.Have_you_made_specific_travel_plans === "Yes") {
    const requiredTravelFields = [
      ["Date_of_Arrival_in_U_S", "Enter the date of arrival in the U.S."],
      ["Arrival_City", "Enter the arrival city."],
      ["Date_of_Departure_from_U_S", "Enter the departure date from the U.S."],
      ["Departure_City", "Enter the departure city."]
    ];

    for (const [fieldName, message] of requiredTravelFields) {
      if (!hasValue(data[fieldName])) return message;
    }

    const locations = Array.isArray(data.Add_Location)
      ? data.Add_Location
      : [];

    if (!locations.length) return "Please add at least one U.S. location.";

    for (const row of locations) {
      if (!hasValue(row.Location)) {
        return "Please enter the U.S. location.";
      }
    }
  } else if (
    data.Have_you_made_specific_travel_plans === "No" &&
    !hasValue(data.Intended_Date_of_Arrival)
  ) {
    return "Enter the intended date of arrival.";
  }

  if (data.Person_Entity_Paying_for_Your_Trip === "OTHER PERSON") {
    const requiredPayerFields = [
      [
        "Surnames_of_Person_Paying_for_Trip",
        "Enter the surname of the person paying for the trip."
      ],
      [
        "Given_Names_of_person_paying_for_Trip",
        "Enter the given name of the person paying for the trip."
      ],
      ["Telephone_Number", "Enter the payer's telephone number."],
      [
        "Do_you_have_an_email_address",
        "Select whether the payer has an email address."
      ],
      ["Relationship_to_you", "Enter the payer's relationship to you."],
      [
        "Is_the_address_of_the_party_paying_for_your_trip_the_same_as_your_Home_or_Mailing_Address",
        "Select whether the payer's address is the same as your address."
      ]
    ];

    for (const [fieldName, message] of requiredPayerFields) {
      if (!hasValue(data[fieldName])) return message;
    }

    if (
      data.Do_you_have_an_email_address === "Yes" &&
      !hasValue(data.Email1)
    ) {
      return "Enter the payer's email address.";
    }

    if (
      data.Is_the_address_of_the_party_paying_for_your_trip_the_same_as_your_Home_or_Mailing_Address ===
        "No" &&
      !hasValue(data.Address_of_person_paying)
    ) {
      return "Enter the address of the person paying.";
    }
  }

  if (
    data.Person_Entity_Paying_for_Your_Trip ===
    "OTHER COMPANY/ORGANIZATION"
  ) {
    const requiredCompanyFields = [
      [
        "Name_of_the_Company_Organization_Paying_for_Trip",
        "Enter the company or organization name."
      ],
      ["Telephone_Number1", "Enter the company telephone number."],
      [
        "Relationship_to_you1",
        "Enter the company's relationship to you."
      ],
      [
        "Address_of_company_Organization_Paying",
        "Enter the company or organization address."
      ]
    ];

    for (const [fieldName, message] of requiredCompanyFields) {
      if (!hasValue(data[fieldName])) return message;
    }
  }

  if (
    data.Purpose_of_Trip_to_the_U_S ===
      "TEMP. BUSINESS OR PLEASURE VISITOR (B)" &&
    !hasValue(data.Specifydr)
  ) {
    return "Please specify the business or pleasure visitor category.";
  }

  return "";
}
function cifValidateUsForm2(data) {
  const hasValue = value => {
    if (Array.isArray(value)) return value.length > 0;

    if (value && typeof value === "object") {
      return Object.values(value).some(hasValue);
    }

    return value !== undefined &&
      value !== null &&
      String(value).trim() !== "";
  };

  const isYes = fieldName =>
    String(data?.[fieldName] ?? "") === "Yes";

  if (isYes("Are_there_other_persons_traveling_with_you")) {
    if (
      !hasValue(
        data.Are_you_traveling_as_part_of_a_group_or_organization
      )
    ) {
      return "Select whether you are travelling as part of a group or organization.";
    }

    if (
      data.Are_you_traveling_as_part_of_a_group_or_organization ===
      "Yes"
    ) {
      if (!hasValue(data.Group_Name)) {
        return "Enter the group or organization name.";
      }
    } else if (
      data.Are_you_traveling_as_part_of_a_group_or_organization ===
      "No"
    ) {
      if (!hasValue(data.Surnames_of_Person_Traveling_With_You)) {
        return "Enter the surname of the person travelling with you.";
      }

      if (!hasValue(data.Given_Names_of_Person_Traveling_With_You)) {
        return "Enter the given name of the person travelling with you.";
      }

      if (!hasValue(data.Relationship_with_Person)) {
        return "Select your relationship with the person travelling with you.";
      }
    }
  }

  if (isYes("Have_you_ever_been_in_the_U_S")) {
    const visits = Array.isArray(data.Add_previous_U_S_Visit_Details)
      ? data.Add_previous_U_S_Visit_Details
      : [];

    if (!visits.length) {
      return "Please add at least one previous U.S. visit.";
    }

    for (const visit of visits) {
      if (!hasValue(visit.Length_of_Stay)) {
        return "Enter the length of stay for each previous U.S. visit.";
      }
    }
  }

  if (
    isYes("Do_you_or_did_you_ever_hold_a_U_S_Driver_s_License")
  ) {
    const licences = Array.isArray(data.Add_U_S_Driver_s_License)
      ? data.Add_U_S_Driver_s_License
      : [];

    if (!licences.length) {
      return "Please add at least one U.S. driver's licence.";
    }

    for (const licence of licences) {
      if (
        !hasValue(
          licence.Does_the_applicant_know_their_driver_s_license_number
        )
      ) {
        return "Select whether you know the U.S. driver's licence number.";
      }

      if (!hasValue(licence.State_of_Driver_s_License)) {
        return "Select the state of the U.S. driver's licence.";
      }
      if (
  licence.Does_the_applicant_know_their_driver_s_license_number ===
    "Yes" &&
  !hasValue(licence.Driver_s_License_Number)
) {
  return "Enter the U.S. driver's licence number.";
}
    }
  }

  if (isYes("Have_you_ever_been_issued_a_U_S_Visa")) {
    const issuedVisaFields = [
      [
        "Date_Last_Visa_Was_Issued",
        "Enter the date when the last U.S. visa was issued."
      ],
      [
        "Does_your_visa_have_a_number",
        "Select whether the U.S. visa has a number."
      ],
      [
        "Are_you_applying_in_the_same_country_or_location_where_the_visa_above_was_issued_and_is_th",
        "Select whether you are applying in the same country or location."
      ],
      [
        "Have_you_been_ten_printed",
        "Select whether you have been ten-printed."
      ],
      [
        "Has_your_U_S_Visa_ever_been_lost_or_stolen",
        "Select whether your U.S. visa was lost or stolen."
      ],
      [
        "Has_your_U_S_Visa_ever_been_cancelled_or_revoked",
        "Select whether your U.S. visa was cancelled or revoked."
      ]
    ];

    for (const [fieldName, message] of issuedVisaFields) {
      if (!hasValue(data[fieldName])) return message;
    }

    if (
      isYes("Does_your_visa_have_a_number") &&
      !hasValue(data.Visa_Number)
    ) {
      return "Enter the U.S. visa number.";
    }

    if (isYes("Has_your_U_S_Visa_ever_been_lost_or_stolen")) {
      if (!hasValue(data.Year1)) {
        return "Enter the year when the U.S. visa was lost or stolen.";
      }

      if (
        !hasValue(
          data.Explain_Has_your_U_S_Visa_ever_been_lost_or_stolen
        )
      ) {
        return "Explain how the U.S. visa was lost or stolen.";
      }
    }

    if (
      isYes("Has_your_U_S_Visa_ever_been_cancelled_or_revoked") &&
      !hasValue(
        data.Explain_Has_your_U_S_Visa_ever_been_cancelled_or_revoked
      )
    ) {
      return "Explain why the U.S. visa was cancelled or revoked.";
    }
  }

  const explanationRules = [
    [
      "Have_you_ever_been_refused_a_U_S_Visa_or_been_refused_admission_to_the_United_States_or_wi",
      "Explain_Have_you_ever_been_refused_a_U_S_Visa_or_been_refused_admission_to_the_United_Stat",
      "Explain the U.S. visa refusal or refused admission."
    ],
    [
      "Have_you_ever_been_denied_travel_authorization_by_the_Department_of_Homeland_Security_thro",
      "Explain_Have_you_ever_been_denied_travel_authorization_by_the_Department_of_Homeland_Secur",
      "Explain the denied ESTA travel authorization."
    ],
    [
      "Has_anyone_ever_filed_an_immigrant_petition_on_your_behalf_with_the_United_States_Citizens",
      "Explain_Has_anyone_ever_filed_an_immigrant_petition_on_your_behalf_with_the_United_States",
      "Explain the immigrant petition filed on your behalf."
    ]
  ];

  for (const [answerField, detailField, message] of explanationRules) {
    if (isYes(answerField) && !hasValue(data[detailField])) {
      return message;
    }
  }

  if (
    data.Is_your_Mailing_Address_the_same_as_your_Home_Address ===
      "No" &&
    !hasValue(data.Provide_your_mailing_address)
  ) {
    return "Enter your mailing address.";
  }

  if (
    isYes("Do_you_have_a_secondary_phone_number") &&
    !hasValue(data.Secondary_Phone_Number)
  ) {
    return "Enter your secondary phone number.";
  }

  if (
    isYes("Do_you_have_a_work_phone_number") &&
    !hasValue(data.Work_Phone_Number)
  ) {
    return "Enter your work phone number.";
  }

  const repeatingRules = [
    {
      trigger:
        "Have_you_used_any_other_phone_numbers_in_the_last_five_years",
      subform: "Add_Additional_Phone_Number",
      fields: [
        ["Additional_Phone_Number", "Enter each additional phone number."]
      ],
      empty: "Please add at least one additional phone number."
    },
    {
      trigger:
        "Have_you_used_any_other_email_addresses_in_the_last_five_years",
      subform: "Add_Additional_Email_Address",
      fields: [
        ["Additional_Email_Address", "Enter each additional email address."]
      ],
      empty: "Please add at least one additional email address."
    },
    {
      trigger:
        "Do_you_wish_to_provide_information_about_your_presence_on_any_other_websites_or_applicatio",
      subform: "Add_Social_Media_Platform_and_identifiers",
      fields: [
        [
          "Additional_Social_Media_Platform",
          "Enter each additional social-media platform."
        ],
        [
          "Additional_Social_Media_Handle",
          "Enter each additional social-media handle."
        ]
      ],
      empty: "Please add at least one social-media platform."
    }
  ];

  for (const rule of repeatingRules) {
    if (!isYes(rule.trigger)) continue;

    const rows = Array.isArray(data[rule.subform])
      ? data[rule.subform]
      : [];

    if (!rows.length) return rule.empty;

    for (const row of rows) {
      for (const [fieldName, message] of rule.fields) {
        if (!hasValue(row[fieldName])) return message;
      }
    }
  }

  if (
  isYes("Does_the_applicant_have_a_Passport_Book_Number") &&
  !hasValue(data.Passport_Book_Number)
) {
  return "Enter the Passport Book Number.";
}

  if (
    isYes("Does_the_applicant_have_an_Expiration_Date") &&
    !hasValue(data.Expiration_Date)
  ) {
    return "Enter the passport expiration date.";
  }

  if (isYes("Have_you_ever_lost_a_passport_or_had_one_stolen")) {
    const passports = Array.isArray(data.Add_passport_Travel_Document)
      ? data.Add_passport_Travel_Document
      : [];

    if (!passports.length) {
      return "Please add the lost or stolen passport details.";
    }

    for (const passport of passports) {
      if (
        !hasValue(
          passport.Does_the_applicant_know_their_Passport_Travel_document_number
        )
      ) {
        return "Select whether you know the lost or stolen passport number.";
      }

      if (
        !hasValue(
          passport.Country_Authority_that_Issued_Passport_Travel_Document
        )
      ) {
        return "Select the authority that issued the lost or stolen passport.";
      }

     if (
  passport.Does_the_applicant_know_their_Passport_Travel_document_number ===
    "Yes" &&
  !hasValue(passport.Passport_Travel_Document_Number)
) {
  return "Enter the lost or stolen Passport/Travel Document Number.";
}

if (
  passport.Does_the_applicant_know_their_Passport_Travel_document_number ===
    "No" &&
  !hasValue(
    passport.Explain_Does_the_applicant_know_their_Passport_Travel_document_number
  )
) {
  return "Explain why the lost or stolen Passport/Travel Document Number is unavailable.";
}
    }
  }

  if (
    isYes(
      "Does_the_applicant_have_a_Contact_Person_in_the_United_States"
    )
  ) {
    if (!hasValue(data.Surnames)) {
      return "Enter the U.S. contact's surname.";
    }

    if (!hasValue(data.Given_Names)) {
      return "Enter the U.S. contact's given name.";
    }
  }

  if (
    isYes(
      "Does_the_applicant_have_an_Organization_Name_in_the_United_States"
    ) &&
    !hasValue(data.Organization_Name)
  ) {
    return "Enter the U.S. organization name.";
  }

  if (
    isYes("Does_the_applicant_have_an_Email_Address") &&
    !hasValue(data.Email_Address1)
  ) {
    return "Enter the U.S. contact's email address.";
  }

  return "";
}
function cifValidateUsForm3(data) {
  const hasValue = value => {
    if (Array.isArray(value)) return value.length > 0;

    if (value && typeof value === "object") {
      return Object.values(value).some(hasValue);
    }

    return value !== undefined &&
      value !== null &&
      String(value).trim() !== "";
  };

  const isYes = fieldName =>
    String(data?.[fieldName] ?? "") === "Yes";

  const conditionalFields = [
    [
      "Does_the_applicant_know_their_Father_s_Surname",
      "Father_s_Surnames",
      "Enter the father's surname."
    ],
    [
      "Does_the_applicant_know_their_Father_s_Given_Name",
      "Father_s_Given_Names",
      "Enter the father's given name."
    ],
    [
      "Does_the_applicant_know_their_Father_s_Date_of_Birth",
      "Father_s_Date_of_Birth",
      "Enter the father's date of birth."
    ],
    [
      "Is_your_father_in_the_U_S",
      "Father_s_Status",
      "Select the father's U.S. status."
    ],
    [
      "Does_the_applicant_know_their_Mother_s_Surnames",
      "Mother_s_Surnames",
      "Enter the mother's surname."
    ],
    [
      "Does_the_applicant_know_their_Mother_s_Given_Name",
      "Mother_s_Given_Names",
      "Enter the mother's given name."
    ],
    [
      "Does_the_applicant_know_their_Mother_s_Date_of_Birth",
      "Mother_s_Date_of_Birth",
      "Enter the mother's date of birth."
    ],
    [
      "Is_your_mother_in_the_U_S",
      "Mother_s_Status",
      "Select the mother's U.S. status."
    ],
    [
      "Does_your_current_employment_provide_a_monthly_income_in_local_currency",
      "Monthly_Income_in_Local_Currency_if_employed",
      "Enter the monthly income in local currency."
    ],
    [
      "Do_you_belong_to_a_clan_or_tribe",
      "Clan_or_Tribe_Name",
      "Enter the clan or tribe name."
    ],
    [
      "Have_you_traveled_to_any_countries_regions_within_the_last_five_years",
      "Country_Region1",
      "Select the countries or regions visited within the last five years."
    ],
    [
      "Do_you_have_any_specialized_skills_or_training_such_as_firearms_explosives_nuclear_biologi",
      "Explain_Do_you_have_any_specialized_skills_or_training_such_as_firearms_explosives_nuclear",
      "Explain the specialized skills or training."
    ],
    [
      "Have_you_ever_served_in_been_a_member_of_or_been_involved_with_a_paramilitary_unit_vigilan",
      "Explain_Have_you_ever_served_in_been_a_member_of_or_been_involved_with_a_paramilitary_unit",
      "Explain the paramilitary, vigilante, rebel, guerrilla or insurgent involvement."
    ],
    [
      "Do_you_have_a_communicable_disease_of_public_health_significance_Communicable_diseases_of",
      "Explain_Do_you_have_any_communicable_disease_of_public_health_significance_e_g_chancroid_g",
      "Explain the communicable disease."
    ],
    [
      "Do_you_have_a_mental_or_physical_disorder_that_poses_or_is_likely_to_pose_a_threat_to_the",
      "Explain_Do_you_have_a_mental_or_physical_disorder_that_poses_or_is_likely_to_pose_a_threat",
      "Explain the mental or physical disorder."
    ],
    [
      "Are_you_or_have_you_ever_been_a_drug_abuser_or_addict",
      "Explain_Are_you_or_have_you_ever_been_a_drug_abuser_or_addict",
      "Explain the drug abuse or addiction."
    ],
    [
      "Have_you_ever_been_arrested_or_convicted_for_any_offense_or_crime_even_though_subject_of_a",
      "Explain_Have_you_ever_been_arrested_or_convicted_for_any_offense_or_crime_even_though_subj",
      "Explain the arrest or conviction."
    ],
    [
      "Have_you_ever_violated_or_engaged_in_a_conspiracy_to_violate_any_law_relating_to_controlle",
      "Explain_Have_you_ever_violated_or_engaged_in_a_conspiracy_to_violate_any_law_relating_to_c",
      "Explain the controlled-substance violation."
    ],
    [
      "Are_you_coming_to_the_United_States_to_engage_in_prostitution_or_unlawful_commercialized_v",
      "Explain_Are_you_coming_to_the_United_States_to_engage_in_prostitution_or_unlawful_commerci",
      "Explain the prostitution or unlawful commercialized-vice answer."
    ],
    [
      "Have_you_ever_been_involved_in_or_do_you_seek_to_engage_in_money_laundering",
      "Explain_Have_you_ever_been_involved_in_or_do_you_seek_to_engage_in_money_laundering",
      "Explain the money-laundering answer."
    ],
    [
      "Have_you_ever_committed_or_conspired_to_commit_a_human_trafficking_offense_in_the_United_States_or",
      "Explain_Have_you_ever_committed_or_conspired_to_commit_a_human_trafficking_offense_in_the_United_S",
      "Explain the human-trafficking offence."
    ],
    [
      "Have_you_knowingly_aided_abetted_or_assisted_anyone_involved_in_a_severe_human_trafficking_offense",
      "Explain_Have_you_knowingly_aided_abetted_or_assisted_anyone_involved_in_a_severe_human_trafficking",
      "Explain the assistance connected with human trafficking."
    ],
    [
      "Are_you_the_spouse_son_or_daughter_of_someone_involved_in_human_trafficking_in_or_outside_the_U_S",
      "Explain_Are_you_the_spouse_son_or_daughter_of_someone_involved_in_human_trafficking_in_or_outside",
      "Explain the family connection with human trafficking."
    ]
  ];

  for (const [answerField, detailField, message] of conditionalFields) {
    if (isYes(answerField) && !hasValue(data[detailField])) {
      return message;
    }
  }

  if (
    isYes(
      "Do_you_have_any_immediate_relatives_not_including_parents_in_the_United_States"
    )
  ) {
    const relatives = Array.isArray(data.Add_Relative_s_in_U_S)
      ? data.Add_Relative_s_in_U_S
      : [];

    if (!relatives.length) {
      return "Please add at least one immediate relative in the U.S.";
    }

    const requiredRelativeFields = [
      ["Surnames", "Enter each relative's surname."],
      ["Given_Names", "Enter each relative's given name."],
      ["Relationship_to_You", "Select each relative's relationship."],
      ["Relative_s_Status", "Select each relative's U.S. status."]
    ];

    for (const relative of relatives) {
      for (const [fieldName, message] of requiredRelativeFields) {
        if (!hasValue(relative[fieldName])) return message;
      }
    }

    if (
      !hasValue(
        data.Do_you_have_any_other_relatives_in_the_United_States
      )
    ) {
      return "Select whether you have any other relatives in the U.S.";
    }
  }

  if (isYes("Were_you_previously_employed")) {
    const employers = Array.isArray(
      data.Add_Employer_Employment_information
    )
      ? data.Add_Employer_Employment_information
      : [];

    if (!employers.length) {
      return "Please add at least one previous employer.";
    }

    const requiredEmployerFields = [
      ["Employer_Name", "Enter each previous employer's name."],
      ["Address", "Enter each previous employer's address."],
      ["Telephone_Number", "Enter each previous employer's telephone number."],
      ["Job_Title", "Enter each previous job title."],
      [
        "Does_the_applicant_know_their_Supervisor_s_Surname",
        "Select whether the supervisor's surname is known."
      ],
      [
        "Does_the_applicant_know_their_supervisor_s_Given_Names",
        "Select whether the supervisor's given name is known."
      ],
      ["Employment_Date_From", "Enter each employment start date."],
      ["Employment_Date_To", "Enter each employment end date."]
    ];

    for (const employer of employers) {
      for (const [fieldName, message] of requiredEmployerFields) {
        if (!hasValue(employer[fieldName])) return message;
      }
    }
  }

  if (
    isYes(
      "Have_you_attended_any_educational_institutions_at_a_secondary_level_or_above"
    )
  ) {
    const education = Array.isArray(data.Add_Educational_information)
      ? data.Add_Educational_information
      : [];

    if (!education.length) {
      return "Please add at least one educational institution.";
    }

    const requiredEducationFields = [
      ["Name_of_Institution", "Enter each institution's name."],
      ["Address", "Enter each institution's address."],
      ["Course_of_Study", "Enter each course of study."],
      ["Date_of_Attendance_From", "Enter each attendance start date."],
      ["Date_of_Attendance_To", "Enter each attendance end date."]
    ];

    for (const institution of education) {
      for (const [fieldName, message] of requiredEducationFields) {
        if (!hasValue(institution[fieldName])) return message;
      }
    }
  }

  const languages = Array.isArray(data.Add_list_of_languages)
    ? data.Add_list_of_languages
    : [];

  if (!languages.length) {
    return "Please add at least one language.";
  }

  for (const language of languages) {
    if (!hasValue(language.Language_Name)) {
      return "Enter each language name.";
    }
  }

  if (
    isYes(
      "Have_you_belonged_to_contributed_to_or_worked_for_any_professional_social_or_charitable_or"
    )
  ) {
    const organizations = Array.isArray(data.Add_list_of_Organizations)
      ? data.Add_list_of_Organizations
      : [];

    if (!organizations.length) {
      return "Please add at least one organization.";
    }

    for (const organization of organizations) {
      if (!hasValue(organization.Organization_Name)) {
        return "Enter each organization name.";
      }
    }
  }

  if (isYes("Have_you_ever_served_in_the_military")) {
    const militaryRows = Array.isArray(
      data.Add_Details_of_Applicant_s_Military_Service
    )
      ? data.Add_Details_of_Applicant_s_Military_Service
      : [];

    if (!militaryRows.length) {
      return "Please add the military-service details.";
    }

    const requiredMilitaryFields = [
      ["Name_of_Country_Region", "Select the military-service country."],
      ["Branch_of_Service", "Enter the branch of service."],
      ["Rank_Position", "Enter the rank or position."],
      ["Military_Specialty", "Enter the military specialty."],
      ["Date_of_Service_From", "Enter the service start date."],
      ["Date_of_Service_To", "Enter the service end date."]
    ];

    for (const service of militaryRows) {
      for (const [fieldName, message] of requiredMilitaryFields) {
        if (!hasValue(service[fieldName])) return message;
      }
    }
  }

  return "";
}
function cifValidateUsForm4(data) {
  const hasValue = value =>
    value !== undefined &&
    value !== null &&
    String(value).trim() !== "";

  const rules = [
    [
      "Do_you_seek_to_engage_in_espionage_sabotage_export_control_violations_or_any_other_illegal",
      "Explain_Do_you_seek_to_engage_in_espionage_sabotage_export_control_violations_or_any_other1",
      "Explain the espionage, sabotage, export-control or illegal-activity answer."
    ],
    [
      "Do_you_seek_to_engage_in_terrorist_activities_while_in_the_United_States_or_have_you_ever",
      "Explain_Do_you_seek_to_engage_in_terrorist_activities_while_in_the_United_States_or_have_yo",
      "Explain the terrorist-activities answer."
    ],
    [
      "Have_you_ever_or_do_you_intend_to_provide_financial_assistance_or_other_support",
      "Explain_Have_you_ever_or_do_you_intend_to_provide_financial_assistance_or_other_support",
      "Explain the financial assistance or support answer."
    ],
    [
      "Are_you_a_member_or_representative_of_a_terrorist_organization1",
      "Explain_Are_you_a_member_or_representative_of_a_terrorist_organization1",
      "Explain the terrorist-organization membership answer."
    ],
    [
      "Are_you_the_spouse_son_or_daughter_of_someone_who_has_supported_terrorist",
      "Explain_Are_you_the_spouse_son_or_daughter_of_someone_who_has_supported",
      "Explain the family connection to terrorist support."
    ],
    [
      "Have_you_ever_ordered_incited_committed_assisted_or_otherwise_participated_in_genocide",
      "Explain_Have_you_ever_ordered_incited_committed_assisted_or_otherwise_participated",
      "Explain the genocide answer."
    ],
    [
      "Have_you_ever_committed_ordered_incited_assisted_or_otherwise_participated_in_torture",
      "Explain_Have_you_ever_committed_ordered_incited_assisted_or_otherwise_participated_in_torture",
      "Explain the torture answer."
    ],
    [
      "Have_you_committed_ordered_incited_assisted_or_otherwise_participated_in_extrajudicial_killings",
      "Explain_Have_you_committed_ordered_incited_assisted_or_otherwise_participated",
      "Explain the extrajudicial killings or acts-of-violence answer."
    ],
    [
      "Have_you_ever_engaged_in_the_recruitment_or_the_use_of_child_soldiers",
      "Explain_Have_you_ever_engaged_in_the_recruitment_or_the_use_of_child_soldiers",
      "Explain the recruitment or use of child soldiers."
    ],
    [
      "Have_you_while_serving_as_a_government_official_been_responsible_for_or_directly_carried",
      "Explain_Have_you_while_serving_as_a_government_official_been_responsible",
      "Explain the religious-freedom violation answer."
    ],
    [
      "Have_you_ever_been_involved_in_forcing_someone_to_undergo_abortion_or_sterilization",
      "Explain_Have_you_ever_been_involved_in_forcing_someone_to_undergo_abortion",
      "Explain the forced abortion or sterilization answer."
    ],
    [
      "Have_you_ever_been_directly_involved_in_the_coercive_transplantation_of_human_organs",
      "Explain_Have_you_ever_been_directly_involved_in_the_coercive_transplantation_of_human",
      "Explain the coercive organ or tissue transplantation answer."
    ],
    [
      "Have_you_ever_tried_to_obtain_or_help_others_obtain_a_U_S_visa_or_immigration_benefit_through",
      "Explain_Have_you_ever_tried_to_obtain_or_help_others_obtain_a_U_S_visa_or_immigration_benefit",
      "Explain the unlawful visa or immigration-benefit answer."
    ],
    [
      "Have_you_ever_been_removed_or_deported_from_any_country",
      "Explain_Have_you_ever_been_removed_or_deported_from",
      "Explain the removal or deportation answer."
    ],
    [
      "Have_you_ever_withheld_custody_of_a_U_S_citizen_child_outside_the_United_States_from_a_person",
      "Explain_Have_you_ever_withheld_custody_of_a_U_S_citizen_child_outside_the_United_States",
      "Explain the U.S.-citizen child-custody answer."
    ],
    [
      "Have_you_voted_in_the_United_States_in_violation_of_any_law_or_regulation",
      "Explain_Have_you_voted_in_the_United_States_in_violation_of_any_law_or_regulation",
      "Explain the unlawful U.S. voting answer."
    ],
    [
      "Have_you_ever_renounced_United_States_citizenship_for_the_purposes_of_avoiding_taxation",
      "Explain_Have_you_ever_renounced_United_States_citizenship_for_the_purposes_of_avoiding_taxation",
      "Explain the renunciation of U.S. citizenship answer."
    ]
  ];

  for (const [answerField, explanationField, message] of rules) {
    if (
      String(data?.[answerField] ?? "") === "Yes" &&
      !hasValue(data?.[explanationField])
    ) {
      return message;
    }
  }

  return "";
}
// ═══════════════════════════════════════════════════════════════════════
// SCHENGEN CIF — validation rules, built from the real Field Rules /
// validation scripts pulled from the Schengen_Visitor_visa Creator form.
// Follows the same hasValue/early-return pattern as cifValidateUsForm1-4.
// ═══════════════════════════════════════════════════════════════════════
// Tracks which field triggered the most recent cifValidateSchengen failure, so the caller
// can jump to the right category tab instead of just showing a toast that names a field
// the person can't see. Reset before every validation run.
function cifSchengenFail(field, message) {
  state.__schengenValidationField = field;
  return message;
}

function cifValidateSchengen(data) {
  const hasValue = value => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") return Object.values(value).some(hasValue);
    return value !== undefined && value !== null && String(value).trim() !== "";
  };
  const asList = value => Array.isArray(value) ? value : String(value || "").split(SCHENGEN_MULTI_DELIM).map(s => s.trim()).filter(Boolean);
  const contains = (value, item) => asList(value).includes(item);

  // ── Live outside home country ──
  if (data.Do_you_live_outside_your_home_country === "Yes" && !hasValue(data.Your_current_country_of_residence)) {
    return cifSchengenFail("Your_current_country_of_residence", "Please enter your current country of residence.");
  }

  // ── Purpose of visit (each selected type's own required detail field) ──
  const purpose = data.What_is_the_purpose_of_your_visit;
  if (contains(purpose, "To Visit family") && !hasValue(data.Please_describe_your_visit)) {
    return cifSchengenFail("Please_describe_your_visit", "Please describe your visit.");
  }
  if (contains(purpose, "Business visit (Paid or Unpaid)") && !hasValue(data.What_is_the_business_activity)) {
    return cifSchengenFail("What_is_the_business_activity", "Please enter the business activity.");
  }
  if (contains(purpose, "Other") && !hasValue(data.Please_describe_your_exact_purpose_of_visit)) {
    return cifSchengenFail("Please_describe_your_exact_purpose_of_visit", "Please describe your exact purpose of visit.");
  }
  if (contains(purpose, "To attend family function")) {
    if (!hasValue(data.What_is_the_function)) return cifSchengenFail("What_is_the_function", "Please enter the function.");
    if (!hasValue(data.Please_share_tell_us_about_the_function_you_re_planning_to_attend)) return cifSchengenFail("Please_share_tell_us_about_the_function_you_re_planning_to_attend", "Please provide function details.");
  }
  if (contains(purpose, "To attend convocation") && !hasValue(data.Please_share_details_of_convocation)) {
    return cifSchengenFail("Please_share_details_of_convocation", "Please provide convocation details.");
  }

  // ── Travel dates ──
  if (data.Have_you_decided_your_travel_dates === "Yes") {
    if (!hasValue(data.When_will_you_depart)) return cifSchengenFail("When_will_you_depart", "Please enter departure date.");
    if (!hasValue(data.When_will_you_return)) return cifSchengenFail("When_will_you_return", "Please enter return date.");
    if (!hasValue(data.Have_you_booked_your_flight_tickets)) return cifSchengenFail("Have_you_booked_your_flight_tickets", "Please select flight ticket status.");
    if (hasValue(data.When_will_you_depart) && hasValue(data.When_will_you_return)) {
      const depart = new Date(data.When_will_you_depart);
      const returnDate = new Date(data.When_will_you_return);
      if (!isNaN(depart.getTime()) && !isNaN(returnDate.getTime()) && returnDate < depart) {
        return cifSchengenFail("When_will_you_return", "Return date should be after departure date.");
      }
    }
  }
  if (data.Have_you_decided_your_travel_dates === "No" && !hasValue(data.Please_provide_tentative_month_and_year_of_travel)) {
    return cifSchengenFail("Please_provide_tentative_month_and_year_of_travel", "Please provide tentative month and year of travel.");
  }

  // ── Finalized itinerary ──
  if (data.Have_you_finalized_your_travel_itinerary_and_the_countries_you_plan_to_visit === "Yes") {
    if (!hasValue(data.Please_select_Schengen_country_you_will_arrive_first)) return cifSchengenFail("Please_select_Schengen_country_you_will_arrive_first", "Please select the Schengen country you will arrive first.");
    if (!hasValue(data.Please_select_Schengen_country_you_will_stay_for_most_of_the_time)) return cifSchengenFail("Please_select_Schengen_country_you_will_stay_for_most_of_the_time", "Please select the country where you will stay the longest.");
  }

  // ── Funding ──
  if (data.How_will_you_be_funding_your_trip === "My Inviter" && !hasValue(data.What_will_your_inviter_sponsor_cover_during_your_trip)) {
    return cifSchengenFail("What_will_your_inviter_sponsor_cover_during_your_trip", "Please provide what your inviter will sponsor.");
  }
  if (data.How_will_you_be_funding_your_trip === "A Sponsor (Third party)") {
    if (!hasValue(data.Name_of_sponsor)) return cifSchengenFail("Name_of_sponsor", "Please enter sponsor name.");
    if (!hasValue(data.Your_relationship_with_sponsor)) return cifSchengenFail("Your_relationship_with_sponsor", "Please specify your relationship with the sponsor.");
    if (!hasValue(data.Occupation_of_Sponsor)) return cifSchengenFail("Occupation_of_Sponsor", "Please enter sponsor occupation.");
    if (!hasValue(data.Sponsor_s_annual_income)) return cifSchengenFail("Sponsor_s_annual_income", "Please enter sponsor annual income.");
  }

  // ── Applicant current occupation ──
  const occupation = data.What_is_your_current_occupation;
  if (contains(occupation, "Employed (Job)")) {
    if (!hasValue(data.Name_of_the_current_organisation_you_work_for)) return cifSchengenFail("Name_of_the_current_organisation_you_work_for", "Please enter your organisation name.");
    if (!hasValue(data.What_is_your_designation_position_in_the_organisation)) return cifSchengenFail("What_is_your_designation_position_in_the_organisation", "Please enter your designation.");
    if (!hasValue(data.Address_of_the_organisation)) return cifSchengenFail("Address_of_the_organisation", "Please enter your organisation address.");
    if (!hasValue(data.What_is_your_present_annual_salary)) return cifSchengenFail("What_is_your_present_annual_salary", "Please enter your annual salary.");
  }
  if (contains(occupation, "Self employed (Freelancer)")) {
    if (!hasValue(data.Describe_your_day_to_day_work_as_a_self_employed_person)) return cifSchengenFail("Describe_your_day_to_day_work_as_a_self_employed_person", "Please describe your work.");
    if (!hasValue(data.What_is_your_annual_turnover_of_freelancing_work)) return cifSchengenFail("What_is_your_annual_turnover_of_freelancing_work", "Please enter your annual turnover.");
    if (!hasValue(data.How_much_amount_you_earn_annually_from_freelancing_work)) return cifSchengenFail("How_much_amount_you_earn_annually_from_freelancing_work", "Please enter your annual income.");
  }
  if (contains(occupation, "Business Owner")) {
    if (!hasValue(data.What_type_of_business_do_you_own)) return cifSchengenFail("What_type_of_business_do_you_own", "Please enter your business type.");
    if (!hasValue(data.What_is_the_name_of_your_business)) return cifSchengenFail("What_is_the_name_of_your_business", "Please enter your business name.");
    if (!hasValue(data.Please_provide_address_of_your_business)) return cifSchengenFail("Please_provide_address_of_your_business", "Please enter your business address.");
    if (!hasValue(data.What_is_the_annual_turnover_of_your_business)) return cifSchengenFail("What_is_the_annual_turnover_of_your_business", "Please enter your business's annual turnover.");
    if (!hasValue(data.How_much_amount_you_earn_annually_from_business)) return cifSchengenFail("How_much_amount_you_earn_annually_from_business", "Please enter your annual income from the business.");
    if (!hasValue(data.Please_tell_us_more_about_your_business_Industry_products_you_sell_what_activities_you_perform_etc)) return cifSchengenFail("Please_tell_us_more_about_your_business_Industry_products_you_sell_what_activities_you_perform_etc", "Please provide more details about your business.");
  }
  if (contains(occupation, "Retired")) {
    if (!hasValue(data.What_was_the_name_of_organisation_where_you_get_retired)) return cifSchengenFail("What_was_the_name_of_organisation_where_you_get_retired", "Please enter the organisation you retired from.");
    if (!hasValue(data.What_was_your_last_designation_position_in_the_oganisation_you_get_retired)) return cifSchengenFail("What_was_your_last_designation_position_in_the_oganisation_you_get_retired", "Please enter your last designation.");
    if (!hasValue(data.Do_you_currently_receive_pension)) return cifSchengenFail("Do_you_currently_receive_pension", "Please select your pension status.");
    if (!hasValue(data.When_did_you_join_this_organisation)) return cifSchengenFail("When_did_you_join_this_organisation", "Please enter when you joined that organisation.");
    if (!hasValue(data.When_did_you_retire)) return cifSchengenFail("When_did_you_retire", "Please enter your retirement date.");
  }
  if (contains(occupation, "Student")) {
    if (!hasValue(data.What_is_the_name_of_the_institute_you_are_currently_studying_at)) return cifSchengenFail("What_is_the_name_of_the_institute_you_are_currently_studying_at", "Please enter the institute name.");
    if (!hasValue(data.What_is_name_of_program_course_grade_are_you_currently_studying)) return cifSchengenFail("What_is_name_of_program_course_grade_are_you_currently_studying", "Please enter your course/grade.");
    if (!hasValue(data.Address_of_institute_you_are_currently_studying)) return cifSchengenFail("Address_of_institute_you_are_currently_studying", "Please enter the institute address.");
  }
  if (contains(occupation, "Other") && !hasValue(data.Please_describe_any_other_other_sources_of_income_employment_not_listed_above)) {
    return cifSchengenFail("Please_describe_any_other_other_sources_of_income_employment_not_listed_above", "Please describe your occupation.");
  }
  if (data.Do_you_currently_receive_pension === "Yes" && !hasValue(data.What_is_the_monthly_pension_amount)) {
    return cifSchengenFail("What_is_the_monthly_pension_amount", "Please enter your monthly pension amount.");
  }

  // ── Fixed assets / properties ──
  if (data.Do_you_personally_own_any_fix_assets_properties === "Yes") {
    if (!hasValue(data.Please_check_the_properties_you_own)) return cifSchengenFail("Please_check_the_properties_you_own", "Please select the properties you own.");
    if (!hasValue(data.What_is_the_total_value_of_all_property_s_owned_by_you)) return cifSchengenFail("What_is_the_total_value_of_all_property_s_owned_by_you", "Please enter the total value of your properties.");
  }
  if (data.Please_check_the_properties_you_own === "Other" && !hasValue(data.Please_provide_which_type_of_other_assets_do_you_have)) {
    return cifSchengenFail("Please_provide_which_type_of_other_assets_do_you_have", "Please specify the other assets you own.");
  }

  // ── Investments ──
  const investmentTriggers = ["Stock Market","FD (Fix deposits)","Mutual Funds","PPF (Public Provident Fund)","EPF (Employee's Provident Fund)","Bonds","Gold","Other"];
  if (investmentTriggers.some(t => contains(data.Please_check_your_investments, t)) && !hasValue(data.What_is_the_total_amount_of_investment_you_have_done)) {
    return cifSchengenFail("What_is_the_total_amount_of_investment_you_have_done", "Please enter your total investment amount.");
  }
  if (contains(data.Please_check_your_investments, "Other") && !hasValue(data.Please_provide_which_type_of_other_investments_do_you_have)) {
    return cifSchengenFail("Please_provide_which_type_of_other_investments_do_you_have", "Please specify your other investments.");
  }

  // ── Family members in home country (subform) ──
  const familyMembers = Array.isArray(data.Family_members_in_home_country) ? data.Family_members_in_home_country : [];
  for (const rec of familyMembers) {
    if (!hasValue(rec.Relationship_with_you)) return cifSchengenFail("Family_members_in_home_country", "Please select relationship for each family member.");
    if (!hasValue(rec.Name_of_family_member?.first_name) && !hasValue(rec.Name_of_family_member?.last_name)) return cifSchengenFail("Family_members_in_home_country", "Please enter first and last name for each family member.");
    if (!hasValue(rec.Date_of_Birth_of_family_member)) return cifSchengenFail("Family_members_in_home_country", "Please select date of birth for each family member.");
    if (!hasValue(rec.Where_do_they_live_Name_of_City_Town_Village)) return cifSchengenFail("Family_members_in_home_country", "Please enter city/town/village for each family member.");
    if (!hasValue(rec.Current_occupation_of_family_member)) return cifSchengenFail("Family_members_in_home_country", "Please enter occupation for each family member.");
  }

  // ── Own travel history ──
  if (data.Have_you_ever_visited_any_country_other_than_your_country_of_nationality === "Yes" && !hasValue(data.Please_select_country_s_you_have_visited_in_past_10_years)) {
    return cifSchengenFail("Please_select_country_s_you_have_visited_in_past_10_years", "Please select the countries you have visited in the past 10 years.");
  }
  if (data.Have_you_applied_for_a_Schengen_Visa_in_the_past_5_years === "Yes" && !hasValue(data.Please_provide_your_visa_number)) {
    return cifSchengenFail("Please_provide_your_visa_number", "Please enter your Schengen visa number.");
  }
  if (data.Have_you_provided_fingerprints_for_any_Schengen_Visa_previously === "Yes") {
    if (!hasValue(data.When_did_you_submitted_fingerprints_for_Schengen_Visa)) return cifSchengenFail("When_did_you_submitted_fingerprints_for_Schengen_Visa", "Please enter when you submitted fingerprints for your Schengen visa.");
    if (!hasValue(data.Visa_Sticker_No)) return cifSchengenFail("Visa_Sticker_No", "Please enter the visa sticker number.");
    if (!hasValue(data.Date_field)) return cifSchengenFail("Date_field", "Please enter the date.");
  }

  // ── Marital status / children ──
  const maritalNeedsChildrenAnswer = ["Married","Divorced","Widow/er","Separated"].includes(data.Marital_Status);
  if (maritalNeedsChildrenAnswer && !hasValue(data.Do_you_have_children)) {
    return cifSchengenFail("Do_you_have_children", "Please select whether you have children.");
  }

  // ── Children subform ──
  if (data.Do_you_have_children === "Yes") {
    const children = Array.isArray(data.Add_details_of_child) ? data.Add_details_of_child : [];
    if (!children.length) return cifSchengenFail("Add_details_of_child", "Please add child details.");
    for (const c of children) {
      if (c.Is_accompanying_you_during_this_visit === "Yes") {
        if (!hasValue(c.Date_of_Birth)) return cifSchengenFail("Add_details_of_child", "Please enter date of birth for your child.");
        if (!hasValue(c.Nationality)) return cifSchengenFail("Add_details_of_child", "Please enter nationality for your child.");
        if (!hasValue(c.Do_they_live_at_your_current_residence_address)) return cifSchengenFail("Add_details_of_child", "Please select residence address option for your child.");
        if (!hasValue(c.Phone_number1)) return cifSchengenFail("Add_details_of_child", "Please enter phone number for your child.");
        if (!hasValue(c.Email_Id)) return cifSchengenFail("Add_details_of_child", "Please enter email ID for your child.");
        if (!hasValue(c.Do_they_currently_reside_outside_their_country_of_nationality)) return cifSchengenFail("Add_details_of_child", "Please select nationality residence option for your child.");
        if (!hasValue(c.Are_they_attending_any_Pre_school_School_College)) return cifSchengenFail("Add_details_of_child", "Please select school/college option for your child.");
      }
      if (c.Is_accompanying_you_during_this_visit === "No" && !hasValue(c.Are_they_attending_any_Pre_school_School_College)) {
        return cifSchengenFail("Add_details_of_child", "Please select school/college option for your child.");
      }
      if (!hasValue(c.Have_your_child_ever_visited_country_other_than_their_country_of_nationality)) return cifSchengenFail("Add_details_of_child", "Please select if your child has visited other countries.");
      if (!hasValue(c.Have_your_child_applied_for_a_Schengen_Visa_in_the_past_5_years)) return cifSchengenFail("Add_details_of_child", "Please select your child's Schengen visa status.");
      if (!hasValue(c.Have_your_child_provided_fingerprints_for_any_Schengen_Visa_previously)) return cifSchengenFail("Add_details_of_child", "Please select your child's fingerprint status.");
      if (c.Do_they_live_at_your_current_residence_address === "No" && !hasValue(c.Address_they_currently_live)) {
        return cifSchengenFail("Add_details_of_child", "Please enter your child's current living address.");
      }
      if (c.Do_they_currently_reside_outside_their_country_of_nationality === "Yes" && !hasValue(c.Which_country_do_they_live_currently)) {
        return cifSchengenFail("Add_details_of_child", "Please enter the country your child currently lives in.");
      }
      if (c.Are_they_attending_any_Pre_school_School_College === "Yes") {
        if (!hasValue(c.Name_of_the_program_course_grade_they_are_studying)) return cifSchengenFail("Add_details_of_child", "Please enter your child's course/grade.");
        if (!hasValue(c.Name_of_the_institute_your_child_is_currently_attending)) return cifSchengenFail("Add_details_of_child", "Please enter your child's institute name.");
        if (!hasValue(c.Address_of_the_institute_they_are_attending)) return cifSchengenFail("Add_details_of_child", "Please enter your child's institute address.");
      }
      if (c.Have_your_child_ever_visited_country_other_than_their_country_of_nationality === "Yes" && !hasValue(c.Please_select_country_s_your_child_visited_in_past_10_years)) {
        return cifSchengenFail("Add_details_of_child", "Please select the countries your child has visited.");
      }
    }
  }

  // ── Spouse — accompanying ──
  if (data.Do_your_spouse_accompanying_you_for_this_visit === "Yes") {
    if (!hasValue(data.Name_of_your_spouse_As_per_passport)) return cifSchengenFail("Name_of_your_spouse_As_per_passport", "Please enter your spouse's name.");
    if (!hasValue(data.Your_spouse_s_Nationality)) return cifSchengenFail("Your_spouse_s_Nationality", "Please select your spouse's nationality.");
    if (!hasValue(data.Do_your_spouse_live_outside_your_home_country)) return cifSchengenFail("Do_your_spouse_live_outside_your_home_country", "Please select your spouse's residence status.");
    if (!hasValue(data.Spouse_s_email_id)) return cifSchengenFail("Spouse_s_email_id", "Please enter your spouse's email ID.");
    if (!hasValue(data.Spouse_s_Phone)) return cifSchengenFail("Spouse_s_Phone", "Please enter your spouse's phone number.");
    if (!hasValue(data.Please_select_employment_source_of_income_of_your_spouse)) return cifSchengenFail("Please_select_employment_source_of_income_of_your_spouse", "Please select your spouse's employment.");
    if (!hasValue(data.Do_your_spouse_s_ITRs_from_last_two_years_reflects_your_occupation)) return cifSchengenFail("Do_your_spouse_s_ITRs_from_last_two_years_reflects_your_occupation", "Please select your spouse's ITR option.");
    if (!hasValue(data.What_is_personal_income_of_your_spouse_in_a_year)) return cifSchengenFail("What_is_personal_income_of_your_spouse_in_a_year", "Please enter your spouse's annual income.");
    if (!hasValue(data.Have_your_spouse_ever_visited_country_other_than_their_country_of_nationality)) return cifSchengenFail("Have_your_spouse_ever_visited_country_other_than_their_country_of_nationality", "Please select whether your spouse has visited another country.");
    if (!hasValue(data.Have_your_spouse_applied_for_a_Schengen_Visa_in_the_past_5_years)) return cifSchengenFail("Have_your_spouse_applied_for_a_Schengen_Visa_in_the_past_5_years", "Please select whether your spouse applied for a Schengen visa in the past 5 years.");
    if (!hasValue(data.Have_your_spouse_provided_fingerprints_for_any_Schengen_Visa_previously)) return cifSchengenFail("Have_your_spouse_provided_fingerprints_for_any_Schengen_Visa_previously", "Please select your spouse's fingerprint status.");
  }

  // ── Spouse — not accompanying ──
  if (data.Do_your_spouse_accompanying_you_for_this_visit === "No") {
    if (!hasValue(data.Name_of_your_spouse_As_per_passport)) return cifSchengenFail("Name_of_your_spouse_As_per_passport", "Please enter your spouse's name.");
    if (!hasValue(data.Spouse_s_date_of_birth)) return cifSchengenFail("Spouse_s_date_of_birth", "Please enter your spouse's date of birth.");
    if (!hasValue(data.Name_of_City_Town_Village_they_live)) return cifSchengenFail("Name_of_City_Town_Village_they_live", "Please enter your spouse's city/town/village.");
    if (!hasValue(data.In_which_country_they_live)) return cifSchengenFail("In_which_country_they_live", "Please enter your spouse's country.");
    if (!hasValue(data.Current_occupation_of_your_spouse)) return cifSchengenFail("Current_occupation_of_your_spouse", "Please enter your spouse's occupation.");
  }

  // ── Spouse — live outside home country ──
  if (data.Do_your_spouse_live_outside_your_home_country === "Yes" && !hasValue(data.Your_spouse_s_current_country_of_residence)) {
    return cifSchengenFail("Your_spouse_s_current_country_of_residence", "Please enter your spouse's current country of residence.");
  }

  // ── Spouse — employment source of income ──
  const spouseOccupation = data.Please_select_employment_source_of_income_of_your_spouse;
  if (contains(spouseOccupation, "Employed (Job)")) {
    if (!hasValue(data.Name_of_the_current_organisation_your_spouse_work_for)) return cifSchengenFail("Name_of_the_current_organisation_your_spouse_work_for", "Please enter your spouse's organisation name.");
    if (!hasValue(data.What_is_your_spouse_s_designation_position_in_the_organisation)) return cifSchengenFail("What_is_your_spouse_s_designation_position_in_the_organisation", "Please enter your spouse's designation.");
    if (!hasValue(data.Address_of_the_organisation_your_spouse_working_for1)) return cifSchengenFail("Address_of_the_organisation_your_spouse_working_for1", "Please enter your spouse's organisation address.");
    if (!hasValue(data.What_is_your_spouse_s_present_annual_salary)) return cifSchengenFail("What_is_your_spouse_s_present_annual_salary", "Please enter your spouse's annual salary.");
  }
  if (contains(spouseOccupation, "Self employed (Freelancer)")) {
    if (!hasValue(data.Please_describe_What_do_your_spouse_exactly_do_as_self_employed_person)) return cifSchengenFail("Please_describe_What_do_your_spouse_exactly_do_as_self_employed_person", "Please describe your spouse's self-employed work.");
    if (!hasValue(data.What_is_your_spouse_s_annual_turnover_of_feelancing_work)) return cifSchengenFail("What_is_your_spouse_s_annual_turnover_of_feelancing_work", "Please enter your spouse's annual freelancing turnover.");
    if (!hasValue(data.How_much_amount_your_spouse_earn_annually_from_freelancing_work)) return cifSchengenFail("How_much_amount_your_spouse_earn_annually_from_freelancing_work", "Please enter your spouse's annual freelancing income.");
  }
  if (contains(spouseOccupation, "Business Owner")) {
    if (!hasValue(data.What_type_of_business_do_your_spouse_own)) return cifSchengenFail("What_type_of_business_do_your_spouse_own", "Please enter your spouse's business type.");
    if (!hasValue(data.What_is_the_name_of_your_spouse_s_business)) return cifSchengenFail("What_is_the_name_of_your_spouse_s_business", "Please enter your spouse's business name.");
    if (!hasValue(data.Please_provide_address_of_your_spouse_s_business)) return cifSchengenFail("Please_provide_address_of_your_spouse_s_business", "Please enter your spouse's business address.");
    if (!hasValue(data.What_is_the_annual_turnover_of_your_spouse_s_business)) return cifSchengenFail("What_is_the_annual_turnover_of_your_spouse_s_business", "Please enter your spouse's business turnover.");
    if (!hasValue(data.How_much_amount_you_spouse_earn_annually_from_business)) return cifSchengenFail("How_much_amount_you_spouse_earn_annually_from_business", "Please enter your spouse's annual income from the business.");
    if (!hasValue(data.Please_tell_us_more_about_your_spouse_s_business_Industry_products_you_sell_what_activities_you_pe)) return cifSchengenFail("Please_tell_us_more_about_your_spouse_s_business_Industry_products_you_sell_what_activities_you_pe", "Please provide more details about your spouse's business.");
  }
  if (contains(spouseOccupation, "Retired")) {
    if (!hasValue(data.What_was_the_name_of_organisation_where_your_spouse_get_retired)) return cifSchengenFail("What_was_the_name_of_organisation_where_your_spouse_get_retired", "Please enter the organisation your spouse retired from.");
    if (!hasValue(data.What_was_the_last_designation_position_in_the_oganisation_your_spouse_get_retired)) return cifSchengenFail("What_was_the_last_designation_position_in_the_oganisation_your_spouse_get_retired", "Please enter your spouse's last designation.");
    if (!hasValue(data.When_did_your_spouse_join_this_organisation)) return cifSchengenFail("When_did_your_spouse_join_this_organisation", "Please enter when your spouse joined that organisation.");
    if (!hasValue(data.When_did_your_spouse_retire)) return cifSchengenFail("When_did_your_spouse_retire", "Please enter your spouse's retirement date.");
    if (!hasValue(data.Do_your_spouse_currently_receive_pension)) return cifSchengenFail("Do_your_spouse_currently_receive_pension", "Please select your spouse's pension status.");
  }
  if (contains(spouseOccupation, "Student")) {
    if (!hasValue(data.What_is_the_name_of_the_institute_your_spouse_is_currently_studying_at)) return cifSchengenFail("What_is_the_name_of_the_institute_your_spouse_is_currently_studying_at", "Please enter your spouse's institute name.");
    if (!hasValue(data.What_is_name_of_program_course_grade_your_spouse_currently_studying)) return cifSchengenFail("What_is_name_of_program_course_grade_your_spouse_currently_studying", "Please enter your spouse's course/grade.");
    if (!hasValue(data.Address_of_institute_your_spouse_is_currently_studying)) return cifSchengenFail("Address_of_institute_your_spouse_is_currently_studying", "Please enter your spouse's institute address.");
  }
  if (contains(spouseOccupation, "Other") && !hasValue(data.Please_describe_your_spouse_s_other_source_of_income_employment_which_is_not_listed_above)) {
    return cifSchengenFail("Please_describe_your_spouse_s_other_source_of_income_employment_which_is_not_listed_above", "Please describe your spouse's other source of income.");
  }
  if (data.Do_your_spouse_currently_receive_pension === "Yes" && !hasValue(data.What_is_the_monthly_pension_amount_your_spouse_receives)) {
    return cifSchengenFail("What_is_the_monthly_pension_amount_your_spouse_receives", "Please enter your spouse's monthly pension amount.");
  }

  // ── Spouse family member subform ──
  if (data.Marital_Status === "Married" && data.Do_your_spouse_accompanying_you_for_this_visit === "Yes") {
    const spouseFamily = Array.isArray(data.Family_member_living_in_home_country_Spouse) ? data.Family_member_living_in_home_country_Spouse : [];
    for (const s of spouseFamily) {
      if (!hasValue(s.Relationship_with_you1)) return cifSchengenFail("Family_member_living_in_home_country_Spouse", "Please select relationship for each spouse family member.");
      if (!hasValue(s.Name_of_the_family_member?.first_name) || !hasValue(s.Name_of_the_family_member?.last_name)) return cifSchengenFail("Family_member_living_in_home_country_Spouse", "Please enter surname and given name for each spouse family member.");
      if (!hasValue(s.Date_of_Birth_of_family_member)) return cifSchengenFail("Family_member_living_in_home_country_Spouse", "Please select date of birth for each spouse family member.");
      if (!hasValue(s.Where_do_they_live_Name_of_City_Town_Village)) return cifSchengenFail("Family_member_living_in_home_country_Spouse", "Please enter city/town/village for each spouse family member.");
      if (!hasValue(s.Current_occupation_of_family_member)) return cifSchengenFail("Family_member_living_in_home_country_Spouse", "Please enter occupation for each spouse family member.");
    }
  }

  // ── Spouse travel/Schengen history ──
  if (data.Have_your_spouse_provided_fingerprints_for_any_Schengen_Visa_previously === "Yes" && !hasValue(data.When_did_your_spouse_submitted_fingerprints_for_Schengen_Visa)) {
    return cifSchengenFail("When_did_your_spouse_submitted_fingerprints_for_Schengen_Visa", "Please enter when your spouse submitted fingerprints for their Schengen visa.");
  }
  if (data.Have_your_spouse_ever_visited_country_other_than_their_country_of_nationality === "Yes" && !hasValue(data.Please_select_country_s_your_spouse_visited_in_past_10_years)) {
    return cifSchengenFail("Please_select_country_s_your_spouse_visited_in_past_10_years", "Please select the countries your spouse has visited in the past 10 years.");
  }
  if (data.Have_your_spouse_applied_for_a_Schengen_Visa_in_the_past_5_years === "Yes" && !hasValue(data.Please_provide_your_spouse_s_visa_number)) {
    return cifSchengenFail("Please_provide_your_spouse_s_visa_number", "Please enter your spouse's Schengen visa number.");
  }

  return "";
}
    function cifAustraliaHasValue(value) {
      if (Array.isArray(value)) return value.length > 0;
      if (value && typeof value === "object") return Object.values(value).some(cifAustraliaHasValue);
      return value !== undefined && value !== null && String(value).trim() !== "";
    }

    function cifValidateAustraliaForm1(data) {
      const need = (field, message) => cifAustraliaHasValue(data?.[field]) ? "" : message;
      const needAll = (fields, message) => fields.every(field => cifAustraliaHasValue(data?.[field])) ? "" : message;
      const rows = field => Array.isArray(data?.[field]) ? data[field] : [];
      let error = "";

      if (data.Is_the_applicant_currently_outside_Australia === "Yes") {
        error = needAll([
          "Select_your_current_location_Country","Select_your_status_at_this_location",
          "Give_details_of_why_the_applicant_is_at_their_current_location_including_the_end_date_of_their_cur",
          "Select_the_stream_the_applicant_is_applying_for","Select_all_reasons_for_visiting_Australia",
          "Give_details_of_any_significant_dates_on_which_the_applicant_needs_to_be_in_Australia"
        ], "Complete all current-location and Australian visit details.");
      } else if (data.Is_the_applicant_currently_outside_Australia === "No") {
        error = needAll(["Length_of_further_stay","Requested_end_date","Reason_for_further_stay","Is_the_applicant_travelling_as_a_representative_of_a_foreign_government_or_travelling_on_a_United"], "Complete all further-stay details.");
      }
      if (error) return error;

      if (data.Do_you_have_have_a_national_identity_card === "Yes") {
        error = needAll(["Name","Identification_number","Country_of_issue","Date_of_issue","Date_of_expiry"], "Complete all national identity card details.");
      } else if (data.Do_you_have_have_a_national_identity_card === "No") {
        error = need("Give_the_reason_the_applicant_cannot_provide_details_of_a_national_identity_card_issued_by_their_c", "Explain why a national identity card cannot be provided.");
      }
      if (error) return error;

      if (data.Is_the_applicant_a_Pacific_Australia_Card_holder === "Yes" && (error = need("Pacific_Australia_Card_serial_number", "Enter the Pacific-Australia Card serial number."))) return error;
      if (data.Is_this_applicant_currently_or_have_they_ever_been_known_by_any_other_names === "Yes") {
        if ((error = needAll(["Previous_name","Reason_for_name_change"], "Enter the applicant's previous name and reason for the change."))) return error;
        if (data.Reason_for_name_change === "Other" && (error = need("Give_detailed_reason_for_name_change", "Provide the detailed reason for the name change."))) return error;
      }
      if (data.Is_this_applicant_a_citizen_of_the_selected_country_of_passport === "No" && data.Is_this_applicant_a_citizen_of_any_other_country === "No") {
        if ((error = need("Is_this_applicant_currently_stateless", "Select whether the applicant is currently stateless."))) return error;
        if (data.Is_this_applicant_currently_stateless === "No" && (error = need("Give_details_as_to_why_the_applicant_is_not_a_citizen_of_any_country_and_is_not_stateless", "Explain why the applicant is neither a citizen nor stateless."))) return error;
      }
      if (data.Have_you_undertaken_a_health_examination_for_an_Australian_visa_in_the_last_12_months === "Yes" && (error = need("Give_details_of_your_heath_examination", "Enter the Australian visa health-examination details."))) return error;

      if (data.Do_you_have_any_other_passports_or_documents_for_travel === "Yes") {
        if ((error = need("Does_you_intend_to_on_a_United_Nations_Laissez_Passer", "Select the UN Laissez-Passer option."))) return error;
        const documents = rows("Add_document_other_passport_Travel");
        if (!documents.length) return "Add at least one other passport or travel document.";
        const common = ["Name","Date_of_Birth","Country_of_issue","Nationality_of_document_holder"];
        for (const document of documents) {
          if (!cifAustraliaHasValue(document.Type_of_document)) return "Select a document type for every travel document.";
          let required = common;
          if (["DFTTA","PLO56(M56)"].includes(document.Type_of_document)) required = [...common,"Document_number"];
          else if (document.Type_of_document === "Immicard") required = [...common,"Sex","Date_of_expiry","Place_of_issue_issuing_authority"];
          else if (document.Type_of_document === "Passport") required = [...common,"Sex","Passport_number","Date_of_issue","Date_of_expiry","Place_of_issue_issuing_authority"];
          else if (["Titre de Voyage","Other Travel document"].includes(document.Type_of_document)) required = [...common,"Sex","Document_number","Date_of_issue","Date_of_expiry","Place_of_issue_issuing_authority"];
          if (!required.every(field => cifAustraliaHasValue(document[field]))) return `Complete all required fields for the ${document.Type_of_document} document.`;
        }
      }

      if (data.Do_you_have_other_identity_documents === "Yes") {
        const identityDocuments = rows("Add_identity_document");
        if (!identityDocuments.length) return "Add at least one other identity document.";
        if (identityDocuments.some(row => !["Name","Type_of_document","Identification_number","Country_of_issue"].every(field => cifAustraliaHasValue(row[field])))) return "Complete all required fields for every identity document.";
      }
      if (data.Are_there_any_other_persons_travelling_with_the_applicant_to_Australia === "Yes") {
        const companions = rows("Add_Companions");
        if (!companions.length) return "Add at least one travelling companion.";
        if (companions.some(row => !["Relationship_to_the_applicant","Name_of_accompanying_member","Sex","Date_of_birth"].every(field => cifAustraliaHasValue(row[field])))) return "Complete all required details for every travelling companion.";
      }
      if (data.Is_the_postal_address_the_same_as_the_residential_address === "No" && (error = need("Postal_address", "Enter the applicant's postal address."))) return error;

      if (data.Will_the_applicant_undertake_a_course_of_study_in_Australia === "Yes" &&
          (error = needAll(["Course_name","Institution_name","Course_start_date","Course_end_date"], "Complete all Australian course details."))) return error;

      const employment = data.Employment_status;
      if (["Employed","Self employed"].includes(employment)) {
        error = needAll(["Occupation_grouping","Organisation","Start_date_with_current_employer","Organisation_address"], "Complete the applicant's current employment details.");
      } else if (employment === "Unemployed") {
        error = needAll(["Date_since_you_are_unemployed","Last_employment_position"], "Complete the applicant's unemployment details.");
      } else if (employment === "Retired") {
        error = need("Retirement_date", "Enter the applicant's retirement date.");
      } else if (employment === "Student") {
        error = needAll(["Current_course_name","Current_institution_name","Current_study_start_date","Current_study_end_date"], "Complete the applicant's current study details.");
        if (!error && data.Current_study_start_date > data.Current_study_end_date) error = "Current study end date must be after the start date.";
      } else if (employment === "Other") {
        error = need("Provide_detail_about_your_other_employment", "Provide the applicant's other employment details.");
      }
      if (error) return error;

      const funding = data.Give_details_of_how_the_applicant_s_stay_in_Australia_will_be_funded;
      if (funding === "Self funded") error = need("What_funds_will_the_applicant_have_available_to_support_their_stay_in_Australia", "Enter the funds available for the applicant's stay.");
      else if (funding === "Supported by current employer") error = needAll(["Type_of_support","What_funds_will_the_applicant_have_available_to_support_their_stay_in_Australia"], "Complete the employer support details.");
      else if (funding === "Supported by other organisation") error = needAll(["Type_of_support","What_funds_will_the_applicant_have_available_to_support_their_stay_in_Australia","Supporting_organisation_address"], "Complete the supporting organisation details.");
      else if (funding === "Supported by other person") error = needAll(["Type_of_support","What_funds_will_the_applicant_have_available_to_support_their_stay_in_Australia","Supporter_s_relationship_to_the_applicant","Name_of_supporting_person","Address_of_the_supporting_person"], "Complete the supporting person's details.");
      return error;
    }

    function cifValidateAustraliaForm3(data) {
      const rows = field => Array.isArray(data?.[field]) ? data[field] : [];
      const validateRows = (trigger, field, required, emptyMessage, incompleteMessage, datePair) => {
        if (data?.[trigger] !== "Yes") return "";
        const values = rows(field);
        if (!values.length) return emptyMessage;
        for (const row of values) {
          if (!required.every(key => cifAustraliaHasValue(row[key]))) return incompleteMessage;
          if (datePair && row[datePair[0]] > row[datePair[1]]) return `${datePair[2]} end date must be after the start date.`;
        }
        return "";
      };
      let error = "";
      error = validateRows("In_the_last_five_years_has_the_applicant_visited_or_lived_outside_their_country_of_passport_for_mo","Add_visit_details",["Dropdown","Visit_start_date","Visit_end_date"],"Add at least one visit detail.","Complete every visit-history entry.",["Visit_start_date","Visit_end_date","Visit"]); if (error) return error;

      const requiredDetails = [
        ["Does_the_applicant_intend_to_enter_a_hospital_or_a_health_care_facility_including_nursing_homes_wh",["Select_reason","Give_details_for_intention_to_enter_hospitals_or_health_care_facilities"],"Complete the hospital or healthcare-facility details."],
        ["Does_the_applicant_intend_to_work_study_or_train_within_aged_care_or_disability_care_while_in_Aust",["On_which_role_the_applicant_will_work_in_age_care_or_disability_care","Give_detail_about_applicant_s_intention_to_work_in_age_care_or_disability_care"],"Complete the aged or disability-care details."],
        ["Has_the_applicant_tuberculosis",["Give_detail_about_contact_with_tuberculosis"],"Provide the tuberculosis details."],
        ["During_their_proposed_visit_to_Australia_does_applicant_expect_to_incur_medical_costs",["Select_Condition","Give_details_of_the_medical_condition_for_which_the_applicant_expects_to_incur_costs_require_treat"],"Complete the expected medical-cost details."],
        ["Does_the_applicant_require_ongoing_medical_care_or_need_special_equipment_assistive_technology_or",["Give_detail_about_requirement_of_Health_or_Community_Care"],"Provide the ongoing medical-care details."],
        ["Has_the_applicant_ever_been_the_subject_of_an_arrest_warrant_or_Interpol_notice",["Give_details_of_an_arrest_warrant_or_Interpol_notice"],"Provide the arrest warrant or Interpol notice details."],
        ["Has_the_applicant_ever_been_found_guilty_of_a_sexually_based_offence_involving_a_child_including_w",["Give_details_of_a_sexually_based_offence_involving_a_child"],"Provide the child-related offence details."],
        ["Has_the_applicant_ever_been_named_on_a_sex_offender_register",["Give_details_for_applicant_s_name_on_a_sex_offender_register"],"Provide the sex-offender-register details."],
        ["Has_the_applicant_ever_been_acquitted_of_any_offence_on_the_grounds_of_unsoundness_of_mind_or_insa",["Give_details_about_acquittal"],"Provide the acquittal details."],
        ["Has_the_applicant_ever_been_found_by_a_court_not_fit_to_plead",["Give_detail_of_incident_found_by_a_court_not_fit_to_plead"],"Provide the court finding details."],
        ["Has_the_applicant_ever_been_directly_or_indirectly_involved_in_or_associated_with_activities_which",["Give_details_of_such_involvement_association_and_activity"],"Provide the national-security activity details."],
        ["Has_the_applicant_ever_been_charged_with_or_indicted_for_genocide_war_crimes_crimes_against_humani",["Give_details_of_such_genocide_war_crimes_crimes_against_humanity_torture_slavery_or_any_other_crim"],"Provide the international-crime details."],
        ["Has_the_applicant_ever_been_associated_with_a_person_group_or_organisation_that_has_been_or_is_inv",["Give_detail_of_such_association_or_involvement_in_criminal_conduct"],"Provide the criminal-association details."],
        ["A_applicant_ever_been_associated_with_an_organisation_engaged_in_violence_or_engaged_in_acts_of_vi",["Give_details_of_association_with_an_organisation_engaged_in_above_stated_activities"],"Provide the violent-organisation association details."],
        ["Has_the_applicant_ever_been_involved_in_people_smuggling_or_people_trafficking_offences",["Give_details_about_involvement_in_people_smuggling_or_people_trafficking_offences"],"Provide the people-smuggling or trafficking details."],
        ["Has_the_applicant_ever_been_removed_deported_or_excluded_from_any_country_including_Australia",["Give_details_about_removal_deportation_or_exclusion_from_any_country_including_Australia"],"Provide the removal, deportation or exclusion details."],
        ["Has_the_applicant_ever_overstayed_a_visa_in_any_country_including_Australia",["Give_details_about_overstay_a_visa_in_any_country_including_Australia"],"Provide the visa-overstay details."],
        ["Has_the_applicant_ever_had_any_outstanding_debts_to_the_Australian_Government_or_any_public_author",["Give_details_about_such_debts"],"Provide the outstanding-debt details."],
        ["Has_the_applicant_held_or_does_the_applicant_currently_hold_a_visa_to_Australia_or_any_other_country",["Give_details_of_Visa_your_are_currently_holding"],"Provide the current or previous visa details."],
        ["Has_the_applicant_ever_been_in_Australia_or_any_other_country_and_not_complied_with_visa_condition",["Give_details_of_such_incidents"],"Provide the visa non-compliance details."],
        ["Has_the_applicant_ever_had_a_visa_for_Australia_or_any_other_country_refused_or_cancelled",["Give_details_of_visa_refusal_and_or_cancellation"],"Provide the visa refusal or cancellation details."]
      ];
      for (const [trigger, fields, message] of requiredDetails) {
        if (data?.[trigger] === "Yes" && !fields.every(field => cifAustraliaHasValue(data?.[field]))) return message;
      }

      const subforms = [
        ["Has_the_applicant_ever_been_charged_with_any_offence_that_is_currently_awaiting_legal_action","Add_offense_detail",["Offence_type","Date_of_offence","Description_of_the_offence"],"Add at least one pending-offence detail.","Complete every pending-offence entry."],
        ["Has_the_applicant_ever_been_convicted_of_an_offence_in_any_country_including_any_conviction_which","Add_details_in_conviction_offense",["Offence_type","Date_of_conviction","Description_of_the_conviction_including_any_penalties_imposed"],"Add at least one conviction detail.","Complete every conviction entry."],
        ["A_applicant_ever_been_the_subject_of_a_domestic_violence_or_family_violence_order_or_any_other_ord","Add_details_in_Domestic_violence",["Date_order_raised","Give_details_of_domestic_violence_order"],"Add at least one domestic-violence-order detail.","Complete every domestic-violence-order entry."],
        ["Has_the_applicant_ever_served_in_a_military_force_police_force_state_sponsored_private_militia_or","Add_Service_details",["Country_of_service","Service_start_date","Service_end_date","Give_detail_of_your_service"],"Add at least one military or police service detail.","Complete every military or police service entry.",["Service_start_date","Service_end_date","Military or police service"]],
        ["Has_the_applicant_ever_undergone_any_military_paramilitary_training_been_trained_in_weapons_explos","Add_training_details",["Country_of_training","Start_date_of_training","End_date_of_training","Give_details_of_training"],"Add at least one military or weapons-training detail.","Complete every military or weapons-training entry.",["Start_date_of_training","End_date_of_training","Military or weapons training"]]
      ];
      for (const args of subforms) {
        error = validateRows(...args);
        if (error) return error;
      }
      return "";
    }

    function cifValidateGeneric(travId, instance) {
      for (const stage of instance.definition.stages) {
        const data = cifInstanceData(travId, instance.id)[stage.tag] || {};
        const missing = cifCustomerFields(state.cifMetadata[stage.form]).filter(field => {
          if (!cifGenericFieldVisible(instance, stage, data, field.link_name)) return false;
          if (!field.mandatory) return false;
          const value = data[field.link_name];
          if (Array.isArray(value)) return !value.length;
          if (value && typeof value === "object") return !Object.values(value).some(v => String(v || "").trim());
          return value === undefined || value === null || String(value).trim() === "";
        });
if (missing.length) {
  const firstMissing = missing[0];
  const missingConfig = GENERIC_CATEGORY_CONFIG[instance.type];
  state.activeCifStage = stage.tag;
  if (missingConfig) {
    state.activeGenericCifCategory = missingConfig.fieldMap[firstMissing.link_name] || "__other__";
  }
  return `${stage.title}: complete “${firstMissing.display_name}”.`;
}

if (
  instance?.type === "usa" &&
  stage.form === "Us_Form_1"
) {
  const conditionalError = cifValidateUsForm1(data);

  if (conditionalError) {
    return `${stage.title}: ${conditionalError}`;
  }
}
if (
  instance?.type === "usa" &&
  stage.form === "Us_Form_2"
) {
  const conditionalError = cifValidateUsForm2(data);

  if (conditionalError) {
    return `${stage.title}: ${conditionalError}`;
  }
}
if (
  instance?.type === "usa" &&
  stage.form === "Us_Form_3"
) {
  const conditionalError = cifValidateUsForm3(data);

  if (conditionalError) {
    return `${stage.title}: ${conditionalError}`;
  }
}
if (
  instance?.type === "usa" &&
  stage.form === "Us_Form_4"
) {
  const conditionalError = cifValidateUsForm4(data);

  if (conditionalError) {
    return `${stage.title}: ${conditionalError}`;
  }
}

if (instance?.type === "australia" && stage.form === "Australia_Customer_Information") {
  const conditionalError = cifValidateAustraliaForm1(data);
  if (conditionalError) {
    state.activeCifStage = stage.tag;
    return `${stage.title}: ${conditionalError}`;
  }
}
if (instance?.type === "australia" && stage.form === "Australia_Customer_Information_3") {
  const conditionalError = cifValidateAustraliaForm3(data);
  if (conditionalError) {
    state.activeCifStage = stage.tag;
    return `${stage.title}: ${conditionalError}`;
  }
}

if (instance?.type === "schengen") {
  state.__schengenValidationField = null;
  const conditionalError = cifValidateSchengen(data);

  if (conditionalError) {
    const failedField = state.__schengenValidationField;
    const schengenConfig = GENERIC_CATEGORY_CONFIG[instance.type];
    if (failedField && schengenConfig) {
      state.activeGenericCifCategory = schengenConfig.fieldMap[failedField] || "__other__";
      state.activeCifStage = stage.tag;
    }
    return `${stage.title}: ${conditionalError}`;
  }
}
      }
      return "";
    }

    function cifChainLinks(instance, ids, stageTag) {
      const links = {};
      if (instance.type === "australia") {
        const names = {f1:"Australia_Customer_Information",f2:"Australia_Customer_Information_2",f3:"Australia_Customer_Information_3",f4:"Australia_Customer_Information_4"};
        Object.entries(ids).forEach(([tag,id]) => { if (tag !== stageTag && id) links[names[tag]] = id; });
      }
      if (instance.type === "usa") {
        const names = {f1:"Us_Form_1",f2:"Us_Form_2",f3:"Us_Form_3",f4:"Us_Form_4"};
        Object.entries(ids).forEach(([tag,id]) => { if (tag !== stageTag && id) links[names[tag]] = id; });
      }
      if (instance.type === "uk") {
        const names = {f1:"UK_CIF_1",f2:"UK_CIF_2",f3:"UK_CIF_3"};
        Object.entries(ids).forEach(([tag,id]) => { if (tag !== stageTag && id) links[names[tag]] = id; });
      }
      return links;
    }

    async function saveGenericCIFForTraveller(travId, instance) {
      await cifLoadInstanceMetadata(instance);
      const validation = cifValidateGeneric(travId, instance);
      if (validation) throw new Error(validation);
      const context = cifTravellerContext(travId, instance);
      const existing = cifRecordState(travId, instance.id);
      const ids = Object.assign({}, existing?.ids || {});
      for (const stage of instance.definition.stages) {
        const payload = cifGenericBuildPayload(travId, instance, stage);
        if (stage.tag === "f1") Object.assign(payload, cifCommonPayload(instance.type, context));
        Object.assign(payload, cifChainLinks(instance, ids, stage.tag));
        if (ids[stage.tag]) {
          await cifUpdateRecord(stage.form, stage.report, ids[stage.tag], payload);
        } else {
          ids[stage.tag] = await cifCreateRecord(stage.form, payload);
          cifSetPartialRecordState(travId, instance.id, ids);
        }
      }
      // Complete the bidirectional chain now that every stage ID is known.
      for (const stage of instance.definition.stages) {
        const links = cifChainLinks(instance, ids, stage.tag);
        if (Object.keys(links).length) await cifUpdateRecord(stage.form, stage.report, ids[stage.tag], links);
      }
      cifSetRecordState(travId, instance.id, ids);
      return ids;
    }

    async function saveUKCIFForTraveller(travId, instance) {
      const context = cifTravellerContext(travId, instance);
      const existing = cifRecordState(travId, instance.id);
      const ids = Object.assign({}, existing?.ids || {});
      const data = cifInstanceData(travId, instance.id);
      const purposeValue = (data.f1 || {}).What_is_the_main_reason_for_your_visit_to_the_UK || "";
      const stages = instance.definition.stages;
      const extras = {
        f1:cifCommonPayload("uk", context),
        f2:{ What_is_the_main_reason_for_your_visit_to_the_UK1:purposeValue },
        f3:{}
      };
      for (const stage of stages) {
        const payload = cifBuildFormPayload(travId, stage.tag, Object.assign({}, extras[stage.tag], cifChainLinks(instance, ids, stage.tag)), instance.id);
        if (ids[stage.tag]) {
          await cifUpdateRecord(stage.form, stage.report, ids[stage.tag], payload);
        } else {
          ids[stage.tag] = await cifCreateRecord(stage.form, payload);
          cifSetPartialRecordState(travId, instance.id, ids);
        }
      }
      for (const stage of stages) {
        const links = cifChainLinks(instance, ids, stage.tag);
        if (Object.keys(links).length) await cifUpdateRecord(stage.form, stage.report, ids[stage.tag], links);
      }
      cifSetRecordState(travId, instance.id, ids);
      return ids;
    }

    async function saveCIFDataForTraveller(travId, instanceId) {
      const instance = cifGetInstance(instanceId || state.activeCifInstance);
      if (!instance) throw new Error("No destination CIF was selected.");
      return instance.type === "uk"
        ? saveUKCIFForTraveller(travId, instance)
        : saveGenericCIFForTraveller(travId, instance);
    }

    async function saveCIFData() {
      saveDraft(false);
      const travellers = applicationData.deal.travellers;
      const results = {};
      for (const instance of cifDestinationInstances()) {
        for (const t of travellers) {
          try {
            results[`${t.id}:${instance.id}`] = await saveCIFDataForTraveller(t.id, instance.id);
          } catch (error) {
            console.error(`[Winny] CIF save failed for traveller ${t.id}, ${instance.country}:`, error);
            toast(`CIF save failed for ${t.firstName || "traveller"} (${instance.country}): ${error.message}`);
            throw error;
          }
        }
      }
      return results;
    }


    // ─── ZOHO TRANSPORT HELPERS ──────────────────────────────────────────────


    // ── CRM-style multi-select dropdown handlers (source 13909-14013, 14024-14038) ──
    function cmsToggle(safeId, path) {
  const drop    = document.getElementById("cms-drop-" + safeId);
  const trigger = document.getElementById("cms-trigger-" + safeId);
  if (!drop) return;
  const isOpen  = drop.classList.contains("open");
  // Close all other open dropdowns first
  document.querySelectorAll(".cms-dropdown.open").forEach(d => {
    d.classList.remove("open");
    d.closest(".cms-wrap")?.querySelector(".cms-trigger")?.classList.remove("open");
  });
  if (!isOpen) {
    const rect = trigger.getBoundingClientRect();
    drop.style.top   = `${rect.bottom + 4}px`;
    drop.style.left  = `${rect.left}px`;
    drop.style.width = `${rect.width}px`;

    drop.classList.add("open");
    trigger.classList.add("open");
    const search = drop.querySelector(".cms-search");
    if (search) { search.value = ""; cmsFilter(safeId, ""); search.focus(); }
  }
}

    function cmsSelect(path, country, safeId) {
      const current = String(getByPath(applicationData, path) || "").split(",").map(s => s.trim()).filter(Boolean);
      const idx     = current.indexOf(country);
      const updated = idx >= 0 ? current.filter(c => c !== country) : [...current, country];
      setByPath(applicationData, path, updated.join(", "));
      if (path === "questionnaire.applyingCountries" || path === "deal.destination") {
        applicationData.stepStatus.cifCompleted = false;
        state.activeCifInstance = null;
        state.activeCifStage = null;
      }
      if (path === "deal.destination") { reconcileTravellerCountries(); requestRender(); }
      // Update option highlight
      const opt = document.querySelector(`#cms-list-${safeId} [data-val="${country}"]`);
      if (opt) opt.classList.toggle("selected", idx < 0);
      // Update count
      const count = document.getElementById("cms-count-" + safeId);
      if (count) count.textContent = updated.length + " selected";
      // Rebuild trigger tags
      cmsRebuildTrigger(path, safeId, updated);
      markAutoSavePending();
    }

   function cmsRemove(path, country) {
      const safeId  = path.replace(/\./g, "-");
      const current = String(getByPath(applicationData, path) || "").split(",").map(s => s.trim()).filter(Boolean);
      const updated = current.filter(c => c !== country);
      setByPath(applicationData, path, updated.join(", "));
      if (path === "questionnaire.applyingCountries" || path === "deal.destination") {
        applicationData.stepStatus.cifCompleted = false;
        state.activeCifInstance = null;
        state.activeCifStage = null;
      }
      if (path === "deal.destination") { reconcileTravellerCountries(); requestRender(); }
      const opt = document.querySelector(`#cms-list-${safeId} [data-val="${country}"]`);
      if (opt) opt.classList.remove("selected");
      const count = document.getElementById("cms-count-" + safeId);
      if (count) count.textContent = updated.length + " selected";
      cmsRebuildTrigger(path, safeId, updated);
      markAutoSavePending();
    }

    function cmsClear(path, safeId) {
      setByPath(applicationData, path, "");
      if (path === "questionnaire.applyingCountries" || path === "deal.destination") {
        applicationData.stepStatus.cifCompleted = false;
        state.activeCifInstance = null;
        state.activeCifStage = null;
      }
      document.querySelectorAll(`#cms-list-${safeId} .cms-option`).forEach(o => o.classList.remove("selected"));
      const count = document.getElementById("cms-count-" + safeId);
      if (count) count.textContent = "0 selected";
      cmsRebuildTrigger(path, safeId, []);
      if (path === "deal.destination") { reconcileTravellerCountries(); requestRender(); }
      markAutoSavePending();
    }

    function cmsRebuildTrigger(path, safeId, selected) {
      const trigger = document.getElementById("cms-trigger-" + safeId);
      if (!trigger) return;
      const isOpen  = trigger.classList.contains("open");
      trigger.innerHTML = selected.length
        ? selected.map(c => `<span class="cms-tag">${escapeHtml(c)}<button type="button" onclick="cmsRemove('${path}','${escapeHtml(c)}');event.stopPropagation()">×</button></span>`).join("")
        : `<span class="cms-placeholder">Select countries...</span>`;
      if (isOpen) trigger.classList.add("open");
    }

    function cmsFilter(safeId, query) {
      const list = document.getElementById("cms-list-" + safeId);
      if (!list) return;
      const q     = query.toLowerCase().trim();
      let   shown = 0;
      list.querySelectorAll(".cms-option").forEach(o => {
        const match = !q || o.dataset.val.toLowerCase().includes(q);
        o.style.display = match ? "" : "none";
        if (match) shown++;
      });
      let empty = list.querySelector(".cms-empty");
      if (!shown) {
        if (!empty) { empty = document.createElement("div"); empty.className = "cms-empty"; list.appendChild(empty); }
        empty.textContent = `No results for "${query}"`;
      } else if (empty) { empty.remove(); }
    }
    function closeAllCmsDropdowns(event) {
  // Don't close if the scroll happened *inside* the dropdown itself
  // (e.g. scrolling through the options list) — only close on page/ancestor scroll.
  if (event && event.target && event.target.closest && event.target.closest(".cms-dropdown")) return;
  document.querySelectorAll(".cms-dropdown.open").forEach(d => {
    d.classList.remove("open");
    d.closest(".cms-wrap")?.querySelector(".cms-trigger")?.classList.remove("open");
  });
}
// NOTE: the original attached window scroll/resize listeners here at module top
// level; the <CIF> island attaches them on mount instead (see CIF.jsx).

    // Legacy helpers kept for compatibility
    function removeCountryTag(path, country) { cmsRemove(path, country); }
    function refreshCountryTags() {}

export {
  cifMarkInstanceDirtyFromPath, completeCIF, renderCIF,
  cifDestinationInstances, cifIsInstanceSaved, cifInstanceData, cifSwitchTraveller,
  cifSwitchInstance, cifSwitchStage, cifSwitchCategory, cifSwitchGenericCategory,
  cifGoToCategoryOffset, cifSetYesNo, cifToggleMulti, cifSchengenToggleMulti,
  cifAddSubformRow, cifRemoveSubformRow, cifGenericAddRow, cifGenericRemoveRow,
  cifRetryMetadata, cifSaveTraveller, cifValidateUsForm1, cifValidateGeneric,
  saveCIFData, cmsToggle, cmsSelect, cmsRemove, cmsClear, cmsFilter, closeAllCmsDropdowns
};
