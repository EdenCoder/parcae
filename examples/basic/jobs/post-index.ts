/**
 * Job example — index a post (placeholder).
 *
 * This file is auto-discovered from the jobs/ directory.
 */

import { job } from "@parcae/backend";

export default job("post:index", async ({ data }) => {
  console.log(`[job] Indexing post: ${data.postId}`);
  // In a real app: index in Typesense, Elasticsearch, etc.
  return { success: true };
});
