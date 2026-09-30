import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {applyChangeset} from '../src/changeset.mjs';
test('an explicit complete new file in edits creates atomically without a format retry',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'os-full-new-'));
 try{fs.writeFileSync(path.join(root,'old.txt'),'old');const result=applyChangeset(root,[{kind:'edit',path:'old.txt',target:'old',replacement:'new'},{kind:'edit',path:'nested/new.txt',fullFile:true,replacement:'complete new file'}]);assert.equal(fs.readFileSync(path.join(root,'old.txt'),'utf8'),'new');assert.equal(fs.readFileSync(path.join(root,'nested/new.txt'),'utf8'),'complete new file');}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('a missing source target still rejects the entire changeset',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'os-full-missing-'));
 try{fs.writeFileSync(path.join(root,'old.txt'),'old');assert.throws(()=>applyChangeset(root,[{kind:'edit',path:'old.txt',target:'old',replacement:'new'},{kind:'edit',path:'new.txt',fullFile:true,target:'expected',replacement:'complete'}]),/cannot edit missing file/);assert.equal(fs.readFileSync(path.join(root,'old.txt'),'utf8'),'old');assert.equal(fs.existsSync(path.join(root,'new.txt')),false);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
