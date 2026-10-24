import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('fresh bootstrap no longer generates retired login credentials and existing environment stays protected',()=>{
 const source=fs.readFileSync(new URL('../deploy/bootstrap.py',import.meta.url),'utf8');
 const section=source.slice(source.indexOf("if not (ETC / 'service.env').exists():"),source.indexOf("if not (ETC / 'webhook.secret').exists():"));
 assert.ok(section);assert.doesNotMatch(section,/HANDOVER_AGENT_TOKEN|HANDOVER_LOGIN_CODE/);
 assert.match(section,/HANDOVER_ADMIN_TOKEN/);assert.match(section,/HANDOVER_VAPID_PUBLIC_KEY/);assert.match(source,/HANDOVER_WEBHOOK_SECRET/);
});
