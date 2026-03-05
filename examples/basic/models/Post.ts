import { Model } from "@parcae/model";
import { User } from "./User";

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
  format?: "markdown" | "html";
}

export class Post extends Model {
  static type = "post" as const;

  static scope = {
    read: (ctx: any) => (qb: any) =>
      qb.where("published", true).orWhere("user", ctx.user?.id),
    create: (ctx: any) => (ctx.user ? { user: ctx.user.id } : null),
    update: (ctx: any) =>
      ctx.user ? (qb: any) => qb.where("user", ctx.user.id) : null,
    delete: (ctx: any) =>
      ctx.user ? (qb: any) => qb.where("user", ctx.user.id) : null,
  };

  user!: User;
  title: string = "";
  body: PostBody = { content: "" };
  published: boolean = false;
  views: number = 0;
}
