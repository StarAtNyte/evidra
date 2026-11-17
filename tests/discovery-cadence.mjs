import test from "node:test";
import assert from "node:assert/strict";
import { discoveryCadence } from "../dist/core/discovery-cadence.js";
const event = createdAt => ({type:"research.decision.audit",createdAt});
test("two unexecuted cycles request a bounded test without bypassing gates",()=>{
 const r=discoveryCadence([event("2026-10-15T01:00Z"),event("2026-10-15T02:00Z")],[]);
 assert.equal(r.idleCycles,2);assert.match(r.guidance,/rejection criterion/);assert.match(r.guidance,/remain binding/);
});
test("a recorded run resets review pressure regardless of score",()=>{
 assert.equal(discoveryCadence([event("2026-10-15T01:00Z"),event("2026-10-15T02:00Z")],[{createdAt:"2026-10-15T01:30Z"}]).guidance,"");
});
test("unrelated events and empty history do not trigger cadence",()=>{
 assert.equal(discoveryCadence([{type:"tool",createdAt:"2026-10-15"}],[]).guidance,"");
});

const { verificationRuntimeGuidance } = await import('../dist/core/discovery-cadence.js');
test('Python runtime guidance preserves the declared virtualenv and evidence boundaries', () => {
  const guidance = verificationRuntimeGuidance(['/project with spaces/.venv/bin/python', 'evaluate.py']);
  assert.ok(guidance.includes(JSON.stringify('/project with spaces/.venv/bin/python')));
  assert.match(guidance, /not lockfile parity/);
  assert.match(guidance, /sys.executable/);
  assert.equal(verificationRuntimeGuidance(['python', 'evaluate.py']), '');
  assert.equal(verificationRuntimeGuidance(['/usr/bin/node', 'evaluate.js']), '');
  assert.equal(verificationRuntimeGuidance([]), '');
  assert.match(verificationRuntimeGuidance(['C:\\project\\venv\\Scripts\\python.exe']), /VERIFICATION RUNTIME/);
});

const { incompleteVerificationProposal } = await import('../dist/core/discovery-cadence.js');
test('unmaterialized verify-only metric ideas cannot enter automatic portfolio execution', () => {
 const followup = {outcomeType:'metric', implementationMode:'verify', implementationSource:null, implementationArtifacts:[], experimentEnvironment:[], verificationCommands:[]};
 assert.match(incompleteVerificationProposal(followup), /Materialize/);
 for (const patch of [
  {implementationSource:{path:'solution/predict.py',sha256:'sha256:abc'}},
  {implementationArtifacts:[{path:'config.json'}]},
  {experimentEnvironment:[{name:'GAIN',value:'0.75'}]},
  {verificationCommands:[['python','check.py']]},
  {implementationMode:'modify'}, {outcomeType:'artifact'},
 ]) assert.equal(incompleteVerificationProposal({...followup,...patch}),undefined);
});
