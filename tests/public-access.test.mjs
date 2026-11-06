import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {ControlStore} from '../src/control.mjs';
import {membersScreen,inviteScreen} from '../src/presentation.mjs';
test('open registration admits 120 accounts without invites, keeps revocation and bounded admin lists',()=>{
 const store=new Store();try{const control=new ControlStore(store.db,{admin:'123',mode:'open'});for(let i=0;i<120;i++)assert.equal(control.access(String(200+i),{start:true}).allowed,true);assert.equal(control.overview().activeCount,121);assert.equal(control.overview().members.length,50);assert.equal(control.overview().capacity,null);assert.equal(control.access('999').reason,'start');assert.equal(control.invite('200').url,'https://t.me/mybob_robot');assert.ok(inviteScreen(control.invite('200')).text.includes('открыта'));assert.ok(membersScreen(control.overview()).text.includes('121'));control.revoke('123','200');assert.equal(control.access('200',{start:true}).reason,'revoked');assert.throws(()=>control.invite('200'));assert.ok(control.due().length<=20);}finally{store.close();}
});
test('public inbound limits are per account, persist restarts and reset each minute',()=>{
 const store=new Store();let now='2026-11-06T10:00:00Z';try{let control=new ControlStore(store.db,{admin:'123',mode:'open',clock:()=>now});control.access('200',{start:true});control.access('201',{start:true});assert.equal(control.allowRequest('200',{voice:true,eventId:'one'}),true);assert.equal(control.allowRequest('200',{voice:true,eventId:'one'}),true);assert.equal(control.allowRequest('200',{voice:true}),true);assert.equal(control.allowRequest('200',{voice:true}),false);assert.equal(control.allowRequest('201',{voice:true}),true);for(let i=0;i<28;i++)assert.equal(control.allowRequest('200'),true);assert.equal(control.allowRequest('200'),false);control=new ControlStore(store.db,{admin:'123',mode:'open',clock:()=>now});assert.equal(control.allowRequest('200'),false);now='2026-11-06T10:01:00Z';assert.equal(control.allowRequest('200',{voice:true}),true);}finally{store.close();}
});
