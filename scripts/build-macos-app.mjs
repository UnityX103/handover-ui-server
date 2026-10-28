#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundleId = 'com.handover-ui.desktop';
const name = '远程交接.app';
const run = (program, args) => execFileSync(program, args, {stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8'});
const xml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const plist = body => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`;

if (process.platform !== 'darwin') throw new Error('本机 App 需在 macOS 上构建。');
const installing = process.argv.includes('--install');
const local = path.join(root, '.local/macos');
fs.mkdirSync(local, {recursive: true});
const staging = fs.mkdtempSync(path.join(local, 'build-'));
const stagedApp = path.join(staging, name), contents = path.join(stagedApp, 'Contents');
try {
  fs.mkdirSync(path.join(contents, 'MacOS'), {recursive:true});
  fs.mkdirSync(path.join(contents, 'Resources'), {recursive:true});
  process.stderr.write('正在构建 macOS 远程交接 App…\n');
  run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', `${os.arch() === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`, '-module-cache-path', path.join(local,'module-cache'), path.join(root,'desktop/macos/Models.swift'), path.join(root,'desktop/macos/main.swift'), '-framework','AppKit','-framework','WebKit','-o',path.join(contents,'MacOS/Handover')]);
  const iconset = path.join(staging, 'AppIcon.iconset'); fs.mkdirSync(iconset);
  for (const size of [16,32,128,256,512]) {
    run('/usr/bin/sips', ['-z',String(size),String(size),path.join(root,'web/icons/icon-512.png'),'--out',path.join(iconset,`icon_${size}x${size}.png`)]);
    run('/usr/bin/sips', ['-z',String(size*2),String(size*2),path.join(root,'web/icons/icon-512.png'),'--out',path.join(iconset,`icon_${size}x${size}@2x.png`)]);
  }
  run('/usr/bin/iconutil',['-c','icns',iconset,'-o',path.join(contents,'Resources/AppIcon.icns')]);
  fs.writeFileSync(path.join(contents,'Info.plist'),plist(`
    <key>CFBundleIdentifier</key><string>${bundleId}</string>
    <key>CFBundleExecutable</key><string>Handover</string>
    <key>CFBundleName</key><string>远程交接</string>
    <key>CFBundleDisplayName</key><string>远程交接</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>`));
  run('/usr/bin/codesign',['--force','--sign','-',stagedApp]);
  run('/usr/bin/codesign',['--verify','--deep','--strict',stagedApp]);
  const destination = installing ? path.join(os.homedir(),'Applications',name) : path.join(local,name);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  let backup;
  if (fs.existsSync(destination)) {
    backup=path.join(os.homedir(),'.local/share/handover-ui/app-backups',new Date().toISOString().replace(/[:.]/g,'-'),name);
    fs.mkdirSync(path.dirname(backup),{recursive:true,mode:0o700});
    fs.cpSync(destination,backup,{recursive:true,errorOnExist:true,force:false});
  }
  // Stage on the destination volume before switching; a failed copy leaves the old App in place.
  const prepared = destination+`.${process.pid}.new`;
  try {
    fs.cpSync(stagedApp,prepared,{recursive:true,errorOnExist:true,force:false});
    if(fs.existsSync(destination))fs.rmSync(destination,{recursive:true});
    fs.renameSync(prepared,destination);
  } catch(error) {
    fs.rmSync(prepared,{recursive:true,force:true});
    if(backup&&!fs.existsSync(destination))fs.cpSync(backup,destination,{recursive:true});
    throw error;
  }
  let loginFile;
  if(installing&&!process.argv.includes('--no-login')) {
    loginFile=path.join(os.homedir(),'Library/LaunchAgents',`${bundleId}.plist`);
    fs.mkdirSync(path.dirname(loginFile),{recursive:true});
    if(fs.existsSync(loginFile)&&!fs.readFileSync(loginFile,'utf8').includes(`<string>${bundleId}</string>`))throw new Error('登录启动配置已被其他内容占用，保留原文件。');
    fs.writeFileSync(loginFile,plist(`<key>Label</key><string>${bundleId}</string><key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-g</string><string>${xml(destination)}</string><string>--args</string><string>--background</string></array><key>RunAtLoad</key><true/>`),{mode:0o600});
    // Registration takes effect at the next login; do not steal focus during installation.
  }
  process.stdout.write(JSON.stringify({ok:true,app:destination,...(backup?{backup}:{}),...(loginFile?{loginFile}:{}),installed:installing})+'\n');
} catch(error) {
  process.stderr.write(error.stderr?.toString()||error.message+'\n');process.exitCode=1;
} finally {fs.rmSync(staging,{recursive:true,force:true});}
