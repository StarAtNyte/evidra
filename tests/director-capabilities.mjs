import test from 'node:test';
import assert from 'node:assert/strict';
import {selectResearchTools,availableResearchTools} from '../dist/core/tools.js';
import {researchDirectorAvailableTools} from '../dist/agents/research-director.js';
test('builtin inventory passed as additions does not duplicate or overflow selected tools',()=>{
 const tools=selectResearchTools('Inspect source and artifact hashes',12,availableResearchTools());
 assert.equal(new Set(tools.map(x=>x.name)).size,tools.length);assert.ok(tools.length<=12);
});
test('task capability boundary removes even normally core tools',()=>{
 const allowed=['workspace.read','artifact.audit'];
 const tools=researchDirectorAvailableTools('Inspect source and artifact hashes',availableResearchTools(),true,allowed);
 assert.deepEqual(new Set(tools.map(x=>x.name)),new Set(allowed));
 assert.deepEqual(researchDirectorAvailableTools('inspect',availableResearchTools(),true,[]),[]);
 assert.deepEqual(researchDirectorAvailableTools('inspect',availableResearchTools(),false,allowed),[]);
});
test('a duplicate external name cannot replace builtin inspection semantics',()=>{
 const tools=selectResearchTools('read',12,[{name:'workspace.read',description:'overridden',input:{},readOnly:false}],['workspace.read']);
 assert.equal(tools.length,1);assert.equal(tools[0].readOnly,true);assert.notEqual(tools[0].description,'overridden');
});

import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runResearchDirector} from '../dist/agents/research-director.js';
test('director never dispatches a model-requested tool outside its configured capabilities',async()=>{
 const root=mkdtempSync(join(tmpdir(),'evidra-capabilities-'));const previous=process.env.OLLAMA_HOST;let calls=0,executions=0;const results=[];
 const server=createServer((req,res)=>{
  if(req.url.endsWith('/api/version')){res.end(JSON.stringify({version:'0.40.3'}));return;}
  req.resume();req.on('end',()=>{calls++;const decision={phase:'hypothesis',goalStatus:'active',decision:calls===1?'inspect':'propose',bottleneck:'Need source integrity',rationale:'Use only configured observations',hypotheses:[],selectedHypothesis:null,nextAction:'continue',toolCalls:calls===1?[{name:'artifact.audit',arguments:{paths:['source.py']}}]:[]};res.setHeader('content-type','application/json');res.end(JSON.stringify({done:true,done_reason:'stop',message:{content:JSON.stringify(decision)}}));});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env.OLLAMA_HOST=`http://127.0.0.1:${server.address().port}`;
 try{
  const decision=await runResearchDirector('Inspect source',{}, {provider:'local',model:'test',cwd:root,maxToolRounds:2,maxAgentAttempts:1,allowedToolNames:['workspace.read'],executeTool:async()=>{executions++;return {name:'artifact.audit',ok:true,output:{},trust:'controller_observation'};},onToolResult:(_source,_id,result)=>results.push(result)});
  assert.equal(executions,0);assert.equal(calls,2);assert.equal(decision.goalStatus,'active');assert.equal(results[0].trust,'permission_boundary');assert.match(results[0].error,/configured capabilities/);
 }finally{if(previous===undefined)delete process.env.OLLAMA_HOST;else process.env.OLLAMA_HOST=previous;await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});}
});
