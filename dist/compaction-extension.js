#!/usr/bin/env node

// src/pi-rpc/compaction-extension.ts
import { readFileSync, rmSync } from "fs";
import { join } from "path";
function compactionHandoff(pi) {
  const dir = process.env.PI_ACP_COMPACTION_HANDOFF_DIR;
  if (!dir) return;
  pi.on("session_before_compact", (event, ctx) => {
    if (event.customInstructions) return;
    const file = join(dir, `${ctx.sessionManager.getSessionId()}.json`);
    let handoff;
    try {
      handoff = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return;
    }
    rmSync(file, { force: true });
    const entries = event.branchEntries;
    const lastCompaction = entries.map((e) => e.type).lastIndexOf("compaction");
    if (entries.findIndex((e) => e.id === handoff.firstKeptEntryId) <= lastCompaction) return;
    if (event.preparation.tokensBefore >= (handoff.maxTokensBefore ?? Infinity)) return;
    return {
      compaction: {
        summary: handoff.summary,
        firstKeptEntryId: handoff.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: handoff.details,
        usage: handoff.usage
      }
    };
  });
}
export {
  compactionHandoff as default
};
//# sourceMappingURL=compaction-extension.js.map