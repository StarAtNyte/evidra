import test from 'node:test';
import assert from 'node:assert/strict';
import {architectureDifferences,architectureNovelty} from '../dist/core/architecture-search.js';
import {planPortfolio} from '../dist/core/portfolio.js';
import {ResearchHypothesisSchema} from '../dist/core/types.js';
import {normalizeResearchDecisionPayload} from '../dist/agents/research-director.js';
const baseline={representation:'real observed cells',predictionMechanism:'conditional moment transport',learningObjective:'marginal mean and detection matching',generalizationAssumption:'WT stage changes transfer locally'};
const proposed={representation:'learned latent cell state',predictionMechanism:'conditional neural vector field',learningObjective:'multi-time trajectory matching',generalizationAssumption:'WT stage changes transfer locally'};
const architectureChange={baseline,proposed};
const preferred={id:'local',title:'Local refinement',operator:'greedy',family:'moments',expectedValue:10,costMinutes:1};
const exploration={id:'new',title:'Different mechanism',operator:'evolutionary',family:'flow',expectedValue:0,costMinutes:3,architectureChange};
const options={maxCandidates:1,maxParallel:1,budgetMinutes:20,preferredCandidateId:'local'};
test('design contrasts count concrete axes, not family labels or missing evidence',()=>{
 assert.equal(architectureNovelty(),0);
 assert.deepEqual(architectureDifferences(architectureChange),['representation','predictionMechanism','learningObjective']);
 assert.equal(architectureNovelty({baseline,proposed:{...baseline}}),0);
 assert.equal(architectureNovelty({baseline:{...baseline,predictionMechanism:'Ridge rank32 rate0.5'},proposed:{...baseline,predictionMechanism:'ridge rank64 rate0.8'}}),0);
});
test('plateau reserves a feasible architectural test even when a local forecast is larger',()=>{
 assert.equal(planPortfolio([preferred,exploration],options).selected[0].id,'local');
 const p=planPortfolio([preferred,exploration],{...options,exploreArchitecture:true});
 assert.equal(p.selected[0].id,'new');assert.equal(p.architectureExploration.candidateId,'new');
 assert.equal(p.architectureExploration.declaredAxes.length,3);
});
test('exploration does not bypass budget or accept an invalid forecast',()=>{
 for(const patch of [{costMinutes:100},{expectedValue:NaN}]){
  const p=planPortfolio([preferred,{...exploration,...patch}],{...options,exploreArchitecture:true});
  assert.equal(p.selected[0].id,'local');assert.equal(p.architectureExploration.candidateId,undefined);
 }
});
test('one exploration slot preserves a local comparator in a larger portfolio',()=>{
 const p=planPortfolio([preferred,exploration],{...options,maxCandidates:2,exploreArchitecture:true});
 assert.deepEqual(p.selected.map(x=>x.id),['new','local']);
});
test('renaming the same architecture and scalar changes cannot occupy exploration',()=>{
 const renamed={...exploration,family:'totally-new',architectureChange:{baseline,proposed:{...baseline}}};
 const p=planPortfolio([preferred,renamed],{...options,exploreArchitecture:true});
 assert.equal(p.selected[0].id,'local');assert.equal(p.architectureExploration.candidateId,undefined);
});
test('optional local schema and strict-provider null normalization preserve old proposals',()=>{
 const minimal={title:'candidate',mechanism:'learn dynamics',proposedChange:'new field',falsificationTest:'heldout comparison'};
 assert.equal(ResearchHypothesisSchema.parse(minimal).architectureChange,undefined);
 assert.deepEqual(ResearchHypothesisSchema.parse({...minimal,architectureChange}).architectureChange,architectureChange);
 assert.throws(()=>ResearchHypothesisSchema.parse({...minimal,architectureChange:{baseline,proposed:{...proposed,learningObjective:' '}}}));
 const normalized=normalizeResearchDecisionPayload({hypotheses:[{...minimal,architectureChange:null}]});
 assert.equal(ResearchHypothesisSchema.parse(normalized.hypotheses[0]).architectureChange,undefined);
});
