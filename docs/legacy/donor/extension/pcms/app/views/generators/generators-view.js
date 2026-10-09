// Generators list and detail (P036, 02 §5.3). Rows come from the Core generator index
// (pcms.generator-index/v1); every mutation is a background Core command through the UI
// client. Repository files and uploads are untrusted text and are rendered with textContent.
import { createEntityPicker } from "../../ui/picker/entity-picker.js";
import { pcmsV2Href } from "../../router-v2.js";
import { generatorPayloadHash, thumbnailHash } from "../../../providers/perchance/contract.js";
import {
  LISTING_CHOICES,
  base64ToBytes,
  bytesToBase64,
  decodeUtf8Exact,
  deploymentIdForSlug,
  generatorDeployError,
  listingLabel,
  manualDeployPlan,
  originLabel,
  parsePerchanceAddress,
  payloadEvidence,
  shortTime,
  validateDraft
} from "./model.js";

const STYLESHEET = "views/generators/generators.css";
const ANSWERS = Object.freeze([
  Object.freeze({ outcome:"APPLIED", label:"Yes — Perchance shows this content", note:"recorded as Applied" }),
  Object.freeze({ outcome:"NOT_APPLIED", label:"No — Perchance still shows the old content", note:"recorded as Not applied; you can deploy again" }),
  Object.freeze({ outcome:"UNKNOWN", label:"I'm not sure", note:"stays Unknown; nothing will be retried" })
]);

