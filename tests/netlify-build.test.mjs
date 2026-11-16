import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyNetlifyRuntime} from '../scripts/check-netlify-build.mjs';
const fixture=()=>({functions:[{name:'gigachat',runtime:'js',runtimeVersion:'nodejs24.x',buildData:{runtimeAPIVersion:2},routes:[{pattern:'/api/gigachat',literal:'/api/gigachat'}]}]});
test('Netlify build gate accepts native runtime metadata produced by modern CLI',()=>{assert.equal(verifyNetlifyRuntime(fixture()).runtimeAPIVersion,2);});
test('Netlify build gate rejects legacy API and lost route before deployment',()=>{for(const mutate of [m=>m.functions[0].buildData.runtimeAPIVersion=1,m=>m.functions[0].routes=[],m=>m.functions[0].routes[0].pattern='/*',m=>m.functions.push({...m.functions[0],name:'unexpected'}),m=>m.functions[0].runtimeVersion='nodejs18.x']){const data=fixture();mutate(data);assert.throws(()=>verifyNetlifyRuntime(data));}});
