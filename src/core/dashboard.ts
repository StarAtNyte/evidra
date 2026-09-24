import { redactStructured } from "./redaction.js";
import { phaseGoalsForMode, researchStageProgress } from "./phase-goals.js";
import { PhaseGoalSchema } from "./types.js";
import { approvalInbox } from "./approvals.js";
import { goalAlignment } from "./goal-alignment.js";
import { agentOrganization } from "./agent-organization.js";
import { evaluateAgentRoles } from "./agent-evals.js";
import { agentBudgetLedger, summarizeAgentUsageBy, summarizeAgentUsageByScope } from "./usage.js";
import { queueEffectivePriority, type ResearchStore } from "./store.js";
import { externalToolStatus, loadExternalResearchTools } from "./external-tools.js";
import { operatorAttention } from "./attention.js";
import { campaignOrganization } from "./campaign-organization.js";

/** Build a bounded, secret-redacted read model for the local dashboard. */
export function dashboardSnapshot(store: ResearchStore, root?: string): Record<string, unknown> {
  const experiments = store.experiments();
  const runs = store.runs();
  const phases = store.phaseGoals().map((entry) => {
    const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as Record<string, unknown> : {};
    return { id: entry.id, name: payload.name, status: payload.status, objective: payload.objective, updatedAt: payload.updatedAt ?? entry.updatedAt };
  }).slice(0, 24);
  const campaign = store.campaign() as { runtime?: { mode?: unknown } } | undefined;
  const scheduler = store.schedulerState();
  const mode = campaign?.runtime?.mode === "challenge" || campaign?.runtime?.mode === "research"
    ? campaign.runtime.mode
    : scheduler.mode === "challenge" ? "challenge" : "research";
  const goals = store.phaseGoals().flatMap((entry) => {
    const parsed = PhaseGoalSchema.safeParse(entry.payload);
    return parsed.success ? [parsed.data] : [];
  });
  const agentEvents = store.eventsByType("research.agent.usage");
  const attention = operatorAttention(store, root);
  const campaignStartedAt = campaign && typeof (campaign as { startedAt?: unknown }).startedAt === "string" ? (campaign as { startedAt: string }).startedAt : "";
  const agentBudget = campaignStartedAt ? agentBudgetLedger(agentEvents, campaignStartedAt, typeof (campaign?.runtime as { agentTokenBudget?: unknown } | undefined)?.agentTokenBudget === "number" ? (campaign?.runtime as { agentTokenBudget: number }).agentTokenBudget : null) : agentBudgetLedger([], "", null);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    workspaceId: store.workspaceId(),
    project: store.project() ?? null,
    campaign: campaign ?? null,
    scheduler,
    counts: store.counts(),
    integrity: store.verifyEventChain(),
    stages: researchStageProgress(phaseGoalsForMode(goals, mode)),
    phases,
    planRevisions: store.phaseGoalRevisions(undefined, 24).map((revision) => ({ goalId: revision.goalId, phase: revision.phase, revision: revision.revision, fingerprint: revision.fingerprint, previousFingerprint: revision.previousFingerprint, createdAt: revision.createdAt })),
    agents: store.agentLanes().slice(0, 24).map((agent) => ({ ...agent, leaseId: agent.leaseId ? `${agent.leaseId.slice(0, 12)}…` : null })),
    externalWorkers: store.externalWorkers(32).map((worker) => ({ ...worker, workerId: `${worker.workerId.slice(0, 12)}…` })),
    organization: agentOrganization(store).map((agent) => ({ ...agent, control: store.agentPause(agent.role) ?? null, pendingDirectives: store.pendingAgentDirectives(agent.role).length })),
    agentDirectives: store.agentDirectives(undefined, 48).map((directive) => ({ id: directive.id, sourceRole: directive.sourceRole, role: directive.role, scopeKey: directive.scopeKey, status: directive.cancelledAt ? "cancelled" : directive.appliedAt ? "applied" : "pending", createdAt: directive.createdAt, appliedAt: directive.appliedAt, cancelledAt: directive.cancelledAt })),
    agentDirectiveOutcomes: store.agentDirectiveOutcomes(48),
    staleAgentDirectives: store.staleAgentDirectives(300_000).slice(0, 24).map((entry) => ({ directiveId: entry.directive.id, role: entry.directive.role, reason: entry.reason, acknowledgedAt: entry.outcome.createdAt })),
    agentReviews: evaluateAgentRoles(store.trajectoryHistory()),
    agentReviewHistory: store.eventsByType("research.agent.reviewed", 12).map((event) => {
      const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
      return {
        createdAt: event.createdAt,
        source: typeof payload.source === "string" ? payload.source : null,
        objective: typeof payload.objective === "string" ? payload.objective.slice(0, 240) : null,
        interventions: Array.isArray(payload.interventions) ? payload.interventions.slice(0, 24) : [],
        coachingDirectiveIds: Array.isArray(payload.coachingDirectiveIds)
          ? payload.coachingDirectiveIds.filter((id): id is number => typeof id === "number").slice(0, 24)
          : [],
      };
    }),
    agentCoachingHistory: store.eventsByType("research.agent.coaching.evaluated", 12).map((event) => {
      const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
      return {
        createdAt: event.createdAt,
        evidenceAt: typeof payload.evidenceAt === "string" ? payload.evidenceAt : null,
        outcomes: Array.isArray(payload.outcomes) ? payload.outcomes.slice(0, 24) : [],
      };
    }),
    agentActivity: store.agentActivities({ limit: 32 }).map((activity) => ({ role: activity.role, taskId: activity.taskId, kind: activity.kind, message: activity.message, createdAt: activity.createdAt })),
    agentSessions: store.agentSessions(24).map((session) => ({ role: session.role, scopeKey: session.scopeKey, provider: session.provider, model: session.model, threadId: `${session.threadId.slice(0, 12)}…`, taskId: session.taskId, updatedAt: session.updatedAt })),
    agentUsage: summarizeAgentUsageBy(agentEvents).slice(0, 24),
    agentUsageByScope: summarizeAgentUsageByScope(agentEvents).slice(0, 24),
    agentBudget,
    routines: store.routines().slice(0, 24).map((routine) => ({ id: routine.id, name: routine.name, mode: routine.mode, status: routine.status, nextRunAt: routine.nextRunAt, triggerEvent: routine.triggerEvent ?? null, lastTriggerAt: routine.lastTriggerAt ?? null, pendingTriggers: routine.pendingTriggers ?? 0, pendingTriggerEvent: routine.pendingTriggerEvent ?? null, lastRunAt: routine.lastRunAt, lastResult: routine.lastResult, lastError: routine.lastError, runCount: routine.runCount, leaseId: routine.leaseId ? `${routine.leaseId.slice(0, 12)}…` : null, recentRuns: store.routineRuns(routine.id).slice(0, 3).map((run) => ({ status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, exitCode: run.exitCode, error: run.error })) })),
    approvals: approvalInbox(store, root).slice(0, 48),
    attention,
    controlHealth: attention.health,
    tools: root ? loadExternalResearchTools(root).tools.map((tool) => ({ name: tool.name, description: tool.description, readOnly: tool.readOnly, cacheable: tool.cacheable, status: externalToolStatus(root, tool.name).status, reason: externalToolStatus(root, tool.name).reason ?? null })) : [],
    alignment: goalAlignment(store),
    organizationMap: campaignOrganization(store),
    queueControl: store.queueControl(),
    queue: store.queueTasks().slice(0, 40).map((task) => ({ id: task.id, kind: task.kind, priority: task.priority, effectivePriority: queueEffectivePriority(task), status: task.status, attempts: task.attempts, claimedAt: task.claimedAt, ownerId: task.ownerId ? `${task.ownerId.slice(0, 12)}…` : null, assigneeId: task.assigneeId, labels: task.labels, requiredCapabilities: task.requiredCapabilities, tokenBudget: task.tokenBudget, costBudgetUsd: task.costBudgetUsd, approvalStatus: task.approvalStatus, approvalReason: task.approvalReason, deadlineAt: task.deadlineAt, usageState: store.queueUsageState(task.id), usageTotals: store.queueUsageTotals(task.id), checkpoint: store.queueCheckpoint(task.id), children: store.queueChildSummary(task.id), activity: store.queueActivities(task.id, 8), usage: store.queueUsage(task.id, 8), goalId: task.goalId, parentTaskId: task.parentTaskId, lineage: store.taskLineage(task.id), dependsOn: task.dependsOn, readiness: store.taskReadiness(task.id), updatedAt: task.updatedAt })),
    queueRecovery: store.eventsByType("queue.recovery_required", 24).map((event) => {
      const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
      return { taskId: typeof payload.taskId === "string" ? payload.taskId : null, failureClass: payload.failureClass ?? "unknown", route: payload.route ?? "change_route", action: payload.action ?? "inspect failure", createdAt: event.createdAt };
    }),
    experiments: experiments.slice(0, 40).map((entry) => {
      const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as Record<string, unknown> : {};
      return { id: entry.id, status: payload.status, hypothesisId: payload.hypothesisId, executor: (payload.resources as Record<string, unknown> | undefined)?.executor, createdAt: entry.createdAt };
    }),
    runs: runs.slice(0, 40).map((entry) => ({ id: entry.id, experimentId: entry.experimentId, status: entry.status, metrics: (entry.payload as Record<string, unknown> | null)?.metrics, updatedAt: entry.updatedAt })),
    // The browser only needs the event stream's index. Do not ship arbitrary
    // event payloads or long tool traces into a local web page.
    events: store.recentEvents(60).map((event) => ({ type: event.type, createdAt: event.createdAt })),
  };
  return redactStructured(snapshot) as Record<string, unknown>;
}

