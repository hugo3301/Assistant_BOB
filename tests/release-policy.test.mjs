import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRelease,RELEASE_REPOSITORY} from '../scripts/release-policy.mjs';
const sha='a'.repeat(40),run={head_sha:sha,head_branch:'main',head_repository:{full_name:RELEASE_REPOSITORY},event:'push',conclusion:'success'},input={repository:RELEASE_REPOSITORY,sha,head:sha,main:sha,runs:[run]};
test('release permits the current immutable main commit with successful push CI',()=>assert.equal(verifyRelease(input),run));
test('release rejects a fork even with matching commit and successful CI',()=>assert.throws(()=>verifyRelease({...input,repository:'someone/Assistant_BOB'})));
test('release rejects an old green commit when main advanced',()=>assert.throws(()=>verifyRelease({...input,main:'b'.repeat(40)})));
test('release rejects a checkout different from the CI commit and malformed refs',()=>{assert.throws(()=>verifyRelease({...input,head:'b'.repeat(40)}));assert.throws(()=>verifyRelease({...input,sha:'main'}));});
test('release does not trust pull request, failed or foreign CI',()=>{for(const change of[{event:'pull_request'},{conclusion:'failure'},{head_branch:'feature'},{head_repository:{full_name:'someone/fork'}},{head_sha:'b'.repeat(40)}])assert.throws(()=>verifyRelease({...input,runs:[{...run,...change}]}));});
