import * as z from 'zod/v4';
import { listDocuments, openDocument, writeDocument, patchDocument, importDocument } from './documents.mjs';
import { beginTask, reconcileTask, finishTask, indexSources, updateTaskScope } from './reconciliation.mjs';
export function registerWorkspaceTools(server, withProject, readResult, writeResult) {
  const common = {projectRoot:z.string().min(1).optional(),taskContextId:z.string().optional(),includeStructured:z.boolean().default(false)};
  const register=(name,description,schema,action,write=false)=>server.registerTool(name,{description,inputSchema:{...common,...schema}},async input=>{
    const data=withProject(input,(service,payload)=>action(service,payload));
    const markdown=data.markdown !== undefined ? `${data.markdown}\n\n${data.truncated ? "[Truncated: open a chapter or expand maxChars]\n" : ""}${data.openURL ?? ""}` : JSON.stringify(data,null,2);
    return (write?writeResult:readResult)(data,markdown,input.includeStructured,name);
  });
  register('document_list','List OS documents and stable chapter locators; no full bodies.',{query:z.string().optional()},(s,p)=>({documents:listDocuments(s,p)}));
  register('document_open','Read one OS document or chapter under a character budget; return App deep link.',{id:z.string(),sectionId:z.string().optional(),maxChars:z.number().int().min(200).max(50000).optional(),revision:z.number().int().optional()},openDocument);
  register('document_write','Create/update canonical OS Markdown. Existing documents require expectedRevision. README remains a read-only repository file.',{
    id:z.string().min(1),title:z.string().min(1),body:z.string().max(1000000),summary:z.string().optional(),
    kind:z.enum(['note','audit','design','guide','reference']).optional(),status:z.enum(['draft','review','accepted','archived']).optional(),
    relations:z.array(z.string()).optional(),expectedRevision:z.number().int().optional()},writeDocument,true);
  register('document_patch','Replace a document chapter including its heading, using optimistic revision checking.',{id:z.string(),sectionId:z.string(),body:z.string(),expectedRevision:z.number().int()},patchDocument,true);
  register('document_import','Import an internal Markdown document into OS with source hash; leaves original file until migration is reviewed. README cannot be imported.',{relativePath:z.string(),id:z.string(),title:z.string(),kind:z.enum(['note','audit','design','guide','reference']).optional(),expectedRevision:z.number().int().optional()},importDocument,true);
  register('task_begin','Start a persistent task after registering Blocks. Declare a feature network or standalone reason. Returns unfinished sessions for recovery.',{
    intent:z.string().min(1),blockIds:z.array(z.string()).default([]),linkIds:z.array(z.string()).default([]),chainId:z.string().optional(),planId:z.string().optional(),standaloneReason:z.string().optional(),readOnly:z.boolean().optional(),
    feature:z.object({id:z.string(),title:z.string(),nodeIds:z.array(z.string()),linkIds:z.array(z.string()),inputContract:z.string().optional(),outputContract:z.string().optional()}).strict().optional()},beginTask,true);
  register('task_scope','Revise or hand off a task scope with an optimistic timestamp. Excluded paths require explicit reasons.',{taskId:z.string(),expectedUpdatedAt:z.string(),blockIds:z.array(z.string()).optional(),linkIds:z.array(z.string()).optional(),chainId:z.string().nullable().optional(),planId:z.string().nullable().optional(),standaloneReason:z.string().optional(),excludedPaths:z.array(z.object({path:z.string(),reason:z.string().min(1)}).strict()).optional(),nextAction:z.string().optional(),summary:z.string().optional()},updateTaskScope,true);
  register('task_reconcile','Index changed/new/deleted source, reconcile task bindings and feature network, persist actionable sync issues.',{taskId:z.string()},reconcileTask,true);
  register('task_finish','Atomically complete verified task Blocks and feature Chain with a source/revision fence and idempotency key; report missing evidence.',{taskId:z.string(),expectedGraphRevision:z.number().int(),sourceRevision:z.string(),idempotencyKey:z.string(),summary:z.string().optional()},finishTask,true);
  register('source_index','Scan source inventory including unbound files; persist file/symbol index and revisioned events. Bodies never returned.',{},indexSources,true);
  register('sync_issues','Read open synchronization issues and resumable tasks.',{},s=>({issues:s.database.prepare("SELECT * FROM sync_issues WHERE status='open' ORDER BY updated_at DESC LIMIT 100").all(),tasks:s.database.prepare("SELECT id,intent,status,scope_json,updated_at FROM task_sessions WHERE status='active' ORDER BY updated_at DESC LIMIT 20").all().map(({scope_json,...row})=>({...row,scope:JSON.parse(scope_json)}))}));
  register('runtime_info','Report the running protocol and knowledge/sync capabilities for installation verification.',{},()=>({protocolVersion:2,version:'0.4.0',capabilities:['documents','readme-readonly','task-sessions','source-index','projection-recovery','chapter-context','plan-append','chain-append','chain-reconcile','block-ast-slice','source-cache']}));
}
