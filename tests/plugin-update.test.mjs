import test from 'node:test';
import assert from 'node:assert/strict';
import {updateOutcome,PLUGIN_RELEASE} from '../src/plugin-release.js';
test('package update never claims installation from workbench or server version alone',()=>{assert.equal(updateOutcome(PLUGIN_RELEASE,PLUGIN_RELEASE.version),'current');for(const v of [undefined,'0.18.0','unknown'])assert.equal(updateOutcome(PLUGIN_RELEASE,v),'handoff');assert.throws(()=>updateOutcome({...PLUGIN_RELEASE,url:'https://attacker.example/install'},'0.19.0'));assert.throws(()=>updateOutcome({...PLUGIN_RELEASE,version:'<script>'}));});
test('an older server cannot suggest downgrading a newer installed plugin',()=>{assert.equal(updateOutcome(PLUGIN_RELEASE,'0.20.0'),'current');assert.equal(updateOutcome(PLUGIN_RELEASE,'1.0.0'),'current');assert.equal(updateOutcome(PLUGIN_RELEASE,'0.9.10'),'handoff');});
