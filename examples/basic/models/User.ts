import { Model } from "@parcae/model";

/**
 * User model — managed by Better Auth.
 * We declare it here so other models can reference it,
 * but set managed=false so Parcae doesn't create the table
 * (Better Auth owns the users table).
 */
export class User extends Model {
  static type = "user" as const;
  static managed = false;

  name: string = "";
  email: string = "";
  image?: string;
}
