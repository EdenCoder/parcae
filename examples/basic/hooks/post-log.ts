/**
 * Hook example — log post saves.
 *
 * This file is auto-discovered from the hooks/ directory.
 */

import { hook } from "@parcae/backend";
import { Post } from "../models/Post";

hook.after(Post as any, "save", async ({ model }) => {
  console.log(`[hook] Post saved: ${model.id} — "${model.__data.title}"`);
});
