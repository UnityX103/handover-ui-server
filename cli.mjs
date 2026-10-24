#!/usr/bin/env node
import { main } from './skills/grill-with-ui/scripts/handover.mjs';
main().catch((error) => { process.stdout.write(JSON.stringify({ok:false,error:error.message,status:error.status})+'\n'); process.exitCode=1; });
