// Re-export the model's id generator so analytics rows share the
// shape of user-facing rows (no drift between system tables and
// model rows).
export { generateId } from "@parcae/model";
