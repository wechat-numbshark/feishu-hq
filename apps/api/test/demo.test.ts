import test from "node:test";
import assert from "node:assert/strict";
import { validateDemoFlow } from "../src/demo.ts";

const valid = {customerName:"拾光零售",opportunityName:"门店经营中台",amountYuan:680000,expectedCloseDate:"2026-09-18",projectName:"拾光零售数字化一期",startDate:"2026-09-21",endDate:"2026-12-18",hiringEnabled:true,jobTitle:"实施顾问",headcount:2,paymentPercent:30,paymentDueDate:"2026-09-30"};
test("validates a complete cross-module demo flow",()=>assert.equal(validateDemoFlow(valid).headcount,2));
test("rejects invalid dates and payment percentage",()=>assert.throws(()=>validateDemoFlow({...valid,endDate:"2026-01-01",paymentPercent:0}),/invalid_demo_input/));
test("allows a flow without hiring",()=>assert.equal(validateDemoFlow({...valid,hiringEnabled:false,jobTitle:"",headcount:0}).hiringEnabled,false));
