import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

test('native Markdown renderer preserves chapters, code and images without executable document HTML',{skip:process.platform!=='darwin'},()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'contextos-markdown-'));
 try {
  fs.writeFileSync(path.join(temp,'main.swift'),String.raw`
import Foundation
let body = "# Heading\n# Heading\n<a id=\"开始使用\"></a>\n![demo](assets/demo.png)\n[bad](javascript:evil)\n<script>evil()</script>\n\n\u{0060}\u{0060}\u{0060}html\n<script>example</script>\n\u{0060}\u{0060}\u{0060}\n1. First\n2. Second\n"
let html = MarkdownPage.render(body)
precondition(html.contains("id=\"heading-2\""))
precondition(html.contains("id=\"开始使用\""))
precondition(html.contains("src=\"assets/demo.png\""))
precondition(html.contains("&lt;script&gt;example&lt;/script&gt;"))
precondition(!html.contains("<script>"))
precondition(!html.contains("javascript:"))
precondition(html.contains("2. Second"))
precondition(html.contains("script-src 'none'"))
print("Markdown chapters, code, relative images and inert HTML passed")
`);
  execFileSync('swiftc',['apps/desktop/Sources/ContextOSDesktop/MarkdownPage.swift',path.join(temp,'main.swift'),'-o',path.join(temp,'verify')],{timeout:30000});
  assert.match(execFileSync(path.join(temp,'verify'),{encoding:'utf8',timeout:10000}),/passed/);
 } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
