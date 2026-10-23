import test from 'node:test';
import assert from 'node:assert/strict';
import {distilCampaignLessons} from '../dist/core/campaign-lessons.js';

const base = {label:'contrast', metric:{name:'score',direction:'maximize'},
  experiments:[{id:'e1',hypothesisId:'h1',sourceReference:'candidate.py @ sha256:abc'}],
  hypotheses:[{id:'h1',title:'conditional response',formulationFamily:'response'}]};

test('failed-only campaigns retain evidence without interpreting partial metrics as a result',()=>{
  const text=distilCampaignLessons({...base,runs:[{runId:'r-failed',experimentId:'e1',status:'failed',createdAt:'2026-01-01',metrics:{score:999}}]});
  assert.match(text,/r-failed: failed; no accepted measurement/);
  assert.match(text,/candidate.py @ sha256:abc/);
  assert.doesNotMatch(text,/score 999/);
  assert.match(text,/No full evaluation completed/);
});

test('losing and failed variants remain visible alongside the best output',()=>{
  const text=distilCampaignLessons({...base,runs:[
    {runId:'winner',experimentId:'e1',status:'completed',createdAt:'2026-01-01',metrics:{score:80}},
    {runId:'loser',experimentId:'e1',status:'completed',createdAt:'2026-01-02',metrics:{score:40}},
    {runId:'failed',experimentId:'e1',status:'failed',createdAt:'2026-01-03',metrics:{}}
  ]});
  assert.match(text,/winner: completed; score 80/);
  assert.match(text,/loser: completed; score 40/);
  assert.match(text,/failed: failed; no accepted measurement/);
  assert.match(text,/confounded/);
  assert.match(text,/Adoption or a higher score alone does not show which edit helped/);
});

test('component winners suggest an experiment rather than asserting a combined win',()=>{
  const text=distilCampaignLessons({...base,components:['component'],runs:[{experimentId:'e1',status:'completed',createdAt:'2026-01-01',metrics:{score:80,component:50}}]});
  assert.match(text,/combination candidates require a fresh test/);
  assert.doesNotMatch(text,/combine mechanisms that won different components/);
});

test('failed-only campaigns retain normalized failure evidence for the next campaign',()=>{
  const text=distilCampaignLessons({...base,runs:[
    {runId:'runtime-failure',experimentId:'e1',status:'failed',createdAt:'2026-01-01',metrics:{score:999}}
  ],failures:['Checkpoint manifest/runtime does not match exact cache identity',
    'Aggregate/phase GPU budget exhausted; optimization incomplete',
    'Aggregate/phase GPU budget exhausted;\n optimization incomplete','   ']});
  assert.match(text,/Checkpoint manifest\/runtime does not match exact cache identity/);
  assert.equal(text.split('Aggregate/phase GPU budget exhausted').length-1,1);
  assert.match(text,/do not establish that a scientific method is ineffective/);
  assert.match(text,/No full evaluation completed/);
  assert.doesNotMatch(text,/Best score|score 999/);
});

test('partial screens also retain failures without claiming a full-evaluation winner',()=>{
  const text=distilCampaignLessons({...base,components:['unreported'],runs:[
    {experimentId:'e1',status:'completed',createdAt:'2026-01-01',metrics:{score:80}}
  ],failures:['Missing, partial or scientifically uninterpretable fit']});
  assert.match(text,/0 full evaluations, 1 partial screens/);
  assert.match(text,/scientifically uninterpretable fit/);
  assert.doesNotMatch(text,/Best score/);
});