/** Read-only browser UI for a local Evidra controller. */
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark;--bg:#090b10;--panel:#11151e;--line:#273142;--muted:#8d99aa;--text:#edf2f7;--accent:#9b8cff;--good:#54d39b;--warn:#f2bf68;--bad:#ff7777}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#211b42 0,transparent 38%),var(--bg);color:var(--text);font:14px ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:1440px;margin:0 auto;padding:32px}header{display:flex;align-items:end;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:22px;margin-bottom:22px}h1{font:700 30px ui-sans-serif,system-ui;margin:0;letter-spacing:-.04em}h1 span{color:var(--accent)}h2{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;margin:0 0 12px}.sub{color:var(--muted);margin-top:7px}.refresh{color:var(--muted);font-size:12px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:22px}.card,.panel{background:color-mix(in srgb,var(--panel) 93%,transparent);border:1px solid var(--line);border-radius:14px;padding:16px;box-shadow:0 18px 50px #0003}.label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.1em}.value{font-size:23px;margin-top:8px}.layout{display:grid;grid-template-columns:1.15fr .85fr;gap:16px}.panel{margin-bottom:16px}.row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid #202735}.row:last-child{border-bottom:0}.pill{border:1px solid var(--line);border-radius:999px;padding:3px 8px;color:var(--muted);font-size:11px}.running{color:var(--good)}.paused,.pending{color:var(--warn)}.failed,.blocked{color:var(--bad)}pre{white-space:pre-wrap;overflow:auto;color:#c9d2df;line-height:1.45;margin:0;font:12px inherit}.empty{color:var(--muted);padding:10px 0}@media(max-width:900px){main{padding:18px}.grid{grid-template-columns:repeat(2,1fr)}.layout{grid-template-columns:1fr}}@media(max-width:520px){.grid{grid-template-columns:1fr}}
 </style></head><body><main><header><div><h1><span>EVIDRA</span> / DASHBOARD</h1><div class="sub">Read-only local view of durable research state</div></div><div class="refresh" id="updated">Connecting…</div></header><section class="grid" id="stats"></section><div class="layout"><div><section class="panel"><h2>Campaign</h2><div id="campaign"></div></section><section class="panel"><h2>Research stages</h2><div id="stages"></div></section><section class="panel"><h2>Research phases</h2><div id="phases"></div></section><section class="panel"><h2>Experiments & runs</h2><div id="work"></div></section></div><div><section class="panel"><h2>Research agents</h2><div id="agents"></div></section><section class="panel"><h2>Inference cost by work item</h2><div id="agent-cost"></div></section><section class="panel"><h2>Recurring routines</h2><div id="routines"></div></section><section class="panel"><h2>Approval inbox</h2><div id="approvals"></div></section><section class="panel"><h2>Operator attention</h2><div id="attention"></div></section><section class="panel"><h2>Work queue</h2><div id="queue"></div></section><section class="panel"><h2>Recent events</h2><pre id="events"></pre></section></div></div></main>
