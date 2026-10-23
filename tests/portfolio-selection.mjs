import test from 'node:test';import assert from 'node:assert/strict';
import {planPortfolio} from '../dist/core/portfolio.js';
const low={id:'chosen',title:'Selected implemented hypothesis',operator:'greedy',expectedValue:1,costMinutes:1,family:'a'};
const high={id:'alternative',title:'Higher forecast follow-up',operator:'evolutionary',expectedValue:10,costMinutes:1,family:'b'};
const options={maxCandidates:1,maxParallel:1,budgetMinutes:30};
test('feasible director-selected hypothesis precedes an alternative forecast',()=>{
 assert.equal(planPortfolio([high,low],{...options,preferredCandidateId:'chosen'}).selected[0].id,'chosen');
 assert.equal(planPortfolio([high,low],options).selected[0].id,'alternative');
});
test('director selection cannot bypass the execution budget',()=>{
 const p=planPortfolio([high,{...low,costMinutes:100}],{...options,preferredCandidateId:'chosen'});
 assert.equal(p.selected[0].id,'alternative');assert.match(p.rejected.find(x=>x.candidate.id==='chosen').reason,/budget/);
});
test('invalid and absent preferred candidates leave ordinary ranking intact',()=>{
 assert.equal(planPortfolio([high,{...low,expectedValue:NaN}],{...options,preferredCandidateId:'chosen'}).selected[0].id,'alternative');
 assert.equal(planPortfolio([high,low],{...options,preferredCandidateId:'missing'}).selected[0].id,'alternative');
});
