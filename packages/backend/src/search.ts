/**
 * @parcae/backend — Search Utilities
 *
 * Cross-model search for Cmd+K global search and search pages.
 * Uses the same hybrid search (tsvector + trigram + optional vector)
 * as the per-model .search() chain method.
 */

import type { ModelConstructor, ScopeContext } from "@parcae/model";
import type { BackendAdapter } from "./adapters/model";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SearchResult {
  /** Model type (e.g. "project", "user") */
  type: string;
  /** Sanitized model data */
  item: Record<string, any>;
  /** Relevance rank (higher = more relevant) */
  rank: number;
}

export interface SearchAllOptions {
  /** Models to search across. Only models with `static searchFields` are queried. */
  models: ModelConstructor[];
  /** Scope context for access control (applied per-model via model.scope.read). */
  scope?: ScopeContext;
  /** Maximum results per model. Default: 10 */
  limit?: number;
}

// ─── searchAll ───────────────────────────────────────────────────────────────

/**
 * Search across multiple models in parallel and return unified results
 * sorted by relevance rank.
 *
 * Only models that declare `static searchFields = [...]` are queried.
 * Scope (access control) is applied per-model.
 *
 * @example
 * ```typescript
 * import { searchAll } from "@parcae/backend";
 *
 * route.get("/v1/search", async (req, res) => {
 *   const results = await searchAll(adapter, req.query.q, {
 *     models: [Project, User],
 *     scope: { user: req.session?.user },
 *     limit: 20,
 *   });
 *   ok(res, { results, query: req.query.q });
 * });
 * ```
 */
export async function searchAll(
  adapter: BackendAdapter,
  term: string,
  options: SearchAllOptions,
): Promise<SearchResult[]> {
  if (!term?.trim()) return [];

  const limit = options.limit ?? 10;
  const scopeCtx = options.scope ?? {};

  // Filter to models that have searchFields defined
  const searchableModels = options.models.filter(
    (m) => (m as any).searchFields?.length > 0,
  );

  // Run searches in parallel
  const promises = searchableModels.map(async (modelClass) => {
    try {
      // Apply read scope
      const scopeFn = modelClass.scope?.read;
      const scopeResult = scopeFn ? scopeFn(scopeCtx) : () => {};

      // null scope = access denied
      if (scopeResult === null) return [];

      // Build scoped search query
      let chain = adapter.query(modelClass);

      if (typeof scopeResult === "function") {
        chain = chain.where(scopeResult);
      } else if (typeof scopeResult === "object" && scopeResult !== null) {
        chain = chain.where(scopeResult);
      }

      chain = (chain as any).search(term).limit(limit);

      const items = await chain.find();

      return Promise.all(
        items.map(async (item: any, index: number) => {
          const sanitized = await item.sanitize();
          return {
            type: modelClass.type,
            item: sanitized,
            // _rank from SQL if available, otherwise use position
            rank: (item as any)._rank ?? items.length - index,
          } as SearchResult;
        }),
      );
    } catch {
      return [];
    }
  });

  const resultArrays = await Promise.all(promises);
  const allResults = resultArrays.flat();

  // Sort by rank descending and clamp total
  allResults.sort((a, b) => b.rank - a.rank);
  return allResults.slice(0, limit);
}
