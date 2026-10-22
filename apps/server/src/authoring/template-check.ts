import type { Ast, Block, LayoutSlot, TemplatePackage, TemplateSlot } from "@dmall/contracts";

export function templateAstValid(pkg: TemplatePackage, ast: Ast, ownershipAst: Ast = ast): boolean {
  if (pkg.manifest.kind !== ast.kind || pkg.manifest.status === "archived") return false;
  if (ast.kind === "feishu_doc") return pkg.layouts.length === 0;
  if (pkg.layouts.length === 0 || ownershipAst.kind !== "html_deck") return false;
  const owners = new Map(ownershipAst.slides.map((slide, index) => [
    slide.id,
    pkg.narrative.deck.slides[index],
  ]));
  for (const slide of ast.slides) {
    const layout = pkg.layouts.find((item) => item.id === slide.layout);
    if (layout === undefined || slide.title.length > layout.titleMaxCharacters) return false;
    const owner = owners.get(slide.id);
    const containerSlots = owner === undefined ? [] : pkg.slots.filter((slot) => slot.containerId === owner.id);
    const counts = new Map<string, number>();
    for (const block of slide.blocks) {
      // Unplaced blocks stay in the draft and continue to block export.
      if (block.slotId === null || block.slotId === undefined) continue;
      const layoutSlot = layout.slots.find((slot) => slot.id === block.slotId);
      if (layoutSlot === undefined || !layoutSlot.blockTypes.some((type) => type === block.type)) return false;
      if (!withinCapacity(block, layoutSlot)) return false;
      const used = counts.get(layoutSlot.id) ?? 0;
      if (used >= (layoutSlot.maxItems ?? 1)) return false;
      counts.set(layoutSlot.id, used + 1);
      // AST slotId is a layout slot, not the package's globally unique slot id.
      const slots = containerSlots.filter((slot) => slot.layoutSlotId === block.slotId && slot.blockType === block.type);
      if (owner === undefined || owner.layout !== slide.layout || !slots.some((slot) => withinCapacity(block, slot.capacity))) return false;
    }
  }
  return true;
}

function withinCapacity(block: Block, capacity: TemplateSlot["capacity"] | LayoutSlot): boolean {
  const text = (inlines: import("@dmall/contracts").Inlines) => inlines.map((item) => item.text).join("");
  const texts = block.type === "paragraph" || block.type === "callout"
    ? [text(block.inlines)]
    : block.type === "heading"
      ? [block.text]
      : block.type === "list"
        ? block.items.map(text)
        : block.type === "table"
          ? [...block.columns, ...block.rows.flatMap((row) => row.map(text))]
          : [];
  const maxCharacters = capacity.maxCharacters;
  if (maxCharacters !== undefined && texts.some((value) => value.length > maxCharacters)) return false;
  if (block.type === "list" && capacity.maxItems !== undefined && block.items.length > capacity.maxItems) return false;
  if (block.type === "table" && capacity.maxRows !== undefined && block.rows.length > capacity.maxRows) return false;
  return true;
}