<script>
const esc=v=>String(v??"—").replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const status=(v)=>{const s=String(v??"—");const cls=['running','paused','pending','acknowledged','failed','blocked','met','active','aligned','attention'].includes(s.toLowerCase())?s.toLowerCase():'unknown';return '<span class="pill '+cls+'">'+esc(s)+'</span>'};
const row=(a,b)=>'<div class="row"><span>'+esc(a)+'</span><span>'+b+'</span></div>';
const empty='<div class="empty">Nothing recorded yet.</div>';
const age=v=>v?Math.max(0,Math.round((Date.now()-Date.parse(v))/1000))+'s ago':'—';
const readiness=q=>{const r=q.readiness;if(!r||r.ready)return '';const reasons=[...(r.missing||[]).map(x=>'missing:'+x),...(r.pending||[]).map(x=>'waiting:'+x),...(r.failed||[]).map(x=>'failed:'+x)];return reasons.length?' · blocked '+reasons.map(esc).join(','):''};
function render(d){
 let organizationPanel=document.getElementById('organization-map'); if(!organizationPanel){const stages=document.getElementById('stages'); const host=stages?.parentElement; if(host){const section=document.createElement('section');section.className='panel';section.innerHTML='<h2>Campaign organization</h2><div id="organization-map"></div>';host.before(section);organizationPanel=document.getElementById('organization-map')}}
 document.getElementById('updated').textContent='Updated '+new Date(d.generatedAt).toLocaleTimeString();
 const c=d.counts||{}; document.getElementById('stats').innerHTML=[['Hypotheses',c.hypotheses],['Experiments',c.experiments],['Runs',c.runs],['Sources',c.sources],['Claims',c.claims],['Artifacts',c.artifacts],['Decisions',c.decisions],['Integrity',d.integrity?.status||'—']].map(x=>'<div class="card"><div class="label">'+x[0]+'</div><div class="value">'+esc(x[1])+'</div></div>').join('');
 const campaign=d.campaign; const health=d.controlHealth||{}; const ab=d.agentBudget||{}; const agentBudgetText=ab.budgetTokens?esc(ab.usedTokens)+' / '+esc(ab.budgetTokens)+' tokens · '+status(ab.status):esc(ab.status||'unlimited'); document.getElementById('campaign').innerHTML=campaign?row('Status',status(campaign.status))+row('Health',status(health.status||'unknown')+' · '+esc(health.reason||''))+row('Mode',esc(campaign.runtime?.mode||d.scheduler?.mode||'research'))+row('Goal',esc(campaign.goal))+row('Budget',esc(campaign.budgetMinutes)+' min')+row('Agent tokens',agentBudgetText):empty;
 const al=d.alignment||{}; document.getElementById('campaign').innerHTML+=(al.status?row('Alignment',status(al.status)+' · '+esc(Math.round((al.score||0)*100))+'%'):'')+(al.checks||[]).filter(x=>x.status!=='pass').map(x=>row(esc(x.id),status(x.status)+' · '+esc(x.detail))).join('');
 const map=d.organizationMap||{}; const progress=map.progress||{}; const phases=(map.phases||[]).map(p=>row(esc(p.phase)+' · '+esc(p.id),status(p.status)+' · '+esc(p.queue.active)+' active / '+esc(p.queue.total)+' queued'+(p.queue.blocked?' · '+esc(p.queue.blocked)+' blocked':'')+(p.objective?' · '+esc(p.objective):''))).join(''); const roles=(map.roles||[]).filter(r=>r.parentRole===null||r.status!=='unstarted'||r.pendingDirectives||r.activeQueue).map(r=>row(esc(r.role)+' · '+esc(r.parentRole||'operator'),status(r.status)+' · '+esc(r.admission||'approved')+' · '+esc(r.authority||'unknown')+' · tools '+esc((r.toolAllowlist||[]).join(',')||'defaults')+' · '+esc(r.health)+(r.activeQueue?' · '+esc(r.activeQueue)+' active':'')+(r.pendingDirectives?' · '+esc(r.pendingDirectives)+' directives':'')+(r.task?' · '+esc(r.task):''))).join(''); const accountability=map.accountability||{}; if(organizationPanel) organizationPanel.innerHTML=row('Mission',esc(map.goal||'not initialized'))+row('Shape',esc(map.mode)+' · '+esc(map.totals?.roles||0)+' roles · '+esc(map.totals?.phases||0)+' phases')+row('Goal progress',esc(progress.completedPhases||0)+'/'+esc(progress.totalPhases||0)+' phases · '+esc(Math.round((progress.ratio||0)*100))+'% · '+esc(progress.status||'pending')+(progress.activePhase?' · active '+esc(progress.activePhase):''))+row('Work',esc(map.totals?.activeQueue||0)+' active · '+esc(map.totals?.queue||0)+' aligned'+(map.totals?.blockedQueue?' · '+esc(map.totals.blockedQueue)+' blocked':''))+row('Accountability',esc((accountability.unassignedRunning||[]).length)+' ownerless · '+esc((accountability.unscopedLive||[]).length)+' unscoped · '+esc((accountability.misalignedLive||[]).length)+' mis-scoped · '+esc((accountability.unbudgetedLive||[]).length)+' unbudgeted')+(phases?'<div class="sub">phase ownership</div>'+phases:'')+(roles?'<div class="sub">active reporting lines</div>'+roles:'');
 document.getElementById('stages').innerHTML=(d.stages||[]).map(s=>row(esc(s.stage)+' · '+esc(s.activePhase||'ready'),status(s.status)+' '+esc(s.completed)+'/'+esc(s.total))).join('')||empty;
 document.getElementById('phases').innerHTML=(d.phases||[]).map(p=>row(esc(p.name||p.id),status(p.status))).join('')||empty; const planRevisions=(d.planRevisions||[]).slice().reverse().slice(0,6).map(r=>'<div class="sub">plan r'+esc(r.revision)+' · '+esc(r.phase||r.goalId)+' · '+esc(r.previousFingerprint)+' → '+esc(r.fingerprint)+'</div>').join(''); if(planRevisions) document.getElementById('phases').innerHTML+='<div class="sub">structural plan revisions</div>'+planRevisions;
 const reviews=new Map((d.agentReviews||[]).map(x=>[x.role,x])); document.getElementById('agents').innerHTML=(d.organization||d.agents||[]).map(a=>{const review=reviews.get(a.role);const checks=review?(' · checks '+(review.playbookPasses||0)+' pass / '+(review.playbookPartials||0)+' partial / '+(review.playbookBlocks||0)+' blocked'):'';const directives=a.pendingDirectives?' · directives '+a.pendingDirectives:'';const playbook=(a.playbook||[]).slice(0,2).map(esc).join(' · ');return row(esc(a.role)+' · '+esc(a.parentRole||'operator'),a.control?.terminated?status('terminated'):a.control?.paused?status('paused'):status(a.status)+' · '+esc(a.health||'unknown')+(review?' · review '+esc(review.recommendation)+' '+Math.round((review.score||0)*100)+'%':'')+checks+directives+(a.task?' · '+esc(a.task):'')+(a.budgetSeconds!==null&&a.budgetSeconds!==undefined?' · '+Math.round(a.usedSeconds||0)+'/'+Math.round(a.budgetSeconds)+'s':'') )+(playbook?'<div class="sub">playbook: '+playbook+'</div>':'')}).join('')||empty;
 const workers=(d.externalWorkers||[]).map(w=>row(esc(w.role)+' · '+esc(w.workerId),status(w.status)+' · '+esc(w.admission||'approved')+' · '+esc(w.provider)+'/'+esc(w.model)+(w.workspaceId?' · '+esc(w.workspaceId):' · workspace unknown')+(w.capabilities?.length?' · '+w.capabilities.map(esc).join(', '):'')+(w.task?' · '+esc(w.task):'')+' · '+age(w.lastHeartbeatAt))).join(''); if(workers) document.getElementById('agents').innerHTML+='<div class="sub">external workers</div>'+workers;
 const handoffOutcomes=(d.agentDirectiveOutcomes||[]).slice(0,8).map(o=>'<div class="sub">#'+esc(o.directiveId)+' · '+esc(o.role)+' · '+status(o.status)+' · '+esc(o.message)+' · '+esc(o.createdAt)+'</div>').join(''); if(handoffOutcomes) document.getElementById('agents').innerHTML+='<div class="sub">handoff outcomes</div>'+handoffOutcomes;
 document.getElementById('agent-cost').innerHTML=(d.agentUsageByScope||[]).map(s=>row(esc(s.taskId||'unattributed')+(s.goalId?' · '+esc(s.goalId):''),esc((s.inputTokens||0)+(s.outputTokens||0))+' tokens · '+esc(s.calls)+' calls')).join('')||empty;
 const reviewHistory=(d.agentReviewHistory||[]).slice().reverse().slice(0,6).map(h=>'<div class="sub">review '+esc(h.createdAt)+' · '+esc(h.source||'controller')+(h.objective?' · '+esc(h.objective):'')+'<br>'+((h.interventions||[]).map(i=>esc((i.role||'role')+' → '+(i.action||'observe')+' · '+(i.priority||'normal'))).join(' · ')||'no interventions')+(h.coachingDirectiveIds?.length?' · coaching '+h.coachingDirectiveIds.map(id=>'#'+esc(id)).join(', '):'')+'</div>').join('')||empty; const reviewHistoryEl=document.getElementById('agent-review-history')||document.getElementById('agents'); if(reviewHistoryEl) reviewHistoryEl.innerHTML+=(reviewHistory?' <div class="sub">review history</div>'+reviewHistory:'');
 const coachingHistory=(d.agentCoachingHistory||[]).slice().reverse().slice(0,6).map(h=>'<div class="sub">coaching evaluation '+esc(h.createdAt)+(h.evidenceAt?' · evidence '+esc(h.evidenceAt):'')+'<br>'+((h.outcomes||[]).map(o=>esc((o.role||'role')+' · '+(o.verdict||'unknown')+(typeof o.delta==='number'?' · Δ '+(o.delta>=0?'+':'')+o.delta.toFixed(3):'')+' · directive '+((o.directiveIds||[]).map(id=>'#'+id).join(', ')||'none'))).join(' · ')||'no outcomes')+'</div>').join(''); if(reviewHistoryEl) reviewHistoryEl.innerHTML+=(coachingHistory?' <div class="sub">coaching outcomes</div>'+coachingHistory:'');
 const activity=(d.agentActivity||[]).slice().reverse().slice(0,8).map(a=>'<div class="sub">'+esc(a.kind)+' · '+esc(a.role)+' · '+esc(a.message)+' · '+esc(a.createdAt)+'</div>').join(''); if(reviewHistoryEl) reviewHistoryEl.innerHTML+=(activity?' <div class="sub">recent work activity</div>'+activity:'');
 const sessions=(d.agentSessions||[]).slice(0,6).map(s=>'<div class="sub">session · '+esc(s.role)+' · '+esc(s.provider)+'/'+esc(s.model)+' · '+esc(s.scopeKey)+' · '+esc(s.threadId)+'</div>').join(''); if(reviewHistoryEl) reviewHistoryEl.innerHTML+=(sessions?' <div class="sub">resumable provider sessions</div>'+sessions:'');
 document.getElementById('routines').innerHTML=(d.routines||[]).map(r=>row(esc(r.name)+' · '+esc(r.mode),status(r.status)+' · next '+esc(r.nextRunAt)+' · trigger '+esc(r.triggerEvent||'none')+(r.pendingTriggers?' · pending '+esc(r.pendingTriggers):'')+(r.lastTriggerAt?' · triggered '+esc(r.lastTriggerAt):'')+' · '+esc(r.runCount)+' run'+(r.runCount===1?'':'s')+(r.lastResult?' · last '+esc(r.lastResult):'')+(r.lastError?' · '+esc(r.lastError):'')+(r.recentRuns?.length?' · history '+r.recentRuns.map(x=>esc(x.status)).join(' → '):''))).join('')||empty;
 document.getElementById('approvals').innerHTML=(d.approvals||[]).map(a=>row(esc(a.kind)+' · '+esc(a.id),status(a.status)+' · '+esc(a.detail)+' · next '+esc(a.next))).join('')||empty;
 const attention=d.attention||{}; document.getElementById('attention').innerHTML=(attention.items||[]).map(a=>row(esc(a.kind)+' · '+esc(a.id),status(a.severity)+' · '+esc(a.summary)+' · next '+esc(a.next))).join('')||empty;
 let toolPanel=document.getElementById('tools'); if(!toolPanel){const host=document.querySelector('.layout>div:last-child');if(host){const section=document.createElement('section');section.className='panel';section.innerHTML='<h2>Research adapters</h2><div id="tools"></div>';host.insertBefore(section,host.children[3]||null);toolPanel=document.getElementById('tools')}} if(toolPanel) toolPanel.innerHTML=(d.tools||[]).map(t=>row(esc(t.name),status(t.status)+' · '+(t.readOnly?'read-only':'mutating')+(t.reason?' · '+esc(t.reason):''))).join('')||empty;
 const queueControl=d.queueControl||{}; const queueBanner=queueControl.paused?'<div class="sub" style="color:var(--warn);margin-bottom:10px">⏸ dispatch paused'+(queueControl.reason?' · '+esc(queueControl.reason):'')+'</div>':''; document.getElementById('queue').innerHTML=queueBanner+((d.queue||[]).map(q=>{const usage=(q.usage||[]);const totals=q.usageTotals||{};const tokens=(totals.inputTokens??usage.reduce((sum,u)=>sum+(u.inputTokens||0),0))+(totals.outputTokens??usage.reduce((sum,u)=>sum+(u.outputTokens||0),0));const cost=totals.costUsd??usage.reduce((sum,u)=>sum+(u.costUsd||0),0);const approval=q.approvalStatus&&q.approvalStatus!=='none'&&q.approvalStatus!=='approved'?' · approval '+esc(q.approvalStatus)+(q.approvalReason?' · '+esc(q.approvalReason):''):'';const checkpoint=q.checkpoint?.present?' · resume '+esc(q.checkpoint.stage||'available'):'';const children=q.children?.total?' · children '+esc(q.children.completed)+'/'+esc(q.children.total)+' done'+(q.children.unfinished?' ('+esc(q.children.unfinished)+' active)':''):'';return row(esc(q.kind)+' · '+esc(q.id),status(q.status)+' · '+(q.ownerId?esc(q.ownerId):'unclaimed')+(q.labels?.length?' · labels '+q.labels.map(esc).join(', '): '')+(q.assigneeId?' · assigned '+esc(q.assigneeId):'')+(q.requiredCapabilities?.length?' · requires '+q.requiredCapabilities.map(esc).join(', '): '')+approval+checkpoint+children+' · '+esc(q.attempts)+' attempt'+(q.attempts===1?'':'s')+(tokens?' · usage '+esc(tokens)+' tokens':'')+(cost?' · $'+cost.toFixed(4):'')+(q.activity?.length?' · last '+esc(q.activity[q.activity.length-1].message.slice(0,100)):'')+(q.parentTaskId?' · parent '+esc(q.parentTaskId):'')+(q.goalId?' · goal '+esc(q.goalId):'')+((q.lineage?.cycle||q.lineage?.missingParentIds?.length||q.lineage?.truncated)?' · broken lineage':'')+((q.dependsOn||[]).length?' · depends '+q.dependsOn.map(esc).join(','): '')+readiness(q))}).join('')||empty); const recoveries=(d.queueRecovery||[]).slice().reverse().slice(0,6).map(r=>'<div class="sub">recovery · '+esc(r.taskId||'task')+' · '+esc(r.failureClass)+' · '+esc(r.route)+' · '+esc(r.action)+'</div>').join(''); if(recoveries) document.getElementById('queue').innerHTML+='<div class="sub">recovery actions</div>'+recoveries;
 const ex=(d.experiments||[]).slice(0,20).map(e=>row('experiment '+e.id,status(e.status))).join(''); const ru=(d.runs||[]).slice(0,20).map(r=>row('run '+r.id,status(r.status))).join(''); document.getElementById('work').innerHTML=ex+ru||empty;
 document.getElementById('events').textContent=(d.events||[]).map(e=>new Date(e.createdAt).toLocaleTimeString()+'  '+e.type).join('\n')||'Nothing recorded yet.';
}
async function refresh(){try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error(r.status);render(await r.json())}catch(e){document.getElementById('updated').textContent='Disconnected'}} refresh();setInterval(refresh,2000);
</script></body></html>`;
}
