# Deluge Changes — Document Checklist Widget

## 1 — Add `traveller_id` & `traveller_name` to "Get Document Checklist"

Your existing branch already fetches Document records and builds a JSON list.
You only need to pull the `Traveller_Info` lookup from each record and add
two keys to every item map.

Find the loop that builds each item and add the two highlighted lines:

```
// ── inside the "Get Document Checklist" branch ──────────────────────────
documents = zoho.crm.searchRecords(
    "Document",
    "(Deal_Name:equals:" + input.CRM_Deal_ID + ")",
    1, 200,
    "winny_connection"
);

doc_list = list();
for each doc in documents
{
    // ── existing fields (keep whatever you already have) ─────────────────
    item = map();
    item.put("id",                   doc.get("id").toString());
    item.put("requirement",          doc.get("Name").toString());
    item.put("document_requirement", doc.get("Document_Requirement").toString());
    item.put("status",               doc.get("Status").toString());
    item.put("review_comments",      doc.get("Review_Comments").toString());
    item.put("has_file",             doc.get("Has_File").toString());
    item.put("source_request_id",    doc.get("Source_Request_ID").toString());

    // ── ADD THESE TWO LINES ──────────────────────────────────────────────
    trav_lookup = doc.get("Traveller_Info");
    item.put("traveller_id",   ifNull(trav_lookup.get("id").toString(),   ""));
    item.put("traveller_name", ifNull(trav_lookup.get("name").toString(), "Unassigned"));
    // ────────────────────────────────────────────────────────────────────

    doc_list.add(item);
}

checklist_json = doc_list.toString();   // Deluge list → JSON string

zoho.creator.updateRecord(
    "hpatel_winnyedu",
    "hiren-patel",
    "Portal_CRM_Request_Report",
    input.ID.toLong(),
    {
        "Document_Checklist_JSON": checklist_json,
        "Status":                  "Success"
    },
    "winny_connection"
);
```

> **Note — field API name:**  
> The lookup field on the Document CRM module is `Traveller_Info`.  
> `doc.get("Traveller_Info")` returns a map like `{"id":"4750000012345","name":"John Smith"}`.  
> If your Creator Deluge throws a null-pointer error, add a null guard:
> ```
> trav_lookup = doc.get("Traveller_Info");
> trav_id     = "";
> trav_name   = "Unassigned";
> if(trav_lookup != null && trav_lookup != "")
> {
>     trav_id   = trav_lookup.get("id").toString();
>     trav_name = trav_lookup.get("name").toString();
> }
> item.put("traveller_id",   trav_id);
> item.put("traveller_name", trav_name);
> ```

---

## 2 — New branch: "Validate Doc Token"

Add this as a new `if` block **before** (or after) your existing branches in the
same On Add workflow.

```
if(input.Request_Type == "Validate Doc Token")
{
    payload      = input.Payload.toMap();
    doc_token    = payload.get("Doc_Token").toString();
    traveller_id = payload.get("Traveller_ID").toString();

    // Fetch the Traveller_Info record from CRM by ID
    trav_records = zoho.crm.getRecordById(
        "Traveller_Info",
        traveller_id.toLong(),
        "winny_connection"
    );

    // getRecordById returns a map directly (not a list); handle both cases
    if(trav_records == null || trav_records.isEmpty())
    {
        zoho.creator.updateRecord(
            "hpatel_winnyedu", "hiren-patel",
            "Portal_CRM_Request_Report",
            input.ID.toLong(),
            {"Status": "Failed", "CRM_Response": "Traveller not found"},
            "winny_connection"
        );
        return;
    }

    // Depending on your Deluge version, getRecordById may return a list
    // with one item — use .get(0) if you see a list error:
    // trav = trav_records.get(0);
    trav = trav_records;

    stored_token = trav.get("Doc_Token").toString();
    if(stored_token != doc_token)
    {
        zoho.creator.updateRecord(
            "hpatel_winnyedu", "hiren-patel",
            "Portal_CRM_Request_Report",
            input.ID.toLong(),
            {"Status": "Failed", "CRM_Response": "Invalid token"},
            "winny_connection"
        );
        return;
    }

    // Token is valid — return the traveller's full name in CRM_Response
    full_name = trav.get("Full_Name").toString();
    zoho.creator.updateRecord(
        "hpatel_winnyedu", "hiren-patel",
        "Portal_CRM_Request_Report",
        input.ID.toLong(),
        {"Status": "Success", "CRM_Response": full_name},
        "winny_connection"
    );
}
```

> **Field names to confirm in your CRM Traveller_Info module:**
> - Token field:     `Doc_Token`   (the one you added)
> - Full name field: `Full_Name`   (check the API name in CRM field setup)
>
> **Connection name:** replace `"winny_connection"` with whatever connection
> name you use in your other existing Deluge branches.

---

## 3 — How it all connects

```
Case officer clicks "Generate Link" in portal
  → portal saves random token to Traveller_Info.Doc_Token (CRM)
  → portal builds share URL:
      https://creatorapp.zohopublic.in/.../page-perma/Document_Checklist/<key>
        ?Doc_Token=<token>
        &Traveller_ID=<CRM traveller record ID>
        &CRM_Deal_ID=<CRM deal ID>

Non-portal traveller opens the URL
  → widget reads Doc_Token, Traveller_ID, CRM_Deal_ID from URL params
  → calls bridge: Request_Type = "Validate Doc Token"
      Deluge checks CRM Traveller_Info.Doc_Token == Doc_Token → Success
  → calls bridge: Request_Type = "Get Document Checklist"
      Deluge fetches Document records for the deal, returns JSON with traveller_id
      widget filters client-side to show only this traveller's documents
  → traveller uploads each file via the existing "Upload Document" bridge
```
