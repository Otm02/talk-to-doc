import type { TranscriptItem } from "./state";

/**
 * Conversation order from previous_item_id links, never from arrival alone.
 *
 * Input transcription is asynchronous, so a user item can be announced (and
 * its text can land) after the assistant's reply has already started. The
 * links put it back where it belongs. Items from earlier sessions come
 * first; inside a session, items whose predecessor is unknown (null, not
 * told yet, or an id we never saw) are roots ordered by arrival, and each
 * root is followed by its chain.
 */
export function orderItems(items: Record<string, TranscriptItem>): string[] {
  const all = Object.values(items);
  const byEpoch = new Map<number, TranscriptItem[]>();
  for (const it of all) {
    const bucket = byEpoch.get(it.epoch);
    if (bucket) bucket.push(it);
    else byEpoch.set(it.epoch, [it]);
  }

  const out: string[] = [];
  const emitted = new Set<string>();
  const epochs = [...byEpoch.keys()].sort((a, b) => a - b);

  for (const epoch of epochs) {
    const group = byEpoch.get(epoch) ?? [];
    const ids = new Set(group.map((g) => g.id));
    const children = new Map<string, TranscriptItem[]>();
    const roots: TranscriptItem[] = [];
    for (const it of group) {
      if (
        typeof it.prev === "string" &&
        ids.has(it.prev) &&
        it.prev !== it.id
      ) {
        const list = children.get(it.prev);
        if (list) list.push(it);
        else children.set(it.prev, [it]);
      } else {
        roots.push(it);
      }
    }
    const byArrival = (a: TranscriptItem, b: TranscriptItem) =>
      a.arrival - b.arrival;
    roots.sort(byArrival);

    // Iterative walk: a long conversation must not grow the call stack.
    const visit = (root: TranscriptItem) => {
      const stack: TranscriptItem[] = [root];
      while (stack.length > 0) {
        const cur = stack.pop();
        if (!cur || emitted.has(cur.id)) continue;
        emitted.add(cur.id);
        out.push(cur.id);
        const kids = children.get(cur.id);
        if (kids) stack.push(...[...kids].sort(byArrival).reverse());
      }
    };
    for (const root of roots) visit(root);

    // A cycle (corrupt links) leaves items unreached; keep them visible.
    for (const it of [...group].sort(byArrival)) {
      if (!emitted.has(it.id)) visit(it);
    }
  }
  return out;
}

/** An interrupted answer with no words has nothing to show. */
export function isHidden(item: TranscriptItem): boolean {
  return item.status === "interrupted" && item.text === "";
}

/** Order for display: hidden tombstones keep their chain but are not listed. */
export function visibleOrder(items: Record<string, TranscriptItem>): string[] {
  return orderItems(items).filter((id) => {
    const it = items[id];
    return it !== undefined && !isHidden(it);
  });
}
