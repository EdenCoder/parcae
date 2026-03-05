/**
 * Hook example — log post saves.
 *
 * This file is auto-discovered from the hooks/ directory.
 */

import { hook } from "@parcae/backend";
import { Post } from "../models/Post";

export default hook(Post as any, "after", ["save"], {
  async: true,
  handler: async ({ model }) => {
    console.log(`[hook] Post saved: ${model.id} — "${model.__data.title}"`);
  },
});