function e(doc, tag, cls, text) {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(doc, label, action, cls = null) {
  const node = e(doc, "button", cls, label);
  node.type = "button";
  if (action) node.dataset.generatorsAction = action;
  return node;
}
function badge(doc, status) {
  const node = e(doc, "span", "status-token", status?.label || "Unknown");
  node.dataset.token = status?.token || "INFO";
  return node;
}
function fact(doc, list, label, value) {
  const line = e(doc, "div");
  line.append(e(doc, "dt", null, label), e(doc, "dd", null, value));
  list.appendChild(line);
}
async function readBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}
async function copyText(windowRef, text) {
  try { await windowRef.navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export function createPcmsGeneratorsView({ documentRef, windowRef, runtime, mount = null, onChanged = async () => {} } = {}) {
  if (!documentRef || !windowRef || !runtime?.generators || !runtime?.deployer || !runtime?.accounts) {
    throw new TypeError("Generators UI requires the UI-client runtime");
  }
  const parent = mount || documentRef.getElementById("viewPlaceholder");
  if (!parent) throw new Error("Generators view host is missing");
  if (documentRef.head && !documentRef.querySelector("link[data-generators-css]")) {
    const link = documentRef.createElement("link");
    link.rel = "stylesheet"; link.href = STYLESHEET; link.dataset.generatorsCss = "true";
    documentRef.head.appendChild(link);
  }
  const host = e(documentRef, "div", "generators-v2");
  host.id = "generatorsV2";
  host.hidden = true;
  host.setAttribute("aria-label", "Generators");
  const feedback = e(documentRef, "p", "generators-feedback");
  feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite");
  const content = e(documentRef, "div", "generators-content");
  const dialogHost = e(documentRef, "div", "generators-modal-host");
  host.append(feedback, content, dialogHost);
  parent.appendChild(host);

  let dead = false, epoch = 0, route = null, lastList = null, lastDetail = null, modal = null;

  function say(text, tone = "") { feedback.textContent = text; feedback.dataset.tone = tone; }

  // --- list -------------------------------------------------------------------------------

  function drawList(result) {
    content.replaceChildren();
    const toolbar = e(documentRef, "div", "generators-toolbar");
    const summary = e(documentRef, "p", "generators-summary",
      result.total + " generator" + (result.total === 1 ? "" : "s") + (result.matching !== result.total ? " · " + result.matching + " shown by filter" : ""));
    const account = e(documentRef, "select", "generators-account-filter");
    account.setAttribute("aria-label", "Filter by account");
    const all = e(documentRef, "option", null, "All accounts"); all.value = ""; account.appendChild(all);
    for (const item of result.accounts) {
      const option = e(documentRef, "option", null, item.label); option.value = item.accountId; account.appendChild(option);
    }
    account.value = result.filter.account || "";
    account.addEventListener("change", () => {
      windowRef.location.hash = pcmsV2Href("generators", { filter:filterString(result.filter.status, account.value) });
    });
    const deploy = button(documentRef, "Deploy from file…", "deploy-new", "generators-primary");
    toolbar.append(summary, account, deploy);

    const chips = e(documentRef, "nav", "generators-chips");
    chips.setAttribute("aria-label", "Status filters");
    const allChip = e(documentRef, "a", "generators-chip", "All " + result.total);
    allChip.href = pcmsV2Href("generators", { filter:filterString(null, result.filter.account) });
    if (!result.filter.status) allChip.setAttribute("aria-current", "true");
    chips.appendChild(allChip);
    for (const chip of result.chips) {
      const link = e(documentRef, "a", "generators-chip", chip.label + " " + chip.count);
      link.href = pcmsV2Href("generators", { filter:filterString(chip.key, result.filter.account) });
      link.dataset.filter = chip.key;
      if (result.filter.status === chip.key) link.setAttribute("aria-current", "true");
      chips.appendChild(link);
    }
    content.append(toolbar, chips);

    if (!result.rows.length) {
      content.appendChild(e(documentRef, "p", "empty-state", result.total
        ? "No generators match this filter."
        : "No generators yet. Use Deploy from file… to deploy a generator to one of your accounts."));
      return;
    }
    const table = e(documentRef, "table", "generators-table");
    const head = e(documentRef, "tr");
    for (const label of ["Generator", "Account", "Status", "Repo", "Perchance", "Listing"]) head.appendChild(e(documentRef, "th", null, label));
    const thead = e(documentRef, "thead"); thead.appendChild(head); table.appendChild(thead);
    const tbody = e(documentRef, "tbody");
    for (const row of result.rows) {
      const tr = e(documentRef, "tr"); tr.dataset.generatorRef = row.ref; tr.dataset.statusToken = row.status.token;
      const name = e(documentRef, "td"); const link = e(documentRef, "a", null, row.title || row.slug);
      link.href = pcmsV2Href("generators", { id:row.slug }); name.appendChild(link);
      const status = e(documentRef, "td"); status.appendChild(badge(documentRef, row.status));
      if (row.notes.length) status.appendChild(e(documentRef, "small", "generators-note", " · " + row.notes.join(" · ")));
      tr.append(name, e(documentRef, "td", null, row.accountLabel), status,
        e(documentRef, "td", null, row.columns.repo ?? "—"), e(documentRef, "td", null, row.columns.perchance ?? "—"),
        e(documentRef, "td", null, row.columns.listing ?? "—"));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody); content.appendChild(table);
    const paging = e(documentRef, "div", "generators-paging");
    if (result.page > 1) {
      const prev = e(documentRef, "a", null, "‹ Prev");
      prev.href = pcmsV2Href("generators", { filter:filterString(result.filter.status, result.filter.account), page:result.page - 1 });
      paging.appendChild(prev);
    }
    paging.appendChild(e(documentRef, "span", null, "Page " + result.page + " of " + result.pages));
    if (result.page < result.pages) {
      const next = e(documentRef, "a", null, "Next ›");
      next.href = pcmsV2Href("generators", { filter:filterString(result.filter.status, result.filter.account), page:result.page + 1 });
      paging.appendChild(next);
    }
    content.appendChild(paging);
  }

  function filterString(status, account) {
    return [status ? "status:" + status : null, account ? "account:" + account : null].filter(Boolean).join(",");
  }

  // --- detail -----------------------------------------------------------------------------

  function card(title, facts) {
    const section = e(documentRef, "section", "generators-card");
    section.appendChild(e(documentRef, "h4", null, title));
    const dl = e(documentRef, "dl");
    for (const [label, value] of facts) fact(documentRef, dl, label, value);
    section.appendChild(dl);
    return section;
  }

  async function drawDetail(slug, detail, generation) {
    content.replaceChildren();
    const back = e(documentRef, "a", "generators-back", "All generators"); back.href = pcmsV2Href("generators");
    content.appendChild(back);
    if (!detail || !detail.row) {
      content.appendChild(e(documentRef, "h3", null, slug));
      content.appendChild(e(documentRef, "p", "empty-state", "PCMS does not manage this generator yet."));
      const deployNew = button(documentRef, "Deploy from file…", "deploy-new", "generators-primary");
      deployNew.dataset.slug = slug;
      content.appendChild(deployNew);
      return;
    }
    const row = detail.row; const facet = detail.deployer;
    const header = e(documentRef, "div", "generators-header");
    header.append(e(documentRef, "h3", null, row.title || row.slug), e(documentRef, "span", "generators-account", row.accountLabel));
    const open = e(documentRef, "a", null, "Open on Perchance ↗");
    open.href = "https://perchance.org/" + encodeURIComponent(row.slug); open.target = "_blank"; open.rel = "noopener noreferrer";
    header.appendChild(open);
    content.appendChild(header);
    const banner = e(documentRef, "div", "generators-banner");
    banner.dataset.token = row.status.token;
    banner.append(badge(documentRef, row.status), e(documentRef, "span", "generators-next", row.next.text ? "Next: " + row.next.text : ""));
    content.appendChild(banner);
    for(const note of row.notes??[])content.appendChild(e(documentRef,"p","generators-evidence",note));
    if (!facet) return;

    const cards = e(documentRef, "div", "generators-cards");
    cards.append(
      card("PCMS wants", [["Content", originLabel(facet.origin)], ["Listing", listingLabel(facet.desiredListing)],
        ["Thumbnail", facet.desiredHasThumbnail ? "Included" : "None"]]),
      card("PCMS last confirmed", facet.confirmedAt
        ? [["Deployed", shortTime(facet.confirmedAt)], ["Listing", listingLabel(facet.confirmedListing)],
          ["Matches wanted", facet.confirmedMatchesDesired ? "Yes" : "No"]]
        : [["Deployed", "Not yet deployed"]]),
      card("Perchance now", facet.observation?.observation?.method==="PROVIDER_READ"
        ? [["Checked",shortTime(facet.observation.observation.observedAt)],
          ["Result",facet.observation.observation.challenge?"Needs your attention":facet.observation.observation.exists===false?"Missing":facet.observation.drift?"Changed":"Observed"],
          ["Listing",listingLabel(facet.observation.observation.listing)]]
        : [["Checked", "Not verified"], ["Reading",facet.observation?.available?"Available — choose Verify now":"Unavailable until compatibility is confirmed"]])
    );
    content.appendChild(cards);

    const actions = e(documentRef, "div", "generators-actions");
    const status = facet.operationStatus;
    if (!["ACTIVE", "RECONCILE"].includes(status)&&!facet.observation?.drift) {
      const deploy = button(documentRef, "Deploy from file…", "deploy-file", "generators-primary");
      deploy.dataset.slug = row.slug; actions.appendChild(deploy);
    }
    if (status === "RECONCILE" && !detail.handoffTaskId) actions.appendChild(button(documentRef, "Check Perchance…", "reconcile"));
    if (!["ACTIVE", "RECONCILE"].includes(status)) {
      if(!facet.observation?.drift)actions.appendChild(button(documentRef, facet.paused ? "Resume" : "Pause", facet.paused ? "resume" : "pause"));
    }
    if(runtime.observations&&facet.observation?.available){
      const verify=button(documentRef,"Verify now","verify");verify.disabled=facet.observation.automaticBlocked;actions.appendChild(verify);
      if(facet.observation.drift){
        if(facet.origin.kind==="REPOSITORY")actions.appendChild(button(documentRef,"Compare changes","compare"));
        if(facet.observation.observation?.exists===true)actions.appendChild(button(documentRef,"Keep Perchance version…","keep"));
        if(facet.origin.kind==="REPOSITORY")actions.appendChild(button(documentRef,"Overwrite with repository version…","overwrite"));
      }
    }
    content.appendChild(actions);

    if (detail.handoffTaskId && runtime.providerHandoff) {
      let handoff = null;
      try { handoff = await runtime.providerHandoff.describe(detail.handoffTaskId); } catch {}
      if (dead || generation !== epoch) return;
      if (handoff) content.appendChild(handoffPanel(handoff, facet));
    }

    const technical = e(documentRef, "details", "generators-technical");
    technical.appendChild(e(documentRef, "summary", null, "Technical details"));
    const dl = e(documentRef, "dl");
    for (const [label, value] of Object.entries(facet.technical)) fact(documentRef, dl, label, value === null ? "—" : String(value));
    fact(documentRef, dl, "operationStatus", status);
    technical.appendChild(dl);
    content.appendChild(technical);
  }

  function copyBlock(label, text, key) {
    const wrap = e(documentRef, "div", "generators-copy");
    const heading = e(documentRef, "div", "generators-copy-heading");
    heading.appendChild(e(documentRef, "strong", null, label + " · " + text.length + " characters"));
    const copy = button(documentRef, "Copy " + label.toLowerCase(), null);
    copy.dataset.copy = key;
    copy.addEventListener("click", async () => {
      say(await copyText(windowRef, text) ? label + " copied." : "Copy failed — select the text and copy it manually.", "ok");
    });
    heading.appendChild(copy);
    const area = e(documentRef, "textarea", "generators-source");
    area.readOnly = true; area.value = text; area.rows = 8; area.setAttribute("aria-label", label);
    wrap.append(heading, area);
    return wrap;
  }

  // The durable handoff (ADR-002 §9): answered from any tab at any later time.
  function handoffPanel(handoff, facet) {
    const panel = e(documentRef, "section", "generators-handoff");
    panel.dataset.handoffTask = handoff.taskId;
    panel.appendChild(e(documentRef, "h4", null, handoff.title));
    panel.appendChild(e(documentRef, "p", null, handoff.instructions));
    const payload = handoff.payload;
    if (payload) {
      const evidence = payloadEvidence(payload.code, payload.html);
      panel.appendChild(e(documentRef, "p", "generators-evidence", "The first line of the code panel should be: “" + evidence.firstLine + "”"));
      panel.appendChild(e(documentRef, "p", null, "Listing: " + payload.listing));
      panel.append(copyBlock("Code panel", payload.code, "code"), copyBlock("HTML panel", payload.html, "html"));
      if (payload.thumbnail) {
        const link = e(documentRef, "a", null, "Download thumbnail.jpeg");
        link.href = windowRef.URL.createObjectURL(new Blob([base64ToBytes(payload.thumbnail)], { type:"image/jpeg" }));
        link.download = "thumbnail.jpeg";
        panel.appendChild(link);
      }
    }
    if (handoff.state === "OPEN") {
      const form = e(documentRef, "form", "generators-answer");
      const legend = e(documentRef, "p", null, "Did the save reach Perchance?");
      form.appendChild(legend);
      for (const answer of ANSWERS) {
        const label = e(documentRef, "label");
        const radio = e(documentRef, "input"); radio.type = "radio"; radio.name = "outcome"; radio.value = answer.outcome;
        label.append(radio, e(documentRef, "span", null, " " + answer.label + " → " + answer.note));
        form.appendChild(label);
      }
      const submit = e(documentRef, "button", "generators-primary", "Record answer"); submit.type = "submit";
      form.appendChild(submit);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const outcome = form.querySelector("input[name=outcome]:checked")?.value;
        if (!outcome) { say("Choose an answer first.", "warning"); return; }
        submit.disabled = true;
        try {
          await runtime.providerHandoff.answer(handoff.taskId, outcome);
          await settle(facet.deploymentId);
          say(outcome === "UNKNOWN" ? "Recorded as unknown. Nothing will be retried." : "Answer recorded.", "ok");
        } catch (error) {
          say(generatorDeployError(error), "error");
        } finally {
          await refresh();
          await onChanged();
        }
      });
      panel.appendChild(form);
    }
    return panel;
  }

  // The Deployer settles from the durable RemoteOperation (never by replaying the dispatch).
  async function settle(deploymentId) {
    const listed = await runtime.deployer.listDeployments();
    const deployment = listed.deployments.find((item) => item.deploymentId === deploymentId);
    if (deployment && ["RECONCILE", "ACTIVE"].includes(deployment.operation.status)) {
      await runtime.deployer.reconcileDeployment(deploymentId, { expectedRevision:listed.revision });
    }
  }

  // --- deploy from file -------------------------------------------------------------------

  function closeModal() {
    if (!modal) return;
    modal.picker?.destroy();
    dialogHost.replaceChildren();
    modal = null;
  }

  async function openDeployDialog(slug = null) {
    closeModal();
    const listedAccounts = await runtime.accounts.listAccounts();
    const listedDeployments = await runtime.deployer.listDeployments();
    const existing = slug ? listedDeployments.deployments.find((item) => item.targetRef.id === slug) || null : null;
    const mask = e(documentRef, "div", "generators-modal-backdrop");
    const panel = e(documentRef, "section", "generators-modal");
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-label", "Deploy from file");
    panel.appendChild(e(documentRef, "h3", null, existing ? "Deploy " + slug + " from file" : "Deploy a generator from file"));
    const form = e(documentRef, "form", "generators-dialog-form");
    const state = { accountId:existing?.accountId ?? null, busy:false, picker:null, error:null };

    let address = null;
    if (existing) {
      form.appendChild(e(documentRef, "p", null, "Account: " + (listedAccounts.accounts.find((a) => a.accountId === existing.accountId)?.displayName || existing.accountId)));
    } else {
      const addressLabel = e(documentRef, "label", null, "Perchance address");
      address = e(documentRef, "input"); address.name = "address"; address.placeholder = "perchance.org/your-generator";
      address.autocomplete = "off"; address.maxLength = 300; address.value = slug || "";
      addressLabel.appendChild(address); form.appendChild(addressLabel);
      const chosen = e(documentRef, "p", "generators-chosen", "No account selected");
      const picker = createEntityPicker({ documentRef, kind:"account", onSelect:(item) => {
        state.accountId = item.id; chosen.textContent = "Account: " + item.label; edited();
      } });
      const taken = new Set(listedDeployments.deployments.map((item) => item.targetRef.id));
      picker.setOptions(listedAccounts.accounts.map((account) => ({ id:account.accountId, label:account.displayName, detail:account.providerId })));
      state.picker = picker; state.taken = taken;
      form.append(chosen, picker.root);
    }
    const files = [
      ["code", "Code panel file (required)", ".perchance,.txt,text/plain"],
      ["html", "HTML panel file (optional)", ".html,.htm,text/html,text/plain"],
      ["thumbnail", "Thumbnail (optional JPEG ≤ 1 MiB)", "image/jpeg,.jpg,.jpeg"]
    ];
    const inputs = {};
    for (const [key, label, accept] of files) {
      const wrap = e(documentRef, "label", null, label);
      const input = e(documentRef, "input"); input.type = "file"; input.accept = accept; input.name = key;
      wrap.appendChild(input); form.appendChild(wrap); inputs[key] = input;
      input.addEventListener("change", edited);
    }
    const listing = e(documentRef, "fieldset", "generators-listing");
    listing.appendChild(e(documentRef, "legend", null, "Listing"));
    for (const choice of LISTING_CHOICES) {
      const label = e(documentRef, "label");
      const radio = e(documentRef, "input"); radio.type = "radio"; radio.name = "listing"; radio.value = choice.value;
      radio.checked = (existing?.desired.listing ?? "PUBLICLY_LISTED") === choice.value;
      label.append(radio, e(documentRef, "span", null, " " + choice.label));
      listing.appendChild(label);
    }
    form.appendChild(listing);
    const preview = e(documentRef, "p", "generators-preview");
    const reason = e(documentRef, "p", "generators-dialog-status");
    reason.setAttribute("role", "status"); reason.setAttribute("aria-live", "polite");
    const actions = e(documentRef, "div", "generators-dialog-actions");
    const cancel = button(documentRef, "Cancel", null);
    const submit = e(documentRef, "button", "generators-primary", "Deploy"); submit.type = "submit";
    cancel.addEventListener("click", closeModal);
    actions.append(cancel, submit);
    form.append(e(documentRef, "p", "generators-explain",
      "PCMS opens the generator in the account's Persona and shows the code and HTML to paste. Nothing is retried automatically."),
    preview, reason, actions);
    panel.appendChild(form); mask.appendChild(panel); dialogHost.appendChild(mask);
    modal = state;

    function targetSlug() { return existing ? slug : parsePerchanceAddress(address.value); }
    // A failed attempt stays visible until the operator changes the form.
    function edited() { state.error = null; update(); }
    function update() {
      const target = targetSlug();
      let problem = "";
      if (!target) problem = "Enter the generator's Perchance address.";
      else if (!existing && state.taken?.has(target)) problem = "PCMS already manages " + target + ". Open it from the list instead.";
      else if (!state.accountId) problem = "Choose the account to deploy with.";
      else if (!inputs.code.files?.length) problem = "Choose the code panel file.";
      preview.textContent = target ? "Target: perchance.org/" + target : "";
      reason.textContent = problem || state.error || "";
      reason.dataset.tone = problem ? "warning" : state.error ? "error" : "";
      submit.disabled = state.busy || Boolean(problem);
    }
    address?.addEventListener("input", edited);
    listing.addEventListener("change", edited);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.busy || submit.disabled) return;
      state.busy = true; update();
      const target = targetSlug();
      try {
        const code = decodeUtf8Exact(await readBytes(inputs.code.files[0]), "The code panel file");
        const html = inputs.html.files?.length ? decodeUtf8Exact(await readBytes(inputs.html.files[0]), "The HTML panel file") : "";
        const thumbnailBytes = inputs.thumbnail.files?.length ? await readBytes(inputs.thumbnail.files[0]) : null;
        const chosenListing = form.querySelector("input[name=listing]:checked")?.value;
        validateDraft({ code, html, thumbnailBytes, listing:chosenListing });
        const thumbnail = thumbnailBytes ? bytesToBase64(thumbnailBytes) : null;
        const intent = { payloadHash:await generatorPayloadHash(code, html), thumbnailHash:thumbnail ? await thumbnailHash(thumbnail) : null, listing:chosenListing };
        await runDeploy({ slug:target, accountId:state.accountId, intent, payload:{ code, html, thumbnail } });
        closeModal();
        if (!route?.id) windowRef.location.hash = pcmsV2Href("generators", { id:target });
      } catch (error) {
        state.error = generatorDeployError(error);
      } finally {
        if (modal === state) { state.busy = false; update(); }
        await refresh();
        await onChanged();
      }
    });
    update();
  }

  // Background commands only; each step is CAS-fenced on the Deployer revision.
  async function runDeploy({ slug, accountId, intent, payload }) {
    let listed = await runtime.deployer.listDeployments();
    let deployment = listed.deployments.find((item) => item.targetRef.id === slug) || null;
    const plan = manualDeployPlan(deployment, { ...intent, payloadKind:"v2-release" });
    if (plan.step === "blocked" || plan.step === "none") throw new Error(plan.reason);
    let revision = listed.revision;
    if (plan.step === "create") {
      const created = await runtime.deployer.createDeployment({
        deploymentId:deploymentIdForSlug(slug), accountId, generatorId:slug,
        payloadHash:intent.payloadHash, thumbnailHash:intent.thumbnailHash, listing:intent.listing, origin:{ kind:"MANUAL" }
      }, { expectedRevision:revision });
      deployment = created.deployment; revision = created.revision;
    } else if (plan.step === "setDesired") {
      const changed = await runtime.deployer.setDesired(deployment.deploymentId, {
        expectedRevision:revision, expectedDesiredRevision:deployment.desired.revision,
        payloadHash:intent.payloadHash, thumbnailHash:intent.thumbnailHash, listing:intent.listing, origin:{ kind:"MANUAL" }
      });
      deployment = changed.deployment; revision = changed.revision;
    } else if (plan.step === "retry") {
      const retried = await runtime.deployer.prepareRetry(deployment.deploymentId, { expectedRevision:revision });
      deployment = retried.deployment; revision = retried.revision;
    }
    say("Deploying " + slug + "…", "");
    try {
      const result = await runtime.deployer.deploy(deployment.deploymentId, { expectedRevision:revision, payload });
      say(result.status === "NOT_APPLIED" ? "Perchance reported the deployment was not applied." : "Deployed " + slug + ".", result.status === "NOT_APPLIED" ? "warning" : "ok");
    } catch (error) {
      // An assisted handoff reports an unknown outcome by design: the durable HumanTask now waits.
      const after = await runtime.generators.get("perchance:" + slug);
      if (after?.handoffTaskId) { say("PCMS opened " + slug + " in its Persona. Finish the save there, then answer below.", "ok"); return; }
      throw error;
    }
  }

  // --- events -----------------------------------------------------------------------------

  async function openDriftDialog(action){
    closeModal();const facet=lastDetail?.deployer,slug=lastDetail?.row?.slug;
    if(!facet||!slug)return;
    const mask=e(documentRef,"div","generators-modal-backdrop"),panel=e(documentRef,"section","generators-modal");
    panel.setAttribute("role","dialog");panel.setAttribute("aria-modal","true");panel.setAttribute("aria-label","Review Perchance changes");
    panel.appendChild(e(documentRef,"h3",null,action==="compare"?"Compare "+slug:action==="keep"?"Keep Perchance version":"Overwrite Perchance version"));
    const state={busy:false};modal=state;mask.appendChild(panel);dialogHost.appendChild(mask);
    const status=e(documentRef,"p","generators-dialog-status");status.setAttribute("role","status");
    const cancel=button(documentRef,"Close",null);cancel.addEventListener("click",closeModal);
    if(action==="compare"){
      panel.append(status,cancel);status.textContent="Reading current Perchance content…";
      try{
        const comparison=await runtime.observations.compare(facet.deploymentId);
        if(modal!==state)return;status.textContent="Repository release and current Perchance content. Nothing is changed by this comparison.";
        for(const role of ["code","html"]){
          const section=e(documentRef,"section","generators-comparison");section.appendChild(e(documentRef,"h4",null,role==="code"?"Code panel":"HTML panel"));
          const pair=e(documentRef,"div","generators-comparison-pair");
          for(const [key,label] of [["desired","Repository"],["observed","Perchance"]]){
            const side=e(documentRef,"div");side.append(e(documentRef,"strong",null,label),e(documentRef,"pre",null,comparison[key][role]));pair.appendChild(side);
          }section.appendChild(pair);panel.insertBefore(section,cancel);
        }
        panel.insertBefore(e(documentRef,"p",null,"Listing: repository "+listingLabel(comparison.desiredListing)+" · Perchance "+listingLabel(comparison.observedListing)),cancel);
        panel.insertBefore(e(documentRef,"p",null,"Thumbnail: "+(comparison.desired.thumbnail===comparison.observed.thumbnail?"matches":"differs")),cancel);
        for(const role of ["code","html","thumbnail"]){
          if(comparison.observed[role]===null)continue;
          const download=button(documentRef,"Download Perchance "+role,null);
          download.addEventListener("click",()=>{
            const bytes=role==="thumbnail"?base64ToBytes(comparison.observed.thumbnail):comparison.observed[role];
            const blob=new windowRef.Blob([bytes],{type:role==="thumbnail"?"image/jpeg":"text/plain;charset=utf-8"});
            const url=windowRef.URL.createObjectURL(blob),link=e(documentRef,"a");link.href=url;
            link.download=slug+(role==="code"?".perchance":role==="html"?".html":".jpeg");link.click();
            windowRef.setTimeout(()=>windowRef.URL.revokeObjectURL(url),1000);
          });panel.insertBefore(download,cancel);
        }
      }catch(error){if(modal===state)status.textContent=error?.message||"Comparison unavailable";}
      return;
    }
    panel.appendChild(e(documentRef,"p",null,action==="keep"
      ?"Keep the last observed Perchance content as the baseline. This generator stays paused and diverged from the repository until you resume or the repository releases a newer version. Download its Perchance files from Compare changes to commit them yourself."
      :"Replace the current Perchance code, HTML, thumbnail and listing with the repository release. Changes made on Perchance will be lost. PCMS creates a new deployment and checks the saved result."));
    const label=e(documentRef,"label",null,"Type "+slug+" to confirm"),input=e(documentRef,"input");input.autocomplete="off";label.appendChild(input);
    const apply=button(documentRef,action==="keep"?"Keep version":"Overwrite with repository",null,"generators-primary");apply.disabled=true;
    input.addEventListener("input",()=>{apply.disabled=state.busy||input.value!==slug;});
    apply.addEventListener("click",async()=>{
      if(state.busy||input.value!==slug)return;state.busy=true;apply.disabled=true;cancel.disabled=true;
      try{
        const evidence={expectedRevision:facet.revision,expectedObservedAt:facet.observation.observation.observedAt,confirmation:input.value};
        await runtime.observations[action](facet.deploymentId,evidence);closeModal();say(action==="keep"?"Perchance version kept. This generator remains paused.":"Repository deployment prepared. Complete any Perchance confirmation task.","ok");
      }catch(error){status.textContent=error?.message||"The generator changed; refresh and try again.";}
      finally{state.busy=false;apply.disabled=input.value!==slug;cancel.disabled=false;await refresh();await onChanged();}
    });panel.append(label,status,apply,cancel);input.focus();
  }

  async function onClick(event) {
    const target = event.target.closest?.("[data-generators-action]");
    if (!target) return;
    const action = target.dataset.generatorsAction;
    try {
      if (action === "deploy-new") await openDeployDialog(target.dataset.slug || null);
      if (action === "deploy-file") await openDeployDialog(target.dataset.slug);
      if(action==="verify"&&lastDetail?.deployer){
        const result=await runtime.observations.verifyNow(lastDetail.deployer.deploymentId);
        say(result.status==="OBSERVED"?"Perchance observation recorded.":result.status==="DEFERRED"?"Verification queued; reads are spaced by at least 10 seconds.":"Verification unavailable or waiting for your attention.",result.status==="OBSERVED"?"ok":"warning");
      }
      if(["compare","keep","overwrite"].includes(action))await openDriftDialog(action);
      if (action === "reconcile" && lastDetail?.deployer) {
        await settle(lastDetail.deployer.deploymentId);
        say("Checking Perchance. Answer the task when it appears.", "ok");
      }
      if ((action === "pause" || action === "resume") && lastDetail?.deployer) {
        const listed = await runtime.deployer.listDeployments();
        await runtime.deployer.setPaused(lastDetail.deployer.deploymentId, { expectedRevision:listed.revision, paused:action === "pause" });
        say(action === "pause" ? "Paused. Nothing will be deployed for this generator." : "Resumed.", "ok");
      }
    } catch (error) {
      say(generatorDeployError(error), "error");
    }
    if (action !== "deploy-new" && action !== "deploy-file") { await refresh(); await onChanged(); }
  }
  function onKey(event) { if (event.key === "Escape" && modal) { event.preventDefault(); closeModal(); } }
  host.addEventListener("click", onClick);
  documentRef.addEventListener("keydown", onKey);

  async function refresh() {
    if (dead || !route || route.route !== "generators") return;
    const generation = ++epoch;
    try {
      if (route.id) {
        const detail = await runtime.generators.get("perchance:" + route.id);
        if (dead || generation !== epoch) return;
        lastDetail = detail; await drawDetail(route.id, detail, generation);
      } else {
        const result = await runtime.generators.list({ filter:route.filter || "", page:route.page || 1 });
        if (dead || generation !== epoch) return;
        lastList = result; drawList(result);
      }
    } catch {
      if (dead || generation !== epoch) return;
      content.replaceChildren(e(documentRef, "p", "empty-state", "Generators are unavailable right now."));
    }
  }

  return Object.freeze({
    async render(nextRoute) {
      if (dead) return;
      route = nextRoute;
      host.hidden = route?.route !== "generators";
      if (host.hidden) { closeModal(); return; }
      await refresh();
    },
    get lastList() { return lastList; },
    destroy() {
      dead = true; epoch += 1; closeModal();
      host.removeEventListener("click", onClick); documentRef.removeEventListener("keydown", onKey);
      host.remove();
    }
  });
}
