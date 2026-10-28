#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if(process.platform!=='darwin')throw new Error('macOS App 验证需在 macOS 上运行。');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'handover-app-models-'));
try{
  const binary=path.join(temporary,'models-test');
  execFileSync('/usr/bin/xcrun',['swiftc','-swift-version','5',path.join(root,'desktop/macos/Models.swift'),path.join(root,'desktop/macos/ModelTests.swift'),'-o',binary],{stdio:'inherit'});
  execFileSync(binary,[],{stdio:'inherit'});
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
