import assert from "node:assert/strict";
import test from "node:test";

import { PERSONA_BROKER_COMMAND_NAMES, PERSONA_BROKER_COMMANDS } from "../../extension/pcms/core/persona-broker-contract.js";
import {
  PERSONA_BROKER_CAPABILITY_COMMANDS,
  PERSONA_BROKER_CONTROL_COMMANDS,
  PERSONA_BROKER_EXECUTION_COMMANDS,
  getPersonaBrokerCapabilityCommands,
  getPersonaBrokerCommandCapability
} from "../../extension/pcms/core/persona-broker.js";

test("A009-02 every accepted broker command maps to exactly one Integration capability",()=>{
  const flattened=Object.values(PERSONA_BROKER_CAPABILITY_COMMANDS).flat().sort();
  assert.deepEqual(flattened,[...PERSONA_BROKER_COMMAND_NAMES].sort());
  for(const command of PERSONA_BROKER_COMMAND_NAMES){
    assert.equal(getPersonaBrokerCommandCapability(command),PERSONA_BROKER_COMMANDS[command].capability);
    assert.ok(getPersonaBrokerCapabilityCommands(PERSONA_BROKER_COMMANDS[command].capability).includes(command));
  }
  assert.deepEqual(getPersonaBrokerCapabilityCommands("missing"),[]);
});

test("A009-02 control and execution families remain inside External Automation authority",()=>{
  assert.ok(PERSONA_BROKER_CONTROL_COMMANDS.length>=4);
  assert.ok(PERSONA_BROKER_EXECUTION_COMMANDS.length>=3);
  for(const command of [...PERSONA_BROKER_CONTROL_COMMANDS,...PERSONA_BROKER_EXECUTION_COMMANDS]){
    assert.equal(PERSONA_BROKER_COMMANDS[command].capability,"external-automation");
  }
});

test("A009-02 capability lookup rejects prototype-inherited names",()=>{
  assert.deepEqual(getPersonaBrokerCapabilityCommands("constructor"),[]);
  assert.deepEqual(getPersonaBrokerCapabilityCommands("toString"),[]);
});
