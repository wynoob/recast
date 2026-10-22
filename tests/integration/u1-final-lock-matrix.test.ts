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
async function editor(kind: "feishu_doc" | "html_deck") {
  const app = await startT02cApp(); apps.push(app);
  const result = createInternalContent(app, {schemaVersion:1,title:"独立反例",kind});
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
type Kind = "feishu_doc" | "html_deck";
function paragraph(kind: Kind, id: string = randomUUID()) {
  return {id,type:"paragraph" as const,inlines:[{text:"受保护正文",marks:[]}],provenance:[],locks:[],...(kind === "html_deck" ? {slotId:null} : {})};
}
function container(kind: Kind, blocks: ReturnType<typeof paragraph>[] = []) {
  return {id:randomUUID(),title:"章节",blocks,locks:[],...(kind === "html_deck" ? {layout:"cover" as const,speakerNotes:""} : {})};
}
async function locked(e: Awaited<ReturnType<typeof editor>>, action: () => ReturnType<typeof e.post>, label: string) {
  const before=e.snapshot(); const response=await action();
  expect(response.status, label + JSON.stringify(response.body)).toBe(409);
  expect(response.body).toMatchObject({error:{code:"LOCKED_FIELD"}});
  expect(e.snapshot(),label).toEqual(before);
}
const kinds: Kind[] = ["feishu_doc","html_deck"];
const scopes = kinds.flatMap(kind => [
  {kind,scope:"container",wildcard:true}, {kind,scope:"root",wildcard:false},
]);
it.each(scopes)("$kind $scope inherited field paths protect source subtree and atomic batches",async ({kind,scope,wildcard}) => {
  const e=await editor(kind), p=paragraph(kind), a=container(kind,[p]), b=container(kind);
  await e.save([a,b].map(node=>({op:"insertNode",parentId:e.rendition.rootNodeId,afterId:null,node})));
  const collection=kind === "feishu_doc" ? "sections" : "slides";
  const lock=(scope === "root" ? collection+"." : "")+"blocks.inlines"+(wildcard ? ".*" : ".0.text");
  await e.save([{op:"setField",nodeId:scope === "root" ? e.rendition.rootNodeId : a.id,path:"locks",value:[lock]}]);
  const edits: AuthoringOperation[][] = [
    [{op:"setField",nodeId:p.id,path:"inlines",value:[{text:"直接编辑",marks:[]}]}],
    [{op:"removeNode",nodeId:p.id}],
    [{op:"moveNode",nodeId:p.id,parentId:b.id,afterId:null}],
    [{op:"moveNode",nodeId:p.id,parentId:b.id,afterId:null},{op:"setField",nodeId:p.id,path:"inlines",value:[]}],
    [{op:"setField",nodeId:b.id,path:"title",value:"先改未锁字段"},{op:"removeNode",nodeId:a.id}],
  ];
  for (const [i,operations] of edits.entries()) await locked(e,()=>e.post(operations),String(i));
});
it.each(kinds)("%s checks destination ancestor fields for move and move+edit",async kind=>{
  const e=await editor(kind), p=paragraph(kind), a=container(kind,[p]), b=container(kind);
  await e.save([a,b].map(node=>({op:"insertNode",parentId:e.rendition.rootNodeId,afterId:null,node})));
  await e.save([{op:"setField",nodeId:b.id,path:"locks",value:["blocks.inlines.*"]}]);
  await locked(e,()=>e.post([{op:"moveNode",nodeId:p.id,parentId:b.id,afterId:null}]),"destination");
  await locked(e,()=>e.post([{op:"moveNode",nodeId:p.id,parentId:b.id,afterId:null},{op:"setField",nodeId:p.id,path:"inlines",value:[]}]),"destination and edit");
});
const restores = kinds.flatMap(kind => (["delete","reparent","reorder"] as const).map(effect=>({kind,effect})));
it.each(restores)("$kind restore $effect respects current inherited fields with identical lock arrays",async ({kind,effect})=>{
  const e=await editor(kind), p=paragraph(kind), q=paragraph(kind), a=container(kind), b=container(kind);
  a.blocks=effect === "delete" || effect === "reparent" ? [] : [q,p];
  b.blocks=effect === "reparent" ? [p] : [];
  await e.save([a,b].map(node=>({op:"insertNode",parentId:e.rendition.rootNodeId,afterId:null,node})));
  const history=await e.save([{op:"setField",nodeId:a.id,path:"locks",value:["blocks.inlines.*"]}]);
  await e.save([{op:"setField",nodeId:a.id,path:"locks",value:[]}]);
  if(effect === "delete") await e.save([{op:"insertNode",parentId:a.id,afterId:null,node:p}]);
  if(effect === "reparent") await e.save([{op:"moveNode",nodeId:p.id,parentId:a.id,afterId:null}]);
  if(effect === "reorder") await e.save([{op:"moveNode",nodeId:p.id,parentId:a.id,beforeId:q.id}]);
  await e.save([{op:"setField",nodeId:a.id,path:"locks",value:["blocks.inlines.*"]}]);
  await locked(e,()=>e.restore(history.id),effect);
});
it.each(kinds)("%s allows unrelated field/structure changes and restore beside protected descendants",async kind=>{
  const e=await editor(kind), p=paragraph(kind), a=container(kind,[p]), b=container(kind);
  await e.save([a,b].map(node=>({op:"insertNode",parentId:e.rendition.rootNodeId,afterId:null,node})));
  const history=await e.save([{op:"setField",nodeId:a.id,path:"locks",value:["blocks.inlines.*"]}]);
  const heading={id:randomUUID(),type:"heading" as const,text:"未保护字段",level:1,provenance:[],locks:[],...(kind === "html_deck" ? {slotId:null} : {})};
  await e.save([{op:"setField",nodeId:a.id,path:"title",value:"新标题"},{op:"insertNode",parentId:a.id,beforeId:p.id,node:heading}]);
  const restored=await e.restore(history.id);
  expect(restored.status,JSON.stringify(restored.body)).toBe(201);
  expect(ApiSuccessSchema(RevisionViewSchema).parse(restored.body).data.ast).toEqual(history.ast);
  const f=await editor(kind), c=container(kind,[paragraph(kind)]), d=container(kind);
  await f.save([c,d].map(node=>({op:"insertNode",parentId:f.rendition.rootNodeId,afterId:null,node})));
  await f.save([{op:"setField",nodeId:c.id,path:"locks",value:["title"]}]);
  const child=c.blocks[0]; if(!child) throw new Error("missing paragraph");
  await f.save([{op:"moveNode",nodeId:child.id,parentId:d.id,afterId:null}]);
  await f.save([{op:"removeNode",nodeId:child.id}]);
});
it.each(kinds)("%s rejects complete inserted subtree root/internal/existing ID collisions with zero batch writes",async kind=>{
  const e=await editor(kind), p=paragraph(kind), a=container(kind,[p]);
  await e.save([{op:"insertNode",parentId:e.rendition.rootNodeId,afterId:null,node:a}]);
  const x=container(kind); const fresh=paragraph(kind);
  const invalid = [
    {...x,id:e.rendition.rootNodeId},
    {...x,blocks:[paragraph(kind,e.rendition.rootNodeId)]},
    {...x,blocks:[paragraph(kind,x.id)]},
    {...x,blocks:[fresh,{...fresh}]},
    {...x,blocks:[paragraph(kind,p.id)]},
    {...x,blocks:[paragraph(kind,a.id)]},
  ];
  for(const node of invalid) {
    const before=e.snapshot();
    const response=await e.post([{op:"setField",nodeId:e.rendition.rootNodeId,path:"title",value:"必须回滚"},{op:"insertNode",parentId:e.rendition.rootNodeId,afterId:null,node}]);
    expect(response.status,JSON.stringify(response.body)).toBe(422);expect(e.snapshot()).toEqual(before);
  }
});
