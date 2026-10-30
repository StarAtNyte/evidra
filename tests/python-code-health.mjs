import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotCodeHealth,assessCodeHealth} from '../dist/core/code-health.js';

test('Python discovery names count as tests outside a tests directory',()=>{
 const snapshot=snapshotCodeHealth([
  {path:'tools/test_state.py',content:'def test_stage_exclusion():\n    pass\n'},
  {path:'test_root.py',content:'def test_root():\n    pass\n'},
  {path:'tools/state.py',content:'def forecast():\n    pass\n'},
  {path:'tools/contest_state.py',content:'def forecast():\n    pass\n'},
  {path:'test_runtime/model.py',content:'def forecast():\n    pass\n'},
 ]);
 assert.equal(snapshot.testFiles,2);assert.equal(snapshot.sourceFiles,3);
});

test('Python test deletion fails while untested source growth only warns',()=>{
 const before=snapshotCodeHealth([{path:'tools/test_state.py',content:'def test_state():\n    pass\n'}]);
 const deleted=assessCodeHealth(before,snapshotCodeHealth([{path:'solution/model.py',content:'x\n'.repeat(600)}]));
 assert.equal(deleted.status,'fail');assert.equal(deleted.removedTestFiles,1);
 const untested=assessCodeHealth(snapshotCodeHealth([]),snapshotCodeHealth([{path:'solution/model.py',content:'x\n'.repeat(600)}]));
 assert.equal(untested.status,'warn','a large new algorithm is an attempt worth evaluating');
});

test('Recognized Python test growth resolves only the structural no-test-growth signal',()=>{
 const health=assessCodeHealth(snapshotCodeHealth([]),snapshotCodeHealth([
  {path:'solution/model.py',content:'x\n'.repeat(600)},
  {path:'tools/test_state.py',content:'def test_state():\n    pass\n'},
 ]));
 assert.equal(health.status,'pass');assert.equal(health.testLineDelta,3);
 // A structural pass does not establish that tests execute or exercise the implementation.
});
