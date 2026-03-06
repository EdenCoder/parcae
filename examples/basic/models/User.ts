import { Model } from "@parcae/model";

/**
 * User model — a first-class Parcae Model.
 *
 * Auth fields (name, email, image, emailVerified) are written by
 * the auth adapter. Custom fields (bio, role) are yours.
 */
export class User extends Model {
  static type = "user" as const;

  // Auth-synced fields
  name: string = "";
  email: string = "";
  emailVerified: boolean = false;
  image?: string;

  // Custom fields
  bio: string = "";
  role: "user" | "admin" = "user";
}
