import { Model } from '@parcae/model';
import type { QueryChain, ScopeContext } from '@parcae/model';
import { User } from './User';

/**
 * Post model — a simple blog post.
 *
 * Properties ARE the schema:
 * - user: User → VARCHAR (reference, lazy-loads User on access)
 * - title: string → VARCHAR
 * - body: PostBody → JSONB (any object = json)
 * - published: boolean → BOOLEAN
 * - views: number → INTEGER
 */

interface PostBody {
  content: string;
  format?: 'markdown' | 'html';
}

export class Post extends Model {
  static type = "post" as const;

  static scope = {
    read: (ctx: ScopeContext) => (query: QueryChain<Post>) =>
      query.where('published', true).orWhere('user', ctx.user?.id),
    create: (ctx: ScopeContext) =>
      ctx.user ? { user: ctx.user.id } : null,
    update: (ctx: ScopeContext) => {
      const userId = ctx.user?.id;
      return userId
        ? (query: QueryChain<Post>) => query.where('user', userId)
        : null;
    },
    delete: (ctx: ScopeContext) => {
      const userId = ctx.user?.id;
      return userId
        ? (query: QueryChain<Post>) => query.where('user', userId)
        : null;
    },
  };

  user!: User;
  title: string = '';
  body: PostBody = { content: '' };
  published: boolean = false;
  views: number = 0;
}
