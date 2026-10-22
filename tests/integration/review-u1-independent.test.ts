import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { ApiSuccessSchema, ContentDetailSchema, RevisionViewSchema, type AuthoringOperation } from "@dmall/contracts";
import { startT02cApp, type T02cTestApp } from "./t02c-test-helpers.js";
import {
  createInternalContent,
  restoreInternalRevision,
  saveInternalRevision,
} from "./internal-authoring-helpers.js";

const apps: T02cTestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    const port = new URL(app.base).port;
    await app.close();
    console.log(JSON.stringify({event:"review_server_closed",pid:process.pid,port}));
    await rm(app.config.dataRoot, {recursive:true,force:true});
  }
});
async function editor() {
  const app = await startT02cApp(); apps.push(app);
  const result = createInternalContent(app, {schemaVersion:1,title:"独立反例",kind:"feishu_doc"});
  expect(result.status).toBe(201);
  const rendition = ApiSuccessSchema(ContentDetailSchema).parse(result.body).data.renditions[0];
  if (!rendition) throw new Error("missing rendition");
  let current = rendition.currentRevisionId;
  const post = (operations: AuthoringOperation[],key = randomUUID()) => saveInternalRevision(app,rendition.id,{schemaVersion:1,baseRevisionId:current,operations,claims:[],evidenceSelections:[]},key);
  const save = async (operations: AuthoringOperation[]) => {
    const response = await post(operations);expect(response.status,JSON.stringify(response.body)).toBe(201);
    const view=ApiSuccessSchema(RevisionViewSchema).parse(response.body).data;current=view.id;return view;
  };
  const restore = (historicalRevisionId:string) => restoreInternalRevision(app,rendition.id,{schemaVersion:1,historicalRevisionId,expectedRevisionId:current});
  const snapshot = () => {
    const db=app.context.database.db;
    return {
      renditions:db.prepare("SELECT * FROM renditions ORDER BY id").all(),
      revisions:db.prepare("SELECT * FROM revisions ORDER BY id").all(),
      refs:db.prepare("SELECT * FROM revision_refs ORDER BY revision_id,ref_type,ref_id").all(),
      evidence:db.prepare("SELECT * FROM revision_evidence ORDER BY revision_id").all(),
      receipts:db.prepare("SELECT * FROM idempotency_keys ORDER BY route_scope,key").all(),
    };
  };
  return {app,rendition,post,save,restore,snapshot};
}
function paragraph(id=randomUUID()) {return {id,type:"paragraph" as const,inlines:[{text:"受保护正文",marks:[]}],provenance:[],locks:[]};}
function section(blocks:ReturnType<typeof paragraph>[] = []) {return {id:randomUUID(),title:"章节",blocks,locks:[]};}
function observe(name:string,response:unknown,before:ReturnType<Awaited<ReturnType<typeof editor>>['snapshot']>,after:ReturnType<Awaited<ReturnType<typeof editor>>['snapshot']>) {
 console.log(JSON.stringify({event:"review_observation",name,response,writes:{revisions:after.revisions.length-before.revisions.length,refs:after.refs.length-before.refs.length,evidence:after.evidence.length-before.evidence.length,receipts:after.receipts.length-before.receipts.length},stateUnchanged:JSON.stringify(before)===JSON.stringify(after)}));
}
it("rejects nested block ID equal to rendition root with zero writes",async()=>{
 const e=await editor();const a=section([paragraph(e.rendition.rootNodeId)]);const before=e.snapshot();
 const response=await e.post([{op:"insertNode",parentId:e.rendition.rootNodeId,afterId:null,node:a}]);
 observe("nested_root_collision",response,before,e.snapshot());
 expect(response.status).toBe(422);expect(e.snapshot()).toEqual(before);
});
it("ancestor field lock prevents deleting the protected descendant",async()=>{
 const e=await editor();const p=paragraph(),a=section([p]);
 await e.save([{op:"insertNode",parentId:e.rendition.rootNodeId,afterId:null,node:a}]);
 await e.save([{op:"setField",nodeId:a.id,path:"locks",value:["blocks.inlines.*"]}]);
 const controlBefore=e.snapshot();const direct=await e.post([{op:"setField",nodeId:p.id,path:"inlines",value:[{text:"直接修改",marks:[]}]}]);
 expect(direct.status).toBe(409);expect(direct.body).toMatchObject({error:{code:"LOCKED_FIELD"}});expect(e.snapshot()).toEqual(controlBefore);
 console.log(JSON.stringify({event:"review_lock_control",status:direct.status,code:"LOCKED_FIELD",stateUnchanged:true}));
 const before=e.snapshot();const response=await e.post([{op:"removeNode",nodeId:p.id}]);
 observe("ancestor_delete",response,before,e.snapshot());
 expect(response.status).toBe(409);expect(e.snapshot()).toEqual(before);
});
it("ancestor field lock prevents move then edit outside the ancestor",async()=>{
 const e=await editor();const p=paragraph(),a=section([p]),b=section();
 await e.save([a,b].map(node=>({op:"insertNode",parentId:e.rendition.rootNodeId,afterId:null,node})));
 await e.save([{op:"setField",nodeId:a.id,path:"locks",value:["blocks.inlines.*"]}]);
 const before=e.snapshot();const response=await e.post([{op:"moveNode",nodeId:p.id,parentId:b.id,afterId:null},{op:"setField",nodeId:p.id,path:"inlines",value:[{text:"绕过锁后重写",marks:[]}]}]);
 observe("ancestor_move_edit",response,before,e.snapshot());
 expect(response.status).toBe(409);expect(e.snapshot()).toEqual(before);
});
it("restore cannot delete descendant protected by unchanged ancestor field lock",async()=>{
 const e=await editor();const a=section();
 await e.save([{op:"insertNode",parentId:e.rendition.rootNodeId,afterId:null,node:a}]);
 const history=await e.save([{op:"setField",nodeId:a.id,path:"locks",value:["blocks.inlines.*"]}]);
 await e.save([{op:"setField",nodeId:a.id,path:"locks",value:[]}]);
 await e.save([{op:"insertNode",parentId:a.id,afterId:null,node:paragraph()}]);
 await e.save([{op:"setField",nodeId:a.id,path:"locks",value:["blocks.inlines.*"]}]);
 const before=e.snapshot();const response=await e.restore(history.id);
 observe("ancestor_restore_delete",response,before,e.snapshot());
 expect(response.status).toBe(409);expect(e.snapshot()).toEqual(before);
});
it("stale base with changed body cannot reuse a successful manual receipt",async()=>{
 const e=await editor();const key=randomUUID();const operation={op:"setField" as const,nodeId:e.rendition.rootNodeId,path:"title" as const,value:"第一次"};const body=[operation];
 const first=await e.post(body,key);expect(first.status).toBe(201);
 const before=e.snapshot();const replay=await e.post(body,key);expect(replay).toEqual(first);expect(e.snapshot()).toEqual(before);
 const response=await e.post([{...operation,value:"不同请求"}],key);
 observe("receipt_conflict",response,before,e.snapshot());
 expect(response.status).toBe(409);expect(response.body).toMatchObject({error:{code:"IDEMPOTENCY_CONFLICT"}});expect(e.snapshot()).toEqual(before);
});
