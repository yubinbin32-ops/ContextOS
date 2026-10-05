// Model discovery returns public metadata only; credentials enter through stdin, never argv.
// Protocol: {models:[{id,label,reasoningLevels:[{id,label}],reasoningSource}],source,warnings,status,error?}.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';

const LIMIT = 2_000_000;
const cleanString = v => typeof v === 'string' && v.length <= 500 && !/[\r\n]/.test(v) ? v.trim() : '';
const levels = v => [...new Map((Array.isArray(v) ? v : []).map(x => {
  const id = cleanString(typeof x === 'string' ? x : x?.id ?? x?.reasoningEffort ?? x?.reasoning_effort);
  return [id, {id, label:cleanString(x?.label ?? x?.description) || id}];
}).filter(([id])=>id)).values()];
export function normalizeModels(payload, source) {
  const data = Array.isArray(payload) ? payload : payload?.models ?? payload?.data;
  if (!Array.isArray(data)) throw new Error('catalog-schema');
  const rows = [];
  const seen = new Set();
  for (const raw of data) {
    const item = typeof raw === 'string' ? {id:raw} : raw;
    if (!item || item.hidden === true) continue;
    const id = cleanString(item.model ?? item.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({id,label:cleanString(item.label ?? item.displayName ?? item.display_name ?? item.name) || id,
      reasoningLevels:levels(item.reasoningLevels ?? item.thinkingLevels ?? item.supportedReasoningEfforts ?? item.supported_reasoning_efforts ?? item.reasoning_efforts),
      reasoningSource:cleanString(item.reasoningSource) || source});
  }
  return rows;
}
export function modelsURL(base) {
  const url = new URL(base);
  if (!['http:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error('invalid-endpoint');
  if (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('https-required');
  url.pathname = url.pathname.replace(/\/(chat\/completions|responses|models)\/?$/, '').replace(/\/$/, '') + '/models';
  return url;
}
export function agyModels(text) {
  const models = [];
  for (const line of text.replace(/\x1b\[[0-9;]*m/g,'').split(/\r?\n/)) {
    const match = line.trim().match(/^([\w.-]+)(?:\t+| {2,})(.+)$/);
    if (match) models.push({id:match[1],label:match[2],reasoningLevels:[],reasoningSource:'agy models / listed aliases'});
  }
  const ids = new Set(models.map(x=>x.id));
  for (const model of models) {
    const match = model.id.match(/^(.*)-(low|medium|high|xhigh|max)$/);
    if (match) model.reasoningLevels = levels(['low','medium','high','xhigh','max'].filter(level=>ids.has(match[1]+'-'+level)));
  }
  return [...new Map(models.map(model=>[model.id,model])).values()];
}
function profileHome() {
  return process.env.CONTEXTOS_HOME || path.join(os.homedir(),'.contextos');
}
function readProfile() {
  const file = path.join(profileHome(),'profile.json');
  if (!fs.existsSync(file)) return {};
  const data = JSON.parse(fs.readFileSync(file,'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid-profile');
  return data;
}
export async function syncMicro(draft, profile = readProfile()) {
  const micro = profile.micro || {};
  const base = cleanString(draft?.baseURL) || cleanString(micro.baseUrl || micro.url);
  const key = cleanString(draft?.replacementKey) || cleanString(micro.key || micro.apiKey) || cleanString(process.env[micro.keyEnv || '']);
  const url = modelsURL(base);
  const savedBase = cleanString(micro.baseUrl || micro.url);
  if (!cleanString(draft?.replacementKey) && key && (!savedBase || modelsURL(savedBase).origin !== url.origin)) throw new Error('service-key-required');
  if (!key) throw new Error('credential-required');
  const response = await fetch(url,{headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error('http-'+response.status);
  const advertisedLength = Number(response.headers.get('content-length'));
  if (advertisedLength > LIMIT) throw new Error('catalog-size');
  let body = '';
  for await (const chunk of response.body) {
    body += Buffer.from(chunk).toString('utf8');
    if (Buffer.byteLength(body) > LIMIT) throw new Error('catalog-size');
  }
  const source = url.origin + url.pathname;
  const payload = JSON.parse(body);
  const models = normalizeModels(payload,source);
  const advertised = new Set((Array.isArray(payload) ? payload : payload.models ?? payload.data).filter(item => item && typeof item === 'object' && ['reasoningLevels','thinkingLevels','supportedReasoningEfforts','supported_reasoning_efforts','reasoning_efforts'].some(field => field in item)).map(item => item.model ?? item.id));
  for (const model of models) {
    if (advertised.has(model.id)) continue;
    const explicit = micro.thinkingMap?.[micro.transport || 'chat'];
    if (explicit && typeof explicit === 'object') {
      model.reasoningLevels = levels(Object.keys(explicit).filter(k=>explicit[k] !== false && explicit[k] != null));
      model.reasoningSource = 'Profile thinkingMap';
    } else if (/^deepseek-v4/i.test(model.id) || ['deepseek-flash','deepseek-pro'].includes(model.id.toLowerCase())) {
      model.reasoningLevels = levels(['none','minimal','low','medium','high','xhigh','max','ultra']);
      model.reasoningSource = 'ContextOS DeepSeek mapping · https://api-docs.deepseek.com/guides/thinking_mode/';
    }
  }
  if (!models.length) throw new Error('catalog-empty');
  return {models,source,warnings:[],status:'synced'};
}
export function runCommand(command,args=[],env={}) {
  if (!cleanString(command) || !Array.isArray(args) || args.some(x=>typeof x!=='string')) return Promise.reject(new Error('catalog-command'));
  return new Promise((resolve,reject)=>{
    const child = spawn(command,args,{env:{...process.env,...env},shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',done=false;
    const finish=(err)=>{if(done)return;done=true;clearTimeout(timer);if(err){child.kill();reject(err);}else resolve(output);};
    const timer=setTimeout(()=>finish(new Error('catalog-timeout')),22000);
    child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>LIMIT)finish(new Error('catalog-size'));});
    child.stderr.resume(); // Never return authentication messages or arbitrary diagnostic text.
    child.on('error',()=>finish(new Error('catalog-launch')));
    child.on('close',code=>finish(code===0?null:new Error('catalog-exit')));
  });
}
export function codexModels(command='codex',env={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,['app-server'],{env:{...process.env,...env},shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let buffer='',bytes=0,nextId=1,done=false,pages=0,models=[];
    const pending=new Map();
    const timer=setTimeout(()=>finish(new Error('catalog-timeout')),22000);
    function finish(error) {
      if(done)return;done=true;clearTimeout(timer);child.stdin.end();child.kill();
      if(error)reject(error);else resolve({models,source:'codex app-server model/list',warnings:[],status:'synced'});
    }
    const send=(method,params)=>{const id=nextId++;pending.set(id,method);child.stdin.write(JSON.stringify({id,method,params})+'\n');};
    child.stdout.on('data',chunk=>{
      bytes+=chunk.length;if(bytes>LIMIT)return finish(new Error('catalog-size'));
      buffer+=chunk;
      while(buffer.includes('\n')) {
        const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);
        let message;try{message=JSON.parse(line);}catch{continue;}
        const method=pending.get(message.id);
        if(!method)continue;pending.delete(message.id);
        if(message.error)return finish(new Error('catalog-rpc'));
        if(method==='initialize') {
          child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
          send('model/list',{limit:100});
        } else {
          try{models.push(...normalizeModels(message.result,'codex app-server model/list'));}catch{return finish(new Error('catalog-schema'));}
          const cursor=message.result?.nextCursor;
          if(cursor && ++pages<20)send('model/list',{limit:100,cursor});
          else if(cursor)finish(new Error('catalog-pagination'));
          else {models=[...new Map(models.map(x=>[x.id,x])).values()];finish(models.length ? undefined : new Error('catalog-empty'));}
        }
      }
    });
    child.stderr.resume();
    child.stdin.on('error',()=>finish(new Error('catalog-launch')));
    child.on('error',()=>finish(new Error('catalog-launch')));
    child.on('close',()=>{if(!done)finish(new Error('catalog-exit'));});
    send('initialize',{clientInfo:{name:'contextos-model-catalog',version:'3.0.0'},capabilities:{}});
  });
}
export async function syncCLI(adapterName,profile=readProfile()) {
  const adapter=profile.agents?.adapters?.[adapterName];
  if (!adapter || typeof adapter !== 'object') throw new Error('adapter-unconfigured');
  const env=adapter.env && typeof adapter.env==='object' ? adapter.env : {};
  if (adapter.catalog) {
    const catalog=adapter.catalog;
    const payload=Array.isArray(catalog.models) ? catalog.models :
      JSON.parse(await runCommand(catalog.command,catalog.args || [],env));
    const models=normalizeModels(payload,'Configured adapter catalog');
    if (!models.length) throw new Error('catalog-empty');
    return {models,source:'Configured adapter catalog',warnings:[],status:'synced'};
  }
  const command=Array.isArray(adapter.command)?adapter.command[0]:adapter.command;
  const executable=path.basename(command || '').replace(/\.exe$/i,'').toLowerCase();
  if (adapter.provider==='codex-cli' || executable==='codex' || (adapter.args || []).some(x=>typeof x==='string' && /codex-cli-bridge\.mjs$/.test(x))) {
    return codexModels(env.CONTEXTOS_CODEX_BIN || process.env.CONTEXTOS_CODEX_BIN || (executable==='codex'?command:'codex'),env);
  }
  if (executable==='agy') {
    const models=agyModels(await runCommand(command,['models'],env));
    if(!models.length)throw new Error('catalog-schema');
    return {models,source:'agy models / listed effort aliases',warnings:[],status:'synced'};
  }
  throw new Error('catalog-not-declared');
}
const messages={
  'credential-required':'Enter an API key before syncing models.',
  'service-key-required':'After changing service address, enter that service API key before syncing.',
  'invalid-endpoint':'Enter a valid Base URL without credentials, query or fragment.',
  'https-required':'Use HTTPS for remote model discovery.',
  'catalog-not-declared':'Ask AI to declare this adapter catalog command.',
  'adapter-unconfigured':'Configure this CLI adapter first.',
  'invalid-profile':'Repair the global profile before syncing.'
};
if (process.env.CONTEXTOS_CATALOG_RUN==='1') {
  const watchdog=setTimeout(()=>process.exit(1),28000);
  try {
    const input=JSON.parse(fs.readFileSync(0,'utf8'));
    const result=input.kind==='micro'?await syncMicro(input.draft):await syncCLI(input.adapter);
    process.stdout.write(JSON.stringify(result));
  } catch(error) {
    const code=error.message;
    const message=messages[code] || (/^http-\d+$/.test(code)?'Model endpoint returned HTTP '+code.slice(5)+'.':'Model sync failed; check credentials, CLI readiness or catalog format.');
    process.stdout.write(JSON.stringify({models:[],source:'',warnings:[],status:'failed',error:message}));
  } finally {clearTimeout(watchdog);}
}
